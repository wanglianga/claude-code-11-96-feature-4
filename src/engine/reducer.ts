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
  WorkOrder,
} from '../types';
import { SEED_COURSES, SEED_ROOMS } from '../lib/seed';

export function initialSnapshot(): Snapshot {
  const rooms: Snapshot['rooms'] = {};
  for (const r of SEED_ROOMS) rooms[r.id] = structuredClone(r);
  const courses: Snapshot['courses'] = {};
  for (const c of SEED_COURSES) courses[c.id] = structuredClone(c);
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
