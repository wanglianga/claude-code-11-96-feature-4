// 出行命令层：把用户操作翻译为事件；确认时的原子核对在这里完成
// （候选计算不占座，确认以最新快照重算候选，任一资源不足即退回重算）

import type {
  AppEvent,
  EscortPhase,
  Snapshot,
  TransitJourney,
  TravelMode,
} from '../types';
import { ev, type CommandResult } from './commands';
import {
  RECEIVING_TEACHER_ID,
  SEED_DEPARTURES,
  SEED_ESCORTS,
  SEED_SHUTTLE_ROUTES,
  SEED_STUDENTS,
  escortById,
  groupById,
  locationById,
} from '../lib/seed';
import { minToHM } from '../lib/time';
import { uid } from '../lib/id';
import {
  activeJourneyOf,
  escortScheduleCheck,
  groupLocationAt,
  latestNotificationOf,
  planCandidate,
} from './transit';

function journeyOf(snap: Snapshot, journeyId: string): TransitJourney | null {
  return snap.transit.journeys[journeyId] ?? null;
}

function modeLabel(mode: TravelMode): string {
  return mode === 'walk' ? '步行护送' : '登记接驳';
}

function journeySummary(groupId: string, mode: TravelMode, departMin: number, arriveMin: number, escortNames: string[]): string {
  const g = groupById(groupId);
  return (
    `${g.name}（${g.studentIds.map((s) => SEED_STUDENTS.find((x) => x.id === s)!.name).join('、')}）` +
    `出行方式：${modeLabel(mode)}；${minToHM(departMin)} 从 ${locationById(g.originId).code} 出发，` +
    `预计 ${minToHM(arriveMin)} 到 ${locationById(g.destId).code}（要求 ${minToHM(g.arriveByMin)} 前）；` +
    `护送：${escortNames.join('、') || '无'}。`
  );
}

/** 确认登记：以当前快照重算候选并原子核对同行者/车次座位与固定位/护送员时间，任一不足退回重算 */
export function confirmJourney(
  snap: Snapshot,
  input: { groupId: string; mode: TravelMode; atMin: number; by: string },
): CommandResult {
  const group = groupById(input.groupId);
  if (activeJourneyOf(snap, group.id)) {
    return { ok: false, error: '该组已有生效行程，如需变更请使用“重新确认”', events: [] };
  }
  const plan = planCandidate(snap, group.id, input.mode);
  if (!plan.feasible) {
    return { ok: false, error: `资源或路线不足，已退回重算：${plan.reasons.join('；')}`, events: [] };
  }
  const journeyId = uid('jrn');
  const phases: EscortPhase[] = plan.phases.map((p) => ({
    id: uid('ph'),
    escortId: p.escortId,
    plannedStudentIds: [...p.studentIds],
    actualStudentIds: null,
    startLocId: p.startLocId,
    endLocId: p.endLocId,
    startMin: p.startMin,
    endMin: p.endMin,
    status: 'assigned',
    releasedAtMin: null,
    releasedAtLocId: null,
  }));
  const prior = latestNotificationOf(snap, group.id);
  const version = (prior?.version ?? 0) + 1;
  const notificationId = uid('tntf');
  const escortNames = phases.map((p) => escortById(p.escortId).name);
  const events: AppEvent[] = [
    ev(
      {
        type: 'transit.journeyConfirmed',
        journeyId,
        groupId: group.id,
        mode: input.mode,
        version,
        legs: plan.legs,
        phases,
        bookings: plan.bookings,
        departMin: plan.departMin,
        arriveMin: plan.arriveMin!,
        by: input.by,
      },
      input.atMin,
    ),
    ev(
      {
        type: 'transit.notificationSent',
        notificationId,
        journeyId,
        groupId: group.id,
        version,
        title: `【出行安排 v${version}】${group.name} ${modeLabel(input.mode)}`,
        body: journeySummary(group.id, input.mode, plan.departMin, plan.arriveMin!, escortNames),
        audience: [RECEIVING_TEACHER_ID, ...phases.map((p) => p.escortId)],
        supersedesId: prior?.id ?? null,
      },
      input.atMin,
    ),
  ];
  return { ok: true, events };
}

/** 重新确认：按扰动后的新快照重算合法候选，原子替代原行程（原安排保留为 superseded） */
export function rebookJourney(
  snap: Snapshot,
  input: { journeyId: string; mode: TravelMode; atMin: number; by: string },
): CommandResult {
  const old = journeyOf(snap, input.journeyId);
  if (!old) return { ok: false, error: '行程不存在', events: [] };
  if (old.status === 'in_progress') {
    return { ok: false, error: '行程已开始执行，不能整体重订；护送变更请用“途中交接”', events: [] };
  }
  if (old.status !== 'confirmed') {
    return { ok: false, error: '行程已被替代或取消', events: [] };
  }
  // 排除被替代行程自身的座位/护送员占用后重算候选
  const plan = planCandidate(snap, old.groupId, input.mode, old.id);
  if (!plan.feasible) {
    return {
      ok: false,
      error: `新的合法候选不可用，原安排保留：${plan.reasons.join('；')}`,
      events: [],
    };
  }
  const journeyId = uid('jrn');
  const phases: EscortPhase[] = plan.phases.map((p) => ({
    id: uid('ph'),
    escortId: p.escortId,
    plannedStudentIds: [...p.studentIds],
    actualStudentIds: null,
    startLocId: p.startLocId,
    endLocId: p.endLocId,
    startMin: p.startMin,
    endMin: p.endMin,
    status: 'assigned',
    releasedAtMin: null,
    releasedAtLocId: null,
  }));
  const prior = latestNotificationOf(snap, old.groupId);
  const version = old.version + 1;
  const notificationId = uid('tntf');
  const escortNames = phases.map((p) => escortById(p.escortId).name);
  const events: AppEvent[] = [
    ev(
      {
        type: 'transit.journeyRebooked',
        journeyId,
        replacesJourneyId: old.id,
        groupId: old.groupId,
        mode: input.mode,
        version,
        legs: plan.legs,
        phases,
        bookings: plan.bookings,
        departMin: plan.departMin,
        arriveMin: plan.arriveMin!,
        by: input.by,
      },
      input.atMin,
    ),
    ev(
      {
        type: 'transit.notificationSent',
        notificationId,
        journeyId,
        groupId: old.groupId,
        version,
        title: `【出行变更 v${version}】${groupById(old.groupId).name} ${modeLabel(input.mode)}`,
        body: journeySummary(old.groupId, input.mode, plan.departMin, plan.arriveMin!, escortNames),
        audience: [RECEIVING_TEACHER_ID, ...phases.map((p) => p.escortId)],
        supersedesId: prior?.id ?? null,
      },
      input.atMin,
    ),
  ];
  return { ok: true, events };
}

export function cancelJourney(
  snap: Snapshot,
  input: { journeyId: string; reason: string; atMin: number; by: string },
): CommandResult {
  const j = journeyOf(snap, input.journeyId);
  if (!j) return { ok: false, error: '行程不存在', events: [] };
  if (j.status !== 'confirmed') return { ok: false, error: '只有未开始的已确认行程可以取消', events: [] };
  return {
    ok: true,
    events: [
      ev(
        { type: 'transit.journeyCancelled', journeyId: j.id, reason: input.reason, by: input.by },
        input.atMin,
      ),
    ],
  };
}

// ---------- 执行状态机 ----------

export function acceptPhase(
  snap: Snapshot,
  input: { journeyId: string; phaseId: string; escortId: string; atMin: number },
): CommandResult {
  const j = journeyOf(snap, input.journeyId);
  if (!j || (j.status !== 'confirmed' && j.status !== 'in_progress')) {
    return { ok: false, error: '行程不存在或已失效', events: [] };
  }
  const p = j.phases.find((x) => x.id === input.phaseId);
  if (!p) return { ok: false, error: '护送阶段不存在', events: [] };
  if (p.escortId !== input.escortId) return { ok: false, error: '该阶段派给了其他护送员', events: [] };
  if (p.status !== 'assigned') return { ok: false, error: '阶段已接单或已结束', events: [] };
  if (snap.transit.escorts[input.escortId]?.onLeave) {
    return { ok: false, error: '护送员请假中，不能接单', events: [] };
  }
  return {
    ok: true,
    events: [
      ev(
        { type: 'transit.phaseAccepted', journeyId: j.id, phaseId: p.id, escortId: input.escortId },
        input.atMin,
      ),
    ],
  };
}

export function confirmPickup(
  snap: Snapshot,
  input: { journeyId: string; phaseId: string; studentIds: string[]; atMin: number },
): CommandResult {
  const j = journeyOf(snap, input.journeyId);
  if (!j || (j.status !== 'confirmed' && j.status !== 'in_progress')) {
    return { ok: false, error: '行程不存在或已失效', events: [] };
  }
  const p = j.phases.find((x) => x.id === input.phaseId);
  if (!p) return { ok: false, error: '护送阶段不存在', events: [] };
  if (p.status !== 'accepted') return { ok: false, error: '护送员须先接单，再确认接到学生', events: [] };
  if (input.atMin < p.startMin) {
    return { ok: false, error: `未到接应时间（${minToHM(p.startMin)} 起）`, events: [] };
  }
  if (!input.studentIds.length || !input.studentIds.every((s) => p.plannedStudentIds.includes(s))) {
    return { ok: false, error: '接到集合必须是非空且属于该阶段计划学生', events: [] };
  }
  // 同一学生不能同时处于两个护送阶段的责任集合中
  for (const other of Object.values(snap.transit.journeys)) {
    if (other.status !== 'confirmed' && other.status !== 'in_progress') continue;
    for (const op of other.phases) {
      if (op.id === p.id || op.status !== 'picked_up') continue;
      const clash = input.studentIds.filter((s) => op.actualStudentIds?.includes(s));
      if (clash.length) {
        return { ok: false, error: `学生 ${clash.join('、')} 已由其他护送阶段负责`, events: [] };
      }
    }
  }
  return {
    ok: true,
    events: [
      ev(
        { type: 'transit.pickupConfirmed', journeyId: j.id, phaseId: p.id, studentIds: [...input.studentIds] },
        input.atMin,
      ),
    ],
  };
}

/** 登记上车：护送员未接到本人不得登记 */
export function registerBoarding(
  snap: Snapshot,
  input: { journeyId: string; phaseId: string; departureId: string; studentIds: string[]; atMin: number },
): CommandResult {
  const j = journeyOf(snap, input.journeyId);
  if (!j || (j.status !== 'confirmed' && j.status !== 'in_progress')) {
    return { ok: false, error: '行程不存在或已失效', events: [] };
  }
  if (j.mode !== 'shuttle') return { ok: false, error: '该行程不是接驳方式', events: [] };
  const p = j.phases.find((x) => x.id === input.phaseId);
  if (!p) return { ok: false, error: '护送阶段不存在', events: [] };
  if (p.status !== 'picked_up' || !p.actualStudentIds) {
    return { ok: false, error: '护送员尚未接到学生，不得登记上车', events: [] };
  }
  if (!input.studentIds.length || !input.studentIds.every((s) => p.actualStudentIds!.includes(s))) {
    return { ok: false, error: '只能为护送员实际负责的学生登记上车', events: [] };
  }
  if (!j.bookings.some((b) => b.departureId === input.departureId)) {
    return { ok: false, error: '该班次不在本行程预订中', events: [] };
  }
  const depState = snap.transit.departures[input.departureId];
  if (depState?.cancelled) return { ok: false, error: '班次已取消，不能登记上车', events: [] };
  const def = SEED_DEPARTURES.find((d) => d.id === input.departureId)!;
  if (input.atMin > def.departMin) {
    return { ok: false, error: `班次 ${minToHM(def.departMin)} 已发车`, events: [] };
  }
  const already = input.studentIds.filter((s) => j.boarded.includes(s));
  if (already.length) return { ok: false, error: '部分学生已登记上车', events: [] };
  return {
    ok: true,
    events: [
      ev(
        {
          type: 'transit.boarded',
          journeyId: j.id,
          phaseId: p.id,
          departureId: input.departureId,
          studentIds: [...input.studentIds],
        },
        input.atMin,
      ),
    ],
  };
}

export function registerAlighting(
  snap: Snapshot,
  input: { journeyId: string; studentIds: string[]; atMin: number },
): CommandResult {
  const j = journeyOf(snap, input.journeyId);
  if (!j || j.status !== 'in_progress') return { ok: false, error: '行程不在执行中', events: [] };
  if (!input.studentIds.length || !input.studentIds.every((s) => j.boarded.includes(s))) {
    return { ok: false, error: '只有已登记上车学生才能登记下车', events: [] };
  }
  const ride = j.legs.find((l) => l.kind === 'ride');
  if (ride && input.atMin < ride.arriveMin) {
    return { ok: false, error: `班车尚未到达（${minToHM(ride.arriveMin)} 到）`, events: [] };
  }
  const already = input.studentIds.filter((s) => j.alighted.includes(s));
  if (already.length) return { ok: false, error: '部分学生已登记下车', events: [] };
  const rideBooking = j.bookings[0];
  return {
    ok: true,
    events: [
      ev(
        {
          type: 'transit.alighted',
          journeyId: j.id,
          departureId: rideBooking?.departureId ?? '',
          studentIds: [...input.studentIds],
        },
        input.atMin,
      ),
    ],
  };
}

/** 交接给教师：步行方式在到达后由护送员交接；接驳方式在下车后交接 */
export function handToTeacher(
  snap: Snapshot,
  input: { journeyId: string; studentIds: string[]; teacherId: string; atMin: number },
): CommandResult {
  const j = journeyOf(snap, input.journeyId);
  if (!j || j.status !== 'in_progress') return { ok: false, error: '行程不在执行中', events: [] };
  if (input.teacherId !== RECEIVING_TEACHER_ID) {
    return { ok: false, error: '接收教师不符', events: [] };
  }
  if (!input.studentIds.length) return { ok: false, error: '交接集合不能为空', events: [] };
  if (j.mode === 'walk') {
    const covered = j.phases
      .filter((p) => p.status === 'picked_up')
      .flatMap((p) => p.actualStudentIds ?? []);
    if (!input.studentIds.every((s) => covered.includes(s))) {
      return { ok: false, error: '学生不在护送员实际负责集合中', events: [] };
    }
    if (input.atMin < j.arriveMin) {
      return { ok: false, error: `尚未到达（预计 ${minToHM(j.arriveMin)} 到）`, events: [] };
    }
  } else {
    if (!input.studentIds.every((s) => j.alighted.includes(s))) {
      return { ok: false, error: '学生尚未登记下车', events: [] };
    }
  }
  const already = input.studentIds.filter((s) => j.handed.includes(s));
  if (already.length) return { ok: false, error: '部分学生已交接', events: [] };
  return {
    ok: true,
    events: [
      ev(
        {
          type: 'transit.handedToTeacher',
          journeyId: j.id,
          studentIds: [...input.studentIds],
          teacherId: input.teacherId,
        },
        input.atMin,
      ),
    ],
  };
}

/** 确认到课：与交接、车程结束分别记录；全组到课后行程完成 */
export function confirmArrival(
  snap: Snapshot,
  input: { journeyId: string; studentId: string; teacherId: string; atMin: number },
): CommandResult {
  const j = journeyOf(snap, input.journeyId);
  if (!j || j.status !== 'in_progress') return { ok: false, error: '行程不在执行中', events: [] };
  if (input.teacherId !== RECEIVING_TEACHER_ID) {
    return { ok: false, error: '接收教师不符', events: [] };
  }
  if (!j.handed.includes(input.studentId)) {
    return { ok: false, error: '学生尚未交接给教师，不能确认到课', events: [] };
  }
  if (j.arrived.includes(input.studentId)) return { ok: false, error: '该学生已确认到课', events: [] };
  return {
    ok: true,
    events: [
      ev(
        {
          type: 'transit.arrivalConfirmed',
          journeyId: j.id,
          studentId: input.studentId,
          teacherId: input.teacherId,
        },
        input.atMin,
      ),
    ],
  };
}

/**
 * 途中交接：原责任保持到接续者实际确认（本命令即接续确认，单事件原子完成）。
 * 交接只能在全组位于地点节点时进行（模拟行程确认位置）。
 */
export function handoverPhase(
  snap: Snapshot,
  input: { journeyId: string; fromPhaseId: string; toEscortId: string; studentIds: string[]; atMin: number },
): CommandResult {
  const j = journeyOf(snap, input.journeyId);
  if (!j || j.status !== 'in_progress') return { ok: false, error: '行程不在执行中', events: [] };
  const from = j.phases.find((x) => x.id === input.fromPhaseId);
  if (!from || from.status !== 'picked_up' || !from.actualStudentIds) {
    return { ok: false, error: '原护送阶段不在负责状态', events: [] };
  }
  if (!input.studentIds.length || !input.studentIds.every((s) => from.actualStudentIds!.includes(s))) {
    return { ok: false, error: '交接集合必须属于原阶段实际负责学生', events: [] };
  }
  if (input.toEscortId === from.escortId) {
    return { ok: false, error: '接续护送员不能是原护送员', events: [] };
  }
  const toEscort = SEED_ESCORTS.find((e) => e.id === input.toEscortId);
  if (!toEscort) return { ok: false, error: '接续护送员不存在', events: [] };
  if (snap.transit.escorts[toEscort.id]?.onLeave) {
    return { ok: false, error: '接续护送员请假中', events: [] };
  }
  const loc = groupLocationAt(j, input.atMin);
  if (!loc) {
    return { ok: false, error: '当前时刻全组在路段途中，无法交接；请在到达地点节点时交接', events: [] };
  }
  const newPhase: EscortPhase = {
    id: uid('ph'),
    escortId: toEscort.id,
    plannedStudentIds: [...input.studentIds],
    actualStudentIds: [...input.studentIds],
    startLocId: loc,
    endLocId: from.endLocId,
    startMin: input.atMin,
    endMin: from.endMin,
    status: 'picked_up',
    releasedAtMin: null,
    releasedAtLocId: null,
  };
  const errs = escortScheduleCheck(snap, toEscort, [
    {
      startMin: newPhase.startMin,
      endMin: newPhase.endMin,
      startLocId: newPhase.startLocId,
      endLocId: newPhase.endLocId,
      studentCount: input.studentIds.length,
    },
  ]);
  if (errs.length) {
    return { ok: false, error: `接续护送员不可行：${errs.join('；')}`, events: [] };
  }
  return {
    ok: true,
    events: [
      ev(
        {
          type: 'transit.phaseHandedOver',
          journeyId: j.id,
          fromPhaseId: from.id,
          newPhase,
          studentIds: [...input.studentIds],
        },
        input.atMin,
      ),
    ],
  };
}

// ---------- 扰动与通知 ----------

export function cancelDeparture(
  snap: Snapshot,
  input: { departureId: string; reason: string; atMin: number; by: string },
): CommandResult {
  const st = snap.transit.departures[input.departureId];
  if (!st) return { ok: false, error: '班次不存在', events: [] };
  if (st.cancelled) return { ok: false, error: '班次已取消', events: [] };
  return {
    ok: true,
    events: [
      ev(
        { type: 'transit.departureCancelled', departureId: input.departureId, reason: input.reason, by: input.by },
        input.atMin,
      ),
    ],
  };
}

export function closeWalkEdge(
  snap: Snapshot,
  input: { edgeId: string; reason: string; atMin: number; by: string },
): CommandResult {
  const st = snap.transit.walkEdges[input.edgeId];
  if (!st) return { ok: false, error: '步行边不存在', events: [] };
  if (st.closed) return { ok: false, error: '该道路已处于封闭状态', events: [] };
  return {
    ok: true,
    events: [
      ev(
        { type: 'transit.walkEdgeClosed', edgeId: input.edgeId, reason: input.reason, by: input.by },
        input.atMin,
      ),
    ],
  };
}

/** 设施解除封路：直达连廊恢复的唯一入口，解除前任何重算都不自动恢复直达 */
export function reopenWalkEdge(
  snap: Snapshot,
  input: { edgeId: string; atMin: number; by: string },
): CommandResult {
  const st = snap.transit.walkEdges[input.edgeId];
  if (!st) return { ok: false, error: '步行边不存在', events: [] };
  if (!st.closed) return { ok: false, error: '该道路未封闭', events: [] };
  return {
    ok: true,
    events: [ev({ type: 'transit.walkEdgeReopened', edgeId: input.edgeId, by: input.by }, input.atMin)],
  };
}

export function setEscortLeave(
  snap: Snapshot,
  input: { escortId: string; onLeave: boolean; atMin: number; by: string },
): CommandResult {
  if (!SEED_ESCORTS.some((e) => e.id === input.escortId)) {
    return { ok: false, error: '护送员不存在', events: [] };
  }
  const cur = snap.transit.escorts[input.escortId]?.onLeave ?? false;
  if (cur === input.onLeave) {
    return { ok: false, error: input.onLeave ? '护送员已在请假中' : '护送员未在请假中', events: [] };
  }
  return {
    ok: true,
    events: [
      ev(
        { type: 'transit.escortLeaveSet', escortId: input.escortId, onLeave: input.onLeave, by: input.by },
        input.atMin,
      ),
    ],
  };
}

/** 临时满载：登记其他乘客占用的座位/轮椅固定位 */
export function setDepartureLoad(
  snap: Snapshot,
  input: { departureId: string; reservedSeats: number; reservedBays: number; atMin: number; by: string },
): CommandResult {
  const def = SEED_DEPARTURES.find((d) => d.id === input.departureId);
  if (!def) return { ok: false, error: '班次不存在', events: [] };
  const route = SEED_SHUTTLE_ROUTES.find((r) => r.id === def.routeId)!;
  if (input.reservedSeats < 0 || input.reservedBays < 0) {
    return { ok: false, error: '占用数不能为负', events: [] };
  }
  if (input.reservedSeats > route.seats || input.reservedBays > route.wheelchairBays) {
    return {
      ok: false,
      error: `占用超出班车容量（座位 ≤${route.seats}，固定位 ≤${route.wheelchairBays}）`,
      events: [],
    };
  }
  return {
    ok: true,
    events: [
      ev(
        {
          type: 'transit.departureLoadSet',
          departureId: input.departureId,
          reservedSeats: input.reservedSeats,
          reservedBays: input.reservedBays,
          by: input.by,
        },
        input.atMin,
      ),
    ],
  };
}

export function receiveTransitNotification(
  snap: Snapshot,
  input: { notificationId: string; userId: string; atMin: number },
): CommandResult {
  const n = snap.transit.notifications[input.notificationId];
  if (!n) return { ok: false, error: '通知不存在', events: [] };
  if (!n.audience.includes(input.userId)) return { ok: false, error: '该通知不是发给你的', events: [] };
  if (n.receivedBy.includes(input.userId)) return { ok: false, error: '已接收过该通知', events: [] };
  return {
    ok: true,
    events: [
      ev(
        { type: 'transit.notificationReceived', notificationId: input.notificationId, userId: input.userId },
        input.atMin,
      ),
    ],
  };
}
