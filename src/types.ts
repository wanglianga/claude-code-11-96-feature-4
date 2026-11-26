// 领域类型定义：事件溯源模型，所有状态变更都通过事件回放得到

export type Role = 'teacher' | 'facility' | 'dispatcher' | 'repair';

export type FaultType = 'leak' | 'power' | 'equipment';

export type IncidentStatus =
  | 'reported' // 已报修，待设施核准
  | 'confirmed' // 已核准事故边界，教室封闭
  | 'work_order' // 已生成工单/维修中
  | 'repaired' // 维修人员标记已修复，待复测
  | 'verified'; // 设施复测通过，解除封闭

export type CourseStatus = 'normal' | 'reassigned';

export type PlanStatus = 'proposed' | 'published' | 'cancelled';

export type DraftStatus = 'draft' | 'submitted' | 'conflict' | 'expired';

export interface User {
  id: string;
  name: string;
  role: Role;
}

export interface Room {
  id: string;
  code: string; // 教室码，扫码用
  name: string;
  capacity: number;
  equipment: string[]; // projector / lab_bench
  accessible: boolean; // 无障碍通道
  safety: boolean; // 安全条件
}

export interface RoomClosure {
  incidentId: string;
  roomIds: string[];
  sinceMin: number;
  estimatedEndMin: number | null; // 预计修复时间，仅参考，不会自动解封
  closed: boolean;
  reopenedAt: string | null;
}

export interface Course {
  id: string;
  className: string;
  teacherId: string;
  roomId: string;
  originalRoomId: string;
  startMin: number;
  endMin: number;
  size: number;
  requirements: string[];
  flexible: boolean; // 弹性课程（可被交换）
  status: CourseStatus;
  planId: string | null;
}

export interface Report {
  id: string;
  incidentId: string;
  roomId: string;
  faultType: FaultType;
  description: string;
  photoIds: string[];
  teacherId: string;
  at: string;
  duplicate: boolean;
}

export interface Incident {
  id: string;
  faultType: FaultType;
  roomIds: string[];
  status: IncidentStatus;
  reportIds: string[];
  workOrderId: string | null;
  createdAt: string;
  confirmedAt: string | null;
  estimatedEndMin: number | null;
  repairedAt: string | null;
  verifiedAt: string | null;
  retestFailures: { at: string; note: string }[];
}

export interface WorkOrder {
  id: string;
  incidentId: string;
  summary: string;
  assignee: string;
  createdAt: string;
  completedAt: string | null;
}

export interface ReassignmentMove {
  courseId: string;
  fromRoomId: string;
  toRoomId: string;
  studentMinutes: number;
}

export interface ReassignmentPlan {
  id: string;
  strategy: 'minimal' | 'swap';
  moves: ReassignmentMove[];
  studentMinutes: number;
  notifiedClassIds: string[];
  status: PlanStatus;
  createdAt: string;
  confirmedCourseIds: string[];
  publishedAt: string | null;
  notificationIds: string[];
  affectedRoomIds: string[];
}

export interface NotificationDoc {
  id: string;
  version: number;
  courseId: string;
  className: string;
  teacherId: string;
  roomId: string;
  roomName: string;
  startMin: number;
  endMin: number;
  title: string;
  body: string;
  planId: string;
  createdAt: string;
  superseded: boolean;
}

// ---------- 事件 ----------

export type AppEvent =
  | {
      seq: number;
      at: string;
      type: 'incident.created';
      incidentId: string;
      roomIds: string[];
      faultType: FaultType;
      sourceReportId: string;
    }
  | {
      seq: number;
      at: string;
      type: 'report.submitted';
      reportId: string;
      incidentId: string;
      roomId: string;
      faultType: FaultType;
      description: string;
      photoIds: string[];
      teacherId: string;
      duplicate: boolean;
    }
  | {
      seq: number;
      at: string;
      type: 'incident.boundaryConfirmed';
      incidentId: string;
      roomIds: string[];
      sinceMin: number;
      estimatedEndMin: number;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'workorder.created';
      workOrderId: string;
      incidentId: string;
      summary: string;
      assignee: string;
    }
  | {
      seq: number;
      at: string;
      type: 'repair.marked';
      incidentId: string;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'retest.failed';
      incidentId: string;
      by: string;
      note: string;
    }
  | {
      seq: number;
      at: string;
      type: 'retest.passed';
      incidentId: string;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'reassignment.proposed';
      planId: string;
      strategy: 'minimal' | 'swap';
      moves: ReassignmentMove[];
      studentMinutes: number;
      notifiedClassIds: string[];
      affectedRoomIds: string[];
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'reassignment.confirmed';
      planId: string;
      courseId: string;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'reassignment.published';
      planId: string;
      notificationIds: string[];
    }
  | {
      seq: number;
      at: string;
      type: 'reassignment.cancelled';
      planId: string;
      reason: string;
    }
  | {
      seq: number;
      at: string;
      type: 'notification.sent';
      notificationId: string;
      version: number;
      courseId: string;
      className: string;
      teacherId: string;
      roomId: string;
      roomName: string;
      startMin: number;
      endMin: number;
      title: string;
      body: string;
      planId: string;
      supersedesId: string | null;
    };

export interface Snapshot {
  seq: number;
  rooms: Record<string, Room>;
  closures: Record<string, RoomClosure>; // roomId -> closure
  courses: Record<string, Course>;
  incidents: Record<string, Incident>;
  reports: Record<string, Report>;
  workOrders: Record<string, WorkOrder>;
  plans: Record<string, ReassignmentPlan>;
  notifications: Record<string, NotificationDoc>;
}

export interface Draft {
  id: string;
  teacherId: string;
  roomId: string;
  courseId: string | null;
  faultType: FaultType;
  description: string;
  photoIds: string[];
  status: DraftStatus;
  baseSeq: number; // 保存草稿时的事件版本，用于联网后冲突检测
  conflictReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BlobMeta {
  id: string;
  mime: string;
  size: number;
  createdAt: string;
}
