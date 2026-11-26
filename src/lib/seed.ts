import type {
  Course,
  EscortDef,
  Room,
  ShuttleDepartureDef,
  ShuttleRouteDef,
  StudentGroup,
  TransitLocation,
  TransitStudent,
  User,
  WalkEdgeDef,
} from '../types';
import { hmToMin } from './time';

// ---------- 用户（测试账号） ----------
export const SEED_USERS: User[] = [
  { id: 'u_teacher_a', name: '林老师（A 班）', role: 'teacher' },
  { id: 'u_teacher_b', name: '周老师（B 班）', role: 'teacher' },
  { id: 'u_teacher_s', name: '苏老师（S 研讨）', role: 'teacher' },
  { id: 'u_facility', name: '王设施（设施人员）', role: 'facility' },
  { id: 'u_dispatch', name: '陈调度（调度员）', role: 'dispatcher' },
  { id: 'u_repair', name: '赵维修（维修人员）', role: 'repair' },
  { id: 'u_escort_1', name: '李护送（护送员）', role: 'escort' },
  { id: 'u_escort_2', name: '王护送（护送员）', role: 'escort' },
];

// ---------- 教室资源 ----------
export const SEED_ROOMS: Room[] = [
  {
    id: 'r_B201',
    code: 'B-B201',
    name: 'B201',
    capacity: 30,
    equipment: ['projector'],
    accessible: true,
    safety: true,
  },
  {
    id: 'r_B202',
    code: 'B-B202',
    name: 'B202',
    capacity: 26,
    equipment: ['lab_bench', 'projector'],
    accessible: true,
    safety: true,
  },
  {
    id: 'r_C101',
    code: 'C-C101',
    name: 'C101',
    capacity: 30,
    equipment: ['projector'],
    accessible: true,
    safety: true,
  },
  {
    id: 'r_C102',
    code: 'C-C102',
    name: 'C102',
    capacity: 24,
    equipment: ['lab_bench'],
    accessible: true,
    safety: true,
  },
  {
    id: 'r_D301',
    code: 'D-D301',
    name: 'D301',
    capacity: 20,
    equipment: ['lab_bench'],
    accessible: false,
    safety: true,
  },
];

// ---------- 步行距离矩阵（分钟，对称，0 表示同房间） ----------
// 题目给定：C101 距 B201 = 8；C102 距 B202 = 18；D301 距 B202 = 7；C102 距 D301 = 7
export const DISTANCE: Record<string, Record<string, number>> = {
  r_B201: { r_B201: 0, r_B202: 2, r_C101: 8, r_C102: 14, r_D301: 12 },
  r_B202: { r_B201: 2, r_B202: 0, r_C101: 10, r_C102: 18, r_D301: 7 },
  r_C101: { r_B201: 8, r_B202: 10, r_C101: 0, r_C102: 6, r_D301: 11 },
  r_C102: { r_B201: 14, r_B202: 18, r_C101: 6, r_C102: 0, r_D301: 7 },
  r_D301: { r_B201: 12, r_B202: 7, r_C101: 11, r_C102: 7, r_D301: 0 },
};

// ---------- 当天课程 ----------
// A 班 10:00-11:00，24 人，需投影+无障碍入口，原 B201
// B 班 10:15-11:15，18 人，需实验台，原 B202
// S 弹性研讨 10:15-11:15，12 人，需实验台，原 D301，可换房
export const SEED_COURSES: Course[] = [
  {
    id: 'c_A',
    className: 'A 班',
    teacherId: 'u_teacher_a',
    roomId: 'r_B201',
    originalRoomId: 'r_B201',
    startMin: hmToMin('10:00'),
    endMin: hmToMin('11:00'),
    size: 24,
    requirements: ['projector', 'accessible'],
    flexible: false,
    status: 'normal',
    planId: null,
  },
  {
    id: 'c_B',
    className: 'B 班',
    teacherId: 'u_teacher_b',
    roomId: 'r_B202',
    originalRoomId: 'r_B202',
    startMin: hmToMin('10:15'),
    endMin: hmToMin('11:15'),
    size: 18,
    requirements: ['lab_bench'],
    flexible: false,
    status: 'normal',
    planId: null,
  },
  {
    id: 'c_S',
    className: 'S 研讨课',
    teacherId: 'u_teacher_s',
    roomId: 'r_D301',
    originalRoomId: 'r_D301',
    startMin: hmToMin('10:15'),
    endMin: hmToMin('11:15'),
    size: 12,
    requirements: ['lab_bench'],
    flexible: true,
    status: 'normal',
    planId: null,
  },
  // 一节午后课，用于验证 14:00 复测通过后房间恢复
  {
    id: 'c_P',
    className: 'P 班午后课',
    teacherId: 'u_teacher_a',
    roomId: 'r_B201',
    originalRoomId: 'r_B201',
    startMin: hmToMin('14:00'),
    endMin: hmToMin('15:00'),
    size: 20,
    requirements: ['projector'],
    flexible: false,
    status: 'normal',
    planId: null,
  },
];

export function roomById(id: string, rooms: Room[]): Room {
  const r = rooms.find((x) => x.id === id);
  if (!r) throw new Error(`未知教室: ${id}`);
  return r;
}

// ---------- 无障碍出行：连廊封闭后的步行护送 / 登记接驳 ----------
// 场景：连廊（O↔C 直达）封闭，四名需要无障碍协助的学生分两组，
// 第一组 08:50 出发、09:10 前到 C 楼；第二组 09:10 出发、09:30 前到 C 楼。
// 所有输入为整分钟；允许在合法地点等待；查询固定在同一份路网/班次/资源快照上。

export const TRANSIT_WINDOW = {
  startMin: hmToMin('08:45'), // 08:45
  endMin: hmToMin('10:00'), // 10:00（含两端共 76 个分钟刻度）
} as const;

export const SEED_TRANSIT_LOCATIONS: TransitLocation[] = [
  { id: 'loc_O', code: 'O', name: 'O · 宿舍区门厅' },
  { id: 'loc_S', code: 'S', name: 'S · 接驳站' },
  { id: 'loc_W', code: 'W', name: 'W · 绕行连廊口' },
  { id: 'loc_C', code: 'C', name: 'C · C 楼' },
];

// 已批准无障碍路径；we_OC 为封闭中的直达连廊（设施解除前不自动恢复）
export const SEED_WALK_EDGES: WalkEdgeDef[] = [
  { id: 'we_OC', fromId: 'loc_O', toId: 'loc_C', minutes: 5, accessible: true, closedSeed: true, note: '直达连廊（封闭中）' },
  { id: 'we_OS', fromId: 'loc_O', toId: 'loc_S', minutes: 2, accessible: true, closedSeed: false, note: null },
  { id: 'we_OW', fromId: 'loc_O', toId: 'loc_W', minutes: 10, accessible: true, closedSeed: false, note: null },
  { id: 'we_WC', fromId: 'loc_W', toId: 'loc_C', minutes: 10, accessible: true, closedSeed: false, note: null },
];

// 班车：S -> C，8 分钟，4 座 + 1 个轮椅固定位
export const SEED_SHUTTLE_ROUTES: ShuttleRouteDef[] = [
  { id: 'rt_SC', fromId: 'loc_S', toId: 'loc_C', rideMinutes: 8, seats: 4, wheelchairBays: 1 },
];

export const SEED_DEPARTURES: ShuttleDepartureDef[] = [
  { id: 'dep_0900', routeId: 'rt_SC', departMin: hmToMin('09:00') },
  { id: 'dep_0920', routeId: 'rt_SC', departMin: hmToMin('09:20') },
];

export const SEED_STUDENTS: TransitStudent[] = [
  { id: 'st_1', name: '同学甲', wheelchair: true, groupId: 'g1' },
  { id: 'st_2', name: '同学乙', wheelchair: false, groupId: 'g1' },
  { id: 'st_3', name: '同学丙', wheelchair: true, groupId: 'g2' },
  { id: 'st_4', name: '同学丁', wheelchair: false, groupId: 'g2' },
];

export const SEED_GROUPS: StudentGroup[] = [
  {
    id: 'g1',
    name: '第一组',
    studentIds: ['st_1', 'st_2'],
    originId: 'loc_O',
    destId: 'loc_C',
    departMin: hmToMin('08:50'),
    arriveByMin: hmToMin('09:10'),
  },
  {
    id: 'g2',
    name: '第二组',
    studentIds: ['st_3', 'st_4'],
    originId: 'loc_O',
    destId: 'loc_C',
    departMin: hmToMin('09:10'),
    arriveByMin: hmToMin('09:30'),
  },
];

// 两名护送员 08:45-10:00 可用，每人最多同时带 2 人
export const SEED_ESCORTS: EscortDef[] = [
  { id: 'u_escort_1', name: '李护送', baseLocId: 'loc_O', fromMin: hmToMin('08:45'), toMin: hmToMin('10:00'), maxStudents: 2 },
  { id: 'u_escort_2', name: '王护送', baseLocId: 'loc_O', fromMin: hmToMin('08:45'), toMin: hmToMin('10:00'), maxStudents: 2 },
];

/** C 楼接收教师（交接与确认到课） */
export const RECEIVING_TEACHER_ID = 'u_teacher_a';

export function locationById(id: string): TransitLocation {
  const l = SEED_TRANSIT_LOCATIONS.find((x) => x.id === id);
  if (!l) throw new Error(`未知地点: ${id}`);
  return l;
}

export function groupById(id: string): StudentGroup {
  const g = SEED_GROUPS.find((x) => x.id === id);
  if (!g) throw new Error(`未知分组: ${id}`);
  return g;
}

export function escortById(id: string): EscortDef {
  const e = SEED_ESCORTS.find((x) => x.id === id);
  if (!e) throw new Error(`未知护送员: ${id}`);
  return e;
}
