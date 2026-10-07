'use strict';

// 有效许可的“单点挂牌失效”风险分析(只读)。
//
// 对每个当前已挂牌开关 s, 假设 s 的挂牌失效(不再阻断供电, 即 tagged=false),
// 其余开关状态与供电图保持原状, 用与许可生效判定相同的完整可达性分析
// (findReachableTarget, 不设数量/长度上限)判断: 此时哪些有效许可的设备会
// 重新出现未切断通路。若是, 则 s 对该许可构成“单点挂牌失效风险”——
// 该许可的断电隔离单独依赖这一块挂牌。
//
// 结果按开关编号、许可编号稳定排序; 每条风险附一条真实带电路径(BFS 见证路径,
// 不依赖仅用于诊断展示的限量路径枚举, 因此不受 200 条 / 64 节点上限影响)。
// 未影响任何所查许可的已挂牌开关同样列出(risks 为空), 便于确认“无单点风险”;
// 所查许可为空时返回空报告。分析纯内存进行, 不改变任何状态。

const { findReachableTarget } = require('./graph');

/**
 * @param {Object} graph loadGraph() 风格的完整供电图(同一次当前状态快照)
 * @param {Array} permits 所查有效许可(activePermits() 行, 任意顺序; 输出按许可编号排序)
 * @returns {{ switches: Array }} 按开关编号升序;
 *   每项 { switch_id, name, risks: [{permit_id, device_id, device_name, livePath}] },
 *   risks 按许可编号升序, livePath 为未序列化的真实路径 {nodes, edges}
 */
function singlePointTagRisk(graph, permits) {
  const targets = [...permits].sort((a, b) => a.id - b.id);
  // 无有效许可(或筛选后无所查许可) -> 空报告
  if (targets.length === 0) return { switches: [] };

  const taggedSwitchIds = graph.nodes
    .filter((n) => n.kind === 'switch' && n.tagged)
    .map((n) => n.id)
    .sort((a, b) => a - b);

  const switches = [];
  for (const switchId of taggedSwitchIds) {
    // 假设图: 仅该开关的挂牌失效, 其余节点与供电边保持原状。
    // 隔离判定只认挂牌(open_pos 是现场分合位, 不影响可达性), 故只改 tagged。
    const nodeById = new Map(graph.nodes.map((n) => [
      n.id,
      n.id === switchId ? { ...n, tagged: false } : n
    ]));
    const hypo = { nodes: [...nodeById.values()], nodeById, outAdj: graph.outAdj };

    const risks = [];
    for (const p of targets) {
      const r = findReachableTarget(hypo, p.device_id);
      if (r.reachable) {
        risks.push({
          permit_id: p.id,
          device_id: p.device_id,
          device_name: p.device_name,
          livePath: r.witness
        });
      }
    }
    const node = graph.nodeById.get(switchId);
    switches.push({ switch_id: switchId, name: node.name, risks });
  }
  return { switches };
}

module.exports = { singlePointTagRisk };
