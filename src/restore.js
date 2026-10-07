'use strict';

// 临时复电单(检修结束): 编排 -> 预演(纯内存推演) -> 确认(事务内原子落库)。
//
// 与检修前的临时操作单(orders.js)方向相反: 先按序“结束指定有效许可”,
// 再对选定开关“解牌、合闸”。结构上强制:
//   - 许可结束步(endPermit)必须全部排在开关步(untag/close)之前;
//   - 一张复电单里同一张许可只能结束一次;
//   - 引用不存在 / 已结束的许可在结构校验阶段即拒绝;
//   - 开关动作只允许 untag(解牌)、close(合闸);
//   - 步数沿用以有操作单上限(MAX_STEPS, 200)。
//
// 预演 simulateRestore 只在节点/许可的内存克隆上按序推演, 完全不触碰数据库:
//   - 每一步都先套用既有开关状态机(与单步接口完全相同的合法条件,
//     挂牌开关不得合闸 SWITCH_TAGGED、未挂牌不得解牌 INVALID_STATE 等);
//   - 每个开关动作之后立即对“当前剩余有效许可”做完整可达性隔离复查;
//   - 任一步不通过即判定该步失败并中止, 后续步骤统一标记 skipped ——
//     不允许用后续步骤补救前一步的违规(例如先解牌使剩余许可带电、再合闸)。
//
// 确认时服务端在 IMMEDIATE 事务、修订号校验通过之后重放同一推演; 推演全部
// 通过才按原顺序真正写库, 随后只递增一次修订号、写一条整单审计(含前后
// 完整快照与有序步骤)。任一步失败: 事务回滚, 整单不落库。

const {
  findReachableTarget,
  evaluateIsolation,
  validateActivePermits,
  serializePath
} = require('./graph');
const { MAX_STEPS, OrderError } = require('./orders');

const RESTORE_ACTIONS = new Set(['endPermit', 'untag', 'close']);
const ACTION_LABEL = {
  endPermit: '结束许可', untag: '解牌', close: '合闸'
};

function switchStateLabel(node) {
  if (node.tagged) return '挂牌';
  return node.open_pos ? '分闸' : '合闸';
}

/**
 * 结构校验并归一化临时复电单。
 * @param graph loadGraph() 风格的完整供电图
 * @param findPermit (id) => 许可行(含已结束许可) 或 undefined, 用于区分
 *                   “许可不存在”(404) 与“许可已结束”(422)
 * @returns 归一化步骤
 *   [{action:'endPermit', permit_id, device_id, device_name} |
 *    {action:'untag'|'close', node_id, name}]
 */
function normalizeRestoreSteps(graph, findPermit, rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new OrderError(400, 'STEPS_REQUIRED', '复电单必须至少包含一个步骤');
  }
  if (rawSteps.length > MAX_STEPS) {
    throw new OrderError(400, 'STEPS_TOO_LONG', `复电单最多 ${MAX_STEPS} 步`);
  }

  const steps = [];
  const endingPermitIds = new Set();
  let switchStepSeen = false;

  rawSteps.forEach((raw, i) => {
    const seq = i + 1;
    if (!raw || typeof raw !== 'object') {
      throw new OrderError(400, 'INVALID_STEP', `第 ${seq} 步格式不正确`);
    }
    const { action } = raw;

    if (action === 'endPermit') {
      if (switchStepSeen) {
        throw new OrderError(400, 'END_PERMIT_FIRST',
          `第 ${seq} 步为结束许可: 必须先按序结束全部许可, 再进行解牌 / 合闸`);
      }
      const permitId = parseInt(raw.permit_id, 10);
      if (!Number.isInteger(permitId) || permitId < 1) {
        throw new OrderError(400, 'INVALID_PERMIT_ID',
          `第 ${seq} 步结束许可必须提供有效的 permit_id(正整数)`);
      }
      const permit = findPermit(permitId);
      if (!permit) {
        throw new OrderError(404, 'PERMIT_NOT_FOUND',
          `第 ${seq} 步: 检修许可 #${permitId} 不存在`);
      }
      if (permit.status !== 'active') {
        throw new OrderError(422, 'PERMIT_NOT_ACTIVE',
          `第 ${seq} 步: 检修许可 #${permitId} 已结束, 不能重复结束`);
      }
      if (endingPermitIds.has(permitId)) {
        throw new OrderError(400, 'PERMIT_END_DUPLICATE',
          `第 ${seq} 步重复结束许可 #${permitId}: 一张复电单内同一张许可只能结束一次`);
      }
      endingPermitIds.add(permitId);
      const node = graph.nodeById.get(permit.device_id);
      steps.push({
        action: 'endPermit',
        permit_id: permitId,
        device_id: permit.device_id,
        device_name: node ? node.name : permit.device_id
      });
      return;
    }

    if (action === 'untag' || action === 'close') {
      switchStepSeen = true;
      const nodeId = parseInt(raw.node_id, 10);
      if (!Number.isInteger(nodeId) || nodeId < 1) {
        throw new OrderError(400, 'NODE_REQUIRED', `第 ${seq} 步必须提供开关编号 node_id`);
      }
      const node = graph.nodeById.get(nodeId);
      if (!node || node.kind !== 'switch') {
        throw new OrderError(404, 'NOT_FOUND', `第 ${seq} 步: 开关不存在`);
      }
      steps.push({ action, node_id: nodeId, name: node.name });
      return;
    }

    throw new OrderError(400, 'INVALID_ACTION',
      `第 ${seq} 步动作无效: 临时复电单仅支持 endPermit(结束许可)、untag(解牌)、close(合闸)`);
  });

  return steps;
}

/**
 * 剩余有效许可的隔离快照: 先用无上限的完整可达性分析判定是否带电(轻量),
 * 仅对确实带电的许可补做 evaluateIsolation 以携带真实带电路径与截断标记。
 */
function remainingReport(view, permits) {
  return permits.map((p) => {
    const item = {
      permit_id: p.id,
      device_id: p.device_id,
      device_name: p.device_name
    };
    const { reachable } = findReachableTarget(view, p.device_id);
    item.isolated = !reachable;
    if (reachable) {
      const r = evaluateIsolation(view, p.device_id);
      item.livePaths = r.livePaths.map((path) => serializePath(view, path));
      item.truncated = r.truncated;
    }
    return item;
  });
}

/**
 * 纯内存预演。输入的 graph / permits 不会被修改。
 * @returns {{ success:boolean, failedStep:number|null,
 *             error:{code:string,message:string}|null, steps:Array }}
 *   每步结果含 before/after 状态; 开关步还含该步落地后 remainingPermits
 *   (剩余有效许可的隔离结果); 失败步含 error, 后续步骤 skipped:true。
 */
function simulateRestore(graph, permits, steps) {
  // 节点浅拷贝(预演中的解牌/合闸只改动克隆); 拓扑边只读, 直接复用。
  const nodeById = new Map(graph.nodes.map((n) => [n.id, { ...n }]));
  const view = () => ({ nodes: [...nodeById.values()], nodeById, outAdj: graph.outAdj });

  const activeById = new Map();
  for (const p of permits) activeById.set(p.id, p);

  const results = [];
  let success = true;
  let failedStep = null;

  function remainingNow() {
    return remainingReport(view(), [...activeById.values()].sort((a, b) => a.id - b.id));
  }

  function pushSkipped(s, seq) {
    results.push({
      step: seq, action: s.action,
      ...(s.action === 'endPermit'
        ? { permit_id: s.permit_id, device_id: s.device_id, device_name: s.device_name }
        : { node_id: s.node_id, name: s.name }),
      ok: false, skipped: true,
      message: '未执行: 前序步骤已失败, 整单在该步之前中止(后续步骤不能补救)'
    });
  }

  function failStep(s, seq, target, before, after, code, message, extra) {
    success = false;
    failedStep = seq;
    results.push({
      step: seq, action: s.action, ...target,
      ok: false, before, after,
      error: { code, message },
      // 失败即该步不落地: 剩余许可隔离结果为“上一步成功后”的状态
      remainingPermits: remainingNow(),
      ...(extra || {})
    });
  }

  function doEndPermit(s, seq) {
    const before = { status: 'active' };
    const permit = activeById.get(s.permit_id);
    if (!permit) {
      // 理论上 normalizeRestoreSteps 已拦截; 防御性兜底(并发演示语义一致)。
      return failStep(s, seq,
        { permit_id: s.permit_id, device_id: s.device_id, device_name: s.device_name },
        before, before, 'PERMIT_NOT_ACTIVE', '该许可不是有效许可, 无法结束');
    }
    activeById.delete(s.permit_id);
    results.push({
      step: seq, action: 'endPermit',
      permit_id: s.permit_id, device_id: s.device_id, device_name: s.device_name,
      ok: true, before, after: { status: 'ended' },
      message: `许可 #${s.permit_id}（${s.device_name}）已结束`,
      remainingPermits: remainingNow()
    });
  }

  function doSwitch(s, seq) {
    const node = nodeById.get(s.node_id);
    const before = { open_pos: node.open_pos, tagged: node.tagged };
    const target = { node_id: node.id, name: node.name };

    if (s.action === 'untag') {
      if (!node.tagged) {
        return failStep(s, seq, target, before, before, 'INVALID_STATE', '该开关未挂牌, 无需解牌');
      }
      node.tagged = false;
    } else { // close
      if (node.tagged) {
        // 状态机在挂牌检查处即拒绝, 开关状态不变, 也不存在隔离复查
        return failStep(s, seq, target, before, before, 'SWITCH_TAGGED',
          '挂牌开关不得合闸, 请先解牌(后续步骤不能补救)');
      }
      if (!node.open_pos) {
        return failStep(s, seq, target, before, before, 'INVALID_STATE', '开关已在合闸位置');
      }
      node.open_pos = false;
    }

    // 有效许可隔离保护: 该步落地之后, 所有“仍未结束”的有效许可必须保持隔离。
    const g = view();
    const violations = validateActivePermits(g, [...activeById.values()]);
    if (violations.length > 0) {
      // 预演失败即回滚克隆, 失败响应中的 before/after 一致; 整单在此中止。
      node.open_pos = before.open_pos;
      node.tagged = before.tagged;
      return failStep(s, seq, target, before, before, 'ISOLATION_VIOLATION',
        '该步会使尚未结束的有效检修许可失去断电隔离; 复电单在该步即拒绝, 后续步骤不能补救',
        {
          violations: violations.map((v) => ({
            permit_id: v.permit.id,
            device_id: v.permit.device_id,
            device_name: v.permit.device_name,
            livePaths: v.livePaths.map((p) => serializePath(g, p)),
            truncated: v.truncated
          }))
        });
    }

    const after = { open_pos: node.open_pos, tagged: node.tagged };
    results.push({
      step: seq, action: s.action, node_id: node.id, name: node.name,
      ok: true, before, after,
      message: `${ACTION_LABEL[s.action]}完成（${switchStateLabel(node)}）`,
      remainingPermits: remainingNow()
    });
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const seq = i + 1;
    if (!success) {
      pushSkipped(s, seq);
    } else if (s.action === 'endPermit') {
      doEndPermit(s, seq);
    } else {
      doSwitch(s, seq);
    }
  }

  const failed = failedStep === null ? null : results[failedStep - 1];
  return {
    success,
    failedStep,
    error: failed ? { code: failed.error.code, message: failed.error.message } : null,
    steps: results
  };
}

/**
 * 确认落库: 仅在 simulateRestore 全部通过后调用。按原顺序执行同样的 SQL,
 * 与预演使用同一套状态机/隔离判定(已由预演担保合法), 不会再失败。
 * @returns 每步紧凑记录
 *   [{step, action:'endPermit', permit_id, device_id} |
 *    {step, action:'untag'|'close', node_id}]
 */
function commitRestore(db, steps, actor) {
  const applySwitch = {
    untag: db.prepare(`UPDATE nodes SET tagged=0 WHERE id=?`),
    close: db.prepare(`UPDATE nodes SET open_pos=0 WHERE id=?`)
  };
  const endPermitStmt = db.prepare(
    `UPDATE permits SET status='ended', ended_at=datetime('now'), ended_by=? WHERE id=?`
  );

  const committed = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const seq = i + 1;
    if (s.action === 'endPermit') {
      endPermitStmt.run(actor, s.permit_id);
      committed.push({
        step: seq, action: 'endPermit',
        permit_id: s.permit_id, device_id: s.device_id
      });
    } else {
      applySwitch[s.action].run(s.node_id);
      committed.push({ step: seq, action: s.action, node_id: s.node_id });
    }
  }
  return committed;
}

module.exports = {
  MAX_STEPS,
  RESTORE_ACTIONS,
  ACTION_LABEL,
  normalizeRestoreSteps,
  simulateRestore,
  commitRestore,
  remainingReport
};
