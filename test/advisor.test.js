'use strict';

// src/advisor.js 的隔离建议单元测试(不走 HTTP / 数据库)。
// 重点: 最小新增挂牌点割、不依赖诊断枚举的数量/长度上限、不可行见证路径、
// 已挂牌屏障零成本、先分闸再挂牌步骤、步数上限不截断。
// 运行: node test/advisor.test.js

const assert = require('assert');
const { planIsolation, planGroupIsolation } = require('../src/advisor');

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

// 与 graph.test.js 同构的内存图构造。
// nodes: [[id, kind, {enabled?, open_pos?, tagged?}], ...]
// edges: [[id, from, to], ...]
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

console.log('\n[A1] 演示网络: 双电源在 K3 汇合 -> 割 K3, 1 个新增挂牌、2 步');
{
  // S1->K1->K3->D1, S2->K2->K3->D1, K1->D2
  const g = buildGraph(
    [[1, 'source'], [2, 'source'], [3, 'switch'], [4, 'switch'],
     [5, 'switch'], [6, 'device'], [7, 'device']],
    [[1, 1, 3], [2, 2, 4], [3, 3, 5], [4, 4, 5], [5, 5, 6], [6, 3, 7]]
  );
  const r = planIsolation(g, 6);
  eq(r.feasible, true, '可行');
  eq(r.isolated, false, '当前带电');
  eq(r.newTagCount, 1, '最少只需 1 个新增挂牌(联络开关)');
  eq(r.switches[0].node_id, 5, '选中的是 K3(id=5), 优于分别挂 K1/K2');
  eq(JSON.stringify(r.steps), JSON.stringify([
    { action: 'open', node_id: 5 }, { action: 'tag', node_id: 5 }
  ]), '步骤为先分闸再挂牌');
  eq(r.withinOrderLimit, true, '未超步数上限');

  const r2 = planIsolation(g, 7); // K1->D2 单路, 割 K1
  eq(r2.switches[0].node_id, 3, 'D2 割 K1');
}

console.log('\n[A2] 已隔离 -> 空步骤');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch', { tagged: true }], [3, 'device']],
    [[1, 1, 2], [2, 2, 3]]
  );
  const r = planIsolation(g, 3);
  eq(r.feasible, true, '可行');
  eq(r.isolated, true, '已隔离');
  eq(r.steps.length, 0, '空步骤');
  eq(r.newTagCount, 0, '无需新增挂牌');
}

console.log('\n[A3] 无启用电源 -> 已隔离, 空步骤');
{
  const g = buildGraph(
    [[1, 'source', { enabled: false }], [2, 'switch'], [3, 'device']],
    [[1, 1, 2], [2, 2, 3]]
  );
  const r = planIsolation(g, 3);
  eq(r.isolated, true, '无启用电源视为已隔离');
  eq(r.stepCount, 0, '空步骤');
}

console.log('\n[A4] 电源直连设备(无开关) -> 不可行, 见证路径为真实无开关通路');
{
  const g = buildGraph([[1, 'source'], [3, 'device']], [[1, 1, 3]]);
  const r = planIsolation(g, 3);
  eq(r.feasible, false, '判定不可行');
  ok(r.livePath, '返回一条真实带电路径');
  eq(r.livePath.nodes.join(','), '1,3', '见证路径直达设备');
  ok(r.livePath.nodes.every((id) => g.nodeById.get(id).kind !== 'switch'),
    '见证路径不经过任何开关');
}

console.log('\n[A5] 存在开关通路, 但另有一条无开关旁路 -> 不可行, 见证走旁路');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch'], [3, 'device']],
    [[1, 1, 2], [2, 2, 3], [3, 1, 3]]
  );
  const r = planIsolation(g, 3);
  eq(r.feasible, false, '旁路不可被挂牌切断 -> 不可行');
  eq(r.livePath.nodes.join(','), '1,3', '见证为旁路 1->3');
}

console.log('\n[A6] 两条并联开关支路 -> 需 2 个新增挂牌, 共 4 步');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch'], [3, 'switch'], [4, 'device']],
    [[1, 1, 2], [2, 1, 3], [3, 2, 4], [4, 3, 4]]
  );
  const r = planIsolation(g, 4);
  eq(r.newTagCount, 2, '两条独立路径各需 1 个');
  eq(r.stepCount, 4, '每个开关 open+tag 共 4 步');
  eq(r.steps[0].action, 'open', '第 1 步分闸');
  eq(r.steps[1].action, 'tag', '第 2 步挂牌');
}

console.log('\n[A7] 已分闸开关只需挂牌; 已挂牌开关为零成本屏障不计入');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'source'], [3, 'switch', { tagged: true }],
     [4, 'switch', { open_pos: true }], [5, 'device']],
    [[1, 1, 3], [2, 2, 4], [3, 3, 5], [4, 4, 5]]
  );
  const r = planIsolation(g, 5);
  eq(r.newTagCount, 1, '仅 K2 需新增挂牌(K1 已是屏障)');
  eq(r.switches[0].node_id, 4, '选中 K2');
  eq(JSON.stringify(r.steps), JSON.stringify([{ action: 'tag', node_id: 4 }]),
    'K2 已分闸 -> 只有挂牌一步');
}

console.log('\n[A8] 含环图: S->K1<->K2, K1->D -> 割 K1 即可');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch'], [3, 'switch'], [4, 'device']],
    [[1, 1, 2], [2, 2, 3], [3, 3, 2], [4, 2, 4]]
  );
  const r = planIsolation(g, 4);
  eq(r.feasible, true, '环图可行');
  eq(r.newTagCount, 1, '环不增加割价');
  eq(r.switches[0].node_id, 2, '割 K1');
}

console.log('\n[A9] 停用电源不产生约束(其通路上的开关无需挂牌)');
{
  const g = buildGraph(
    [[1, 'source', { enabled: false }], [2, 'source'],
     [3, 'switch'], [4, 'switch'], [5, 'device']],
    [[1, 1, 3], [2, 2, 4], [3, 3, 5], [4, 4, 5]]
  );
  const r = planIsolation(g, 5);
  eq(r.newTagCount, 1, '只割启用电源路径上的 K2');
  eq(r.switches[0].node_id, 4, '选中 K2');
}

console.log('\n[A10] 超长链(>64 节点诊断上限)仍给出最优解, 不依赖枚举上限');
{
  const MIDDLE = 80;
  const nodeSpecs = [[1, 'source'], [1000, 'device']];
  for (let i = 0; i < MIDDLE; i++) nodeSpecs.push([100 + i, 'switch']);
  const edgeSpecs = [[1, 1, 100]];
  for (let i = 0; i < MIDDLE - 1; i++) edgeSpecs.push([i + 2, 100 + i, 100 + i + 1]);
  edgeSpecs.push([MIDDLE + 1, 100 + MIDDLE - 1, 1000]);
  const g = buildGraph(nodeSpecs, edgeSpecs);
  const r = planIsolation(g, 1000);
  eq(r.feasible, true, '超长链可行');
  eq(r.newTagCount, 1, '链上任一开关即可');
  eq(r.stepCount, 2, 'open+tag');
}

console.log('\n[A11] 201 条并联支路: 需 201 个挂牌、402 步 -> 超出 200 步上限, 步骤不截断');
{
  const nodeSpecs = [[1, 'source'], [500, 'device']];
  const edgeSpecs = [];
  let eid = 1;
  for (let i = 0; i < 201; i++) {
    const sw = 100 + i;
    nodeSpecs.push([sw, 'switch']);
    edgeSpecs.push([eid++, 1, sw]);
    edgeSpecs.push([eid++, sw, 500]);
  }
  const g = buildGraph(nodeSpecs, edgeSpecs);
  const r = planIsolation(g, 500);
  eq(r.newTagCount, 201, '每条支路一个开关');
  eq(r.stepCount, 402, '共 402 步');
  eq(r.steps.length, 402, '步骤全量返回, 未截断');
  eq(r.withinOrderLimit, false, '明确标记超出操作单步数上限');
  eq(r.orderMaxSteps, 200, '携带上限值');
}

console.log('\n[A12] 结果确定性: 同图重复计算给出同一组开关');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch'], [3, 'switch'], [4, 'switch'], [5, 'device']],
    [[1, 1, 2], [2, 1, 3], [3, 2, 4], [4, 3, 4], [5, 4, 5]]
  );
  const ids = [planIsolation(g, 5).switches.map((s) => s.node_id).join(',')];
  for (let i = 0; i < 5; i++) {
    ids.push(planIsolation(g, 5).switches.map((s) => s.node_id).join(','));
  }
  ok(ids.every((x) => x === ids[0]), '多次计算结果一致');
}

console.log('\n[A13] 自定义步数上限: 101 个挂牌(202 步)对上限 500 仍在限内');
{
  const nodeSpecs = [[1, 'source'], [500, 'device']];
  const edgeSpecs = [];
  let eid = 1;
  for (let i = 0; i < 101; i++) {
    const sw = 100 + i;
    nodeSpecs.push([sw, 'switch']);
    edgeSpecs.push([eid++, 1, sw]);
    edgeSpecs.push([eid++, sw, 500]);
  }
  const g = buildGraph(nodeSpecs, edgeSpecs);
  const r = planIsolation(g, 500, 500);
  eq(r.withinOrderLimit, true, '上限 500 时 202 步可整单执行');
  eq(r.orderMaxSteps, 500, '上限透传');
}

console.log('\n[A14] 多设备协同: 共用联络开关一次挂牌即可保护两台设备');
{
  // S1->K1->K3->D1, S2->K2->K3->D1, K1->D2; K3 对两台目标共用
  const g = buildGraph(
    [[1, 'source'], [2, 'source'], [3, 'switch'], [4, 'switch'],
     [5, 'switch'], [6, 'device'], [7, 'device']],
    [[1, 1, 3], [2, 2, 4], [3, 3, 5], [4, 4, 5], [5, 5, 6], [6, 3, 7]]
  );
  const r = planGroupIsolation(g, [6, 7]);
  eq(r.feasible, true, '协同方案可行');
  eq(r.newTagCount, 2, '最少新增两个开关(K1 共用 + K2)');
  ok(r.sharedSwitchIds.includes(3), 'K1 是共用开关');
  eq(r.stepCount, 4, '分闸挂牌共 4 步');
  eq(r.permitCount, 2, '整组 2 张许可');
  eq(r.confirmationStepCount, 6, '确认总步数含 2 张许可');
  const k1 = r.switches.find((s) => s.node_id === 3);
  ok(k1.shared && k1.protectedDeviceIds.join(',') === '6,7', 'K1 保护 D1、D2');

  const commonGraph = buildGraph(
    [[1, 'source'], [2, 'switch'], [3, 'device'], [4, 'device']],
    [[1, 1, 2], [2, 2, 3], [3, 2, 4]]
  );
  const common = planGroupIsolation(commonGraph, [3, 4]);
  eq(common.newTagCount, 1, '两台下游设备共用一个上游开关');
  eq(common.sharedSwitchIds.join(','), '2', '共用开关为 K2');
}

console.log('\n[A15] 多设备协同: 已隔离目标不增加开关步骤, 仍占许可步');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch', { tagged: true }], [3, 'device'], [4, 'device']],
    [[1, 1, 2], [2, 2, 3]]
  );
  const r = planGroupIsolation(g, [3, 4]);
  eq(r.isolated, true, '两台目标均已隔离');
  eq(r.stepCount, 0, '无新增开关步骤');
  eq(r.permitCount, 2, '仍有两张许可步');
  eq(r.confirmationStepCount, 2, '确认总步数只含许可步');
}

console.log('\n[A16] 多设备协同: 无开关旁路影响任一目标即整组不可行');
{
  const g = buildGraph(
    [[1, 'source'], [2, 'switch'], [3, 'device'], [4, 'device']],
    [[1, 1, 2], [2, 2, 3], [3, 1, 4]]
  );
  const r = planGroupIsolation(g, [3, 4]);
  eq(r.feasible, false, 'D4 无开关直连 -> 整组不可行');
  eq(r.infeasibleDeviceIds.join(','), '4', '指出不可行设备 D4');
  eq(r.infeasibleDevices[0].livePath.nodes.join(','), '1,4', '指出真实无开关通路');
}

console.log(`\n结果: ${pass} 项断言全部通过`);
