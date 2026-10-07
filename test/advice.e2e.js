'use strict';
// 隔离建议端到端测试(HTTP)。
// 使用方式: LOTO_DB=/tmp/loto-advice-test.db PORT=3101 node server.js 后
//           BASE=http://127.0.0.1:3101 node test/advice.e2e.js
// 基于初始演示网络: S1(1)->K1(3)->K3(5)->D1(6); S2(2)->K2(4)->K3(5); K1(3)->D2(7)
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

const OP = { actor: '建议操作员', role: 'operator' };
const ADMIN = { actor: '建议管理员', role: 'admin' };
const S1 = 1, S2 = 2, K1 = 3, K2 = 4, K3 = 5, D1 = 6, D2 = 7;

(async () => {
  let { data: s } = await call('GET', '/api/state');
  const rev0 = s.revision;
  console.log('初始修订号:', rev0);
  let rev = rev0;

  console.log('\n[V1] D1 建议: 双电源经 K3 汇合 -> 最少 1 个新增挂牌(K3), open+tag');
  let r = await call('GET', `/api/devices/${D1}/isolation-advice`);
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.revision, rev0, '携带当前修订号');
  eq(r.data.feasible, true, '可行');
  eq(r.data.isolated, false, '当前带电');
  eq(r.data.newTagCount, 1, '只需新增 1 个挂牌');
  eq(r.data.switches[0].node_id, K3, '选中联络开关 K3(优于 K1+K2)');
  eq(JSON.stringify(r.data.steps),
    JSON.stringify([{ action: 'open', node_id: K3 }, { action: 'tag', node_id: K3 }]),
    '步骤为先分闸 K3 再挂牌 K3');
  eq(r.data.withinOrderLimit, true, '在操作单步数上限内');
  const adviceSteps = r.data.steps;

  console.log('\n[V2] D2 建议: 单路 K1 -> 割 K1');
  r = await call('GET', `/api/devices/${D2}/isolation-advice`);
  eq(r.data.switches[0].node_id, K1, '选中 K1');
  eq(r.data.stepCount, 2, '2 步');

  console.log('\n[V3] 参数错误: 不存在 / 非设备节点 -> 404');
  r = await call('GET', '/api/devices/9999/isolation-advice');
  eq(r.status, 404, '不存在 -> 404');
  eq(r.data.error.code, 'NOT_FOUND', '错误码 NOT_FOUND');
  r = await call('GET', `/api/devices/${K1}/isolation-advice`);
  eq(r.status, 404, '开关 id -> 404');

  console.log('\n[V4] 建议为只读: 修订号与审计不变');
  let cur = await call('GET', '/api/state');
  eq(cur.data.revision, rev0, '建议不递增修订号');
  let logs = await call('GET', '/api/audit?limit=500');
  eq(logs.data.logs.length, 0, '建议不写审计');

  console.log('\n[V5] 建议步骤带入预演: 成功且不落库');
  r = await call('POST', '/api/orders/preview', { ...OP, revision: rev, steps: adviceSteps });
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.success, true, '预演通过');
  eq(r.data.steps.length, 2, '2 个步骤结果');
  eq(r.data.steps[0].after.open_pos, true, '第1步后 K3 分闸');
  eq(r.data.steps[1].after.tagged, true, '第2步后 K3 挂牌');
  cur = await call('GET', '/api/state');
  eq(cur.data.revision, rev0, '预演后修订号仍不变');

  console.log('\n[V6] 建议步骤确认执行: 必须使用建议 revision, 成功整单 +1');
  r = await call('POST', '/api/orders/confirm', { ...OP, revision: rev0, steps: adviceSteps });
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.revision, rev0 + 1, '修订号 +1');
  eq(r.data.steps.length, 2, '返回 2 步紧凑记录');
  rev = r.data.revision;

  console.log('\n[V7] 隔离已生效: 再取建议 -> feasible + isolated + 空步骤');
  r = await call('GET', `/api/devices/${D1}/isolation-advice`);
  eq(r.data.feasible, true, '可行');
  eq(r.data.isolated, true, '已隔离');
  eq(r.data.steps.length, 0, '空步骤');
  eq(r.data.newTagCount, 0, '无需新增挂牌');

  console.log('\n[V8] 基于旧建议修订号确认 -> 409 STALE_REVISION + 当前完整状态');
  // 旧建议基于 rev0; 当前已是 rev, 用 rev0 再确认一张单子
  r = await call('POST', '/api/orders/confirm', {
    ...OP, revision: rev0,
    steps: [{ action: 'open', node_id: K1 }, { action: 'tag', node_id: K1 }]
  });
  eq(r.status, 409, 'HTTP 409');
  eq(r.data.error.code, 'STALE_REVISION', 'STALE_REVISION');
  ok(!!r.data.current && r.data.current.revision === rev, '响应携带当前完整状态');

  console.log('\n[V9] 审计只有一条 order.confirm(建议与预演均不落审计)');
  logs = await call('GET', '/api/audit?limit=500');
  eq(logs.data.logs.length, 1, '仅 1 条审计');
  eq(logs.data.logs[0].action, 'order.confirm', '为整单确认记录');
  eq(logs.data.logs[0].rev_before, rev0, 'rev_before 正确');
  eq(logs.data.logs[0].rev_after, rev0 + 1, 'rev_after 正确');

  console.log('\n[V10] 无开关旁路 -> 不可行, 返回一条真实无开关带电路径');
  // 管理员新增: 电源 S1 -> 设备 D2 的直接接线(绕过全部开关)
  r = await call('POST', '/api/admin/edges', { ...ADMIN, revision: rev, from_node: S1, to_node: D2 });
  eq(r.status, 200, '准备: 旁路接线成功');
  rev = r.data.revision;
  r = await call('GET', `/api/devices/${D2}/isolation-advice`);
  eq(r.status, 422, 'HTTP 422');
  eq(r.data.error.code, 'ISOLATION_INFEASIBLE', '错误码 ISOLATION_INFEASIBLE');
  eq(r.data.feasible, false, 'feasible=false');
  ok(!!r.data.livePath, '返回 livePath');
  eq(r.data.livePath.nodes[0].id, S1, '见证路径起于启用电源');
  eq(r.data.livePath.nodes[r.data.livePath.nodes.length - 1].id, D2, '见证路径到达设备');
  ok(r.data.livePath.nodes.every((n) => n.kind !== 'switch'), '见证路径不经过任何开关');
  eq(r.data.livePath.nodes.map((n) => n.id).join(','), `${S1},${D2}`, '即旁路 S1->D2');

  console.log('\n[V11] 拆除旁路后建议恢复可行(割 K1)');
  const stateNow = (await call('GET', '/api/state')).data;
  const bypassEdge = stateNow.edges.find((e) => e.from_node === S1 && e.to_node === D2);
  r = await call('DELETE', `/api/admin/edges/${bypassEdge.id}`, { ...ADMIN, revision: rev });
  eq(r.status, 200, '拆除旁路成功');
  rev = r.data.revision;
  r = await call('GET', `/api/devices/${D2}/isolation-advice`);
  eq(r.status, 200, '恢复 HTTP 200');
  eq(r.data.feasible, true, '恢复可行');
  // K3 已挂牌会切断 S1->K1->K3 段, 但 D2 由 K1 直接供电, 故仍需割 K1
  eq(r.data.switches[0].node_id, K1, '选中 K1');

  console.log('\n[V12] 停用全部相关电源 -> 设备视为已隔离, 空步骤');
  r = await call('PATCH', `/api/admin/nodes/${S1}`, { ...ADMIN, revision: rev, enabled: false });
  rev = r.data.revision;
  r = await call('PATCH', `/api/admin/nodes/${S2}`, { ...ADMIN, revision: rev, enabled: false });
  rev = r.data.revision;
  r = await call('GET', `/api/devices/${D2}/isolation-advice`);
  eq(r.data.isolated, true, '无启用电源 -> 已隔离');
  eq(r.data.steps.length, 0, '空步骤');

  console.log('\n[V13] 超步数上限: 201 条并联开关支路(402 步) -> 不可整单执行, 步骤不截断');
  // 重新启用电源, 新建独立大电源 -> 201 个开关 -> 新设备
  r = await call('PATCH', `/api/admin/nodes/${S1}`, { ...ADMIN, revision: rev, enabled: true });
  rev = r.data.revision;
  r = await call('POST', '/api/admin/nodes', { ...ADMIN, revision: rev, kind: 'source', name: '建议测试大电源' });
  rev = r.data.revision;
  const bigSrc = r.data.snapshot.nodes.find((n) => n.name === '建议测试大电源').id;
  r = await call('POST', '/api/admin/nodes', { ...ADMIN, revision: rev, kind: 'device', name: '建议测试大负载' });
  rev = r.data.revision;
  const bigDev = r.data.snapshot.nodes.find((n) => n.name === '建议测试大负载').id;
  for (let i = 0; i < 201; i++) {
    r = await call('POST', '/api/admin/nodes',
      { ...ADMIN, revision: rev, kind: 'switch', name: `建议测试SW${i}` });
    rev = r.data.revision;
    const sw = r.data.snapshot.nodes.find((n) => n.name === `建议测试SW${i}`).id;
    r = await call('POST', '/api/admin/edges', { ...ADMIN, revision: rev, from_node: bigSrc, to_node: sw });
    rev = r.data.revision;
    r = await call('POST', '/api/admin/edges', { ...ADMIN, revision: rev, from_node: sw, to_node: bigDev });
    rev = r.data.revision;
  }
  r = await call('GET', `/api/devices/${bigDev}/isolation-advice`);
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.feasible, true, '方案本身可行');
  eq(r.data.newTagCount, 201, '需新增挂牌 201 个');
  eq(r.data.stepCount, 402, '共 402 步');
  eq(r.data.steps.length, 402, '步骤全量返回, 不截断');
  eq(r.data.withinOrderLimit, false, '明确超出 200 步上限, 不可整单执行');
  // 不截断、不部分执行: 直接确认 402 步 -> 400 STEPS_TOO_LONG, 修订号不变、不落审计
  const auditBefore = (await call('GET', '/api/audit?limit=500')).data.logs.length;
  const over = await call('POST', '/api/orders/confirm',
    { ...OP, revision: rev, steps: r.data.steps });
  eq(over.status, 400, '超限整单确认 -> 400');
  eq(over.data.error.code, 'STEPS_TOO_LONG', '错误码 STEPS_TOO_LONG');
  cur = await call('GET', '/api/state');
  eq(cur.data.revision, rev, '修订号不变');
  const auditAfter = (await call('GET', '/api/audit?limit=500')).data.logs.length;
  eq(auditAfter, auditBefore, '超限不落审计');

  console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
