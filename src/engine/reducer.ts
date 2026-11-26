// 事件溯源 reducer：纯函数，把事件流回放成当前快照
// 浏览器 WebWorker 与 vitest 共用同一份逻辑，保证“可回放”

import type {
  AppEvent,
  Course,
  Incident,
  NotificationDoc,
  ReassignmentPlan,
  Report,
  RoomClosure,
  Snapshot,
  TransitJourney,
  TransitNotification,
  WorkOrder,
} from '../types';
import { SEED_COURSES, SEED_DEPARTURES, SEED_ESCORTS, SEED_ROOMS, SEED_WALK_EDGES } from '../lib/seed';
import { isoToMin } from '../lib/time';

export function initialSnapshot(): Snapshot {
  const rooms: Snapshot['rooms'] = {};
  for (const r of SEED_ROOMS) rooms[r.id] = structuredClone(r);
  const courses: Snapshot['courses'] = {};
  for (const c of SEED_COURSES) courses[c.id] = structuredClone(c);
  const walkEdges: Snapshot['transit']['walkEdges'] = {};
  for (const e of SEED_WALK_EDGES) {
    walkEdges[e.id] = { closed: e.closedSeed, reason: e.closedSeed ? (e.note ?? '封闭') : null };
  }
  const departures: Snapshot['transit']['departures'] = {};
  for (const d of SEED_DEPARTURES) {
    departures[d.id] = { cancelled: false, reason: null, reservedSeats: 0, reservedBays: 0 };
  }
  const escorts: Snapshot['transit']['escorts'] = {};
  for (const e of SEED_ESCORTS) escorts[e.id] = { onLeave: false };
  return {
    seq: 0,
    rooms,
    closures: {},
    courses,
    incidents: {},
    reports: {},
    workOrders: {},
    plans: {},
    notifications: {},
    transit: {
      walkEdges,
      departures,
      escorts,
      journeys: {},
      notifications: {},
    },
  };
}

export function applyEvent(prev: Snapshot, ev: AppEvent): Snapshot {
  const s: Snapshot = structuredClone(prev);
  s.seq = ev.seq;

  switch (ev.type) {
    case 'incident.created': {
      const incident: Incident = {
        id: ev.incidentId,
        faultType: ev.faultType,
        roomIds: [...ev.roomIds],
        status: 'reported',
        reportIds: [],
        workOrderId: null,
        createdAt: ev.at,
        confirmedAt: null,
        estimatedEndMin: null,
        repairedAt: null,
        verifiedAt: null,
        retestFailures: [],
      };
      s.incidents[ev.incidentId] = incident;
      break;
    }

    case 'report.submitted': {
      const report: Report = {
        id: ev.reportId,
        incidentId: ev.incidentId,
        roomId: ev.roomId,
        faultType: ev.faultType,
        description: ev.description,
        photoIds: [...ev.photoIds],
        teacherId: ev.teacherId,
        at: ev.at,
        duplicate: ev.duplicate,
      };
      s.reports[ev.reportId] = report;
      const inc = s.incidents[ev.incidentId];
      if (inc) {
        inc.reportIds.push(ev.reportId);
        // 同一主管影响多间教室：报修房间并入事故边界（待设施核准）
        if (!inc.roomIds.includes(ev.roomId)) inc.roomIds.push(ev.roomId);
      }
      break;
    }

    case 'incident.boundaryConfirmed': {
      const inc = s.incidents[ev.incidentId];
      if (!inc) break;
      inc.status = 'confirmed';
      inc.confirmedAt = ev.at;
      inc.roomIds = [...ev.roomIds];
      inc.estimatedEndMin = ev.estimatedEndMin;
      for (const roomId of ev.roomIds) {
        const closure: RoomClosure = {
          incidentId: ev.incidentId,
          roomIds: [...ev.roomIds],
          sinceMin: ev.sinceMin,
          estimatedEndMin: ev.estimatedEndMin,
          closed: true,
          reopenedAt: null,
        };
        s.closures[roomId] = closure;
      }
      break;
    }

    case 'workorder.created': {
      const inc = s.incidents[ev.incidentId];
      const wo: WorkOrder = {
        id: ev.workOrderId,
        incidentId: ev.incidentId,
        summary: ev.summary,
        assignee: ev.assignee,
        createdAt: ev.at,
        completedAt: null,
      };
      s.workOrders[ev.workOrderId] = wo;
      if (inc) {
        inc.status = 'work_order';
        inc.workOrderId = ev.workOrderId;
      }
      break;
    }

    case 'repair.marked': {
      const inc = s.incidents[ev.incidentId];
      if (inc) {
        inc.status = 'repaired';
        inc.repairedAt = ev.at;
        if (inc.workOrderId) {
          s.workOrders[inc.workOrderId].completedAt = ev.at;
        }
      }
      // 关键规则：维修标记“已修复”不解除封闭，必须等设施复测
      break;
    }

    case 'retest.failed': {
      const inc = s.incidents[ev.incidentId];
      if (inc) {
        inc.retestFailures.push({ at: ev.at, note: ev.note });
        // 维持 repaired 状态等待返修后再次复测，封闭不解除
      }
      break;
    }

    case 'retest.passed': {
      const inc = s.incidents[ev.incidentId];
      if (inc) {
        inc.status = 'verified';
        inc.verifiedAt = ev.at;
        for (const roomId of inc.roomIds) {
          const closure = s.closures[roomId];
          if (closure && closure.incidentId === inc.id) {
            closure.closed = false;
            closure.reopenedAt = ev.at;
          }
        }
      }
      break;
    }

    case 'reassignment.proposed': {
      const plan: ReassignmentPlan = {
        id: ev.planId,
        strategy: ev.strategy,
        moves: ev.moves.map((m) => ({ ...m })),
        studentMinutes: ev.studentMinutes,
        notifiedClassIds: [...ev.notifiedClassIds],
        status: 'proposed',
        createdAt: ev.at,
        confirmedCourseIds: [],
        publishedAt: null,
        notificationIds: [],
        affectedRoomIds: [...ev.affectedRoomIds],
      };
      s.plans[ev.planId] = plan;
      break;
    }

    case 'reassignment.confirmed': {
      const plan = s.plans[ev.planId];
      if (plan && !plan.confirmedCourseIds.includes(ev.courseId)) {
        plan.confirmedCourseIds.push(ev.courseId);
      }
      break;
    }

    case 'reassignment.published': {
      const plan = s.plans[ev.planId];
      if (!plan) break;
      plan.status = 'published';
      plan.publishedAt = ev.at;
      plan.notificationIds = [...ev.notificationIds];
      for (const move of plan.moves) {
        const course = s.courses[move.courseId];
        if (course) {
          course.roomId = move.toRoomId;
          course.status = 'reassigned';
          course.planId = plan.id;
        }
      }
      break;
    }

    case 'reassignment.cancelled': {
      const plan = s.plans[ev.planId];
      if (plan) plan.status = 'cancelled';
      break;
    }

    case 'notification.sent': {
      if (ev.supersedesId && s.notifications[ev.supersedesId]) {
        s.notifications[ev.supersedesId].superseded = true;
      }
      const doc: NotificationDoc = {
        id: ev.notificationId,
        version: ev.version,
        courseId: ev.courseId,
        className: ev.className,
        teacherId: ev.teacherId,
        roomId: ev.roomId,
        roomName: ev.roomName,
        startMin: ev.startMin,
        endMin: ev.endMin,
        title: ev.title,
        body: ev.body,
        planId: ev.planId,
        createdAt: ev.at,
        superseded: false,
      };
      s.notifications[ev.notificationId] = doc;
      break;
    }

    // ---------- 无障碍出行 ----------

    case 'transit.journeyConfirmed':
    case 'transit.journeyRebooked': {
      if (ev.type === 'transit.journeyRebooked') {
        const old = s.transit.journeys[ev.replacesJourneyId];
        if (old) {
          old.status = 'superseded';
          old.replacedByJourneyId = ev.journeyId;
        }
      }
      const journey: TransitJourney = {
        id: ev.journeyId,
        groupId: ev.groupId,
        mode: ev.mode,
        version: ev.version,
        legs: ev.legs.map((l) => ({ ...l })),
        phases: ev.phases.map((p) => ({ ...p })),
        bookings: ev.bookings.map((b) => ({ ...b, studentIds: [...b.studentIds] })),
        departMin: ev.departMin,
        arriveMin: ev.arriveMin,
        status: 'confirmed',
        boarded: [],
        alighted: [],
        handed: [],
        arrived: [],
        createdAtMin: isoToMin(ev.at),
        replacedByJourneyId: null,
      };
      s.transit.journeys[ev.journeyId] = journey;
      break;
    }

    case 'transit.journeyCancelled': {
      const j = s.transit.journeys[ev.journeyId];
      if (j) j.status = 'cancelled';
      break;
    }

    case 'transit.phaseAccepted': {
      const p = s.transit.journeys[ev.journeyId]?.phases.find((x) => x.id === ev.phaseId);
      if (p && p.status === 'assigned') p.status = 'accepted';
      break;
    }

    case 'transit.pickupConfirmed': {
      const j = s.transit.journeys[ev.journeyId];
      const p = j?.phases.find((x) => x.id === ev.phaseId);
      if (j && p && p.status === 'accepted') {
        p.status = 'picked_up';
        p.actualStudentIds = [...ev.studentIds];
        j.status = 'in_progress';
      }
      break;
    }

    case 'transit.boarded': {
      const j = s.transit.journeys[ev.journeyId];
      if (!j) break;
      for (const sid of ev.studentIds) if (!j.boarded.includes(sid)) j.boarded.push(sid);
      // 护送员责任在登记上车完成时结束（车门交接）
      const p = j.phases.find((x) => x.id === ev.phaseId);
      if (p && p.status === 'picked_up' && p.actualStudentIds?.every((sid) => j.boarded.includes(sid))) {
        p.status = 'released';
        p.releasedAtMin = isoToMin(ev.at);
        p.releasedAtLocId = p.endLocId;
      }
      break;
    }

    case 'transit.alighted': {
      const j = s.transit.journeys[ev.journeyId];
      if (!j) break;
      for (const sid of ev.studentIds) if (!j.alighted.includes(sid)) j.alighted.push(sid);
      break;
    }

    case 'transit.handedToTeacher': {
      const j = s.transit.journeys[ev.journeyId];
      if (!j) break;
      for (const sid of ev.studentIds) if (!j.handed.includes(sid)) j.handed.push(sid);
      // 步行方式：护送员把实际负责学生全部交接后，阶段释放
      for (const p of j.phases) {
        if (
          p.status === 'picked_up' &&
          p.actualStudentIds &&
          p.actualStudentIds.every((sid) => j.handed.includes(sid))
        ) {
          p.status = 'released';
          p.releasedAtMin = isoToMin(ev.at);
          p.releasedAtLocId = p.endLocId;
        }
      }
      break;
    }

    case 'transit.arrivalConfirmed': {
      const j = s.transit.journeys[ev.journeyId];
      if (!j) break;
      if (!j.arrived.includes(ev.studentId)) j.arrived.push(ev.studentId);
      // 全组（各阶段计划学生的并集）都确认到课后行程完成
      const planned = [...new Set(j.phases.flatMap((p) => p.plannedStudentIds))];
      if (planned.length > 0 && planned.every((sid) => j.arrived.includes(sid)) && j.status === 'in_progress') {
        j.status = 'completed';
      }
      break;
    }

    case 'transit.phaseHandedOver': {
      const j = s.transit.journeys[ev.journeyId];
      if (!j) break;
      const from = j.phases.find((x) => x.id === ev.fromPhaseId);
      if (from && from.actualStudentIds) {
        from.actualStudentIds = from.actualStudentIds.filter((sid) => !ev.studentIds.includes(sid));
        if (from.actualStudentIds.length === 0) {
          // 原责任到接续者实际确认（本事件）才解除
          from.status = 'handed_over';
          from.releasedAtMin = isoToMin(ev.at);
          from.releasedAtLocId = ev.newPhase.startLocId;
        }
      }
      j.phases.push({ ...ev.newPhase, plannedStudentIds: [...ev.newPhase.plannedStudentIds], actualStudentIds: ev.newPhase.actualStudentIds ? [...ev.newPhase.actualStudentIds] : null });
      break;
    }

    case 'transit.departureCancelled': {
      const d = s.transit.departures[ev.departureId];
      if (d) {
        d.cancelled = true;
        d.reason = ev.reason;
      }
      break;
    }

    case 'transit.walkEdgeClosed': {
      const e = s.transit.walkEdges[ev.edgeId];
      if (e) {
        e.closed = true;
        e.reason = ev.reason;
      }
      break;
    }

    case 'transit.walkEdgeReopened': {
      const e = s.transit.walkEdges[ev.edgeId];
      if (e) {
        e.closed = false;
        e.reason = null;
      }
      break;
    }

    case 'transit.escortLeaveSet': {
      const esc = s.transit.escorts[ev.escortId];
      if (esc) esc.onLeave = ev.onLeave;
      break;
    }

    case 'transit.departureLoadSet': {
      const d = s.transit.departures[ev.departureId];
      if (d) {
        d.reservedSeats = ev.reservedSeats;
        d.reservedBays = ev.reservedBays;
      }
      break;
    }

    case 'transit.notificationSent': {
      if (ev.supersedesId && s.transit.notifications[ev.supersedesId]) {
        s.transit.notifications[ev.supersedesId].superseded = true;
      }
      const doc: TransitNotification = {
        id: ev.notificationId,
        journeyId: ev.journeyId,
        groupId: ev.groupId,
        version: ev.version,
        title: ev.title,
        body: ev.body,
        audience: [...ev.audience],
        receivedBy: [],
        superseded: false,
        createdAtMin: isoToMin(ev.at),
      };
      s.transit.notifications[ev.notificationId] = doc;
      break;
    }

    case 'transit.notificationReceived': {
      const n = s.transit.notifications[ev.notificationId];
      if (n && !n.receivedBy.includes(ev.userId)) n.receivedBy.push(ev.userId);
      break;
    }
  }

  return s;
}

export function replay(events: AppEvent[], base?: Snapshot): Snapshot {
  return events.reduce(applyEvent, base ?? initialSnapshot());
}

export function coursesAffectedByClosures(snap: Snapshot): Course[] {
  const closedRoomIds = Object.entries(snap.closures)
    .filter(([, c]) => c.closed)
    .map(([roomId]) => roomId);
  return Object.values(snap.courses).filter((c) => closedRoomIds.includes(c.roomId));
}
