'use strict';
// 单点挂牌失效风险报告端到端测试(HTTP)。
// 使用方式: LOTO_DB=/tmp/loto-tagrisk-e2e.db PORT=3106 node server.js 后
//           BASE=http://127.0.0.1:3106 node test/tagrisk.e2e.js
// 基于初始演示网络: S1(1)->K1(3)->K3(5)->D1(6); S2(2)->K2(4)->K3(5); K1(3)->D2(7)
const BASE = process.env.BASE || 'http://127.0.0.1:3106';

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

const OP = { actor: '风险操作员', role: 'operator' };
const S1 = 1, S2 = 2, K1 = 3, K2 = 4, K3 = 5, D1 = 6, D2 = 7;

(async () => {
  const rev0 = (await call('GET', '/api/state')).data.revision;
  console.log('初始修订号:', rev0);
  let rev = rev0;

  console.log('\n[T1] 无有效许可 -> 空报告(携带修订号)');
  let r = await call('POST', '/api/permits/tag-risk', {});
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.kind, 'permit.tagRisk', 'kind 正确');
  eq(r.data.revision, rev0, '携带当前修订号');
  eq(r.data.permit_ids.length, 0, '无所查许可');
  eq(r.data.switches.length, 0, '空报告: 不列出开关');
  eq(r.data.riskCount, 0, '无风险');

  console.log('\n[T2] 筛选参数校验: 空组/非数组/非正整数/重复/非有效编号 -> 拒绝');
  r = await call('POST', '/api/permits/tag-risk', { permit_ids: [] });
  eq(r.status, 400, '显式空组 -> 400');
  eq(r.data.error.code, 'PERMIT_IDS_REQUIRED', '错误码 PERMIT_IDS_REQUIRED');
  r = await call('POST', '/api/permits/tag-risk', { permit_ids: '1' });
  eq(r.status, 400, '非数组 -> 400');
  r = await call('POST', '/api/permits/tag-risk', { permit_ids: [0] });
  eq(r.status, 400, '0 -> 400');
  eq(r.data.error.code, 'INVALID_PERMIT_ID', '错误码 INVALID_PERMIT_ID');
  r = await call('POST', '/api/permits/tag-risk', { permit_ids: [-2] });
  eq(r.status, 400, '负数 -> 400');
  r = await call('POST', '/api/permits/tag-risk', { permit_ids: ['x'] });
  eq(r.status, 400, '非数字 -> 400');
  r = await call('POST', '/api/permits/tag-risk', { permit_ids: [1.5] });
  eq(r.status, 400, '非整数 -> 400');
  r = await call('POST', '/api/permits/tag-risk', { permit_ids: [1, 1] });
  eq(r.status, 400, '重复 -> 400');
  eq(r.data.error.code, 'PERMIT_IDS_DUPLICATE', '错误码 PERMIT_IDS_DUPLICATE');
  r = await call('POST', '/api/permits/tag-risk', { permit_ids: [999] });
  eq(r.status, 404, '非有效许可编号 -> 404');
  eq(r.data.error.code, 'PERMIT_NOT_FOUND', '错误码 PERMIT_NOT_FOUND');

  console.log('\n[T3] 准备: K1/K2 分闸挂牌, 申请 D1 许可');
  const auditBefore = (await call('GET', '/api/audit?limit=500')).data.logs.length;
  for (const k of [K1, K2]) {
    r = await call('POST', `/api/switches/${k}/open`, { ...OP, revision: rev });
    rev = r.data.revision;
    r = await call('POST', `/api/switches/${k}/tag`, { ...OP, revision: rev });
    rev = r.data.revision;
  }
  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D1 });
  eq(r.status, 200, 'D1 许可生效');
  rev = r.data.revision;
  const P1 = r.data.permit_id;

  console.log('\n[T4] 报告: K1/K2 各自失效都会让 D1 许可重新带电(单点风险)');
  r = await call('POST', '/api/permits/tag-risk', {});
  eq(r.status, 200, 'HTTP 200');
  eq(r.data.revision, rev, '报告携带当前修订号');
  eq(r.data.permit_ids.join(','), String(P1), '检查全部有效许可');
  eq(r.data.taggedSwitchCount, 2, '2 个已挂牌开关');
  eq(r.data.switches.map((s) => s.switch_id).join(','), `${K1},${K2}`, '按开关编号升序');
  eq(r.data.riskCount, 2, '2 项单点风险');
  const k1r = r.data.switches[0].risks[0];
  eq(k1r.permit_id, P1, 'K1 风险指向 D1 许可');
  eq(k1r.livePath.nodes.map((n) => n.id).join(','), `${S1},${K1},${K3},${D1}`,
    'K1 风险附真实带电路径 S1->K1->K3->D1');
  const k2r = r.data.switches[1].risks[0];
  eq(k2r.livePath.nodes.map((n) => n.id).join(','), `${S2},${K2},${K3},${D1}`,
    'K2 风险附真实带电路径 S2->K2->K3->D1');

  console.log('\n[T5] 报告为只读: 修订号/审计/开关/许可均不变');
  let cur = await call('GET', '/api/state');
  eq(cur.data.revision, rev, '报告不推进修订号');
  const auditNow = (await call('GET', '/api/audit?limit=500')).data.logs.length;
  eq(auditNow, auditBefore + 5, '报告不写审计(仅准备阶段 5 条写操作)');
  ok(cur.data.nodes.find((n) => n.id === K1).tagged
    && cur.data.nodes.find((n) => n.id === K2).tagged, 'K1/K2 仍挂牌');
  eq(cur.data.permits.length, 1, '许可仍有效');

  console.log('\n[T6] 筛选: 显式指定许可编号; 已结束许可编号 -> 404');
  r = await call('POST', '/api/permits/tag-risk', { permit_ids: [P1] });
  eq(r.status, 200, '筛选现有许可 -> 200');
  eq(r.data.riskCount, 2, '结果与全量一致');
  r = await call('POST', '/api/permits/tag-risk', { permit_ids: [P1, 999] });
  eq(r.status, 404, '混入无效编号 -> 404');

  console.log('\n[T7] 两张许可: 风险按许可编号排序; 筛选只看一张');
  r = await call('POST', '/api/permits', { ...OP, revision: rev, device_id: D2 });
  eq(r.status, 200, 'D2 许可生效(K1 挂牌保护)');
  rev = r.data.revision;
  const P2 = r.data.permit_id;
  r = await call('POST', '/api/permits/tag-risk', {});
  eq(r.data.riskCount, 3, 'K1 失效影响两张许可 + K2 失效影响 D1 = 3 项');
  const k1sw = r.data.switches.find((s) => s.switch_id === K1);
  eq(k1sw.risks.map((x) => x.permit_id).join(','), `${P1},${P2}`, 'K1 风险按许可编号升序');
  eq(k1sw.risks[1].livePath.nodes.map((n) => n.id).join(','), `${S1},${K1},${D2}`,
    'D2 许可的真实路径 S1->K1->D2');
  r = await call('POST', '/api/permits/tag-risk', { permit_ids: [P2] });
  eq(r.data.permit_ids.join(','), String(P2), '只检查 P2');
  eq(r.data.riskCount, 1, '仅 K1 对 P2 构成单点风险');
  const k2sw = r.data.switches.find((s) => s.switch_id === K2);
  eq(k2sw.risks.length, 0, 'K2 不影响所查许可, 仍列为无单点风险');

  console.log('\n[T8] K3 也挂牌后: 单个失效均被其余挂牌挡住(除 K1->D2 直达)');
  r = await call('POST', `/api/switches/${K3}/open`, { ...OP, revision: rev });
  rev = r.data.revision;
  r = await call('POST', `/api/switches/${K3}/tag`, { ...OP, revision: rev });
  rev = r.data.revision;
  r = await call('POST', '/api/permits/tag-risk', {});
  eq(r.data.taggedSwitchCount, 3, '3 个已挂牌开关');
  eq(r.data.switches.map((s) => s.switch_id).join(','), `${K1},${K2},${K3}`, '全部列出并按编号排序');
  const k1b = r.data.switches.find((s) => s.switch_id === K1);
  eq(k1b.risks.map((x) => x.permit_id).join(','), String(P2),
    'K1 失效: D1 被 K3 挡住, 仅 D2 许可仍带电');
  const k2b = r.data.switches.find((s) => s.switch_id === K2);
  eq(k2b.risks.length, 0, 'K2 失效: K3 仍阻断 -> 无单点风险');
  const k3b = r.data.switches.find((s) => s.switch_id === K3);
  eq(k3b.risks.length, 0, 'K3 失效: K1/K2 仍阻断 -> 无单点风险');
  eq(r.data.riskCount, 1, '全报告仅 1 项单点风险');

  console.log('\n[T9] 结束全部许可 -> 空报告');
  for (const p of [P1, P2]) {
    r = await call('POST', `/api/permits/${p}/end`, { ...OP, revision: rev });
    rev = r.data.revision;
  }
  r = await call('POST', '/api/permits/tag-risk', {});
  eq(r.data.switches.length, 0, '无有效许可 -> 空报告');
  eq(r.data.riskCount, 0, '无风险');
  r = await call('POST', '/api/permits/tag-risk', { permit_ids: [P1] });
  eq(r.status, 404, '已结束许可编号 -> 404(非有效许可)');

  console.log(`\n结果: ${pass} 项通过, ${fail} 项失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
