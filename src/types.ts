// 领域类型定义：事件溯源模型，所有状态变更都通过事件回放得到

export type Role = 'teacher' | 'facility' | 'dispatcher' | 'repair' | 'escort';

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

// ---------- 无障碍出行（连廊封闭后的步行护送 / 登记接驳） ----------

export type TravelMode = 'walk' | 'shuttle';

/** 地点（静态种子）：O 宿舍区 / S 接驳站 / W 绕行点 / C 楼 */
export interface TransitLocation {
  id: string;
  code: string;
  name: string;
}

/** 步行边（静态种子）：均为已批准无障碍路径；closedSeed 表示初始封闭（连廊） */
export interface WalkEdgeDef {
  id: string;
  fromId: string;
  toId: string;
  minutes: number; // 非负整分钟
  accessible: boolean;
  closedSeed: boolean;
  note: string | null;
}

/** 班车线路（静态种子） */
export interface ShuttleRouteDef {
  id: string;
  fromId: string;
  toId: string;
  rideMinutes: number;
  seats: number; // 普通座位数
  wheelchairBays: number; // 轮椅固定位数
}

/** 班次（静态种子）：整分钟发车 */
export interface ShuttleDepartureDef {
  id: string;
  routeId: string;
  departMin: number;
}

export interface TransitStudent {
  id: string;
  name: string;
  wheelchair: boolean; // 需要轮椅固定位
  groupId: string;
}

export interface StudentGroup {
  id: string;
  name: string;
  studentIds: string[];
  originId: string;
  destId: string;
  departMin: number; // 从起点出发时刻
  arriveByMin: number; // 最晚到达时刻
}

export interface EscortDef {
  id: string; // 与护送员用户账号同 id
  name: string;
  baseLocId: string; // 可用窗口开始时的所在地点
  fromMin: number; // 可用窗口（含两端）
  toMin: number;
  maxStudents: number; // 同时最多带领人数
}

/** 行程的一段：步行 / 等候 / 乘车（时间展开图显式等候，地点图在边上算等候，统一落成该结构） */
export interface JourneyLeg {
  kind: 'walk' | 'wait' | 'ride';
  fromId: string;
  toId: string;
  departMin: number;
  arriveMin: number;
  edgeId?: string; // walk 段对应的步行边
  departureId?: string; // ride 段对应的班次
}

export type EscortPhaseStatus =
  | 'assigned' // 已派单，护送员未接单
  | 'accepted' // 已接单
  | 'picked_up' // 已接到学生，实际负责中
  | 'released' // 正常完成（交接教师或登记上车后释放）
  | 'handed_over'; // 已被途中交接的接续者接替

/** 护送阶段：每阶段另存实际负责的学生集合（pickup 后写入） */
export interface EscortPhase {
  id: string;
  escortId: string;
  plannedStudentIds: string[];
  actualStudentIds: string[] | null; // 确认接到后写入的实际负责集合
  startLocId: string;
  endLocId: string;
  startMin: number;
  endMin: number;
  status: EscortPhaseStatus;
  releasedAtMin: number | null; // 实际释放时刻（释放/被接替时写入），位置连续性用
  releasedAtLocId: string | null; // 实际释放地点
}

export type JourneyStatus =
  | 'confirmed' // 已确认（资源已原子核对并占用）
  | 'in_progress' // 已开始执行（至少一次接到学生）
  | 'completed' // 全组确认到课
  | 'superseded' // 已被重新确认的新行程替代（原安排保留可查）
  | 'cancelled';

export interface TransitJourney {
  id: string;
  groupId: string;
  mode: TravelMode;
  version: number; // 该组第几版行程（重新确认递增）
  legs: JourneyLeg[];
  phases: EscortPhase[];
  bookings: { departureId: string; studentIds: string[] }[];
  departMin: number;
  arriveMin: number;
  status: JourneyStatus;
  boarded: string[]; // 已登记上车学生
  alighted: string[]; // 已下车学生
  handed: string[]; // 已交接给教师的学生
  arrived: string[]; // 教师已确认到课的学生（车程结束/通知已发不等于到课）
  createdAtMin: number;
  replacedByJourneyId: string | null;
}

export interface TransitNotification {
  id: string;
  journeyId: string;
  groupId: string;
  version: number;
  title: string;
  body: string;
  audience: string[]; // 应接收的用户（护送员、接收教师）
  receivedBy: string[]; // 已接收的用户；未接收者保留待办
  superseded: boolean;
  createdAtMin: number;
}

/** 快照中可变的出行状态（静态网络定义在 seed.ts） */
export interface TransitSnapshot {
  walkEdges: Record<string, { closed: boolean; reason: string | null }>;
  departures: Record<
    string,
    { cancelled: boolean; reason: string | null; reservedSeats: number; reservedBays: number }
  >;
  escorts: Record<string, { onLeave: boolean }>;
  journeys: Record<string, TransitJourney>;
  notifications: Record<string, TransitNotification>;
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
    }
  // ---------- 无障碍出行事件 ----------
  | {
      seq: number;
      at: string;
      type: 'transit.journeyConfirmed';
      journeyId: string;
      groupId: string;
      mode: TravelMode;
      version: number;
      legs: JourneyLeg[];
      phases: EscortPhase[];
      bookings: { departureId: string; studentIds: string[] }[];
      departMin: number;
      arriveMin: number;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'transit.journeyRebooked';
      journeyId: string;
      replacesJourneyId: string;
      groupId: string;
      mode: TravelMode;
      version: number;
      legs: JourneyLeg[];
      phases: EscortPhase[];
      bookings: { departureId: string; studentIds: string[] }[];
      departMin: number;
      arriveMin: number;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'transit.journeyCancelled';
      journeyId: string;
      reason: string;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'transit.phaseAccepted';
      journeyId: string;
      phaseId: string;
      escortId: string;
    }
  | {
      seq: number;
      at: string;
      type: 'transit.pickupConfirmed';
      journeyId: string;
      phaseId: string;
      studentIds: string[];
    }
  | {
      seq: number;
      at: string;
      type: 'transit.boarded';
      journeyId: string;
      phaseId: string;
      departureId: string;
      studentIds: string[];
    }
  | {
      seq: number;
      at: string;
      type: 'transit.alighted';
      journeyId: string;
      departureId: string;
      studentIds: string[];
    }
  | {
      seq: number;
      at: string;
      type: 'transit.handedToTeacher';
      journeyId: string;
      studentIds: string[];
      teacherId: string;
    }
  | {
      seq: number;
      at: string;
      type: 'transit.arrivalConfirmed';
      journeyId: string;
      studentId: string;
      teacherId: string;
    }
  | {
      // 途中交接：事件本身即接续者实际确认，原责任到此刻才解除
      seq: number;
      at: string;
      type: 'transit.phaseHandedOver';
      journeyId: string;
      fromPhaseId: string;
      newPhase: EscortPhase;
      studentIds: string[];
    }
  | {
      seq: number;
      at: string;
      type: 'transit.departureCancelled';
      departureId: string;
      reason: string;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'transit.walkEdgeClosed';
      edgeId: string;
      reason: string;
      by: string;
    }
  | {
      // 设施解除封路的唯一入口；解除前直达连廊不自动恢复
      seq: number;
      at: string;
      type: 'transit.walkEdgeReopened';
      edgeId: string;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'transit.escortLeaveSet';
      escortId: string;
      onLeave: boolean;
      by: string;
    }
  | {
      // 临时满载：其他乘客占用的座位/轮椅固定位
      seq: number;
      at: string;
      type: 'transit.departureLoadSet';
      departureId: string;
      reservedSeats: number;
      reservedBays: number;
      by: string;
    }
  | {
      seq: number;
      at: string;
      type: 'transit.notificationSent';
      notificationId: string;
      journeyId: string;
      groupId: string;
      version: number;
      title: string;
      body: string;
      audience: string[];
      supersedesId: string | null;
    }
  | {
      seq: number;
      at: string;
      type: 'transit.notificationReceived';
      notificationId: string;
      userId: string;
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
  transit: TransitSnapshot;
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
