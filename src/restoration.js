'use strict';

// 临时复电单(检修结束): 按序结束许可 -> 对选定开关解牌 / 合闸。
//
// 与临时操作单(src/orders.js)同一套“编排 -> 只读预演 -> 确认原子落库”模式:
//   - normalizeRestorationSteps 做结构校验并归一化: end(结束许可)步骤必须全部
//     排在 untag(解牌)/close(合闸)之前; 许可必须当前有效, 不得重复结束;
//     复电单只允许 end / untag / close 三种动作;
//   - simulateRestoration 只在节点/许可的内存克隆上按序推演, 完全不触碰数据库:
//     每个开关动作之后立即对“当前剩余有效许可”做完整可达性隔离复查,
//     任一步不通过即判定该步失败并中止, 后续步骤统一标记 skipped ——
//     不允许用后续步骤补救前一步;
//   - 确认时服务端在 IMMEDIATE 事务、修订号校验通过之后重放同一推演; 全部
//     通过才按原顺序真正写库, 随后只递增一次修订号、写一条整单审计
//     (含前后完整快照)。任一步失败: 事务回滚, 整单不落库。

const {
  validateActivePermits,
  evaluateIsolation,
  serializePath
} = require('./graph');
const { MAX_STEPS } = require('./orders');

const SWITCH_ACTIONS = new Set(['untag', 'close']);
const ACTION_LABEL = {
  end: '结束许可', untag: '解牌', close: '合闸'
};

// 与 server.ApiError 同构(status/code + 附加字段), server 错误处理按鸭子类型识别。
class RestorationError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

/**
 * 结构校验并归一化复电单。
 * @param activePermits 当前有效许可(含 id/device_id/device_name)
 * @param allPermitRows permits 表全部行(仅需 id/status), 用于区分“不存在”与“已结束”
 * @returns 归一化步骤
 *   [{action:'end', permit_id, device_id, device_name}
 *    | {action:'untag'|'close', node_id, name}]
 */
function normalizeRestorationSteps(graph, activePermits, allPermitRows, rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new RestorationError(400, 'STEPS_REQUIRED', '复电单必须至少包含一个步骤');
  }
  if (rawSteps.length > MAX_STEPS) {
    throw new RestorationError(400, 'STEPS_TOO_LONG', `复电单最多 ${MAX_STEPS} 步`);
  }

  const activeById = new Map(activePermits.map((p) => [p.id, p]));
  const anyById = new Map(allPermitRows.map((p) => [p.id, p]));
  const endingPermits = new Set();
  const steps = [];
  let switchSection = false; // 一旦出现开关步, 其后不得再有结束许可步

  rawSteps.forEach((raw, i) => {
    const seq = i + 1;
    if (!raw || typeof raw !== 'object') {
      throw new RestorationError(400, 'INVALID_STEP', `第 ${seq} 步格式不正确`);
    }
    const { action } = raw;

    if (action === 'end') {
      if (switchSection) {
        throw new RestorationError(400, 'PERMIT_ENDS_MUST_BE_FIRST',
          `第 ${seq} 步为结束许可: 必须先按序结束全部指定许可, 再进行解牌 / 合闸`);
      }
      const permitId = parseInt(raw.permit_id, 10);
      if (!Number.isInteger(permitId)) {
        throw new RestorationError(400, 'PERMIT_ID_REQUIRED',
          `第 ${seq} 步结束许可必须提供 permit_id`);
      }
      const row = anyById.get(permitId);
      if (!row) {
        throw new RestorationError(404, 'PERMIT_NOT_FOUND',
          `第 ${seq} 步: 检修许可 #${permitId} 不存在`);
      }
      if (row.status !== 'active') {
        throw new RestorationError(422, 'PERMIT_NOT_ACTIVE',
          `第 ${seq} 步: 许可 #${permitId} 已结束, 不能重复结束`);
      }
      if (endingPermits.has(permitId)) {
        throw new RestorationError(400, 'PERMIT_END_DUPLICATE',
          `第 ${seq} 步重复结束许可 #${permitId}: 同一复电单内每张许可只能结束一次`);
      }
      endingPermits.add(permitId);
      const permit = activeById.get(permitId);
      steps.push({
        action: 'end',
        permit_id: permitId,
        device_id: permit.device_id,
        device_name: permit.device_name
      });
      return;
    }

    if (SWITCH_ACTIONS.has(action)) {
      switchSection = true;
      const nodeId = parseInt(raw.node_id, 10);
      if (!Number.isInteger(nodeId)) {
        throw new RestorationError(400, 'NODE_REQUIRED', `第 ${seq} 步必须提供开关编号 node_id`);
      }
      const node = graph.nodeById.get(nodeId);
      if (!node || node.kind !== 'switch') {
        throw new RestorationError(404, 'NOT_FOUND', `第 ${seq} 步: 开关不存在`);
      }
      steps.push({ action, node_id: nodeId, name: node.name });
      return;
    }

    throw new RestorationError(400, 'INVALID_ACTION',
      `第 ${seq} 步动作无效: 临时复电单仅支持 end(结束许可)、untag(解牌)、close(合闸)`);
  });

  return steps;
}

function stateLabelOf(node) {
  if (node.tagged) return '挂牌';
  return node.open_pos ? '分闸' : '合闸';
}

/**
 * 剩余有效许可的隔离小结(预演展示用)。带电许可附真实带电路径与截断标记;
 * 正常推演中成功步之后不可能有带电许可(带电即判失败), 这里仍如实计算。
 */
function summarizeRemaining(view, permits) {
  return permits.map((p) => {
    const r = evaluateIsolation(view(), p.device_id);
    const item = {
      permit_id: p.id,
      device_id: p.device_id,
      device_name: p.device_name,
      isolated: r.isolated
    };
    if (!r.isolated) {
      item.livePaths = r.livePaths.map((path) => serializePath(view(), path));
      item.truncated = r.truncated;
    }
    return item;
  });
}

/**
 * 纯内存预演。输入的 graph / permits 不会被修改。
 * @returns {{success:boolean, failedStep:number|null,
 *            error:{code:string,message:string}|null, steps:Array}}
 */
function simulateRestoration(graph, permits, steps) {
  // 节点浅拷贝(预演中的解牌/合闸只改动克隆); 拓扑边只读, 直接复用。
  const nodeById = new Map(graph.nodes.map((n) => [n.id, { ...n }]));
  const view = () => ({ nodes: [...nodeById.values()], nodeById, outAdj: graph.outAdj });

  const activeById = new Map(permits.map((p) => [p.id, { ...p }]));
  const remainingList = () => [...activeById.values()].sort((a, b) => a.id - b.id);

  const results = [];
  let success = true;
  let failedStep = null;

  function pushSkipped(s, seq) {
    results.push({
      step: seq, action: s.action,
      ...(s.action === 'end'
        ? { permit_id: s.permit_id, device_id: s.device_id, device_name: s.device_name }
        : { node_id: s.node_id, name: s.name }),
      ok: false, skipped: true,
      message: '未执行: 前序步骤已失败, 整单在该步之前中止(后续步骤不能补救)'
    });
  }

  function doEnd(s, seq) {
    const before = { status: 'active' };
    activeById.delete(s.permit_id);
    const after = { status: 'ended' };
    const remaining = summarizeRemaining(view, remainingList());
    results.push({
      step: seq, action: 'end',
      permit_id: s.permit_id, device_id: s.device_id, device_name: s.device_name,
      ok: true, before, after, remainingPermits: remaining,
      message: `许可 #${s.permit_id}（${s.device_name}）已结束, 剩余 ${remaining.length} 张有效许可`
    });
  }

  function failSwitch(s, seq, node, before, code, message, extra) {
    success = false;
    failedStep = seq;
    results.push({
      step: seq, action: s.action, node_id: node ? node.id : s.node_id,
      name: node ? node.name : s.name,
      ok: false, before, after: before,
      // 失败瞬间的剩余许可隔离结果由调用方在 extra.remaining 中给出(回滚前计算),
      // 否则这里展示的是回滚后的状态, 看不出该步为何违规。
      remainingPermits: (extra && extra.remaining) || summarizeRemaining(view, remainingList()),
      error: { code, message }, ...(extra || {})
    });
  }

  function doSwitch(s, seq) {
    const node = nodeById.get(s.node_id);
    const before = { open_pos: node.open_pos, tagged: node.tagged };

    if (s.action === 'untag') {
      if (!node.tagged) {
        return failSwitch(s, seq, node, before, 'INVALID_STATE', '该开关未挂牌, 无需解牌');
      }
      node.tagged = false;
    } else { // close
      if (node.tagged) {
        // 挂牌合闸: 状态未改变, 回滚前后剩余许可隔离结论一致
        return failSwitch(s, seq, node, before, 'SWITCH_TAGGED', '挂牌开关不得合闸, 请先解牌');
      }
      if (!node.open_pos) {
        return failSwitch(s, seq, node, before, 'INVALID_STATE', '开关已在合闸位置');
      }
      node.open_pos = false;
    }

    // 剩余有效许可隔离保护: 该步落地之后, 所有尚未结束的有效许可仍必须满足隔离。
    const g = view();
    const violations = validateActivePermits(g, remainingList());
    if (violations.length > 0) {
      // 在回滚前记录“该步落地瞬间”的剩余许可隔离结果(违规许可在此刻带电)
      const remainingAtFailure = summarizeRemaining(view, remainingList());
      // 预演失败即中止, 克隆回滚仅为语义干净(失败响应中的 before/after 一致)。
      node.open_pos = before.open_pos;
      node.tagged = before.tagged;
      return failSwitch(s, seq, node, before, 'ISOLATION_VIOLATION',
        '该步会使尚未结束的有效许可失去断电隔离; 复电单在该步即拒绝, 后续步骤不能补救',
        {
          remaining: remainingAtFailure,
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
      remainingPermits: summarizeRemaining(view, remainingList()),
      message: `${ACTION_LABEL[s.action]}完成（${stateLabelOf(node)}）, 剩余 ${remainingList().length} 张有效许可`
    });
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const seq = i + 1;
    if (!success) {
      pushSkipped(s, seq);
    } else if (s.action === 'end') {
      doEnd(s, seq);
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
 * 确认落库: 仅在 simulateRestoration 全部通过后调用。按原顺序执行同样的 SQL,
 * 与预演使用同一套状态机/隔离判定(已由预演担保合法), 不会再失败。
 * @returns 每步紧凑记录
 *   [{step, action:'end', permit_id, device_id}
 *    | {step, action:'untag'|'close', node_id}]
 */
function commitRestorationSteps(db, steps, actor) {
  const endPermit = db.prepare(
    `UPDATE permits SET status='ended', ended_at=datetime('now'), ended_by=? WHERE id=?`
  );
  const applySwitch = {
    untag: db.prepare(`UPDATE nodes SET tagged=0 WHERE id=?`),
    close: db.prepare(`UPDATE nodes SET open_pos=0 WHERE id=?`)
  };

  const committed = [];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const seq = i + 1;
    if (s.action === 'end') {
      endPermit.run(actor, s.permit_id);
      committed.push({ step: seq, action: 'end', permit_id: s.permit_id, device_id: s.device_id });
    } else {
      applySwitch[s.action].run(s.node_id);
      committed.push({ step: seq, action: s.action, node_id: s.node_id });
    }
  }
  return committed;
}

module.exports = {
  MAX_STEPS,
  ACTION_LABEL,
  RestorationError,
  normalizeRestorationSteps,
  simulateRestoration,
  commitRestorationSteps
};
