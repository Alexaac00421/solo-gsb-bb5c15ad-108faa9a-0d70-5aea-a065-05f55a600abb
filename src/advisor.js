'use strict';

// 隔离建议（最小新增挂牌点割）。
//
// 操作员选择设备后, 基于当前修订号的完整供电图给出“使设备断电所需新增挂牌
// 开关数最少”的一组开关。判定与既有隔离判定一致:
//   - 从所有 enabled=1 的启用电源出发, 在有向供电图上分析;
//   - 已挂牌开关视为不可穿过的屏障(成本 0, 无需新增挂牌);
//   - 分析不设任何数量 / 长度上限, 绝不复用仅用于诊断展示的限量路径枚举。
//
// 建模: 有向图“最小顶点割”(割项只允许是未挂牌开关) -> 拆分节点的最小 s-t 割。
//   每个节点 v 拆成 v_in -> v_out:
//     未挂牌开关容量 1(挂牌代价 = 1), 已挂牌开关容量 0(本就是屏障),
//     电源 / 设备 / 其它节点容量 INF(不可作为割项);
//   每条供电边 u->v 变为 u_out -> v_in, 容量 INF;
//   超级源 S -> 每个启用电源的 in, 设备 out -> 超级汇 T, 容量均为 INF。
//   最大流:
//     >= INF 表示存在一条“只经过不可割节点(即不经过任何开关)”的来电通路 -> 不可行;
//     <  INF 时最大流值 = 最少新增挂牌开关数, 最小割中的单位容量内边即建议挂牌的开关。
// 算法用内联 Dinic, 节点 / 边按编号顺序插入, 同一最小割值下结果确定、可复现。

const { findReachableTarget } = require('./graph');

const DEFAULT_MAX_STEPS = 200; // 与临时操作单 MAX_STEPS 一致: 整单步数上限

class Dinic {
  constructor(n) {
    this.n = n;
    this.g = Array.from({ length: n }, () => []);
  }

  // 加一条容量 cap 的有向边。
  addEdge(from, to, cap) {
    const fwd = { to, cap, rev: this.g[to].length };
    const rev = { to: from, cap: 0, rev: this.g[from].length };
    this.g[from].push(fwd);
    this.g[to].push(rev);
  }

  bfsLevel(s) {
    const level = new Int32Array(this.n).fill(-1);
    level[s] = 0;
    const q = [s];
    let head = 0;
    while (head < q.length) {
      const v = q[head++];
      for (const e of this.g[v]) {
        if (e.cap > 0 && level[e.to] < 0) {
          level[e.to] = level[v] + 1;
          q.push(e.to);
        }
      }
    }
    return level;
  }

  maxFlow(s, t) {
    let flow = 0;
    for (;;) {
      const level = this.bfsLevel(s);
      if (level[t] < 0) return flow;
      const it = new Int32Array(this.n);
      const self = this;
      function dfs(v, pushed) {
        if (v === t) return pushed;
        for (let i = it[v]; i < self.g[v].length; i = ++it[v]) {
          const e = self.g[v][i];
          if (e.cap > 0 && level[e.to] === level[v] + 1) {
            const d = dfs(e.to, Math.min(pushed, e.cap));
            if (d > 0) {
              e.cap -= d;
              self.g[e.to][e.rev].cap += d;
              return d;
            }
          }
        }
        return 0;
      }
      for (;;) {
        const f = dfs(s, Infinity);
        if (f === 0) break;
        flow += f;
      }
    }
  }

  // 最大流后残量网络中从 s 可达的节点集合(最小割的源侧)。
  reachableFrom(s) {
    const seen = new Set([s]);
    const q = [s];
    let head = 0;
    while (head < q.length) {
      const v = q[head++];
      for (const e of this.g[v]) {
        if (e.cap > 0 && !seen.has(e.to)) {
          seen.add(e.to);
          q.push(e.to);
        }
      }
    }
    return seen;
  }
}

function isSwitchNode(n) {
  return n && n.kind === 'switch';
}

/**
 * 不可行时, 在“只允许经过非开关节点”的受限图上从启用电源做多源 BFS,
 * 找到一条不经过任何开关的真实来电通路(开关节点既不可进入也不可展开)。
 * 调用方仅在 maxFlow >= INF 时调用, 因此该路径必然存在。
 */
function findSwitchlessWitness(graph, targetId) {
  const parent = new Map(); // nodeId -> {from, edge}
  const q = [];
  for (const n of graph.nodes) {
    if (n.kind === 'source' && n.enabled && !parent.has(n.id)) {
      parent.set(n.id, { from: null, edge: null });
      q.push(n.id);
    }
  }
  while (q.length) {
    const cur = q.shift();
    if (cur === targetId) {
      const nodes = [cur];
      const edges = [];
      let p = parent.get(cur);
      while (p.from !== null) {
        nodes.unshift(p.from);
        edges.unshift(p.edge);
        p = parent.get(p.from);
      }
      return { nodes, edges, tagged: [] };
    }
    for (const e of graph.outAdj.get(cur) || []) {
      if (parent.has(e.to)) continue;
      const to = graph.nodeById.get(e.to);
      if (isSwitchNode(to)) continue; // 开关一律不可穿过
      parent.set(e.to, { from: cur, edge: e.id });
      q.push(e.to);
    }
  }
  return null;
}

/**
 * 计算设备的最小新增挂牌隔离建议(纯只读, 不依赖诊断枚举上限)。
 * @param {Object} graph loadGraph() 风格的完整供电图
 * @param {number} deviceId 目标设备
 * @param {number} [maxSteps=200] 现有临时操作单的步数上限
 * @returns 见各分支; 设备不存在时抛出带 status/code 的鸭子类型错误
 */
function planIsolation(graph, deviceId, maxSteps = DEFAULT_MAX_STEPS) {
  const device = graph.nodeById.get(deviceId);
  if (!device || device.kind !== 'device') {
    throw Object.assign(new Error('目标设备不存在'), { status: 404, code: 'NOT_FOUND' });
  }

  // 已隔离(无启用电源, 或所有来电通路都已被挂牌屏障切断) -> 空步骤。
  const reach = findReachableTarget(graph, deviceId);
  if (!reach.reachable) {
    return {
      device_id: deviceId,
      isolated: true,
      feasible: true,
      switches: [],
      steps: [],
      stepCount: 0,
      newTagCount: 0,
      withinOrderLimit: true,
      orderMaxSteps: maxSteps
    };
  }

  // ---- 构造拆点最小割网络 ----
  const sorted = [...graph.nodes].sort((a, b) => a.id - b.id);
  const idx = new Map(sorted.map((n, i) => [n.id, i * 2]));
  const SUPER_S = sorted.length * 2;
  const SUPER_T = SUPER_S + 1;
  const dinic = new Dinic(SUPER_T + 1);

  // INF 大于“割掉全部候选开关”的总代价, 保证任何可行割都比走不可割边便宜:
  // 没有未挂牌开关时 INF=1, 一条全 INF 通路的流量即 >= INF -> 不可行。
  const removable = sorted.filter((n) => n.kind === 'switch' && !n.tagged).map((n) => n.id);
  const INF = removable.length + 1;

  for (const n of sorted) {
    const i = idx.get(n.id);
    if (n.kind === 'switch') {
      // 已挂牌开关容量 0: 与既有可达性分析一致的屏障; 未挂牌开关容量 1: 割价
      dinic.addEdge(i, i + 1, n.tagged ? 0 : 1);
    } else {
      dinic.addEdge(i, i + 1, INF); // 电源/设备不可作为割项
    }
  }
  for (const n of sorted) {
    if (n.kind === 'source' && n.enabled) dinic.addEdge(SUPER_S, idx.get(n.id), INF);
  }
  dinic.addEdge(idx.get(deviceId) + 1, SUPER_T, INF);

  // 供电边按 id 顺序加入, 保证同值最小割结果确定
  for (const e of [...graph.edges].sort((a, b) => a.id - b.id)) {
    if (!idx.has(e.from_node) || !idx.has(e.to_node)) continue;
    dinic.addEdge(idx.get(e.from_node) + 1, idx.get(e.to_node), INF);
  }

  const flow = dinic.maxFlow(SUPER_S, SUPER_T);

  if (flow >= INF) {
    // 存在不经过任何开关的来电通路: 挂多少开关都无法隔离。
    return {
      device_id: deviceId,
      isolated: false,
      feasible: false,
      orderMaxSteps: maxSteps,
      livePath: findSwitchlessWitness(graph, deviceId)
    };
  }

  // 最小割源侧中的“未挂牌开关内边”(in 在源侧、out 在汇侧)即新增挂牌点。
  const sourceSide = dinic.reachableFrom(SUPER_S);
  const cutIds = removable
    .filter((id) => {
      const i = idx.get(id);
      return sourceSide.has(i) && !sourceSide.has(i + 1);
    })
    .sort((a, b) => a - b);

  // 按状态生成步骤: 每个开关“先分闸(若在合闸位置)再挂牌”。
  const steps = [];
  for (const id of cutIds) {
    const n = graph.nodeById.get(id);
    if (!n.open_pos) steps.push({ action: 'open', node_id: id });
    steps.push({ action: 'tag', node_id: id });
  }

  return {
    device_id: deviceId,
    isolated: false,
    feasible: true,
    switches: cutIds.map((id) => {
      const n = graph.nodeById.get(id);
      return { node_id: id, name: n.name, open_pos: !!n.open_pos, tagged: false };
    }),
    steps,
    stepCount: steps.length,
    newTagCount: cutIds.length,
    // 超出操作单步数上限时显式标记“不可整单执行”, 步骤仍然全量给出、不截断
    withinOrderLimit: steps.length <= maxSteps,
    orderMaxSteps: maxSteps
  };
}

function buildGroupPlan(graph, deviceIds, maxSteps = DEFAULT_MAX_STEPS) {
  const targetIds = [...new Set(deviceIds.map(Number))].sort((a, b) => a - b);
  const targets = targetIds.map((id) => {
    const node = graph.nodeById.get(id);
    if (!node || node.kind !== 'device') {
      throw Object.assign(new Error('目标设备不存在'), { status: 404, code: 'NOT_FOUND', device_id: id });
    }
    return node;
  });

  const initialReach = new Map();
  for (const target of targets) {
    initialReach.set(target.id, findReachableTarget(graph, target.id));
  }
  const liveTargetIds = targets
    .filter((target) => initialReach.get(target.id).reachable)
    .map((target) => target.id);

  const formatDevice = (id) => {
    const n = graph.nodeById.get(id);
    return { device_id: id, device_name: n.name };
  };

  if (liveTargetIds.length === 0) {
    return {
      device_ids: targetIds,
      devices: targets.map((n) => ({
        ...formatDevice(n.id),
        isolated: true,
        protectedBy: []
      })),
      isolated: true,
      feasible: true,
      switches: [],
      sharedSwitchIds: [],
      steps: [],
      stepCount: 0,
      newTagCount: 0,
      permitCount: targets.length,
      confirmationStepCount: targets.length,
      withinOrderLimit: targets.length <= maxSteps,
      orderMaxSteps: maxSteps
    };
  }

  const sorted = [...graph.nodes].sort((a, b) => a.id - b.id);
  const idx = new Map(sorted.map((n, i) => [n.id, i * 2]));
  const SUPER_S = sorted.length * 2;
  const SUPER_T = SUPER_S + 1;
  const dinic = new Dinic(SUPER_T + 1);
  const removable = sorted.filter((n) => n.kind === 'switch' && !n.tagged).map((n) => n.id);
  const INF = removable.length + 1;

  for (const n of sorted) {
    const i = idx.get(n.id);
    dinic.addEdge(i, i + 1, n.kind === 'switch' ? (n.tagged ? 0 : 1) : INF);
  }
  for (const n of sorted) {
    if (n.kind === 'source' && n.enabled) dinic.addEdge(SUPER_S, idx.get(n.id), INF);
  }
  for (const id of liveTargetIds) dinic.addEdge(idx.get(id) + 1, SUPER_T, INF);
  for (const e of [...graph.edges].sort((a, b) => a.id - b.id)) {
    if (idx.has(e.from_node) && idx.has(e.to_node)) {
      dinic.addEdge(idx.get(e.from_node) + 1, idx.get(e.to_node), INF);
    }
  }

  const flow = dinic.maxFlow(SUPER_S, SUPER_T);
  if (flow >= INF) {
    const infeasibleDevices = liveTargetIds
      .map((id) => ({ ...formatDevice(id), livePath: findSwitchlessWitness(graph, id) }))
      .filter((x) => x.livePath);
    return {
      device_ids: targetIds,
      devices: targets.map((n) => ({
        ...formatDevice(n.id),
        isolated: !initialReach.get(n.id).reachable,
        protectedBy: []
      })),
      isolated: false,
      feasible: false,
      orderMaxSteps: maxSteps,
      infeasibleDeviceIds: infeasibleDevices.map((x) => x.device_id),
      infeasibleDevices
    };
  }

  const sourceSide = dinic.reachableFrom(SUPER_S);
  const cutIds = removable
    .filter((id) => {
      const i = idx.get(id);
      return sourceSide.has(i) && !sourceSide.has(i + 1);
    })
    .sort((a, b) => a - b);

  // 判断每个新增挂牌点在“其余新增挂牌均已生效”时仍保护哪些当前带电目标:
  // 从该开关出发, 既有挂牌与其它新增挂牌都是屏障。服务两个及以上目标即为共用。
  const liveTargetSet = new Set(liveTargetIds);
  const cutSet = new Set(cutIds);
  const protectedByDevice = new Map(cutIds.map((id) => [id, []]));
  for (const id of cutIds) {
    const seen = new Set([id]);
    const q = [id];
    while (q.length) {
      const cur = q.shift();
      if (liveTargetSet.has(cur)) protectedByDevice.get(id).push(cur);
      const curNode = graph.nodeById.get(cur);
      if (isSwitchNode(curNode) && curNode.tagged) continue;
      for (const e of graph.outAdj.get(cur) || []) {
        if (seen.has(e.to)) continue;
        const to = graph.nodeById.get(e.to);
        if ((isSwitchNode(to) && to.tagged) || (e.to !== id && cutSet.has(e.to))) continue;
        seen.add(e.to);
        q.push(e.to);
      }
    }
    protectedByDevice.get(id).sort((a, b) => a - b);
  }
  const sharedSwitchIds = cutIds.filter((id) => protectedByDevice.get(id).length >= 2);
  const protectedByTarget = new Map(targets.map((target) => [target.id, []]));
  for (const id of cutIds) {
    for (const deviceId of protectedByDevice.get(id)) protectedByTarget.get(deviceId).push(id);
  }

  const steps = [];
  for (const id of cutIds) {
    const n = graph.nodeById.get(id);
    if (!n.open_pos) steps.push({ action: 'open', node_id: id });
    steps.push({ action: 'tag', node_id: id });
  }

  return {
    device_ids: targetIds,
    devices: targets.map((n) => ({
      ...formatDevice(n.id),
      isolated: !initialReach.get(n.id).reachable,
      protectedBy: protectedByTarget.get(n.id)
    })),
    isolated: false,
    feasible: true,
    switches: cutIds.map((id) => {
      const n = graph.nodeById.get(id);
      return {
        node_id: id,
        name: n.name,
        open_pos: !!n.open_pos,
        tagged: false,
        shared: protectedByDevice.get(id).length >= 2,
        protectedDeviceIds: protectedByDevice.get(id)
      };
    }),
    sharedSwitchIds,
    steps,
    stepCount: steps.length,
    newTagCount: cutIds.length,
    permitCount: targetIds.length,
    confirmationStepCount: steps.length + targetIds.length,
    withinOrderLimit: steps.length + targetIds.length <= maxSteps,
    orderMaxSteps: maxSteps
  };
}

module.exports = {
  planIsolation,
  planGroupIsolation: buildGroupPlan,
  findSwitchlessWitness,
  DEFAULT_MAX_STEPS,
  Dinic
};
