'use strict';
// 临时复电单端到端测试。
// 使用方式: LOTO_DB=/tmp/loto-restore-test.db PORT=3101 node server.js 后
//           BASE=http://127.0.0.1:3101 node test/restore.e2e.js
const BASE = process.env.BASE || 'http://127.0.0.1:3101';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔', msg); }
  else { fail++; console.log('  ✘ FAIL:', msg); }
}
function eq(a, b, msg) { ok(a === b, `${msg} (期望 ${JSON.stringify(b)}, 实际 ${JSON.stringify(a)})`); }

async function call(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const r = await fetch(BASE + url, opts);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const OP = { actor: '复电操作员', role: 'operator' };
const ADMIN = { actor: '复电管理员', role: 'admin' };
const S2 = 2, K1 = 3, K2 = 4, K3 = 5, D1 = 6, D2 = 7;

(async () => {
  let { data: s } = await call('GET', '/api/state');
  let rev = s.revision;
  console.log('初始修订号:', rev);

  const state = async () => (await call('GET', '/api/state')).data;
  const auditCount = async () => (await call('GET', '/api/audit?limit=500')).data.logs.length;
  const preview = async (steps) =>
    call('POST', '/api/restore-orders/preview', { ...OP, revision: rev, steps });
  const confirm = async (steps, revision = rev) =>
    call('POST', '/api/restore-orders/confirm', { ...OP, revision, steps });

  console.log('\n[R1] 准备: K1/K2 分闸挂牌, D1 许可生效; K1 挂牌已顺带隔离 D2');
  for (const id of [K1, K2]) {
    let r = await call('POST', `/api/switches/${id}/open`, { ...OP, revision: rev });
    rev = r.data.revision;
    r = await call('POST', `/api/switches/${id}/tag`, { ...OP, revision: rev });
    rev = r.data.revision;
  }
  let r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D1 });
  rev = r.data.revision;
  const permitD1 = r.data.permit_id;
  ok(!!permitD1, 'D1 许可生效');
  const audits0 = await auditCount();

  console.log('\n[R2] 预演: 完整复电(结束许可→K2解牌→K1解牌→K1合闸→K2合闸) 只读通过');
  const fullSteps = [
    { action: 'endPermit', permit_id: permitD1 },
    { action: 'untag', node_id: K2 },
    { action: 'untag', node_id: K1 },
    { action: 'close', node_id: K1 },
    { action: 'close', node_id: K2 }
  ];
  r = await preview(fullSteps);
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.success, true, '预演成功');
  eq(r.data.failedStep, null, '无失败步');
  eq(r.data.steps.length, 5, '返回 5 步结果');
  eq(r.data.ended_permit_ids.join(','), String(permitD1), 'ended_permit_ids 含该许可');
  eq(r.data.steps[0].before.status, 'active', '结束许可步展示前状态 active');
  eq(r.data.steps[0].after.status, 'ended', '结束许可步展示后状态 ended');
  eq(r.data.steps[1].before.tagged, true, '解牌步前状态为挂牌');
  eq(r.data.steps[1].after.tagged, false, '解牌步后状态为未挂牌');
  eq(r.data.steps[3].before.open_pos, true, '合闸步前状态为分闸');
  eq(r.data.steps[3].after.open_pos, false, '合闸步后状态为合闸');
  // 第1步后剩余 0 张许可; 预演前基线为 1 张且保持隔离
  eq(r.data.remainingPermits.length, 1, '预演前有效许可基线 1 张');
  eq(r.data.remainingPermits[0].isolated, true, '基线许可保持隔离');
  eq(r.data.steps[0].remainingPermits.length, 0, '结束许可后剩余有效许可为 0');
  let cur = await state();
  eq(cur.revision, rev, '修订号不变');
  eq(cur.nodes.find((n) => n.id === K2).tagged, true, '真实状态: K2 仍挂牌(预演只读)');
  eq(cur.permits.length, 1, '真实许可仍为有效');
  eq(await auditCount(), audits0, '无审计落库');

  console.log('\n[R3] 隔离保护: 许可仍有效时解牌 K2 当步 ISOLATION_VIOLATION, 后续 skipped');
  r = await preview([
    { action: 'untag', node_id: K2 },
    { action: 'close', node_id: K2 }
  ]);
  eq(r.data.success, false, '预演失败');
  eq(r.data.failedStep, 1, '第1步失败');
  eq(r.data.steps[0].error.code, 'ISOLATION_VIOLATION', '错误码 ISOLATION_VIOLATION');
  eq(r.data.steps[0].violations[0].permit_id, permitD1, '受影响许可为 D1 许可');
  ok(r.data.steps[0].violations[0].livePaths.length >= 1
    && JSON.stringify(r.data.steps[0].violations[0].livePaths).includes('2#备用电源'),
    '附至少一条真实带电路径(2#备用电源→K2→...)');
  eq(r.data.steps[1].skipped, true, '第2步合闸未执行(不能补救)');
  // 失败步的 remainingPermits 仍反映“上一步成功后”的状态(许可仍在、隔离满足)
  eq(r.data.steps[0].remainingPermits[0].isolated, true, '失败步未落地, 剩余许可仍隔离');

  console.log('\n[R4] 结构校验: 不存在/已结束许可、重复结束、顺序错误、非法动作、开关不存在、空单');
  r = await preview([{ action: 'endPermit', permit_id: 99999 }]);
  eq(r.status, 404, '不存在许可 -> 404');
  eq(r.data.error.code, 'PERMIT_NOT_FOUND', '错误码 PERMIT_NOT_FOUND');
  r = await preview([
    { action: 'endPermit', permit_id: permitD1 },
    { action: 'endPermit', permit_id: permitD1 }
  ]);
  eq(r.status, 400, '重复结束许可 -> 400');
  eq(r.data.error.code, 'PERMIT_END_DUPLICATE', '错误码 PERMIT_END_DUPLICATE');
  r = await preview([
    { action: 'untag', node_id: K1 },
    { action: 'endPermit', permit_id: permitD1 }
  ]);
  eq(r.status, 400, '开关步之后结束许可 -> 400');
  eq(r.data.error.code, 'END_PERMIT_FIRST', '错误码 END_PERMIT_FIRST');
  r = await preview([{ action: 'open', node_id: K1 }]);
  eq(r.status, 400, '复电单含分闸动作 -> 400 INVALID_ACTION');
  eq(r.data.error.code, 'INVALID_ACTION', '错误码 INVALID_ACTION');
  r = await preview([{ action: 'tag', node_id: K1 }]);
  eq(r.status, 400, '复电单含挂牌动作 -> 400');
  r = await preview([{ action: 'untag', node_id: 99999 }]);
  eq(r.status, 404, '开关不存在 -> 404');
  r = await preview([]);
  eq(r.status, 400, '空复电单 -> 400 STEPS_REQUIRED');
  r = await preview([{ action: 'endPermit' }]);
  eq(r.status, 400, '缺 permit_id -> 400 INVALID_PERMIT_ID');
  r = await preview([{ action: 'close' }]);
  eq(r.status, 400, '缺 node_id -> 400 NODE_REQUIRED');

  console.log('\n[R5] 角色: 预演/确认仅 operator; 缺 actor 拒绝');
  r = await call('POST', '/api/restore-orders/preview',
    { ...ADMIN, revision: rev, steps: [{ action: 'endPermit', permit_id: permitD1 }] });
  eq(r.status, 403, '管理员预演 -> 403');
  r = await call('POST', '/api/restore-orders/confirm',
    { role: 'operator', revision: rev, steps: [{ action: 'endPermit', permit_id: permitD1 }] });
  eq(r.status, 400, '缺 actor -> 400');
  r = await call('POST', '/api/restore-orders/confirm',
    { ...ADMIN, revision: rev, steps: [{ action: 'endPermit', permit_id: permitD1 }] });
  eq(r.status, 403, '管理员确认 -> 403');

  console.log('\n[R6] 步数上限: 201 步 -> 400 STEPS_TOO_LONG');
  const longSteps = [{ action: 'endPermit', permit_id: permitD1 }];
  for (let i = 0; i < 200; i++) longSteps.push({ action: 'untag', node_id: K1 });
  r = await preview(longSteps);
  eq(r.status, 400, 'HTTP 400');
  eq(r.data.error.code, 'STEPS_TOO_LONG', '错误码 STEPS_TOO_LONG');

  console.log('\n[R7] 确认失败回滚: 不结束许可直接解牌 -> 422, 状态/修订号/审计不变');
  const auditsBefore = await auditCount();
  r = await confirm([{ action: 'untag', node_id: K2 }]);
  eq(r.status, 422, 'HTTP 422');
  eq(r.data.error.code, 'ISOLATION_VIOLATION', '错误码 ISOLATION_VIOLATION');
  eq(r.data.step, 1, '失败步骤序号 1');
  eq(r.data.step_name, '解牌', '失败步骤动作名');
  ok(Array.isArray(r.data.step_results) && r.data.step_results.length === 1, '返回逐步结果');
  cur = await state();
  eq(cur.revision, rev, '修订号不变');
  eq(cur.nodes.find((n) => n.id === K2).tagged, true, 'K2 仍挂牌(回滚)');
  eq(cur.permits.length, 1, '许可仍有效');
  eq(await auditCount(), auditsBefore, '无审计落库');

  console.log('\n[R8] 状态机: 未挂牌解牌 / 合闸位合闸 / 挂牌开关合闸(后续解牌不能补救)');
  r = await preview([
    { action: 'endPermit', permit_id: permitD1 },
    { action: 'untag', node_id: K3 }
  ]);
  eq(r.data.success, false, '预演失败');
  eq(r.data.steps[1].error.code, 'INVALID_STATE', 'K3 未挂牌解牌 -> INVALID_STATE');
  r = await preview([
    { action: 'endPermit', permit_id: permitD1 },
    { action: 'close', node_id: K3 }
  ]);
  eq(r.data.steps[1].error.code, 'INVALID_STATE', 'K3 合闸位再合闸 -> INVALID_STATE');
  r = await preview([
    { action: 'endPermit', permit_id: permitD1 },
    { action: 'close', node_id: K1 },   // K1 挂牌: 直接拒绝
    { action: 'untag', node_id: K1 }    // 后续解牌不能补救
  ]);
  eq(r.data.steps[1].error.code, 'SWITCH_TAGGED', '挂牌开关合闸 -> SWITCH_TAGGED');
  eq(r.data.steps[2].skipped, true, '后续解牌步未执行');

  console.log('\n[R9] 确认成功: 原子复电, 修订号只 +1, 一条审计含前后快照与有序步骤');
  r = await confirm(fullSteps);
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.revision, rev + 1, `修订号仅 +1 (${rev} → ${r.data.revision})`);
  rev = r.data.revision;
  eq(r.data.ended_permit_ids.join(','), String(permitD1), '返回结束许可编号');
  eq(r.data.steps.length, 5, '返回 5 个紧凑步骤');
  eq(r.data.steps[0].action, 'endPermit', '第1步为结束许可');
  ok(r.data.steps[0].permit_id === permitD1 && r.data.steps[0].device_id === D1,
    '结束许可步含 permit_id/device_id');
  cur = await state();
  eq(cur.permits.length, 0, '许可已结束(无有效许可)');
  const k1 = cur.nodes.find((n) => n.id === K1);
  const k2 = cur.nodes.find((n) => n.id === K2);
  ok(!k1.tagged && !k2.tagged && !k1.open_pos && !k2.open_pos, 'K1/K2 已解牌并合闸');
  const logs = (await call('GET', '/api/audit?limit=500')).data.logs;
  const restoreLog = logs.find((l) => l.action === 'restoreOrder.confirm');
  ok(!!restoreLog, '存在 restoreOrder.confirm 审计');
  ok(restoreLog.actor === OP.actor && restoreLog.role === 'operator'
    && restoreLog.rev_after === restoreLog.rev_before + 1
    && Array.isArray(restoreLog.detail.steps) && restoreLog.detail.steps.length === 5
    && restoreLog.state_before && restoreLog.state_after,
    '审计含 actor/role/有序步骤/前后修订号/前后完整快照');
  ok(restoreLog.state_before.permits.length === 1
    && restoreLog.state_after.permits.length === 0,
    '快照反映整单前后有效许可');
  ok(restoreLog.state_before.nodes.find((n) => n.id === K1).tagged === true
    && restoreLog.state_after.nodes.find((n) => n.id === K1).tagged === false,
    '快照反映 K1 解牌');

  console.log('\n[R10] 已结束许可不能再次结束(确认 422 PERMIT_NOT_ACTIVE)');
  r = await confirm([{ action: 'endPermit', permit_id: permitD1 }]);
  eq(r.status, 422, 'HTTP 422');
  eq(r.data.error.code, 'PERMIT_NOT_ACTIVE', '错误码 PERMIT_NOT_ACTIVE');
  eq(cur.revision, rev, '修订号仍不变');

  console.log('\n[R11] STALE_REVISION: 过期修订号确认 -> 409 + 当前完整状态');
  // 先做一个无关变更推进修订号(K3 分闸)
  const newer = (await call('POST', `/api/switches/${K3}/open`, { ...OP, revision: rev })).data.revision;
  ok(newer === rev + 1, '准备: 修订号推进');
  r = await confirm([{ action: 'close', node_id: K3 }], rev);
  eq(r.status, 409, 'HTTP 409');
  eq(r.data.error.code, 'STALE_REVISION', '错误码 STALE_REVISION');
  ok(r.data.current && r.data.current.revision === newer
    && Array.isArray(r.data.current.nodes) && Array.isArray(r.data.current.permits),
    '响应携带当前完整状态');
  rev = newer;
  // 过期的复电单没有任何步骤落地
  cur = await state();
  eq(cur.nodes.find((n) => n.id === K3).open_pos, true, 'K3 仍分闸(未被过期单合闸)');

  console.log('\n[R12] 多许可部分复电: 先结束 D1 许可再解 K2 牌, D2 新许可仍保持隔离');
  // 当前状态: K1/K2 合闸无牌; K3 分闸。先重建 K1/K2 挂牌, 为 D1、D2 各建许可
  // D2 供电路径 S1→K1→D2, 挂 K1 即隔离; D1 需 K1、K2 都挂牌
  for (const id of [K1, K2]) {
    // 合闸位(K3 分闸不影响), 直接挂牌需先分闸
    const rr = await call('POST', `/api/switches/${id}/open`, { ...OP, revision: rev }); rev = rr.data.revision;
    const rt = await call('POST', `/api/switches/${id}/tag`, { ...OP, revision: rev }); rev = rt.data.revision;
  }
  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D1 }); rev = r.data.revision;
  const pD1 = r.data.permit_id;
  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D2 }); rev = r.data.revision;
  const pD2 = r.data.permit_id;
  cur = await state();
  eq(cur.permits.length, 2, 'D1、D2 各有一张有效许可');
  // 只结束 D1, 然后解 K2(K2 只在 D1 的 S2 路径上; D2 由 K1 挂牌保护)
  r = await preview([
    { action: 'endPermit', permit_id: pD1 },
    { action: 'untag', node_id: K2 }
  ]);
  eq(r.data.success, true, '预演通过');
  eq(r.data.remainingPermits.length, 2, '预演前 2 张有效许可');
  // 第1步(结束D1)后剩余 D2, 隔离满足
  const afterEnd = r.data.steps[0].remainingPermits;
  eq(afterEnd.length, 1, '结束 D1 后剩余 1 张许可');
  eq(afterEnd[0].permit_id, pD2, '剩余许可为 D2');
  eq(afterEnd[0].isolated, true, 'D2 保持隔离');
  // 第2步解 K2 后, D2 仍只经 K1 受电, 保持隔离
  const afterUntag = r.data.steps[1].remainingPermits;
  eq(afterUntag.length, 1, '解 K2 后仍剩 1 张许可');
  eq(afterUntag[0].permit_id, pD2, '剩余许可仍为 D2');
  eq(afterUntag[0].isolated, true, 'D2 不受 K2 影响, 仍隔离');
  // 反例: 不结束任何许可就解 K1, D1 与 D2 都会带电
  r = await preview([{ action: 'untag', node_id: K1 }]);
  eq(r.data.success, false, '未解许可先解 K1 -> 失败');
  const violIds = r.data.steps[0].violations.map((v) => v.device_id).sort().join(',');
  eq(violIds, `${D1},${D2}`, 'D1、D2 两张许可均受影响');
  ok(r.data.steps[0].violations.every((v) => v.livePaths.length >= 1),
    '每个受影响许可都附至少一条真实带电路径');

  // 成功确认部分复电
  const auditsP = await auditCount();
  r = await confirm([
    { action: 'endPermit', permit_id: pD1 },
    { action: 'untag', node_id: K2 }
  ]);
  eq(r.status, 200, '部分复电确认成功');
  eq(r.data.revision, rev + 1, '修订号仅 +1');
  rev = r.data.revision;
  eq(await auditCount(), auditsP + 1, '仅一条审计');
  cur = await state();
  eq(cur.permits.length, 1, '仅剩 D2 有效许可');
  eq(cur.permits[0].device_id, D2, '剩余许可属于 D2');
  eq(cur.nodes.find((n) => n.id === K2).tagged, false, 'K2 已解牌');
  eq(cur.nodes.find((n) => n.id === K1).tagged, true, 'K1 仍挂牌保护 D2');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
