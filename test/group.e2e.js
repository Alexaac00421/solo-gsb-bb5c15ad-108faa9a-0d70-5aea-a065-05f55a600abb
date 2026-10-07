'use strict';
// 多设备协同隔离端到端测试。
// 使用方式: LOTO_DB=/tmp/loto-group-e2e.db PORT=3105 node server.js 后
//           BASE=http://127.0.0.1:3105 node test/group.e2e.js
const BASE = process.env.BASE || 'http://127.0.0.1:3105';

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

const OP = { actor: '协同操作员', role: 'operator' };
const ADMIN = { actor: '协同管理员', role: 'admin' };
const S1 = 1, S2 = 2, K1 = 3, K2 = 4, K3 = 5, D1 = 6, D2 = 7;

(async () => {
  const rev0 = (await call('GET', '/api/state')).data.revision;
  console.log('初始修订号:', rev0);

  console.log('\n[G1] 集合校验: 非空、编号有效、不能重复');
  let r = await call('POST', '/api/isolation-group/plan', { device_ids: [] });
  eq(r.status, 400, '空集合 -> 400');
  eq(r.data.error.code, 'DEVICE_IDS_REQUIRED', '错误码 DEVICE_IDS_REQUIRED');
  r = await call('POST', '/api/isolation-group/plan', { device_ids: [D1, D1] });
  eq(r.status, 400, '重复编号 -> 400');
  eq(r.data.error.code, 'DEVICE_IDS_DUPLICATE', '错误码 DEVICE_IDS_DUPLICATE');
  r = await call('POST', '/api/isolation-group/plan', { device_ids: [D1, 'x'] });
  eq(r.status, 400, '无效编号 -> 400');
  r = await call('POST', '/api/isolation-group/plan', { device_ids: [99999] });
  eq(r.status, 404, '不存在设备 -> 404');
  r = await call('POST', '/api/isolation-group/plan', { device_ids: [K3] });
  eq(r.status, 404, '开关编号作为设备 -> 404');

  console.log('\n[G2] 方案: D1/D2 共用 K1, 另需 K2; 返回共用开关、步骤与修订号');
  r = await call('POST', '/api/isolation-group/plan', { device_ids: [D2, D1] });
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.revision, rev0, '方案携带当前修订号');
  eq(r.data.newTagCount, 2, '新增挂牌 2 个');
  eq(r.data.sharedSwitchIds.join(','), String(K1), 'K1 为共用开关');
  eq(r.data.stepCount, 4, '分闸挂牌 4 步');
  eq(r.data.permitCount, 2, '整组 2 张许可');
  eq(r.data.confirmationStepCount, 6, '确认总步数 6');
  eq(r.data.withinOrderLimit, true, '未超 200 步上限');
  const switchIds = r.data.switches.map((s) => s.node_id).join(',');
  ok(switchIds === `${K1},${K2}`, `挂牌开关为 K1,K2（实际 ${switchIds}）`);

  console.log('\n[G3] 预演: 只读执行 4 个开关步骤与 2 个许可步, 不改变修订号/审计');
  r = await call('POST', '/api/isolation-group/preview', { ...OP, device_ids: [D1, D2] });
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.success, true, '预演成功');
  eq(r.data.steps.length, 6, '返回 6 步结果');
  ok(r.data.steps.slice(-2).every((s) => s.action === 'permit' && s.ok), '末两步两张许可均可生效');
  let cur = await call('GET', '/api/state');
  eq(cur.data.revision, rev0, '预演不推进修订号');
  eq(cur.data.permits.length, 0, '预演不创建许可');

  console.log('\n[G4] 角色: 预演/确认仅 operator');
  r = await call('POST', '/api/isolation-group/preview', { ...ADMIN, device_ids: [D1, D2] });
  eq(r.status, 403, '管理员预演 -> 403');
  r = await call('POST', '/api/isolation-group/confirm',
    { ...ADMIN, revision: rev0, device_ids: [D1, D2] });
  eq(r.status, 403, '管理员确认 -> 403');

  console.log('\n[G5] 一次确认: 整组成功仅 +1, 一条审计含完整前后状态与两张 permit_id');
  const auditBefore = (await call('GET', '/api/audit?limit=500')).data.logs.length;
  r = await call('POST', '/api/isolation-group/confirm',
    { ...OP, revision: rev0, device_ids: [D1, D2] });
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.revision, rev0 + 1, '修订号仅 +1');
  eq(r.data.steps.length, 6, '落库 6 步');
  eq(r.data.permit_ids.length, 2, '返回两张许可 id');
  cur = await call('GET', '/api/state');
  eq(cur.data.revision, rev0 + 1, '当前修订号已推进');
  eq(cur.data.permits.length, 2, '两台设备各有一张有效许可');
  ok([K1, K2].every((id) => {
    const n = cur.data.nodes.find((x) => x.id === id);
    return n.open_pos && n.tagged;
  }), 'K1/K2 均已分闸并挂牌');
  const logs = (await call('GET', '/api/audit?limit=500')).data.logs;
  eq(logs.length, auditBefore + 1, '仅新增一条审计');
  const log = logs[0];
  eq(log.action, 'isolationGroup.confirm', '审计动作正确');
  eq(log.detail.step_count, 6, '审计记录总步数');
  ok(log.state_before && log.state_after &&
    log.state_before.revision === rev0 && log.state_after.revision === rev0 + 1,
    '审计含前后完整状态及修订号');

  console.log('\n[G6] 已有有效许可: 方案仍可完整展示, 但整组确认拒绝且不重复许可');
  r = await call('POST', '/api/isolation-group/plan', { device_ids: [D1, D2] });
  eq(r.data.isolated, true, '两目标当前均已隔离');
  eq(r.data.steps.length, 0, '已隔离目标不增加开关步骤');
  eq(r.data.permitConflicts.length, 2, '指出两张已有许可冲突');
  r = await call('POST', '/api/isolation-group/confirm',
    { ...OP, revision: rev0 + 1, device_ids: [D1, D2] });
  eq(r.status, 422, '重复许可确认 -> 422');
  eq(r.data.error.code, 'PERMIT_EXISTS', '错误码 PERMIT_EXISTS');
  cur = await call('GET', '/api/state');
  eq(cur.data.permits.length, 2, '未新增重复许可');

  console.log('\n[G7] 任一目标存在无开关带电通路: 整组不可行并返回设备及真实路径');
  // 新建 S2 -> 新设备直达旁路; 新设备带电且无法用开关切断。
  r = await call('POST', '/api/admin/nodes',
    { ...ADMIN, revision: rev0 + 1, kind: 'device', name: '协同旁路设备' });
  const revAfterAdd = r.data.revision;
  const bypassDevice = r.data.snapshot.nodes.find((n) => n.name === '协同旁路设备').id;
  r = await call('POST', '/api/admin/edges',
    { ...ADMIN, revision: revAfterAdd, from_node: S2, to_node: bypassDevice });
  eq(r.status, 200, '准备: 新增无开关旁路');
  r = await call('POST', '/api/isolation-group/plan', { device_ids: [D1, bypassDevice] });
  eq(r.status, 422, '不可行 -> 422');
  eq(r.data.error.code, 'ISOLATION_INFEASIBLE', '错误码 ISOLATION_INFEASIBLE');
  eq(r.data.infeasibleDeviceIds.join(','), String(bypassDevice), '指出不可行设备');
  ok(r.data.livePath && r.data.livePath.nodes[0].id === S2
    && r.data.livePath.nodes.at(-1).id === bypassDevice
    && r.data.livePath.nodes.every((n) => n.kind !== 'switch'),
    '返回从 S2 到目标、不经过开关的真实路径');

  console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
