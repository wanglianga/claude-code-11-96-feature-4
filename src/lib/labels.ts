import type { FaultType, IncidentStatus, PlanStatus } from '../types';

export const FAULT_LABELS: Record<FaultType, string> = {
  leak: '漏水',
  power: '断电',
  equipment: '设备故障',
};

export const INCIDENT_STATUS_LABELS: Record<IncidentStatus, string> = {
  reported: '待核准',
  confirmed: '已核准/封闭中',
  work_order: '维修中',
  repaired: '待复测',
  verified: '复测通过/已解封',
};

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  proposed: '待教师确认',
  published: '已发布',
  cancelled: '已取消',
};

export const EQUIPMENT_LABELS: Record<string, string> = {
  projector: '投影',
  lab_bench: '实验台',
  accessible: '无障碍入口',
};

export function reqLabel(req: string): string {
  return EQUIPMENT_LABELS[req] ?? req;
}
