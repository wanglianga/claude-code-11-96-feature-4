// 无障碍出行工作台：连廊封闭后，两组学生的步行护送 / 登记接驳办理、
// 候选计算（两种图实现并列统计）、原子确认、执行跟踪、扰动演示与通知待办

import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { Badge, Button, Card, Empty } from '../components/ui';
import { minToHM } from '../lib/time';
import {
  RECEIVING_TEACHER_ID,
  SEED_DEPARTURES,
  SEED_ESCORTS,
  SEED_GROUPS,
  SEED_SHUTTLE_ROUTES,
  SEED_STUDENTS,
  SEED_WALK_EDGES,
  escortById,
  groupById,
  locationById,
} from '../lib/seed';
import {
  activeJourneyOf,
  departureLoad,
  escortPositionAt,
  journeyProblems,
  transitTodos,
  type CandidatePlan,
} from '../engine/transit';
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
} from '../engine/transitCommands';
import { workerClient } from '../worker/client';
import type { AppEvent, JourneyLeg, Snapshot, TransitJourney, TravelMode } from '../types';

const MODE_LABEL: Record<TravelMode, string> = { walk: '步行护送', shuttle: '登记接驳' };

const JOURNEY_STATUS: Record<TransitJourney['status'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  confirmed: { label: '已确认·待出发', tone: 'info' },
  in_progress: { label: '执行中', tone: 'warn' },
  completed: { label: '已完成（全组到课）', tone: 'ok' },
  superseded: { label: '已被新行程替代', tone: 'neutral' },
  cancelled: { label: '已取消', tone: 'bad' },
};

const PHASE_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }> = {
  assigned: { label: '待接单', tone: 'warn' },
  accepted: { label: '已接单', tone: 'info' },
  picked_up: { label: '负责中', tone: 'ok' },
  released: { label: '已释放', tone: 'neutral' },
  handed_over: { label: '已交接给接续者', tone: 'neutral' },
};

function legText(leg: JourneyLeg): string {
  const from = locationById(leg.fromId).code;
  const to = locationById(leg.toId).code;
  if (leg.kind === 'walk') return `步行 ${from}→${to}`;
  if (leg.kind === 'wait') return `在 ${from} 候车`;
  const dep = SEED_DEPARTURES.find((d) => d.id === leg.departureId);
  return `乘班车 ${from}→${to}（${dep ? minToHM(dep.departMin) : ''} 班次）`;
}

function studentName(id: string): string {
  const s = SEED_STUDENTS.find((x) => x.id === id);
  return s ? `${s.name}${s.wheelchair ? '（轮椅）' : ''}` : id;
}

export function TransitView() {
  const app = useApp();
  const { snapshot, user, nowMin } = app;
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [candidates, setCandidates] = useState<Record<string, CandidatePlan>>({});
  const [modeSel, setModeSel] = useState<Record<string, TravelMode>>({ g1: 'walk', g2: 'walk' });
  const [handoverTo, setHandoverTo] = useState<Record<string, string>>({});

  // 快照变化后候选即过期（资源/路网可能已变），清空强制重算
  useEffect(() => {
    setCandidates({});
  }, [snapshot.seq]);

  const todos = useMemo(() => transitTodos(snapshot, user.id), [snapshot, user.id]);

  async function run(fn: (snap: Snapshot) => { ok: boolean; error?: string; events: AppEvent[] }, okText: string) {
    setMsg(null);
    try {
      await app.dispatch(fn);
      setMsg({ tone: 'ok', text: okText });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    }
  }

  async function computeCandidate(groupId: string, mode: TravelMode) {
    const active = activeJourneyOf(snapshot, groupId);
    const plan = await workerClient.transitCandidate(groupId, mode, active?.id);
    setCandidates((prev) => ({ ...prev, [`${groupId}:${mode}`]: plan }));
  }

  async function confirm(groupId: string, mode: TravelMode) {
    const active = activeJourneyOf(snapshot, groupId);
    if (active) {
      await run(
        (snap) => rebookJourney(snap, { journeyId: active.id, mode, atMin: nowMin, by: user.id }),
        '已按最新快照重新确认，新行程生效并发出新版本通知。',
      );
    } else {
      await run(
        (snap) => confirmJourney(snap, { groupId, mode, atMin: nowMin, by: user.id }),
        '登记成功：座位/固定位/护送员已原子核对并占用。',
      );
    }
  }

  const journeys = Object.values(snapshot.transit.journeys).sort((a, b) => a.createdAtMin - b.createdAtMin);
  const activeJourneys = journeys.filter((j) => j.status === 'confirmed' || j.status === 'in_progress');

  return (
    <div>
      {msg && <div className={`banner banner-${msg.tone}`}>{msg.text}</div>}
      <div className="banner banner-info">
        连廊封闭中：四名需要无障碍协助的学生分两组，须分别于 <b>09:10</b>、<b>09:30</b> 前到 C 楼。
        每组两人，可选<b>步行护送</b>或<b>登记接驳</b>（两种服务都可办理）。
        候选计算不占座；确认时原子核对同行者、车次座位/轮椅固定位与护送员时间，任一不足即退回重算。
      </div>

      {todos.length > 0 && (
        <div className="banner banner-warn">
          <b>{user.name} 的待办：</b>
          {todos.map((t) => (
            <div key={t.notificationId} className="row-gap" style={{ marginTop: 4 }}>
              <span>{t.text}</span>
              <Button
                className="btn-sm"
                tone="primary"
                onClick={() =>
                  void run(
                    (snap) => receiveTransitNotification(snap, { notificationId: t.notificationId, userId: user.id, atMin: nowMin }),
                    '已接收最新通知。',
                  )
                }
              >
                接收 v{t.version}
              </Button>
            </div>
          ))}
        </div>
      )}

      <Card title="① 路网、班次与护送资源（窗口 08:45-10:00，含两端共 76 个分钟刻度）">
        <div className="grid-2">
          <div>
            <h4 style={{ margin: '2px 0 8px' }}>步行路网（均为已批准无障碍路径）</h4>
            <table>
              <thead><tr><th>路段</th><th>耗时</th><th>状态</th></tr></thead>
              <tbody>
                {SEED_WALK_EDGES.map((e) => {
                  const st = snapshot.transit.walkEdges[e.id];
                  return (
                    <tr key={e.id}>
                      <td>
                        {locationById(e.fromId).code}↔{locationById(e.toId).code}
                        {e.note && <span className="muted">（{e.note}）</span>}
                      </td>
                      <td className="mono">{e.minutes} 分钟</td>
                      <td>
                        {st?.closed ? <Badge tone="bad">封闭中{st.reason ? `：${st.reason}` : ''}</Badge> : <Badge tone="ok">开放</Badge>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <h4 style={{ margin: '12px 0 8px' }}>班车站次（S→C，8 分钟，4 座 + 1 轮椅固定位）</h4>
            <table>
              <thead><tr><th>发车</th><th>状态</th><th>座位</th><th>固定位</th></tr></thead>
              <tbody>
                {SEED_DEPARTURES.map((d) => {
                  const st = snapshot.transit.departures[d.id];
                  const load = departureLoad(snapshot, d.id);
                  return (
                    <tr key={d.id}>
                      <td className="mono">{minToHM(d.departMin)}</td>
                      <td>{st?.cancelled ? <Badge tone="bad">已取消</Badge> : <Badge tone="ok">正常</Badge>}</td>
                      <td className="mono">{load.seats}/{load.capSeats}</td>
                      <td className="mono">{load.bays}/{load.capBays}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div>
            <h4 style={{ margin: '2px 0 8px' }}>护送员（08:45-10:00 可用，每人最多同时带 2 人）</h4>
            <table>
              <thead><tr><th>护送员</th><th>状态</th><th>当前位置（模拟行程）</th></tr></thead>
              <tbody>
                {SEED_ESCORTS.map((e) => {
                  const onLeave = snapshot.transit.escorts[e.id]?.onLeave;
                  const pos = escortPositionAt(snapshot, e.id, nowMin);
                  return (
                    <tr key={e.id}>
                      <td>{e.name}</td>
                      <td>{onLeave ? <Badge tone="bad">请假中</Badge> : <Badge tone="ok">可用</Badge>}</td>
                      <td className="muted">{pos.text}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="muted" style={{ fontSize: 12.5 }}>
              护送员位置由已确认行程的模拟行程推出；派单时校验时间重叠与调位可达，重复派单不会让同一人在两处带队。
            </p>
          </div>
        </div>
      </Card>

      {SEED_GROUPS.map((g) => (
        <GroupPanel
          key={g.id}
          groupId={g.id}
          mode={modeSel[g.id] ?? 'walk'}
          setMode={(m) => setModeSel((prev) => ({ ...prev, [g.id]: m }))}
          candidate={candidates[`${g.id}:${modeSel[g.id] ?? 'walk'}`] ?? null}
          onCompute={() => void computeCandidate(g.id, modeSel[g.id] ?? 'walk')}
          onConfirm={() => void confirm(g.id, modeSel[g.id] ?? 'walk')}
          journeys={journeys.filter((j) => j.groupId === g.id)}
        />
      ))}

      <Card title="③ 执行跟踪（上下车、交接教师、确认到课分别记录；车程结束或通知已发 ≠ 学生已到）">
        {activeJourneys.length === 0 && <Empty text="暂无生效行程，请先在上方办理登记" />}
        {activeJourneys.map((j) => {
          const g = groupById(j.groupId);
          const ride = j.legs.find((l) => l.kind === 'ride');
          return (
            <div key={j.id} className="plan-card" style={{ marginBottom: 12 }}>
              <h4>
                {g.name} · {MODE_LABEL[j.mode]} · v{j.version}
                <Badge tone={JOURNEY_STATUS[j.status].tone}>{JOURNEY_STATUS[j.status].label}</Badge>
                <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>
                  {minToHM(j.departMin)} 出发 → {minToHM(j.arriveMin)} 到达（要求 {minToHM(g.arriveByMin)} 前）
                </span>
              </h4>
              <table>
                <thead><tr><th>护送阶段</th><th>护送员</th><th>实际负责学生</th><th>状态</th><th>操作</th></tr></thead>
                <tbody>
                  {j.phases.map((p) => {
                    const st = PHASE_STATUS[p.status];
                    const mine = user.id === p.escortId;
                    return (
                      <tr key={p.id}>
                        <td className="mono">
                          {minToHM(p.startMin)}-{minToHM(p.endMin)} {locationById(p.startLocId).code}→{locationById(p.endLocId).code}
                        </td>
                        <td>{escortById(p.escortId).name}</td>
                        <td>
                          {p.actualStudentIds
                            ? p.actualStudentIds.map(studentName).join('、') || '（已无）'
                            : <span className="muted">计划：{p.plannedStudentIds.map(studentName).join('、')}</span>}
                        </td>
                        <td><Badge tone={st.tone}>{st.label}</Badge></td>
                        <td>
                          <div className="row-gap">
                            {p.status === 'assigned' && (
                              <Button
                                className="btn-sm"
                                tone="primary"
                                disabled={!mine}
                                title={mine ? '' : '请切换到该护送员身份'}
                                onClick={() =>
                                  void run((snap) => acceptPhase(snap, { journeyId: j.id, phaseId: p.id, escortId: user.id, atMin: nowMin }), '已接单。')
                                }
                              >
                                接单
                              </Button>
                            )}
                            {p.status === 'accepted' && (
                              <Button
                                className="btn-sm"
                                tone="primary"
                                disabled={!mine || nowMin < p.startMin}
                                title={nowMin < p.startMin ? `未到接应时间（${minToHM(p.startMin)}）` : ''}
                                onClick={() =>
                                  void run(
                                    (snap) => confirmPickup(snap, { journeyId: j.id, phaseId: p.id, studentIds: p.plannedStudentIds, atMin: nowMin }),
                                    '已确认接到学生，该阶段写入实际负责集合。',
                                  )
                                }
                              >
                                确认接到学生
                              </Button>
                            )}
                            {p.status === 'picked_up' && j.mode === 'shuttle' && (
                              <Button
                                className="btn-sm"
                                tone="primary"
                                disabled={!mine || !ride || nowMin > ride.departMin}
                                title={ride && nowMin > ride.departMin ? '班次已发车' : ''}
                                onClick={() =>
                                  void run(
                                    (snap) =>
                                      registerBoarding(snap, {
                                        journeyId: j.id,
                                        phaseId: p.id,
                                        departureId: ride!.departureId!,
                                        studentIds: p.actualStudentIds ?? [],
                                        atMin: nowMin,
                                      }),
                                    '已登记上车（护送员责任结束于车门）。',
                                  )
                                }
                              >
                                登记上车
                              </Button>
                            )}
                            {p.status === 'picked_up' && (
                              <>
                                <select
                                  value={handoverTo[p.id] ?? ''}
                                  onChange={(e) => setHandoverTo((prev) => ({ ...prev, [p.id]: e.target.value }))}
                                  style={{ padding: '4px 6px', fontSize: 12.5 }}
                                >
                                  <option value="">选择接续护送员…</option>
                                  {SEED_ESCORTS.filter((e) => e.id !== p.escortId).map((e) => (
                                    <option key={e.id} value={e.id}>{e.name}</option>
                                  ))}
                                </select>
                                <Button
                                  className="btn-sm"
                                  disabled={!handoverTo[p.id]}
                                  title="原责任保持到接续者实际确认"
                                  onClick={() =>
                                    void run(
                                      (snap) =>
                                        handoverPhase(snap, {
                                          journeyId: j.id,
                                          fromPhaseId: p.id,
                                          toEscortId: handoverTo[p.id],
                                          studentIds: p.actualStudentIds ?? [],
                                          atMin: nowMin,
                                        }),
                                      '途中交接完成：接续者已实际确认，原责任解除。',
                                    )
                                  }
                                >
                                  途中交接
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="row-gap" style={{ marginTop: 10 }}>
                {j.mode === 'shuttle' && j.boarded.length > 0 && j.alighted.length < j.boarded.length && (
                  <Button
                    className="btn-sm"
                    disabled={!ride || nowMin < ride.arriveMin}
                    title={ride && nowMin < ride.arriveMin ? `班车 ${minToHM(ride.arriveMin)} 才到达` : ''}
                    onClick={() =>
                      void run(
                        (snap) => registerAlighting(snap, { journeyId: j.id, studentIds: j.boarded.filter((s) => !j.alighted.includes(s)), atMin: nowMin }),
                        '已登记下车（注意：下车 ≠ 到课）。',
                      )
                    }
                  >
                    登记下车
                  </Button>
                )}
                {j.status === 'in_progress' && (
                  <Button
                    className="btn-sm"
                    tone="primary"
                    disabled={
                      j.mode === 'walk'
                        ? nowMin < j.arriveMin || !j.phases.some((p) => p.status === 'picked_up')
                        : j.alighted.filter((s) => !j.handed.includes(s)).length === 0
                    }
                    title={j.mode === 'walk' && nowMin < j.arriveMin ? `预计 ${minToHM(j.arriveMin)} 到达` : ''}
                    onClick={() =>
                      void run(
                        (snap) =>
                          handToTeacher(snap, {
                            journeyId: j.id,
                            studentIds:
                              j.mode === 'walk'
                                ? [...new Set(j.phases.filter((p) => p.status === 'picked_up').flatMap((p) => p.actualStudentIds ?? []))]
                                : j.alighted.filter((s) => !j.handed.includes(s)),
                            teacherId: RECEIVING_TEACHER_ID,
                            atMin: nowMin,
                          }),
                        '已交接给接收教师。',
                      )
                    }
                  >
                    交接给接收教师
                  </Button>
                )}
                {j.handed.filter((s) => !j.arrived.includes(s)).map((sid) => (
                  <Button
                    key={sid}
                    className="btn-sm"
                    tone="primary"
                    disabled={user.id !== RECEIVING_TEACHER_ID}
                    title={user.id !== RECEIVING_TEACHER_ID ? '请切换到接收教师（林老师）身份' : ''}
                    onClick={() =>
                      void run(
                        (snap) => confirmArrival(snap, { journeyId: j.id, studentId: sid, teacherId: user.id, atMin: nowMin }),
                        `${studentName(sid)} 已确认到课。`,
                      )
                    }
                  >
                    确认{studentName(sid)}到课
                  </Button>
                ))}
                <span className="muted" style={{ fontSize: 12.5 }}>
                  已上车 {j.boarded.length} · 已下车 {j.alighted.length} · 已交接 {j.handed.length} · 已到课 {j.arrived.length} / {g.studentIds.length}
                </span>
              </div>
            </div>
          );
        })}
      </Card>

      <Card title="④ 扰动演示（不自动改行程：两种方式都需按新的合法候选重新确认，原安排保留）">
        <div className="row-gap">
          <Button
            tone="danger"
            disabled={snapshot.transit.departures.dep_0900?.cancelled}
            onClick={() => void run((snap) => cancelDeparture(snap, { departureId: 'dep_0900', reason: '车辆故障', atMin: nowMin, by: user.id }), '已取消 09:00 班次；受影响行程已在上方标红，等待重新确认。')}
          >
            取消 09:00 班次
          </Button>
          <Button
            tone="danger"
            disabled={snapshot.transit.walkEdges.we_WC?.closed}
            onClick={() => void run((snap) => closeWalkEdge(snap, { edgeId: 'we_WC', reason: '路面维修', atMin: nowMin, by: user.id }), '已关闭 W→C 道路；步行候选将绕行失败，需重新确认。')}
          >
            关闭 W→C 道路
          </Button>
          {SEED_ESCORTS.map((e) => (
            <Button
              key={e.id}
              tone="danger"
              onClick={() =>
                void run(
                  (snap) => setEscortLeave(snap, { escortId: e.id, onLeave: !snapshot.transit.escorts[e.id]?.onLeave, atMin: nowMin, by: user.id }),
                  snapshot.transit.escorts[e.id]?.onLeave ? `${e.name} 已销假。` : `${e.name} 已请假；相关行程需重新确认护送安排。`,
                )
              }
            >
              {snapshot.transit.escorts[e.id]?.onLeave ? `${e.name} 销假` : `${e.name} 请假`}
            </Button>
          ))}
          <Button
            tone="danger"
            onClick={() =>
              void run(
                (snap) =>
                  setDepartureLoad(snap, {
                    departureId: 'dep_0920',
                    reservedSeats: snapshot.transit.departures.dep_0920?.reservedSeats ? 0 : 4,
                    reservedBays: snapshot.transit.departures.dep_0920?.reservedBays ? 0 : 1,
                    atMin: nowMin,
                    by: user.id,
                  }),
                '已更新 09:20 班次的临时占用（模拟其他乘客造成的临时满载）。',
              )
            }
          >
            {snapshot.transit.departures.dep_0920?.reservedSeats ? '清空 09:20 临时占用' : '09:20 临时满载（其他乘客占满）'}
          </Button>
          <Button
            tone="primary"
            disabled={!snapshot.transit.walkEdges.we_OC?.closed || user.role !== 'facility'}
            title={user.role !== 'facility' ? '请切换到设施人员身份' : ''}
            onClick={() => void run((snap) => reopenWalkEdge(snap, { edgeId: 'we_OC', atMin: nowMin, by: user.id }), '设施已解除连廊封闭；既有行程不自动变更。')}
          >
            设施解除连廊封闭
          </Button>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginBottom: 0 }}>
          解除封路前，任何重算都不会自动恢复直达连廊；解除后新候选才会包含 O↔C 直达边，且既有行程保持原样。
        </p>
      </Card>

      <Card title="⑤ 出行通知（版本递增，旧版自动作废；未接收者保留待办，旧通知可能晚到）">
        {Object.keys(snapshot.transit.notifications).length === 0 && <Empty text="暂无通知" />}
        {SEED_GROUPS.map((g) => {
          const notes = Object.values(snapshot.transit.notifications)
            .filter((n) => n.groupId === g.id)
            .sort((a, b) => b.version - a.version);
          if (!notes.length) return null;
          return (
            <div key={g.id} style={{ marginBottom: 12 }}>
              <h4 style={{ margin: '4px 0 6px' }}>{g.name}</h4>
              <table>
                <thead><tr><th>版本</th><th>内容</th><th>状态</th><th>接收情况</th></tr></thead>
                <tbody>
                  {notes.map((n) => (
                    <tr key={n.id}>
                      <td className="notice-version">v{n.version}</td>
                      <td style={{ maxWidth: 420 }}>{n.body}</td>
                      <td>
                        {n.superseded ? <Badge tone="neutral">已作废{n.receivedBy.length < n.audience.length ? '·晚到' : ''}</Badge> : <Badge tone="ok">当前版本</Badge>}
                      </td>
                      <td className="muted">
                        {n.audience.map((uid) => {
                          const got = n.receivedBy.includes(uid);
                          const name = uid === RECEIVING_TEACHER_ID ? '接收教师' : escortById(uid).name;
                          return (
                            <div key={uid}>
                              {name}：{got ? '已接收' : '未接收（待办保留）'}
                            </div>
                          );
                        })}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        })}
      </Card>
    </div>
  );
}

// ---------- 分组办理面板 ----------

function GroupPanel({
  groupId,
  mode,
  setMode,
  candidate,
  onCompute,
  onConfirm,
  journeys,
}: {
  groupId: string;
  mode: TravelMode;
  setMode: (m: TravelMode) => void;
  candidate: CandidatePlan | null;
  onCompute: () => void;
  onConfirm: () => void;
  journeys: TransitJourney[];
}) {
  const app = useApp();
  const { snapshot } = app;
  const g = groupById(groupId);
  const active = activeJourneyOf(snapshot, groupId);
  const problems = active ? journeyProblems(snapshot, active) : [];
  const history = journeys.filter((j) => j.status === 'superseded' || j.status === 'cancelled' || j.status === 'completed');

  return (
    <Card
      title={`② ${g.name}办理（${g.studentIds.map(studentName).join('、')}；${minToHM(g.departMin)} 出发，${minToHM(g.arriveByMin)} 前到 C 楼）`}
      extra={
        <div className="row-gap">
          {(['walk', 'shuttle'] as TravelMode[]).map((m) => (
            <Button key={m} className="btn-sm" tone={mode === m ? 'primary' : 'ghost'} onClick={() => setMode(m)}>
              {MODE_LABEL[m]}
            </Button>
          ))}
          <Button className="btn-sm" onClick={onCompute}>计算候选</Button>
        </div>
      }
    >
      {active && (
        <div className="plan-card" style={{ marginBottom: 12 }}>
          <h4>
            当前安排 v{active.version} · {MODE_LABEL[active.mode]}
            <Badge tone={JOURNEY_STATUS[active.status].tone}>{JOURNEY_STATUS[active.status].label}</Badge>
            <span className="muted" style={{ fontWeight: 400, fontSize: 12.5 }}>
              {minToHM(active.departMin)} → {minToHM(active.arriveMin)}
            </span>
          </h4>
          <LegsTimeline legs={active.legs} />
          {problems.length > 0 && (
            <div className="banner banner-bad" style={{ marginTop: 8, marginBottom: 0 }}>
              <b>受扰动影响，需按新的合法候选重新确认：</b>
              <ul className="reason-list" style={{ marginTop: 4 }}>
                {problems.map((p, i) => <li key={i}>{p}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      {candidate && (
        <div className="plan-card" style={{ marginBottom: 12 }}>
          <h4>
            候选 · {MODE_LABEL[mode]}
            {candidate.feasible ? (
              <Badge tone="ok">最早 {minToHM(candidate.arriveMin!)} 到达（要求 {minToHM(candidate.arriveByMin)} 前）</Badge>
            ) : (
              <Badge tone="bad">不可行</Badge>
            )}
          </h4>
          {candidate.feasible ? (
            <>
              <LegsTimeline legs={candidate.legs} />
              <div className="grid-2" style={{ marginTop: 10 }}>
                <div>
                  <h4 style={{ margin: '2px 0 6px' }}>时间展开图（地点 × 每分钟）</h4>
                  <ul className="mono" style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                    <li>地点时刻点：{candidate.stats.expanded.nodes}（{candidate.stats.expanded.locationCount} 地点 × {candidate.stats.expanded.tickCount} 刻度）</li>
                    <li>等候边：{candidate.stats.expanded.waitEdges}</li>
                    <li>步行边实例：{candidate.stats.expanded.walkEdgeInstances}；班次边实例：{candidate.stats.expanded.rideEdgeInstances}</li>
                    <li>搜索确定状态：{candidate.stats.expanded.settledStates}；边松弛：{candidate.stats.expanded.relaxations}</li>
                  </ul>
                </div>
                <div>
                  <h4 style={{ margin: '2px 0 6px' }}>地点图（遍历时查询班次）</h4>
                  <ul className="mono" style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
                    <li>地理节点：{candidate.stats.location.nodes}（只保留地点与到达标签）</li>
                    <li>确定标签：{candidate.stats.location.settledLabels}；步行松弛：{candidate.stats.location.walkRelaxations}</li>
                    <li>班次查询量：{candidate.stats.location.scheduleQueries}</li>
                  </ul>
                </div>
              </div>
              {candidate.escortChecks.length > 0 && (
                <table style={{ marginTop: 10 }}>
                  <thead><tr><th>护送员评估</th><th>判定</th></tr></thead>
                  <tbody>
                    {candidate.escortChecks.map((c, i) => (
                      <tr key={i}>
                        <td>{c.name}</td>
                        <td>{c.ok ? <Badge tone="ok">可派出</Badge> : <span className="cross-line" style={{ color: 'var(--bad)' }}>{c.reasons.join('；')}</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          ) : (
            <ul className="reason-list">
              {candidate.reasons.map((r, i) => <li key={i}>{r}</li>)}
            </ul>
          )}
          <div className="row-gap" style={{ marginTop: 10 }}>
            <Button tone="primary" disabled={!candidate.feasible || app.user.role !== 'dispatcher'} title={app.user.role !== 'dispatcher' ? '请切换到调度员身份' : '以最新快照原子核对后确认；任一不足退回重算'} onClick={onConfirm}>
              {active ? `重新确认（替代当前安排 v${active.version}）` : '确认登记（原子核对资源）'}
            </Button>
            {app.user.role !== 'dispatcher' && <span className="muted">确认需调度员身份</span>}
          </div>
        </div>
      )}
      {!candidate && <Empty text="选择出行方式后点“计算候选”；候选不占座，确认时才原子核对" />}

      {history.length > 0 && (
        <details>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12.5 }}>历史安排（{history.length}）</summary>
          <table style={{ marginTop: 6 }}>
            <thead><tr><th>版本</th><th>方式</th><th>行程</th><th>状态</th></tr></thead>
            <tbody>
              {history.map((j) => (
                <tr key={j.id}>
                  <td className="notice-version">v{j.version}</td>
                  <td>{MODE_LABEL[j.mode]}</td>
                  <td className="mono">{minToHM(j.departMin)} → {minToHM(j.arriveMin)}</td>
                  <td><Badge tone={JOURNEY_STATUS[j.status].tone}>{JOURNEY_STATUS[j.status].label}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </Card>
  );
}

function LegsTimeline({ legs }: { legs: JourneyLeg[] }) {
  return (
    <ol className="timeline" style={{ marginTop: 4 }}>
      {legs.map((leg, i) => (
        <li key={i}>
          <span className="mono">{minToHM(leg.departMin)}-{minToHM(leg.arriveMin)}</span>{' '}
          <Badge tone={leg.kind === 'ride' ? 'info' : leg.kind === 'wait' ? 'warn' : 'neutral'}>
            {leg.kind === 'walk' ? '步行' : leg.kind === 'wait' ? '候车' : '班车'}
          </Badge>{' '}
          {legText(leg)}
        </li>
      ))}
    </ol>
  );
}
