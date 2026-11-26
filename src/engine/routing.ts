// 出行路由引擎：同一份路网/班次快照上的两种计算表示
//  A. 时间展开图：地点 × 窗口内每分钟 = 地点时刻点，等候/步行/乘车全部显式成边
//  B. 地点图：只保留地理节点与到达标签，遍历到班车边时查询下一班可乘车次（不假设随时有车）
// 两种实现均返回所选方式的最早可达候选（legs 统一为 walk/wait/ride 段），
// 并各自记录图状态数、等候边或班次查询量等实测统计（不是复杂度名称）。

import type { JourneyLeg } from '../types';

export interface RoutingWalkEdge {
  id: string;
  fromId: string;
  toId: string;
  minutes: number; // 非负整分钟
}

export interface RoutingRide {
  departureId: string;
  fromId: string;
  toId: string;
  departMin: number;
  arriveMin: number;
}

export interface RoutingNetwork {
  locationIds: string[];
  walkEdges: RoutingWalkEdge[]; // 仅包含开放且已批准无障碍的边（无向）
  rides: RoutingRide[]; // 仅包含未取消的班次
  windowStartMin: number;
  windowEndMin: number;
}

export interface RouteOutcome {
  feasible: boolean;
  arriveMin: number | null;
  legs: JourneyLeg[];
  reason?: string;
}

export interface ExpandedStats {
  impl: 'time-expanded';
  locationCount: number;
  tickCount: number; // 窗口分钟刻度数
  nodes: number; // 地点时刻点 = 地点 × 刻度
  waitEdges: number; // 等候边 = 地点 × (刻度-1)
  walkEdgeInstances: number; // 步行边的时间展开实例数
  rideEdgeInstances: number; // 班次边实例数
  settledStates: number; // 搜索实际确定的状态数
  relaxations: number; // 实际执行的边松弛次数
}

export interface LocationGraphStats {
  impl: 'location-graph';
  nodes: number; // 地理节点数
  settledLabels: number; // 确定的到达标签数
  walkRelaxations: number; // 步行边松弛次数
  scheduleQueries: number; // 班次查询量（边上查询下一班可乘车次的次数）
}

const INF = Number.POSITIVE_INFINITY;

/** 下一班可乘车次：fromId 出发、departMin >= t 且到达不晚于窗口末班的最早班次 */
export function nextDeparture(
  net: RoutingNetwork,
  fromId: string,
  toId: string,
  t: number,
): RoutingRide | null {
  let best: RoutingRide | null = null;
  for (const r of net.rides) {
    if (r.fromId !== fromId || r.toId !== toId) continue;
    if (r.departMin < t || r.arriveMin > net.windowEndMin) continue;
    if (!best || r.departMin < best.departMin) best = r;
  }
  return best;
}

/** 纯步行最短时间（护送员调位用；不考虑班次与窗口），不可达返回 null */
export function walkTimeBetween(net: RoutingNetwork, fromId: string, toId: string): number | null {
  if (fromId === toId) return 0;
  const dist = new Map<string, number>([[fromId, 0]]);
  const done = new Set<string>();
  for (;;) {
    let u: string | null = null;
    let du = INF;
    for (const [loc, d] of dist) {
      if (!done.has(loc) && d < du) {
        u = loc;
        du = d;
      }
    }
    if (u === null) return null;
    if (u === toId) return du;
    done.add(u);
    for (const e of net.walkEdges) {
      const v = e.fromId === u ? e.toId : e.toId === u ? e.fromId : null;
      if (v === null) continue;
      const nd = du + e.minutes;
      if (nd < (dist.get(v) ?? INF)) dist.set(v, nd);
    }
  }
}

// ---------- A. 时间展开图 ----------

interface ExpandedParent {
  prev: number;
  kind: 'walk' | 'wait' | 'ride';
  edgeId?: string;
  departureId?: string;
}

export function routeTimeExpanded(
  net: RoutingNetwork,
  originId: string,
  destId: string,
  departMin: number,
  useRides: boolean,
): { outcome: RouteOutcome; stats: ExpandedStats } {
  const locs = net.locationIds;
  const L = locs.length;
  const locIdx = new Map(locs.map((l, i) => [l, i] as const));
  const ticks = net.windowEndMin - net.windowStartMin + 1;
  const nodeOf = (li: number, t: number) => li * ticks + (t - net.windowStartMin);
  const nodeCount = L * ticks;

  // 完整展开的边规模（解析计数，与搜索是否访问无关）
  let walkEdgeInstances = 0;
  const walkAdj: { to: number; w: number; edgeId: string }[][] = locs.map(() => []);
  for (const e of net.walkEdges) {
    const a = locIdx.get(e.fromId);
    const b = locIdx.get(e.toId);
    if (a === undefined || b === undefined) continue;
    walkAdj[a].push({ to: b, w: e.minutes, edgeId: e.id });
    walkAdj[b].push({ to: a, w: e.minutes, edgeId: e.id });
    const fits = Math.max(0, net.windowEndMin - e.minutes - net.windowStartMin + 1);
    walkEdgeInstances += 2 * fits;
  }
  const rideAdj: RoutingRide[][] = locs.map(() => []);
  let rideEdgeInstances = 0;
  if (useRides) {
    for (const r of net.rides) {
      const a = locIdx.get(r.fromId);
      const b = locIdx.get(r.toId);
      if (a === undefined || b === undefined) continue;
      if (r.departMin < net.windowStartMin || r.arriveMin > net.windowEndMin) continue;
      rideAdj[a].push(r);
      rideEdgeInstances += 1;
    }
  }
  const stats: ExpandedStats = {
    impl: 'time-expanded',
    locationCount: L,
    tickCount: ticks,
    nodes: nodeCount,
    waitEdges: L * (ticks - 1),
    walkEdgeInstances,
    rideEdgeInstances,
    settledStates: 0,
    relaxations: 0,
  };

  const oi = locIdx.get(originId);
  const di = locIdx.get(destId);
  if (oi === undefined || di === undefined) {
    return { outcome: { feasible: false, arriveMin: null, legs: [], reason: '起点或终点不在路网中' }, stats };
  }
  if (departMin < net.windowStartMin || departMin > net.windowEndMin) {
    return { outcome: { feasible: false, arriveMin: null, legs: [], reason: '出发时刻不在时间窗口内' }, stats };
  }

  const dist = new Array<number>(nodeCount).fill(INF);
  const parent = new Array<ExpandedParent | null>(nodeCount).fill(null);
  const settled = new Array<boolean>(nodeCount).fill(false);
  dist[nodeOf(oi, departMin)] = departMin;

  // Dijkstra：所有边权非负（等候 1、步行 w、乘车 r）
  for (;;) {
    let u = -1;
    let du = INF;
    for (let n = 0; n < nodeCount; n++) {
      if (!settled[n] && dist[n] < du) {
        u = n;
        du = dist[n];
      }
    }
    if (u === -1) break;
    settled[u] = true;
    stats.settledStates += 1;
    const li = Math.floor(u / ticks);
    const t = net.windowStartMin + (u % ticks);
    // 时间展开节点的到达时刻即其时间坐标：首次以更小坐标到达即记录；
    // 同等到达时刻按 等候 > 乘车 > 步行 决胜（避免“步行折返代替候车”的等价丑路径）
    const kindRank = (k: 'walk' | 'wait' | 'ride') => (k === 'wait' ? 0 : k === 'ride' ? 1 : 2);
    const relax = (v: number, p: ExpandedParent) => {
      stats.relaxations += 1;
      const arriveT = net.windowStartMin + (v % ticks);
      if (arriveT < dist[v]) {
        dist[v] = arriveT;
        parent[v] = p;
      } else if (arriveT === dist[v] && parent[v] && kindRank(p.kind) < kindRank(parent[v]!.kind)) {
        parent[v] = p;
      }
    };
    // 乘车边（优先尝试，同等到达时刻下避免无谓等候）
    if (useRides) {
      for (const r of rideAdj[li]) {
        if (r.departMin !== t) continue;
        relax(nodeOf(locIdx.get(r.toId)!, r.arriveMin), {
          prev: u,
          kind: 'ride',
          departureId: r.departureId,
        });
      }
    }
    // 步行边
    for (const e of walkAdj[li]) {
      const t2 = t + e.w;
      if (t2 > net.windowEndMin) continue;
      relax(nodeOf(e.to, t2), { prev: u, kind: 'walk', edgeId: e.edgeId });
    }
    // 等候边
    if (t + 1 <= net.windowEndMin) {
      relax(nodeOf(li, t + 1), { prev: u, kind: 'wait' });
    }
  }

  // 终点最早到达时刻
  let bestT = INF;
  for (let t = net.windowStartMin; t <= net.windowEndMin; t++) {
    bestT = Math.min(bestT, dist[nodeOf(di, t)]);
  }
  if (bestT === INF) {
    return { outcome: { feasible: false, arriveMin: null, legs: [], reason: '窗口内无法到达目的地' }, stats };
  }
  const legs = reconstructExpanded(parent, nodeOf(di, bestT), ticks, net, locs);
  return { outcome: { feasible: true, arriveMin: bestT, legs }, stats };
}

function reconstructExpanded(
  parent: (ExpandedParent | null)[],
  endNode: number,
  ticks: number,
  net: RoutingNetwork,
  locs: string[],
): JourneyLeg[] {
  const raw: JourneyLeg[] = [];
  let cur = endNode;
  while (parent[cur]) {
    const p = parent[cur]!;
    const fromLi = Math.floor(p.prev / ticks);
    const toLi = Math.floor(cur / ticks);
    const fromT = net.windowStartMin + (p.prev % ticks);
    const toT = net.windowStartMin + (cur % ticks);
    raw.push({
      kind: p.kind,
      fromId: locs[fromLi],
      toId: locs[toLi],
      departMin: fromT,
      arriveMin: toT,
      edgeId: p.edgeId,
      departureId: p.departureId,
    });
    cur = p.prev;
  }
  raw.reverse();
  return mergeWaits(raw);
}

/** 连续等候分钟合并为一段等候 */
function mergeWaits(legs: JourneyLeg[]): JourneyLeg[] {
  const out: JourneyLeg[] = [];
  for (const leg of legs) {
    const last = out[out.length - 1];
    if (leg.kind === 'wait' && last && last.kind === 'wait' && last.toId === leg.fromId) {
      last.arriveMin = leg.arriveMin;
      continue;
    }
    out.push({ ...leg });
  }
  return out;
}

// ---------- B. 地点图（遍历时查询班次） ----------

interface LocationParent {
  prevLoc: string;
  via:
    | { kind: 'walk'; edgeId: string; departMin: number; arriveMin: number }
    | { kind: 'ride'; departureId: string; boardMin: number; departMin: number; arriveMin: number };
}

export function routeLocationGraph(
  net: RoutingNetwork,
  originId: string,
  destId: string,
  departMin: number,
  useRides: boolean,
): { outcome: RouteOutcome; stats: LocationGraphStats } {
  const stats: LocationGraphStats = {
    impl: 'location-graph',
    nodes: net.locationIds.length,
    settledLabels: 0,
    walkRelaxations: 0,
    scheduleQueries: 0,
  };
  if (!net.locationIds.includes(originId) || !net.locationIds.includes(destId)) {
    return { outcome: { feasible: false, arriveMin: null, legs: [], reason: '起点或终点不在路网中' }, stats };
  }
  if (departMin < net.windowStartMin || departMin > net.windowEndMin) {
    return { outcome: { feasible: false, arriveMin: null, legs: [], reason: '出发时刻不在时间窗口内' }, stats };
  }

  // 班车边按 (from,to) 分组，遍历时对每组查询下一班
  const ridePairs = new Map<string, { fromId: string; toId: string }>();
  if (useRides) {
    for (const r of net.rides) ridePairs.set(`${r.fromId}->${r.toId}`, { fromId: r.fromId, toId: r.toId });
  }

  const dist = new Map<string, number>([[originId, departMin]]);
  const parent = new Map<string, LocationParent>();
  const settled = new Set<string>();

  for (;;) {
    let u: string | null = null;
    let du = INF;
    for (const [loc, d] of dist) {
      if (!settled.has(loc) && d < du) {
        u = loc;
        du = d;
      }
    }
    if (u === null) break;
    settled.add(u);
    stats.settledLabels += 1;

    // 步行边：到达 = 当前标签 + 步行耗时
    for (const e of net.walkEdges) {
      const v = e.fromId === u ? e.toId : e.toId === u ? e.fromId : null;
      if (v === null) continue;
      const arr = du + e.minutes;
      if (arr > net.windowEndMin) continue;
      stats.walkRelaxations += 1;
      if (arr < (dist.get(v) ?? INF)) {
        dist.set(v, arr);
        parent.set(v, { prevLoc: u, via: { kind: 'walk', edgeId: e.id, departMin: du, arriveMin: arr } });
      }
    }
    // 班车边：查询下一班可乘车次，候车时间在边上现算，不假设随时有车
    if (useRides) {
      for (const pair of ridePairs.values()) {
        if (pair.fromId !== u) continue;
        stats.scheduleQueries += 1;
        const ride = nextDeparture(net, pair.fromId, pair.toId, du);
        if (!ride) continue; // 该时刻之后无可乘班次
        if (ride.arriveMin < (dist.get(pair.toId) ?? INF)) {
          dist.set(pair.toId, ride.arriveMin);
          parent.set(pair.toId, {
            prevLoc: u,
            via: { kind: 'ride', departureId: ride.departureId, boardMin: du, departMin: ride.departMin, arriveMin: ride.arriveMin },
          });
        }
      }
    }
  }

  const best = dist.get(destId);
  if (best === undefined) {
    return { outcome: { feasible: false, arriveMin: null, legs: [], reason: '窗口内无法到达目的地' }, stats };
  }
  // 回溯：乘车弧补上等候段
  const legs: JourneyLeg[] = [];
  let cur = destId;
  while (cur !== originId) {
    const p = parent.get(cur);
    if (!p) break;
    if (p.via.kind === 'walk') {
      legs.push({ kind: 'walk', fromId: p.prevLoc, toId: cur, departMin: p.via.departMin, arriveMin: p.via.arriveMin, edgeId: p.via.edgeId });
    } else {
      legs.push({ kind: 'ride', fromId: p.prevLoc, toId: cur, departMin: p.via.departMin, arriveMin: p.via.arriveMin, departureId: p.via.departureId });
      if (p.via.departMin > p.via.boardMin) {
        legs.push({ kind: 'wait', fromId: p.prevLoc, toId: p.prevLoc, departMin: p.via.boardMin, arriveMin: p.via.departMin });
      }
    }
    cur = p.prevLoc;
  }
  legs.reverse();
  return { outcome: { feasible: true, arriveMin: best, legs }, stats };
}
