'use strict';
// 临时复电单(检修结束)端到端测试。
// 使用方式: LOTO_DB=/tmp/loto-restore-test.db PORT=3100 node server.js 后执行
//          BASE=http://127.0.0.1:3100 node test/restoration.e2e.js
const BASE = process.env.BASE || 'http://127.0.0.1:3100';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✔', msg); }
  else { fail++; console.log('  ✘ FAIL:', msg); }
}

async function call(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const r = await fetch(BASE + url, opts);
  return { status: r.status, data: await r.json().catch(() => ({})) };
}

const OP = { actor: '复电单操作员', role: 'operator' };
const ADMIN = { actor: '复电单管理员', role: 'admin' };

(async () => {
  let { data: s } = await call('GET', '/api/state');
  let rev = s.revision;
  console.log('初始修订号:', rev);
  const K1 = 3, K2 = 4, D1 = 6, D2 = 7;

  const preview = async (steps) =>
    call('POST', '/api/restoration/preview', { ...OP, revision: rev, steps });
  const confirm = async (steps, revision = rev) =>
    call('POST', '/api/restoration/confirm', { ...OP, revision, steps });
  const auditCount = async () => (await call('GET', '/api/audit?limit=500')).data.logs.length;
  const restoreAudits = async () =>
    (await call('GET', '/api/audit?limit=500')).data.logs.filter((l) => l.action === 'restoration.confirm');
  const state = async () => (await call('GET', '/api/state')).data;

  console.log('\n[准备] K1/K2 分闸+挂牌, 为 D1 申请许可 #1');
  for (const id of [K1, K2]) {
    let r = await call('POST', `/api/switches/${id}/open`, { ...OP, revision: rev }); rev = r.data.revision;
    r = await call('POST', `/api/switches/${id}/tag`, { ...OP, revision: rev }); rev = r.data.revision;
  }
  let r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D1 });
  rev = r.data.revision;
  ok(r.status === 200, `准备: D1 许可 #1 生效 (rev=${rev})`);

  console.log('\n[F1] 预演: 结束#1 → 解牌/合闸 K1 → 解牌/合闸 K2 全部通过, 逐步展示前后状态与剩余许可');
  const goodSteps = [
    { action: 'end', permit_id: 1 },
    { action: 'untag', node_id: K1 }, { action: 'close', node_id: K1 },
    { action: 'untag', node_id: K2 }, { action: 'close', node_id: K2 }
  ];
  r = await preview(goodSteps);
  ok(r.status === 200, 'HTTP 200');
  ok(r.data.kind === 'restoration.preview' && r.data.success === true && r.data.failedStep === null,
    '预演成功、无失败步');
  ok(r.data.steps.length === 5, '返回 5 个步骤结果');
  ok(r.data.steps[0].action === 'end' && r.data.steps[0].before.status === 'active'
    && r.data.steps[0].after.status === 'ended'
    && Array.isArray(r.data.steps[0].remainingPermits) && r.data.steps[0].remainingPermits.length === 0,
    '结束步展示 [有效]→[已结束] 与剩余有效许可(0 张)');
  ok(r.data.steps[1].before.tagged === true && r.data.steps[1].after.tagged === false
    && r.data.steps[1].after.open_pos === true, '解牌步展示挂牌→解牌(仍分闸)前后状态');
  ok(r.data.steps[2].before.open_pos === true && r.data.steps[2].after.open_pos === false,
    '合闸步展示分闸→合闸前后状态');

  console.log('\n[F2] 预演纯只读: 状态、许可、修订号、审计均不变');
  let cur = await state();
  ok(cur.revision === rev, '修订号不变');
  ok(cur.nodes.find((n) => n.id === K1).tagged === true
    && cur.nodes.find((n) => n.id === K2).tagged === true, 'K1/K2 仍挂牌');
  ok(cur.permits.length === 1 && cur.permits[0].id === 1, '许可 #1 仍有效');

  console.log('\n[F3] 预演: 未结束许可即解牌破坏隔离 → 当步失败, 附受影响许可与真实带电路径, 后续 skipped');
  r = await preview([
    { action: 'untag', node_id: K2 },   // 会使 D1 重新来电
    { action: 'untag', node_id: K1 }    // 不得执行(不能补救)
  ]);
  ok(r.status === 200 && r.data.success === false, '预演业务失败(HTTP 200, success=false)');
  ok(r.data.failedStep === 1 && r.data.steps[0].error.code === 'ISOLATION_VIOLATION',
    '第 1 步 ISOLATION_VIOLATION');
  const v = r.data.steps[0].violations[0];
  ok(v && v.permit_id === 1 && v.device_id === D1, '指出受影响许可 #1 (D1)');
  ok(v.livePaths.length >= 1 && JSON.stringify(v.livePaths).includes('2#备用电源'),
    '附至少一条真实带电路径');
  ok(r.data.steps[0].remainingPermits.some((p) => p.permit_id === 1 && p.isolated === false),
    '失败步展示剩余许可 #1 的隔离结果(带电)');
  ok(r.data.steps[1].skipped === true, '第 2 步标记未执行');
  cur = await state();
  ok(cur.nodes.find((n) => n.id === K2).tagged === true, '真实状态: K2 仍挂牌');

  console.log('\n[F4] 结构校验: 顺序/不存在/重复/非法动作/空单/缺字段/超步数');
  r = await preview([{ action: 'untag', node_id: K1 }, { action: 'end', permit_id: 1 }]);
  ok(r.status === 400 && r.data.error.code === 'PERMIT_ENDS_MUST_BE_FIRST',
    '开关步之后再结束许可 → 400 PERMIT_ENDS_MUST_BE_FIRST');
  r = await preview([{ action: 'end', permit_id: 999 }]);
  ok(r.status === 404 && r.data.error.code === 'PERMIT_NOT_FOUND', '不存在的许可 → 404');
  r = await preview([{ action: 'end', permit_id: 1 }, { action: 'end', permit_id: 1 }]);
  ok(r.status === 400 && r.data.error.code === 'PERMIT_END_DUPLICATE', '重复结束 → 400');
  r = await preview([{ action: 'open', node_id: K1 }]);
  ok(r.status === 400 && r.data.error.code === 'INVALID_ACTION',
    '非法动作(分闸 open) → 400 INVALID_ACTION');
  r = await preview([{ action: 'tag', node_id: K1 }]);
  ok(r.status === 400 && r.data.error.code === 'INVALID_ACTION', '挂牌 tag 不属于复电单动作');
  r = await preview([]);
  ok(r.status === 400 && r.data.error.code === 'STEPS_REQUIRED', '空复电单 → 400');
  r = await preview([{ action: 'end' }]);
  ok(r.status === 400 && r.data.error.code === 'PERMIT_ID_REQUIRED', '结束步缺 permit_id → 400');
  r = await preview([{ action: 'untag' }]);
  ok(r.status === 400 && r.data.error.code === 'NODE_REQUIRED', '开关步缺 node_id → 400');
  r = await preview(Array(201).fill({ action: 'untag', node_id: K1 }));
  ok(r.status === 400 && r.data.error.code === 'STEPS_TOO_LONG', '超过 200 步上限 → 400');
  r = await preview([{ action: 'untag', node_id: 999 }]);
  ok(r.status === 404 && r.data.error.code === 'NOT_FOUND', '开关不存在 → 404');
  r = await preview([{ action: 'untag', node_id: D1 }]);
  ok(r.status === 404 && r.data.error.code === 'NOT_FOUND', '把设备编号当开关 → 404');

  console.log('\n[F5] 身份与角色: 预演/确认均需 operator');
  r = await call('POST', '/api/restoration/preview',
    { ...ADMIN, revision: rev, steps: [{ action: 'end', permit_id: 1 }] });
  ok(r.status === 403, '管理员预演 → 403');
  r = await call('POST', '/api/restoration/confirm',
    { role: 'operator', revision: rev, steps: [{ action: 'end', permit_id: 1 }] });
  ok(r.status === 400, '缺 actor → 400');
  r = await call('POST', '/api/restoration/confirm',
    { ...ADMIN, revision: rev, steps: [{ action: 'end', permit_id: 1 }] });
  ok(r.status === 403, '管理员确认 → 403');

  console.log('\n[F6] 多许可: 结束 #1 后 K2 可解牌/合闸(#2 仍被 K1 保护); 再解 K1 破坏 #2 → 失败');
  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D2 });
  rev = r.data.revision;
  ok(r.status === 200, `准备: D2 许可 #2 生效 (rev=${rev})`);
  r = await preview([
    { action: 'end', permit_id: 1 },
    { action: 'untag', node_id: K2 },
    { action: 'close', node_id: K2 },
    { action: 'untag', node_id: K1 }
  ]);
  ok(r.data.success === false && r.data.failedStep === 4, '第 4 步失败(前三步成功)');
  ok(r.data.steps[0].remainingPermits.some((p) => p.permit_id === 2 && p.isolated === true),
    '结束 #1 后剩余许可 #2 仍隔离');
  ok(r.data.steps[2].ok && r.data.steps[2].remainingPermits.every((p) => p.isolated),
    '合闸 K2 后剩余许可 #2 仍满足隔离(仅 K1 保护 D2)');
  const v2 = r.data.steps[3].violations[0];
  ok(v2.permit_id === 2 && JSON.stringify(v2.livePaths).includes('1#主电源'),
    '第 4 步解牌 K1: 受影响许可 #2 附真实带电路径');

  console.log('\n[F7] 确认失败: 状态机违规 / 隔离违规均 422 + 步骤序号, 整单回滚不落库');
  let auditsBefore = await auditCount();
  // 挂牌开关直接合闸
  r = await confirm([
    { action: 'end', permit_id: 2 },
    { action: 'close', node_id: K2 }
  ]);
  ok(r.status === 422 && r.data.step === 2 && r.data.error.code === 'SWITCH_TAGGED'
    && r.data.step_name === '合闸', '结束后对挂牌 K2 合闸 → 第 2 步 SWITCH_TAGGED');
  cur = await state();
  ok(cur.revision === rev && cur.permits.some((p) => p.id === 2)
    && cur.nodes.find((n) => n.id === K2).tagged === true,
    '回滚: 修订号不变、#2 仍有效、K2 仍挂牌');
  ok(await auditCount() === auditsBefore, '无审计落库');
  // 隔离违规(确认侧): 只结束 #2, 解 K1 会使仍有效的 #1 带电
  r = await confirm([
    { action: 'end', permit_id: 2 },
    { action: 'untag', node_id: K1 }
  ]);
  ok(r.status === 422 && r.data.step === 2 && r.data.error.code === 'ISOLATION_VIOLATION'
    && r.data.violations[0].permit_id === 1
    && r.data.violations[0].livePaths.length >= 1,
    '确认侧解牌破坏剩余许可 #1 → 422 + 真实带电路径');
  cur = await state();
  ok(cur.revision === rev && cur.permits.length === 2
    && cur.nodes.find((n) => n.id === K1).tagged === true,
    '回滚: #1/#2 均有效, K1 仍挂牌, 修订号不变');
  ok(await auditCount() === auditsBefore, '仍无审计落库');

  console.log('\n[F8] 确认成功: 结束两张许可 + K2/K1 解牌合闸, 原子落库, 修订号只 +1, 一条审计');
  const fullSteps = [
    { action: 'end', permit_id: 1 },
    { action: 'end', permit_id: 2 },
    { action: 'untag', node_id: K2 }, { action: 'close', node_id: K2 },
    { action: 'untag', node_id: K1 }, { action: 'close', node_id: K1 }
  ];
  auditsBefore = await auditCount();
  r = await confirm(fullSteps);
  ok(r.status === 200, 'HTTP 200 确认成功');
  ok(r.data.revision === rev + 1, `修订号仅 +1 (${rev} → ${r.data.revision})`);
  rev = r.data.revision;
  ok(r.data.ended_permit_ids.join() === '1,2', '返回已结束许可编号 [1,2]');
  ok(r.data.steps.length === 6 && r.data.steps[0].action === 'end'
    && r.data.steps[0].permit_id === 1 && r.data.steps[5].action === 'close',
    '返回有序紧凑步骤清单');
  ok(Array.isArray(r.data.step_results) && r.data.step_results.every((x) => x.ok),
    '确认响应同时含全部通过的逐步明细');
  cur = await state();
  ok(cur.permits.length === 0, '两张许可均已结束(移出有效列表)');
  ok(cur.nodes.filter((n) => n.kind === 'switch').every((n) => !n.tagged && !n.open_pos),
    'K1/K2 均解牌且合闸; K3 状态不受影响');
  const logs = await restoreAudits();
  ok(logs.length === 1 && (await auditCount()) === auditsBefore + 1, '整单仅一条 restoration.confirm 审计');
  const log = logs[0];
  ok(log.actor === OP.actor && log.role === 'operator'
    && log.rev_after === log.rev_before + 1
    && Array.isArray(log.detail.steps) && log.detail.steps.length === 6
    && log.detail.ended_permit_ids.join() === '1,2'
    && log.state_before && log.state_after,
    '审计含 actor/role/有序步骤/结束许可清单/前后修订号/前后完整快照');
  ok(log.state_before.permits.length === 2 && log.state_after.permits.length === 0
    && log.state_before.nodes.find((n) => n.id === K1).tagged === true
    && log.state_after.nodes.find((n) => n.id === K1).open_pos === false,
    '快照反映整单前后许可与开关状态');

  console.log('\n[F9] 已结束/不存在的许可在预演与确认中均明确拒绝');
  r = await preview([{ action: 'end', permit_id: 1 }]);
  ok(r.status === 422 && r.data.error.code === 'PERMIT_NOT_ACTIVE', '预演: 已结束许可 → 422');
  r = await confirm([{ action: 'end', permit_id: 2 }]);
  ok(r.status === 422 && r.data.error.code === 'PERMIT_NOT_ACTIVE', '确认: 已结束许可 → 422');

  console.log('\n[F10] STALE_REVISION: 过期修订号确认 → 409 + 当前完整状态');
  r = await confirm([{ action: 'untag', node_id: K2 }], 1);
  ok(r.status === 409 && r.data.error.code === 'STALE_REVISION', '409 STALE_REVISION');
  ok(r.data.current && r.data.current.revision === rev
    && Array.isArray(r.data.current.nodes) && Array.isArray(r.data.current.permits),
    '响应携带当前完整状态');

  console.log('\n[F11] 预演始终基于当前状态(忽略传入 revision), 返回当前修订号');
  r = await call('POST', '/api/restoration/preview', {
    ...OP, revision: 1, steps: [{ action: 'close', node_id: K1 }]
  });
  ok(r.status === 200 && r.data.revision === rev, '预演返回当前修订号(不校验传入值)');
  ok(r.data.success === false && r.data.steps[0].error.code === 'INVALID_STATE',
    '基于当前状态推演: K1 已在合闸位置 → 当步 INVALID_STATE');
  cur = await state();
  ok(cur.revision === rev, '修订号仍不变');

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
