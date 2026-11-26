// 出行业务引擎：候选规划（不占座）、确认时的原子核对、护送员调度可行性、
// 执行/扰动的派生状态（失效行程、护送员位置、待办）。全部为纯函数，worker 与测试共用。

import type {
  EscortDef,
  EscortPhase,
  JourneyLeg,
  Snapshot,
  TransitJourney,
  TransitNotification,
  TravelMode,
} from '../types';
import {
  RECEIVING_TEACHER_ID,
  SEED_DEPARTURES,
  SEED_ESCORTS,
  SEED_GROUPS,
  SEED_SHUTTLE_ROUTES,
  SEED_STUDENTS,
  SEED_TRANSIT_LOCATIONS,
  SEED_WALK_EDGES,
  TRANSIT_WINDOW,
  escortById,
  groupById,
  locationById,
} from '../lib/seed';
import { hmToMin, minToHM } from '../lib/time';
import {
  routeLocationGraph,
  routeTimeExpanded,
  walkTimeBetween,
  type ExpandedStats,
  type LocationGraphStats,
  type RoutingNetwork,
} from './routing';

// ---------- 网络构建（静态种子 + 快照中的封闭/取消/占用） ----------

export function buildRoutingNetwork(snap: Snapshot): RoutingNetwork {
  return {
    locationIds: SEED_TRANSIT_LOCATIONS.map((l) => l.id),
    walkEdges: SEED_WALK_EDGES.filter((e) => e.accessible && !snap.transit.walkEdges[e.id]?.closed).map(
      (e) => ({ id: e.id, fromId: e.fromId, toId: e.toId, minutes: e.minutes }),
    ),
    rides: SEED_DEPARTURES.filter((d) => !snap.transit.departures[d.id]?.cancelled).map((d) => {
      const route = SEED_SHUTTLE_ROUTES.find((r) => r.id === d.routeId)!;
      return {
        departureId: d.id,
        fromId: route.fromId,
        toId: route.toId,
        departMin: d.departMin,
        arriveMin: d.departMin + route.rideMinutes,
      };
    }),
    windowStartMin: TRANSIT_WINDOW.startMin,
    windowEndMin: TRANSIT_WINDOW.endMin,
  };
}

// ---------- 班次占用（已确认预订 + 临时满载占用；候选计算本身不占座） ----------

export interface DepartureLoad {
  seats: number;
  bays: number;
  capSeats: number;
  capBays: number;
}

export function departureLoad(snap: Snapshot, departureId: string, excludeJourneyId?: string): DepartureLoad {
  const def = SEED_DEPARTURES.find((d) => d.id === departureId)!;
  const route = SEED_SHUTTLE_ROUTES.find((r) => r.id === def.routeId)!;
  const st = snap.transit.departures[departureId];
  let seats = st?.reservedSeats ?? 0;
  let bays = st?.reservedBays ?? 0;
  for (const j of Object.values(snap.transit.journeys)) {
    if (j.id === excludeJourneyId) continue;
    if (j.status !== 'confirmed' && j.status !== 'in_progress') continue;
    for (const b of j.bookings) {
      if (b.departureId !== departureId) continue;
      for (const sid of b.studentIds) {
        const stu = SEED_STUDENTS.find((s) => s.id === sid)!;
        if (stu.wheelchair) bays += 1;
        else seats += 1;
      }
    }
  }
  return { seats, bays, capSeats: route.seats, capBays: route.wheelchairBays };
}

// ---------- 护送员调度可行性 ----------

interface PhaseLike {
  startMin: number;
  endMin: number;
  startLocId: string;
  endLocId: string;
  studentCount: number;
}

/** 护送员在生效行程中的全部阶段（含已释放的过去阶段，用于位置连续性） */
export function escortPhases(snap: Snapshot, escortId: string, excludeJourneyId?: string): EscortPhase[] {
  const out: EscortPhase[] = [];
  for (const j of Object.values(snap.transit.journeys)) {
    if (j.id === excludeJourneyId) continue;
    if (j.status !== 'confirmed' && j.status !== 'in_progress') continue;
    for (const p of j.phases) if (p.escortId === escortId) out.push(p);
  }
  return out.sort((a, b) => a.startMin - b.startMin);
}

function effectiveEnd(p: EscortPhase): { locId: string; min: number } {
  if ((p.status === 'released' || p.status === 'handed_over') && p.releasedAtMin !== null) {
    return { locId: p.releasedAtLocId ?? p.endLocId, min: p.releasedAtMin };
  }
  return { locId: p.endLocId, min: p.endMin };
}

/**
 * 护送员接下新阶段是否可行：可用窗口覆盖、人数上限、
 * 与既有阶段时间不重叠且按步行路网调位可达（重复派单不能让同一人在两处带队）。
 */
export function escortScheduleCheck(
  snap: Snapshot,
  escort: EscortDef,
  extra: PhaseLike[],
  excludeJourneyId?: string,
): string[] {
  const reasons: string[] = [];
  if (snap.transit.escorts[escort.id]?.onLeave) reasons.push(`${escort.name} 请假中`);
  const net = buildRoutingNetwork(snap);
  const chain: PhaseLike[] = [
    ...escortPhases(snap, escort.id, excludeJourneyId).map((p) => {
      const end = effectiveEnd(p);
      return {
        startMin: p.startMin,
        endMin: end.min,
        startLocId: p.startLocId,
        endLocId: end.locId,
        studentCount: p.actualStudentIds?.length ?? p.plannedStudentIds.length,
      };
    }),
    ...extra,
  ].sort((a, b) => a.startMin - b.startMin);

  for (const p of extra) {
    if (p.startMin < escort.fromMin || p.endMin > escort.toMin) {
      reasons.push(
        `阶段 ${minToHM(p.startMin)}-${minToHM(p.endMin)} 超出可用窗口 ${minToHM(escort.fromMin)}-${minToHM(escort.toMin)}`,
      );
    }
    if (p.studentCount > escort.maxStudents) {
      reasons.push(`同时带 ${p.studentCount} 人，超过上限 ${escort.maxStudents} 人`);
    }
  }

  // 位置连续性：从窗口开始时的基地位置出发，逐段检查调位
  let curLoc = escort.baseLocId;
  let curMin = escort.fromMin;
  for (const p of chain) {
    if (p.endMin <= curMin) continue; // 已被更晚阶段覆盖的过去阶段
    const travel = walkTimeBetween(net, curLoc, p.startLocId);
    if (travel === null) {
      reasons.push(`从 ${locationById(curLoc).code} 到 ${locationById(p.startLocId).code} 无可行步行路径`);
      break;
    }
    if (curMin + travel > p.startMin) {
      reasons.push(
        `${minToHM(curMin)} 在 ${locationById(curLoc).code}，无法于 ${minToHM(p.startMin)} 前赶到 ${locationById(p.startLocId).code} 带队`,
      );
      break;
    }
    curLoc = p.endLocId;
    curMin = p.endMin;
  }
  return [...new Set(reasons)];
}

// ---------- 候选规划 ----------

export interface PlannedPhase {
  escortId: string;
  studentIds: string[];
  startLocId: string;
  endLocId: string;
  startMin: number;
  endMin: number;
}

export interface CandidatePlan {
  groupId: string;
  mode: TravelMode;
  feasible: boolean;
  reasons: string[];
  legs: JourneyLeg[];
  departMin: number;
  arriveMin: number | null;
  arriveByMin: number;
  phases: PlannedPhase[];
  bookings: { departureId: string; studentIds: string[] }[];
  escortChecks: { escortId: string; name: string; ok: boolean; reasons: string[] }[];
  stats: { expanded: ExpandedStats; location: LocationGraphStats };
}

/** 纯步行路径（含边序列），不可达返回 null */
function walkPath(
  net: RoutingNetwork,
  fromId: string,
  toId: string,
): { minutes: number; edgeIds: string[] } | null {
  if (fromId === toId) return { minutes: 0, edgeIds: [] };
  const dist = new Map<string, number>([[fromId, 0]]);
  const prev = new Map<string, { loc: string; edgeId: string }>();
  const done = new Set<string>();
  for (;;) {
    let u: string | null = null;
    let du = Infinity;
    for (const [loc, d] of dist) if (!done.has(loc) && d < du) { u = loc; du = d; }
    if (u === null) return null;
    if (u === toId) break;
    done.add(u);
    for (const e of net.walkEdges) {
      const v = e.fromId === u ? e.toId : e.toId === u ? e.fromId : null;
      if (v === null) continue;
      const nd = du + e.minutes;
      if (nd < (dist.get(v) ?? Infinity)) {
        dist.set(v, nd);
        prev.set(v, { loc: u, edgeId: e.id });
      }
    }
  }
  const edgeIds: string[] = [];
  let cur = toId;
  while (cur !== fromId) {
    const p = prev.get(cur)!;
    edgeIds.unshift(p.edgeId);
    cur = p.loc;
  }
  return { minutes: dist.get(toId)!, edgeIds };
}

/**
 * 计算某组某种出行方式的最早可达候选。
 * 两种图实现都运行并互相校验；候选本身不占用座位/护送员，确认时才原子核对。
 * excludeJourneyId：重新确认时排除被替代行程自身的占用。
 */
export function planCandidate(
  snap: Snapshot,
  groupId: string,
  mode: TravelMode,
  excludeJourneyId?: string,
): CandidatePlan {
  const group = groupById(groupId);
  const net = buildRoutingNetwork(snap);
  const useRides = mode === 'shuttle';
  const expanded = routeTimeExpanded(net, group.originId, group.destId, group.departMin, useRides);
  const located = routeLocationGraph(net, group.originId, group.destId, group.departMin, useRides);
  const stats = { expanded: expanded.stats, location: located.stats };

  const reasons: string[] = [];
  if (
    expanded.outcome.feasible &&
    located.outcome.feasible &&
    expanded.outcome.arriveMin !== located.outcome.arriveMin
  ) {
    reasons.push(
      `两种实现结果不一致（展开图 ${minToHM(expanded.outcome.arriveMin!)} / 地点图 ${minToHM(located.outcome.arriveMin!)}）`,
    );
  }

  let legs = expanded.outcome.legs;
  let arriveMin = expanded.outcome.arriveMin;
  if (!expanded.outcome.feasible) reasons.push(expanded.outcome.reason ?? '窗口内不可达');

  // 接驳候选必须实际乘坐班车：若纯步行已最优（如连廊恢复开放），退化为“步行->乘车->步行”组合
  if (expanded.outcome.feasible && mode === 'shuttle' && !legs.some((l) => l.kind === 'ride')) {
    const alt = bestShuttleComposition(net, group.originId, group.destId, group.departMin);
    if (!alt) {
      reasons.push('窗口内没有可用的接驳班次组合');
      legs = [];
      arriveMin = null;
    } else {
      legs = alt.legs;
      arriveMin = alt.arriveMin;
    }
  }

  if (arriveMin !== null && arriveMin > group.arriveByMin) {
    reasons.push(`最早 ${minToHM(arriveMin)} 到达，超过要求的 ${minToHM(group.arriveByMin)}`);
  }

  // 护送阶段：步行方式为全程一段；接驳方式为“起点 -> 乘车站（含候车与登记上车）”一段
  const phases: PlannedPhase[] = [];
  const bookings: { departureId: string; studentIds: string[] }[] = [];
  if (arriveMin !== null && legs.length) {
    if (mode === 'walk') {
      phases.push({
        escortId: '',
        studentIds: [...group.studentIds],
        startLocId: group.originId,
        endLocId: group.destId,
        startMin: group.departMin,
        endMin: arriveMin,
      });
    } else {
      const rideLeg = legs.find((l) => l.kind === 'ride')!;
      const afterRide = legs.filter((l) => l.departMin >= rideLeg.arriveMin && l.kind !== 'ride');
      if (rideLeg.toId !== group.destId || afterRide.length) {
        reasons.push('接驳终点不是目的地，当前路网不支持接驳后步行段');
      } else {
        phases.push({
          escortId: '',
          studentIds: [...group.studentIds],
          startLocId: group.originId,
          endLocId: rideLeg.fromId,
          startMin: group.departMin,
          endMin: rideLeg.departMin,
        });
        bookings.push({ departureId: rideLeg.departureId!, studentIds: [...group.studentIds] });
      }
    }
  }

  // 护送员评估（对每阶段选首位可行护送员；多阶段时按护送员分别累计其已派阶段）
  const escortChecks: CandidatePlan['escortChecks'] = [];
  if (arriveMin !== null && phases.length) {
    const assignedByEscort = new Map<string, PlannedPhase[]>();
    for (const ph of phases) {
      let picked: string | null = null;
      for (const esc of SEED_ESCORTS) {
        const mine = assignedByEscort.get(esc.id) ?? [];
        const extras = [...mine, ph].map((p) => ({
          startMin: p.startMin,
          endMin: p.endMin,
          startLocId: p.startLocId,
          endLocId: p.endLocId,
          studentCount: p.studentIds.length,
        }));
        const errs = escortScheduleCheck(snap, esc, extras, excludeJourneyId);
        escortChecks.push({ escortId: esc.id, name: esc.name, ok: errs.length === 0, reasons: errs });
        if (errs.length === 0 && picked === null) picked = esc.id;
      }
      if (picked === null) {
        reasons.push(`阶段 ${minToHM(ph.startMin)}-${minToHM(ph.endMin)} 无可用护送员`);
      } else {
        ph.escortId = picked;
        assignedByEscort.set(picked, [...(assignedByEscort.get(picked) ?? []), ph]);
      }
    }
  }

  // 班车座位/轮椅固定位评估（原子核对在确认时以最新快照重跑本函数）
  if (arriveMin !== null) {
    for (const b of bookings) {
      const load = departureLoad(snap, b.departureId, excludeJourneyId);
      const def = SEED_DEPARTURES.find((d) => d.id === b.departureId)!;
      const wc = b.studentIds.filter((sid) => SEED_STUDENTS.find((s) => s.id === sid)!.wheelchair).length;
      const amb = b.studentIds.length - wc;
      if (load.bays + wc > load.capBays) {
        reasons.push(
          `班次 ${minToHM(def.departMin)} 轮椅固定位不足（已占 ${load.bays}/${load.capBays}，需 ${wc}）`,
        );
      }
      if (load.seats + amb > load.capSeats) {
        reasons.push(`班次 ${minToHM(def.departMin)} 座位不足（已占 ${load.seats}/${load.capSeats}，需 ${amb}）`);
      }
    }
  }

  return {
    groupId,
    mode,
    feasible: arriveMin !== null && reasons.length === 0,
    reasons: [...new Set(reasons)],
    legs,
    departMin: group.departMin,
    arriveMin,
    arriveByMin: group.arriveByMin,
    phases,
    bookings,
    escortChecks,
    stats,
  };
}

/** “必须乘车”的组合候选：步行到车站 -> 候车 -> 乘车 -> （终点即车站） */
function bestShuttleComposition(
  net: RoutingNetwork,
  originId: string,
  destId: string,
  departMin: number,
): { arriveMin: number; legs: JourneyLeg[] } | null {
  let best: { arriveMin: number; legs: JourneyLeg[] } | null = null;
  for (const ride of net.rides) {
    if (ride.toId !== destId) continue;
    const toStop = walkPath(net, originId, ride.fromId);
    if (!toStop) continue;
    const arriveStop = departMin + toStop.minutes;
    if (arriveStop > ride.departMin || ride.arriveMin > net.windowEndMin) continue;
    const legs: JourneyLeg[] = [];
    let t = departMin;
    let cur = originId;
    toStop.edgeIds.forEach((edgeId) => {
      const e = net.walkEdges.find((x) => x.id === edgeId)!;
      const nxt = e.fromId === cur ? e.toId : e.fromId;
      legs.push({ kind: 'walk', fromId: cur, toId: nxt, departMin: t, arriveMin: t + e.minutes, edgeId });
      t += e.minutes;
      cur = nxt;
    });
    if (ride.departMin > t) {
      legs.push({ kind: 'wait', fromId: ride.fromId, toId: ride.fromId, departMin: t, arriveMin: ride.departMin });
    }
    legs.push({
      kind: 'ride',
      fromId: ride.fromId,
      toId: ride.toId,
      departMin: ride.departMin,
      arriveMin: ride.arriveMin,
      departureId: ride.departureId,
    });
    if (!best || ride.arriveMin < best.arriveMin) best = { arriveMin: ride.arriveMin, legs };
  }
  return best;
}

// ---------- 派生状态 ----------

/** 组当前生效行程（已确认或执行中） */
export function activeJourneyOf(snap: Snapshot, groupId: string): TransitJourney | null {
  return (
    Object.values(snap.transit.journeys).find(
      (j) => j.groupId === groupId && (j.status === 'confirmed' || j.status === 'in_progress'),
    ) ?? null
  );
}

/** 扰动后的行程问题（不自动改行程，只标记，等待按新合法候选重新确认） */
export function journeyProblems(snap: Snapshot, j: TransitJourney): string[] {
  if (j.status !== 'confirmed' && j.status !== 'in_progress') return [];
  const problems: string[] = [];
  for (const leg of j.legs) {
    if (leg.kind === 'ride' && leg.departureId) {
      const dep = snap.transit.departures[leg.departureId];
      if (dep?.cancelled) {
        const def = SEED_DEPARTURES.find((d) => d.id === leg.departureId)!;
        problems.push(`班次 ${minToHM(def.departMin)} 已取消（${dep.reason ?? '未说明'}）`);
      }
    }
    if (leg.kind === 'walk' && leg.edgeId) {
      const edge = snap.transit.walkEdges[leg.edgeId];
      if (edge?.closed) {
        problems.push(
          `道路 ${locationById(leg.fromId).code}→${locationById(leg.toId).code} 已关闭（${edge.reason ?? '未说明'}）`,
        );
      }
    }
  }
  for (const p of j.phases) {
    if (p.status === 'released' || p.status === 'handed_over') continue;
    if (snap.transit.escorts[p.escortId]?.onLeave) {
      problems.push(`护送员 ${escortById(p.escortId).name} 请假中，需重新确认护送安排`);
    }
  }
  return [...new Set(problems)];
}

export interface EscortPosition {
  locId: string;
  onLeg: JourneyLeg | null;
  text: string;
}

/** 护送员实际位置：由已确认行程的模拟行程推出（不是实时 GPS） */
export function escortPositionAt(snap: Snapshot, escortId: string, tMin: number): EscortPosition {
  const esc = escortById(escortId);
  const phases = escortPhases(snap, escortId);
  for (const p of phases) {
    const end = effectiveEnd(p);
    if (tMin >= p.startMin && tMin <= end.min) {
      const journey = Object.values(snap.transit.journeys).find((j) => j.phases.some((x) => x.id === p.id));
      if (journey) {
        const leg = journey.legs.find((l) => tMin >= l.departMin && tMin < l.arriveMin);
        if (leg) {
          if (leg.kind === 'walk') {
            return {
              locId: leg.toId,
              onLeg: leg,
              text: `${minToHM(tMin)} 位于 ${locationById(leg.fromId).code}→${locationById(leg.toId).code} 步行段（护送${groupById(journey.groupId).name}）`,
            };
          }
          if (leg.kind === 'wait') {
            return {
              locId: leg.fromId,
              onLeg: leg,
              text: `${minToHM(tMin)} 在 ${locationById(leg.fromId).code} 候车（护送${groupById(journey.groupId).name}）`,
            };
          }
        }
        if (tMin === end.min) {
          return { locId: end.locId, onLeg: null, text: `${minToHM(tMin)} 在 ${locationById(end.locId).code}` };
        }
      }
    }
  }
  // 不在任何阶段内：取最近一个已结束阶段的落点，否则在基地
  const past = phases.filter((p) => effectiveEnd(p).min < tMin);
  if (past.length) {
    const end = effectiveEnd(past[past.length - 1]);
    return { locId: end.locId, onLeg: null, text: `${minToHM(tMin)} 在 ${locationById(end.locId).code}（空闲）` };
  }
  return { locId: esc.baseLocId, onLeg: null, text: `${minToHM(tMin)} 在 ${locationById(esc.baseLocId).code}（空闲）` };
}

/** 途中交接位置：仅当 tMin 时刻全组位于某个地点节点（非路段途中）才可交接 */
export function groupLocationAt(journey: TransitJourney, tMin: number): string | null {
  if (!journey.legs.length) return null;
  if (tMin === journey.legs[0].departMin) return journey.legs[0].fromId;
  for (const leg of journey.legs) {
    if (leg.kind === 'wait' && tMin >= leg.departMin && tMin <= leg.arriveMin) return leg.fromId;
    if (tMin === leg.arriveMin) return leg.toId;
  }
  return null;
}

// ---------- 通知与待办 ----------

export function latestNotificationOf(snap: Snapshot, groupId: string): TransitNotification | null {
  const list = Object.values(snap.transit.notifications)
    .filter((n) => n.groupId === groupId)
    .sort((a, b) => a.version - b.version);
  return list.length ? list[list.length - 1] : null;
}

export interface TransitTodo {
  kind: 'receive' | 'stale';
  groupId: string;
  notificationId: string;
  version: number;
  heldVersion: number;
  text: string;
}

/** 用户待办：最新通知未接收（含“持有的旧版本已作废”提示）；未接收者保留待办 */
export function transitTodos(snap: Snapshot, userId: string): TransitTodo[] {
  const todos: TransitTodo[] = [];
  for (const g of SEED_GROUPS) {
    const notes = Object.values(snap.transit.notifications)
      .filter((n) => n.groupId === g.id)
      .sort((a, b) => a.version - b.version);
    if (!notes.length) continue;
    const latest = notes[notes.length - 1];
    if (!latest.audience.includes(userId) || latest.receivedBy.includes(userId)) continue;
    const received = notes.filter((n) => n.receivedBy.includes(userId)).map((n) => n.version);
    const held = received.length ? Math.max(...received) : 0;
    todos.push({
      kind: held > 0 ? 'stale' : 'receive',
      groupId: g.id,
      notificationId: latest.id,
      version: latest.version,
      heldVersion: held,
      text:
        held > 0
          ? `${g.name}出行通知已更新到 v${latest.version}，你持有的 v${held} 已作废，请接收新版本`
          : `${g.name}出行通知 v${latest.version} 待接收`,
    });
  }
  return todos;
}

export { RECEIVING_TEACHER_ID, TRANSIT_WINDOW, hmToMin, minToHM };
