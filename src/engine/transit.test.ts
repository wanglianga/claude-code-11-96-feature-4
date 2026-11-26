// 无障碍出行：路由双实现、原子确认、执行状态机、扰动重确认的业务规则测试

import { describe, expect, it } from 'vitest';
import { initialSnapshot, replay } from './reducer';
import { setSeqStart } from './commands';
import {
  acceptPhase,
  cancelDeparture,
  closeWalkEdge,
  confirmArrival,
  confirmJourney,
  confirmPickup,
  handToTeacher,
  handoverPhase,
  receiveTransitNotification,
  registerAlighting,
  registerBoarding,
  reopenWalkEdge,
  rebookJourney,
  setDepartureLoad,
  setEscortLeave,
} from './transitCommands';
import {
  activeJourneyOf,
  buildRoutingNetwork,
  departureLoad,
  escortPositionAt,
  groupLocationAt,
  journeyProblems,
  planCandidate,
  transitTodos,
} from './transit';
import { routeLocationGraph, routeTimeExpanded } from './routing';
import { SEED_GROUPS } from '../lib/seed';
import type { AppEvent, Snapshot } from '../types';
import { hmToMin } from '../lib/time';

/** 测试助手：依次执行命令，持续回放成快照（与 scenario.test.ts 同款） */
class World {
  snap: Snapshot = initialSnapshot();

  run(fn: (snap: Snapshot) => { ok: boolean; error?: string; events: AppEvent[] }): AppEvent[] {
    setSeqStart(this.snap.seq);
    const r = fn(this.snap);
    if (!r.ok) throw new Error(r.error ?? '命令失败');
    this.snap = replay(r.events, this.snap);
    return r.events;
  }

  tryRun(fn: (snap: Snapshot) => { ok: boolean; error?: string; events: AppEvent[] }): string {
    setSeqStart(this.snap.seq);
    const r = fn(this.snap);
    if (r.ok) throw new Error('预期失败但命令成功了');
    return r.error!;
  }
}

const T = {
  '08:45': hmToMin('08:45'),
  '08:46': hmToMin('08:46'),
  '08:47': hmToMin('08:47'),
  '08:48': hmToMin('08:48'),
  '08:50': hmToMin('08:50'),
  '08:51': hmToMin('08:51'),
  '08:55': hmToMin('08:55'),
  '09:00': hmToMin('09:00'),
  '09:05': hmToMin('09:05'),
  '09:08': hmToMin('09:08'),
  '09:10': hmToMin('09:10'),
  '09:20': hmToMin('09:20'),
  '09:28': hmToMin('09:28'),
  '09:30': hmToMin('09:30'),
};

function netOf(snap: Snapshot) {
  return buildRoutingNetwork(snap);
}

describe('路由引擎：两种计算表示', () => {
  it('时间展开图：4 地点 × 76 刻度 = 304 状态点、300 等候边，边实例逐项计数', () => {
    const net = netOf(initialSnapshot());
    const walk = routeTimeExpanded(net, 'loc_O', 'loc_C', T['08:50'], false);
    expect(walk.stats.tickCount).toBe(76);
    expect(walk.stats.nodes).toBe(304);
    expect(walk.stats.waitEdges).toBe(300);
    // 连廊封闭时开放边为 OS(2)/OW(10)/WC(10)：2×(74+66+66)=412
    expect(walk.stats.walkEdgeInstances).toBe(412);
    expect(walk.stats.rideEdgeInstances).toBe(0);
    const shuttle = routeTimeExpanded(net, 'loc_O', 'loc_C', T['08:50'], true);
    expect(shuttle.stats.rideEdgeInstances).toBe(2); // 09:00 与 09:20 两班
    expect(shuttle.stats.settledStates).toBeGreaterThan(0);
    expect(shuttle.stats.relaxations).toBeGreaterThan(0);
  });

  it('样例到达时刻：步行 09:10/09:30，接驳 09:08/09:28，两种实现一致', () => {
    const net = netOf(initialSnapshot());
    for (const g of SEED_GROUPS) {
      const expWalk = routeTimeExpanded(net, g.originId, g.destId, g.departMin, false);
      const locWalk = routeLocationGraph(net, g.originId, g.destId, g.departMin, false);
      const expShuttle = routeTimeExpanded(net, g.originId, g.destId, g.departMin, true);
      const locShuttle = routeLocationGraph(net, g.originId, g.destId, g.departMin, true);
      expect(expWalk.outcome.arriveMin).toBe(locWalk.outcome.arriveMin);
      expect(expShuttle.outcome.arriveMin).toBe(locShuttle.outcome.arriveMin);
      if (g.id === 'g1') {
        expect(expWalk.outcome.arriveMin).toBe(T['09:10']);
        expect(expShuttle.outcome.arriveMin).toBe(T['09:08']);
      } else {
        expect(expWalk.outcome.arriveMin).toBe(T['09:30']);
        expect(expShuttle.outcome.arriveMin).toBe(T['09:28']);
      }
    }
    // 接驳 legs 显式包含候车段（展开图等候边 / 地点图边上等车殊途同归）
    const g1 = SEED_GROUPS[0];
    const legs = routeTimeExpanded(net, g1.originId, g1.destId, g1.departMin, true).outcome.legs;
    expect(legs.map((l) => l.kind)).toEqual(['walk', 'wait', 'ride']);
    expect(legs[1].departMin).toBe(hmToMin('08:52'));
    expect(legs[1].arriveMin).toBe(T['09:00']);
  });

  it('地点图：4 个地理节点，班次查询量按次记录（不假设随时有车）', () => {
    const net = netOf(initialSnapshot());
    const r = routeLocationGraph(net, 'loc_O', 'loc_C', T['08:50'], true);
    expect(r.stats.nodes).toBe(4);
    expect(r.stats.scheduleQueries).toBe(1); // 仅在 S 站查询一次下一班
    expect(r.stats.walkRelaxations).toBe(6);
    expect(r.stats.settledLabels).toBe(4);
  });

  it('取消 09:00 后：第一组接驳超过截止不可行，第二组接驳 09:28 仍可行', () => {
    const w = new World();
    w.run((s) => cancelDeparture(s, { departureId: 'dep_0900', reason: '车辆故障', atMin: T['08:45'], by: 'u_facility' }));
    const g1 = planCandidate(w.snap, 'g1', 'shuttle');
    expect(g1.feasible).toBe(false);
    expect(g1.reasons.join('；')).toContain('超过要求');
    const g2 = planCandidate(w.snap, 'g2', 'shuttle');
    expect(g2.feasible).toBe(true);
    expect(g2.arriveMin).toBe(T['09:28']);
    // 只剩 09:20 一班
    const net = netOf(w.snap);
    expect(routeTimeExpanded(net, 'loc_O', 'loc_C', T['08:50'], true).stats.rideEdgeInstances).toBe(1);
  });

  it('道路关闭后步行不可行；连廊未解除前候选不含直达边，解除后 08:55 直达', () => {
    const w = new World();
    // 连廊初始封闭：候选只走 O→W→C
    const before = planCandidate(w.snap, 'g1', 'walk');
    expect(before.legs.every((l) => l.edgeId !== 'we_OC')).toBe(true);
    w.run((s) => closeWalkEdge(s, { edgeId: 'we_WC', reason: '路面维修', atMin: T['08:45'], by: 'u_facility' }));
    expect(planCandidate(w.snap, 'g1', 'walk').feasible).toBe(false);
    // 设施解除连廊封闭（唯一恢复入口）
    w.run((s) => reopenWalkEdge(s, { edgeId: 'we_OC', atMin: T['08:45'], by: 'u_facility' }));
    const after = planCandidate(w.snap, 'g1', 'walk');
    expect(after.feasible).toBe(true);
    expect(after.arriveMin).toBe(T['08:55']);
    expect(after.legs.some((l) => l.edgeId === 'we_OC')).toBe(true);
  });
});

describe('候选与原子确认', () => {
  it('候选计算不占座：重复候选均可行且占用为 0；确认后占用 1 座 1 固定位', () => {
    const w = new World();
    expect(planCandidate(w.snap, 'g1', 'shuttle').feasible).toBe(true);
    expect(planCandidate(w.snap, 'g1', 'shuttle').feasible).toBe(true);
    let load = departureLoad(w.snap, 'dep_0900');
    expect(load).toMatchObject({ seats: 0, bays: 0 });
    w.run((s) => confirmJourney(s, { groupId: 'g1', mode: 'shuttle', atMin: T['08:45'], by: 'u_dispatch' }));
    load = departureLoad(w.snap, 'dep_0900');
    expect(load).toMatchObject({ seats: 1, bays: 1, capSeats: 4, capBays: 1 });
  });

  it('临时满载：09:20 固定位/座位被其他乘客占满后，第二组接驳确认被退回重算', () => {
    const w = new World();
    w.run((s) => setDepartureLoad(s, { departureId: 'dep_0920', reservedSeats: 4, reservedBays: 1, atMin: T['08:45'], by: 'u_dispatch' }));
    const cand = planCandidate(w.snap, 'g2', 'shuttle');
    expect(cand.feasible).toBe(false);
    expect(cand.reasons.join('；')).toContain('轮椅固定位不足');
    const err = w.tryRun((s) => confirmJourney(s, { groupId: 'g2', mode: 'shuttle', atMin: T['08:46'], by: 'u_dispatch' }));
    expect(err).toContain('退回重算');
    // 步行仍可行（护送员可用）
    expect(planCandidate(w.snap, 'g2', 'walk').feasible).toBe(true);
  });

  it('护送员时间冲突与调位：两组步行需两名护送员，接驳可共用一名', () => {
    const w = new World();
    w.run((s) => confirmJourney(s, { groupId: 'g1', mode: 'walk', atMin: T['08:45'], by: 'u_dispatch' }));
    const j1 = activeJourneyOf(w.snap, 'g1')!;
    expect(j1.phases[0].escortId).toBe('u_escort_1');
    // 第二组步行：李护送 09:10 在 C 无法赶回 O，只能派王护送
    const cand = planCandidate(w.snap, 'g2', 'walk');
    const c1 = cand.escortChecks.find((c) => c.escortId === 'u_escort_1')!;
    const c2 = cand.escortChecks.find((c) => c.escortId === 'u_escort_2')!;
    expect(c1.ok).toBe(false);
    expect(c1.reasons.join('；')).toContain('无法于');
    expect(c2.ok).toBe(true);
    expect(cand.phases[0].escortId).toBe('u_escort_2');

    // 接驳：李护送送完第一组到 S（09:00）后可回 O 接第二组（09:10）
    const w2 = new World();
    w2.run((s) => confirmJourney(s, { groupId: 'g1', mode: 'shuttle', atMin: T['08:45'], by: 'u_dispatch' }));
    const cand2 = planCandidate(w2.snap, 'g2', 'shuttle');
    expect(cand2.escortChecks.find((c) => c.escortId === 'u_escort_1')!.ok).toBe(true);
  });

  it('同行者同车次同阶段；护送员请假后步行重订失败且原安排保留（不变无人陪同）', () => {
    const w = new World();
    w.run((s) => confirmJourney(s, { groupId: 'g1', mode: 'walk', atMin: T['08:45'], by: 'u_dispatch' }));
    const j1 = activeJourneyOf(w.snap, 'g1')!;
    expect(j1.phases[0].plannedStudentIds.sort()).toEqual(['st_1', 'st_2']);

    // 两名护送员都请假：步行重订不可行，原行程保持原样（护送员仍在）
    w.run((s) => setEscortLeave(s, { escortId: 'u_escort_1', onLeave: true, atMin: T['08:46'], by: 'u_dispatch' }));
    w.run((s) => setEscortLeave(s, { escortId: 'u_escort_2', onLeave: true, atMin: T['08:46'], by: 'u_dispatch' }));
    const problems = journeyProblems(w.snap, activeJourneyOf(w.snap, 'g1')!);
    expect(problems.join('；')).toContain('请假');
    const err = w.tryRun((s) => rebookJourney(s, { journeyId: j1.id, mode: 'walk', atMin: T['08:47'], by: 'u_dispatch' }));
    expect(err).toContain('原安排保留');
    const still = activeJourneyOf(w.snap, 'g1')!;
    expect(still.id).toBe(j1.id);
    expect(still.phases[0].escortId).toBe('u_escort_1');
    expect(still.phases[0].plannedStudentIds).toHaveLength(2);
  });

  it('接驳确认的原子核对：同行者两人同一班次', () => {
    const w = new World();
    w.run((s) => confirmJourney(s, { groupId: 'g1', mode: 'shuttle', atMin: T['08:45'], by: 'u_dispatch' }));
    const j1 = activeJourneyOf(w.snap, 'g1')!;
    expect(j1.bookings).toHaveLength(1);
    expect(j1.bookings[0].departureId).toBe('dep_0900');
    expect(j1.bookings[0].studentIds.sort()).toEqual(['st_1', 'st_2']);
  });
});

describe('执行状态机', () => {
  function shuttleWorld(): World {
    const w = new World();
    w.run((s) => confirmJourney(s, { groupId: 'g1', mode: 'shuttle', atMin: T['08:45'], by: 'u_dispatch' }));
    return w;
  }

  it('护送员未接到本人不得登记上车；未接单不得确认接到', () => {
    const w = shuttleWorld();
    const j = activeJourneyOf(w.snap, 'g1')!;
    const ph = j.phases[0];
    const err1 = w.tryRun((s) =>
      registerBoarding(s, { journeyId: j.id, phaseId: ph.id, departureId: 'dep_0900', studentIds: ['st_1', 'st_2'], atMin: T['08:55'] }),
    );
    expect(err1).toContain('尚未接到学生');
    const err2 = w.tryRun((s) =>
      confirmPickup(s, { journeyId: j.id, phaseId: ph.id, studentIds: ['st_1', 'st_2'], atMin: T['08:50'] }),
    );
    expect(err2).toContain('先接单');
    // 正确顺序：接单 -> 接到 -> 上车
    w.run((s) => acceptPhase(s, { journeyId: j.id, phaseId: ph.id, escortId: 'u_escort_1', atMin: T['08:46'] }));
    w.run((s) => confirmPickup(s, { journeyId: j.id, phaseId: ph.id, studentIds: ['st_1', 'st_2'], atMin: T['08:50'] }));
    w.run((s) =>
      registerBoarding(s, { journeyId: j.id, phaseId: ph.id, departureId: 'dep_0900', studentIds: ['st_1', 'st_2'], atMin: T['09:00'] }),
    );
    const after = activeJourneyOf(w.snap, 'g1')!;
    expect(after.boarded.sort()).toEqual(['st_1', 'st_2']);
    expect(after.phases[0].status).toBe('released'); // 护送员责任在车门结束
  });

  it('上下车、交接、到课分别记录：车程结束不等于到课，全组到课才完成', () => {
    const w = shuttleWorld();
    const j = activeJourneyOf(w.snap, 'g1')!;
    const ph = j.phases[0];
    w.run((s) => acceptPhase(s, { journeyId: j.id, phaseId: ph.id, escortId: 'u_escort_1', atMin: T['08:46'] }));
    w.run((s) => confirmPickup(s, { journeyId: j.id, phaseId: ph.id, studentIds: ['st_1', 'st_2'], atMin: T['08:50'] }));
    w.run((s) => registerBoarding(s, { journeyId: j.id, phaseId: ph.id, departureId: 'dep_0900', studentIds: ['st_1', 'st_2'], atMin: T['09:00'] }));
    // 未到 09:08 不能下车
    const early = w.tryRun((s) => registerAlighting(s, { journeyId: j.id, studentIds: ['st_1', 'st_2'], atMin: hmToMin('09:05') }));
    expect(early).toContain('尚未到达');
    w.run((s) => registerAlighting(s, { journeyId: j.id, studentIds: ['st_1', 'st_2'], atMin: T['09:08'] }));
    let cur = activeJourneyOf(w.snap, 'g1')!;
    expect(cur.alighted).toHaveLength(2);
    expect(cur.arrived).toHaveLength(0); // 车程结束 ≠ 学生已到
    expect(cur.status).toBe('in_progress');
    // 未交接不能确认到课
    const err = w.tryRun((s) => confirmArrival(s, { journeyId: j.id, studentId: 'st_1', teacherId: 'u_teacher_a', atMin: T['09:08'] }));
    expect(err).toContain('尚未交接');
    w.run((s) => handToTeacher(s, { journeyId: j.id, studentIds: ['st_1', 'st_2'], teacherId: 'u_teacher_a', atMin: T['09:08'] }));
    w.run((s) => confirmArrival(s, { journeyId: j.id, studentId: 'st_1', teacherId: 'u_teacher_a', atMin: T['09:08'] }));
    cur = activeJourneyOf(w.snap, 'g1')!;
    expect(cur.status).toBe('in_progress'); // 还有一人未到课
    w.run((s) => confirmArrival(s, { journeyId: j.id, studentId: 'st_2', teacherId: 'u_teacher_a', atMin: T['09:08'] }));
    expect(activeJourneyOf(w.snap, 'g1')).toBeNull(); // 已完成，不再是生效行程
    expect(w.snap.transit.journeys[j.id].status).toBe('completed');
  });

  it('护送员位置由模拟行程确认；重复派单不能让同一人在两处带队', () => {
    const w = new World();
    w.run((s) => confirmJourney(s, { groupId: 'g1', mode: 'walk', atMin: T['08:45'], by: 'u_dispatch' }));
    expect(escortPositionAt(w.snap, 'u_escort_1', T['09:05']).text).toContain('W→C 步行段');
    expect(escortPositionAt(w.snap, 'u_escort_1', T['09:10']).text).toContain('在 C');
    expect(escortPositionAt(w.snap, 'u_escort_2', T['09:05']).text).toContain('空闲');
    // 第二组步行候选不会把李护送派到 O（09:10 他在 C）
    const cand = planCandidate(w.snap, 'g2', 'walk');
    expect(cand.escortChecks.find((c) => c.escortId === 'u_escort_1')!.ok).toBe(false);
  });

  it('途中交接：路段途中拒绝；到达地点节点时接续者实际确认后原责任解除', () => {
    const w = new World();
    w.run((s) => confirmJourney(s, { groupId: 'g1', mode: 'walk', atMin: T['08:45'], by: 'u_dispatch' }));
    const j = activeJourneyOf(w.snap, 'g1')!;
    const ph = j.phases[0];
    w.run((s) => acceptPhase(s, { journeyId: j.id, phaseId: ph.id, escortId: 'u_escort_1', atMin: T['08:46'] }));
    w.run((s) => confirmPickup(s, { journeyId: j.id, phaseId: ph.id, studentIds: ['st_1', 'st_2'], atMin: T['08:50'] }));
    // 09:05 在 W→C 路段途中，不能交接
    expect(groupLocationAt(activeJourneyOf(w.snap, 'g1')!, T['09:05'])).toBeNull();
    const err = w.tryRun((s) =>
      handoverPhase(s, { journeyId: j.id, fromPhaseId: ph.id, toEscortId: 'u_escort_2', studentIds: ['st_1', 'st_2'], atMin: T['09:05'] }),
    );
    expect(err).toContain('途中');
    // 09:00 全组在 W，可以交接；交接前原护送员仍负责
    expect(groupLocationAt(activeJourneyOf(w.snap, 'g1')!, T['09:00'])).toBe('loc_W');
    w.run((s) =>
      handoverPhase(s, { journeyId: j.id, fromPhaseId: ph.id, toEscortId: 'u_escort_2', studentIds: ['st_1', 'st_2'], atMin: T['09:00'] }),
    );
    const after = activeJourneyOf(w.snap, 'g1')!;
    const oldPh = after.phases.find((p) => p.id === ph.id)!;
    expect(oldPh.status).toBe('handed_over');
    expect(oldPh.actualStudentIds).toEqual([]);
    const newPh = after.phases.find((p) => p.escortId === 'u_escort_2')!;
    expect(newPh.status).toBe('picked_up');
    expect(newPh.actualStudentIds?.sort()).toEqual(['st_1', 'st_2']);
    expect(newPh.startLocId).toBe('loc_W');
    // 位置模拟随之切换：09:05 王护送带队在 W→C 段
    expect(escortPositionAt(w.snap, 'u_escort_2', T['09:05']).text).toContain('W→C 步行段');
  });

  it('步行方式：未到达不能交接教师，交接后护送阶段释放', () => {
    const w = new World();
    w.run((s) => confirmJourney(s, { groupId: 'g1', mode: 'walk', atMin: T['08:45'], by: 'u_dispatch' }));
    const j = activeJourneyOf(w.snap, 'g1')!;
    const ph = j.phases[0];
    w.run((s) => acceptPhase(s, { journeyId: j.id, phaseId: ph.id, escortId: 'u_escort_1', atMin: T['08:46'] }));
    w.run((s) => confirmPickup(s, { journeyId: j.id, phaseId: ph.id, studentIds: ['st_1', 'st_2'], atMin: T['08:50'] }));
    const err = w.tryRun((s) =>
      handToTeacher(s, { journeyId: j.id, studentIds: ['st_1', 'st_2'], teacherId: 'u_teacher_a', atMin: T['09:05'] }),
    );
    expect(err).toContain('尚未到达');
    w.run((s) => handToTeacher(s, { journeyId: j.id, studentIds: ['st_1', 'st_2'], teacherId: 'u_teacher_a', atMin: T['09:10'] }));
    const after = activeJourneyOf(w.snap, 'g1')!;
    expect(after.phases[0].status).toBe('released');
    w.run((s) => confirmArrival(s, { journeyId: j.id, studentId: 'st_1', teacherId: 'u_teacher_a', atMin: T['09:10'] }));
    w.run((s) => confirmArrival(s, { journeyId: j.id, studentId: 'st_2', teacherId: 'u_teacher_a', atMin: T['09:10'] }));
    expect(w.snap.transit.journeys[j.id].status).toBe('completed');
  });
});

describe('扰动重确认与通知', () => {
  it('取消 09:00 后原安排保留并标问题；按新合法候选重新确认后发 v2 通知、旧版作废', () => {
    const w = new World();
    w.run((s) => confirmJourney(s, { groupId: 'g1', mode: 'shuttle', atMin: T['08:45'], by: 'u_dispatch' }));
    const j1 = activeJourneyOf(w.snap, 'g1')!;
    w.run((s) => cancelDeparture(s, { departureId: 'dep_0900', reason: '车辆故障', atMin: T['08:46'], by: 'u_facility' }));
    // 原安排保留（不自动改行程），问题标出
    const cur = activeJourneyOf(w.snap, 'g1')!;
    expect(cur.id).toBe(j1.id);
    expect(cur.status).toBe('confirmed');
    expect(journeyProblems(w.snap, cur).join('；')).toContain('班次 09:00 已取消');
    // 接驳重订不可行（09:20 到 09:28 超截止），步行候选 09:10 合法
    expect(w.tryRun((s) => rebookJourney(s, { journeyId: j1.id, mode: 'shuttle', atMin: T['08:47'], by: 'u_dispatch' }))).toContain('原安排保留');
    w.run((s) => rebookJourney(s, { journeyId: j1.id, mode: 'walk', atMin: T['08:47'], by: 'u_dispatch' }));
    const old = w.snap.transit.journeys[j1.id];
    expect(old.status).toBe('superseded');
    const cur2 = activeJourneyOf(w.snap, 'g1')!;
    expect(cur2.mode).toBe('walk');
    expect(cur2.arriveMin).toBe(T['09:10']);
    expect(cur2.version).toBe(2);
    // 通知 v2 发出，v1 作废
    const notes = Object.values(w.snap.transit.notifications).sort((a, b) => a.version - b.version);
    expect(notes).toHaveLength(2);
    expect(notes[0].superseded).toBe(true);
    expect(notes[1].superseded).toBe(false);
    // 未接收者保留待办
    expect(transitTodos(w.snap, 'u_escort_1')).toHaveLength(1);
    expect(transitTodos(w.snap, 'u_teacher_a')).toHaveLength(1);
  });

  it('旧通知晚到：先收到 v1 再收 v2，待办直到接收最新版才清除', () => {
    const w = new World();
    w.run((s) => confirmJourney(s, { groupId: 'g1', mode: 'shuttle', atMin: T['08:45'], by: 'u_dispatch' }));
    const j1 = activeJourneyOf(w.snap, 'g1')!;
    w.run((s) => cancelDeparture(s, { departureId: 'dep_0900', reason: '车辆故障', atMin: T['08:46'], by: 'u_facility' }));
    w.run((s) => rebookJourney(s, { journeyId: j1.id, mode: 'walk', atMin: T['08:47'], by: 'u_dispatch' }));
    const notes = Object.values(w.snap.transit.notifications).sort((a, b) => a.version - b.version);
    const [v1, v2] = notes;
    // 护送员的设备晚到 v1（已作废），接收后待办仍在（持有版本过期）
    w.run((s) => receiveTransitNotification(s, { notificationId: v1.id, userId: 'u_escort_1', atMin: T['08:50'] }));
    const todos = transitTodos(w.snap, 'u_escort_1');
    expect(todos).toHaveLength(1);
    expect(todos[0].kind).toBe('stale');
    expect(todos[0].heldVersion).toBe(1);
    w.run((s) => receiveTransitNotification(s, { notificationId: v2.id, userId: 'u_escort_1', atMin: T['08:51'] }));
    expect(transitTodos(w.snap, 'u_escort_1')).toHaveLength(0);
  });

  it('设施解除封路前不自动恢复直达路；解除后既有行程不自动变更', () => {
    const w = new World();
    w.run((s) => confirmJourney(s, { groupId: 'g1', mode: 'shuttle', atMin: T['08:45'], by: 'u_dispatch' }));
    const j1 = activeJourneyOf(w.snap, 'g1')!;
    // 多轮扰动与重确认后，直达连廊仍然封闭
    w.run((s) => cancelDeparture(s, { departureId: 'dep_0900', reason: '车辆故障', atMin: T['08:46'], by: 'u_facility' }));
    w.run((s) => rebookJourney(s, { journeyId: j1.id, mode: 'walk', atMin: T['08:47'], by: 'u_dispatch' }));
    expect(w.snap.transit.walkEdges.we_OC.closed).toBe(true);
    expect(buildRoutingNetwork(w.snap).walkEdges.some((e) => e.id === 'we_OC')).toBe(false);
    const j2 = activeJourneyOf(w.snap, 'g1')!;
    // 设施解除封路
    w.run((s) => reopenWalkEdge(s, { edgeId: 'we_OC', atMin: T['08:48'], by: 'u_facility' }));
    expect(buildRoutingNetwork(w.snap).walkEdges.some((e) => e.id === 'we_OC')).toBe(true);
    // 既有行程不自动恢复直达：仍是绕行步行 09:10 到
    const cur = activeJourneyOf(w.snap, 'g1')!;
    expect(cur.id).toBe(j2.id);
    expect(cur.arriveMin).toBe(T['09:10']);
    // 新候选才会用直达边
    expect(planCandidate(w.snap, 'g2', 'walk').legs.some((l) => l.edgeId === 'we_OC')).toBe(true);
  });
});
