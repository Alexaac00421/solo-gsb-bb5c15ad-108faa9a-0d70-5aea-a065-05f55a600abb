'use strict';

// src/tagrisk.js 单点挂牌失效风险分析单元测试(不走 HTTP)。
// 运行: node test/tagrisk.test.js

const assert = require('assert');
const { singlePointTagRisk } = require('../src/tagrisk');
const { MAX_PATH_LEN } = require('../src/graph');

let pass = 0;
function ok(cond, msg) {
  assert.ok(cond, msg);
  pass++;
  console.log('  ✔', msg);
}
function eq(a, b, msg) {
  assert.strictEqual(a, b, `${msg} (期望 ${b}, 实际 ${a})`);
  pass++;
  console.log('  ✔', msg);
}

// 与 test/graph.test.js 相同的图构造方式
function buildGraph(nodeSpecs, edgeSpecs) {
  const nodes = nodeSpecs.map(([id, kind, extra = {}]) => ({
    id, kind, name: `N${id}`,
    enabled: extra.enabled !== undefined ? !!extra.enabled : true,
    open_pos: !!extra.open_pos,
    tagged: !!extra.tagged
  }));
  const edges = edgeSpecs.map(([id, from, to]) => ({
    id, from, to, from_node: from, to_node: to
  }));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const outAdj = new Map();
  for (const e of edges) {
    if (!outAdj.has(e.from_node)) outAdj.set(e.from_node, []);
    outAdj.get(e.from_node).push(e);
  }
  return { nodes, edges, nodeById, outAdj };
}

const permit = (id, deviceId) => ({ id, device_id: deviceId, device_name: `N${deviceId}` });

console.log('\n[R1] 双电源各经一个挂牌开关: 每个挂牌开关都是该许可的单点风险');
{
  // S1(1)->K1(3)->D(6); S2(2)->K2(4)->D(6); K1,K2 已挂牌
  const g = buildGraph(
    [[1, 'source'], [2, 'source'],
     [3, 'switch', { tagged: true, open_pos: true }],
     [4, 'switch', { tagged: true, open_pos: true }],
     [6, 'device']],
    [[1, 1, 3], [2, 3, 6], [3, 2, 4], [4, 4, 6]]
  );
  const r = singlePointTagRisk(g, [permit(10, 6)]);
  eq(r.switches.length, 2, '两个已挂牌开关都列出');
  eq(r.switches[0].switch_id, 3, '按开关编号升序: K1 在前');
  eq(r.switches[1].switch_id, 4, 'K2 在后');
  eq(r.switches[0].risks.length, 1, 'K1 失效 -> 许可出现未切断通路');
  eq(r.switches[1].risks.length, 1, 'K2 失效 -> 许可出现未切断通路');
  eq(r.switches[0].risks[0].permit_id, 10, '风险携带许可编号');
  eq(r.switches[0].risks[0].livePath.nodes.join(','), '1,3,6', 'K1 风险附真实带电路径 S1->K1->D');
  eq(r.switches[1].risks[0].livePath.nodes.join(','), '2,4,6', 'K2 风险附真实带电路径 S2->K2->D');
}

console.log('\n[R2] 许可由两个串联挂牌点保护: 单个失效均被其余挂牌挡住 -> 无单点风险');
{
  // S1(1)->K1(3)->K3(5)->D(6); S2(2)->K2(4)->K3(5); K1,K2,K3 全挂牌
  const g = buildGraph(
    [[1, 'source'], [2, 'source'],
     [3, 'switch', { tagged: true }], [4, 'switch', { tagged: true }],
     [5, 'switch', { tagged: true }], [6, 'device']],
    [[1, 1, 3], [2, 3, 5], [3, 2, 4], [4, 4, 5], [5, 5, 6]]
  );
  const r = singlePointTagRisk(g, [permit(10, 6)]);
  eq(r.switches.length, 3, '三个已挂牌开关都列出');
  ok(r.switches.every((s) => s.risks.length === 0), '全部列为无单点风险(其余挂牌仍阻断)');
}

console.log('\n[R3] 未挂牌开关不出现在报告中; 停用电源方向不产生风险');
{
  // S1 停用, S2->K2(挂牌)->D; K1 未挂牌
  const g = buildGraph(
    [[1, 'source', { enabled: false }], [2, 'source'],
     [3, 'switch'], [4, 'switch', { tagged: true }], [6, 'device']],
    [[1, 1, 3], [2, 3, 6], [3, 2, 4], [4, 4, 6]]
  );
  const r = singlePointTagRisk(g, [permit(10, 6)]);
  eq(r.switches.length, 1, '只有已挂牌的 K2 列出');
  eq(r.switches[0].switch_id, 4, '未挂牌的 K1 不在报告中');
  eq(r.switches[0].risks.length, 1, 'K2 失效 -> S2 通路带电');
  eq(r.switches[0].risks[0].livePath.nodes[0], 2, '路径来自启用电源 S2');
}

console.log('\n[R4] 多张许可: 风险按许可编号稳定排序; 开关按编号稳定排序');
{
  // S1->K1(挂牌)->D1; S1->K1->D2 (K1 同时保护两张许可); S2->K2(挂牌)->D2
  const g = buildGraph(
    [[1, 'source'], [2, 'source'],
     [3, 'switch', { tagged: true }], [4, 'switch', { tagged: true }],
     [6, 'device'], [7, 'device']],
    [[1, 1, 3], [2, 3, 6], [3, 3, 7], [4, 2, 4], [5, 4, 7]]
  );
  // 故意乱序传入, 输出仍须按许可编号升序
  const r = singlePointTagRisk(g, [permit(12, 7), permit(9, 6)]);
  eq(r.switches.length, 2, 'K1/K2 都列出');
  const k1 = r.switches[0];
  eq(k1.switch_id, 3, 'K1 在前');
  eq(k1.risks.length, 2, 'K1 失效 -> 两张许可都失去隔离');
  eq(k1.risks[0].permit_id, 9, '风险按许可编号升序(9 在前)');
  eq(k1.risks[1].permit_id, 12, '许可 12 在后');
  eq(k1.risks[0].livePath.nodes.join(','), '1,3,6', '许可 9 的真实路径');
  eq(k1.risks[1].livePath.nodes.join(','), '1,3,7', '许可 12 的真实路径');
  const k2 = r.switches[1];
  eq(k2.risks.length, 1, 'K2 失效 -> 仅许可 12 受影响');
  eq(k2.risks[0].permit_id, 12, '受影响许可正确');
  eq(k2.risks[0].livePath.nodes.join(','), '2,4,7', 'K2 风险路径来自 S2');
}

console.log('\n[R5] 无所查许可 -> 空报告');
{
  const g = buildGraph(
    [[1, 'source'], [3, 'switch', { tagged: true }], [6, 'device']],
    [[1, 1, 3], [2, 3, 6]]
  );
  const r = singlePointTagRisk(g, []);
  eq(r.switches.length, 0, '空报告: 不列出任何开关');
}

console.log('\n[R6] 不依赖诊断展示上限: 超过 64 节点的长链仍给出真实见证路径');
{
  // 电源 -> 64 个未挂牌开关 -> 挂牌开关 -> 设备; 挂牌失效后链路 66+ 节点带电
  const MIDDLE = MAX_PATH_LEN; // 64
  const nodeSpecs = [[1, 'source']];
  for (let i = 0; i < MIDDLE; i++) nodeSpecs.push([100 + i, 'switch']);
  nodeSpecs.push([900, 'switch', { tagged: true }], [1000, 'device']);
  const edgeSpecs = [[1, 1, 100]];
  for (let i = 0; i < MIDDLE - 1; i++) edgeSpecs.push([i + 2, 100 + i, 100 + i + 1]);
  edgeSpecs.push([MIDDLE + 1, 100 + MIDDLE - 1, 900]);
  edgeSpecs.push([MIDDLE + 2, 900, 1000]);
  const g = buildGraph(nodeSpecs, edgeSpecs);

  const r = singlePointTagRisk(g, [permit(10, 1000)]);
  eq(r.switches.length, 1, '只有末端挂牌开关列出');
  eq(r.switches[0].switch_id, 900, '挂牌开关编号正确');
  eq(r.switches[0].risks.length, 1, '失效后长链带电(完整可达性, 不受 64 节点展示上限影响)');
  eq(r.switches[0].risks[0].livePath.nodes.length, MIDDLE + 3,
    '见证路径完整(67 节点, 可超过展示长度上限)');
  eq(r.switches[0].risks[0].livePath.nodes.at(-1), 1000, '路径真实到达设备');
}

console.log('\n[R7] 分析为纯只读: 输入图与许可不被修改');
{
  const g = buildGraph(
    [[1, 'source'], [3, 'switch', { tagged: true }], [6, 'device']],
    [[1, 1, 3], [2, 3, 6]]
  );
  const before = JSON.stringify(g.nodes);
  singlePointTagRisk(g, [permit(10, 6)]);
  eq(JSON.stringify(g.nodes), before, '图节点状态未被改动(假设失效只发生在内存克隆上)');
}

console.log(`\n结果: ${pass} 项断言全部通过`);
