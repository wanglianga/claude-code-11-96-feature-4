import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../state/store';
import { Badge, Button, Card } from '../components/ui';
import type { AppEvent } from '../types';
import { workerClient } from '../worker/client';
import { minToHM } from '../lib/time';

const EVENT_TEXT: Record<AppEvent['type'], (e: AppEvent) => string> = {
  'incident.created': (e) => e.type === 'incident.created' ? `新建事故，故障类型 ${e.faultType}，首报房间 ${e.roomIds.join(',')}` : '',
  'report.submitted': (e) => e.type === 'report.submitted' ? `收到报修（${e.duplicate ? '重复·合并' : '首报'}）：房间 ${e.roomId}，照片 ${e.photoIds.length} 张` : '',
  'incident.boundaryConfirmed': (e) => e.type === 'incident.boundaryConfirmed' ? `设施核准边界 [${e.roomIds.join('、')}]，预计 ${minToHM(e.estimatedEndMin)} 修复，房间封闭` : '',
  'workorder.created': (e) => e.type === 'workorder.created' ? `生成工单 ${e.workOrderId.slice(-6)}，负责人 ${e.assignee}` : '',
  'repair.marked': () => '维修人员标记“已修复”，等待设施复测（封闭未解除）',
  'retest.failed': (e) => e.type === 'retest.failed' ? `复测失败：${e.note}（维持封闭，安排不回滚）` : '',
  'retest.passed': () => '设施复测通过，解除封闭，房间恢复使用',
  'reassignment.proposed': (e) => e.type === 'reassignment.proposed' ? `调度生成${e.strategy === 'minimal' ? '方案一（仅移动受影响课程）' : '方案二（弹性换房）'}，${e.studentMinutes} 学生分钟，涉及 ${e.moves.length} 个班` : '',
  'reassignment.confirmed': (e) => e.type === 'reassignment.confirmed' ? `教师确认改排：课程 ${e.courseId}` : '',
  'reassignment.published': (e) => e.type === 'reassignment.published' ? `方案 ${e.planId.slice(-6)} 发布，发出 ${e.notificationIds.length} 条同版本通知` : '',
  'reassignment.cancelled': (e) => e.type === 'reassignment.cancelled' ? `方案取消：${e.reason}` : '',
  'notification.sent': (e) => e.type === 'notification.sent' ? `通知 v${e.version} 发给 ${e.className}：改至 ${e.roomName}（${e.supersedesId ? '旧版本已作废' : '首版'}）` : '',
};

export function ReplayView() {
  const app = useApp();
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [seq, setSeq] = useState<number>(0);

  useEffect(() => {
    let alive = true;
    void workerClient.listEvents().then((list) => {
      if (!alive) return;
      setEvents(list);
      const max = list.length ? list[list.length - 1].seq : 0;
      // 处于历史回放时保留滑块位置；回到最新视图时同步到最大 seq
      setSeq((prev) => (app.replaySeq === null ? max : Math.min(prev, max)));
    });
    return () => {
      alive = false;
    };
  }, [app.snapshot.seq, app.replaySeq]);

  const maxSeq = events.length ? events[events.length - 1].seq : 0;
  const visible = useMemo(() => events.filter((e) => e.seq <= seq), [events, seq]);

  return (
    <div>
      <Card title="事件日志与本地回放（IndexedDB 只追加事件流）">
        <div className="row-gap" style={{ marginBottom: 10 }}>
          <input
            type="range"
            min={0}
            max={maxSeq}
            value={seq}
            onChange={(e) => {
              const v = Number(e.target.value);
              setSeq(v);
              void app.replayAt(v === maxSeq ? null : v);
            }}
            style={{ flex: 1 }}
          />
          <span className="mono">回放至 seq #{seq} / {maxSeq}</span>
          <Button onClick={() => { setSeq(maxSeq); void app.replayAt(null); }}>回到最新</Button>
          <Button tone="danger" onClick={() => { if (confirm('确认清空全部事件、草稿与照片并重置演示？')) void app.resetAll(); }}>
            重置演示数据
          </Button>
        </div>
        {app.replaySeq !== null && (
          <div className="banner banner-warn">
            正在浏览历史快照（seq #{app.replaySeq}），各工作台显示的是当时状态；点击“回到最新”恢复实时视图。
          </div>
        )}
        {events.length === 0 && <p className="empty">暂无事件</p>}
        <ol className="timeline">
          {visible.map((e) => (
            <li key={e.seq}>
              <span className="seq">#{e.seq}</span>
              <Badge tone="neutral">{e.type}</Badge>
              <span className="at">{e.at.replace('T', ' ').slice(0, 16)}</span>
              <div className="desc">{EVENT_TEXT[e.type](e)}</div>
            </li>
          ))}
        </ol>
      </Card>

      <Card title="当前快照核查（随回放位置变化）">
        <ul>
          <li>事件总数（当前视图）：{visible.length} ／ 全量 {events.length}</li>
          <li>封闭房间：{Object.entries(app.snapshot.closures).filter(([, c]) => c.closed).map(([r]) => app.snapshot.rooms[r]?.name).join('、') || '无'}</li>
          <li>事故数：{Object.keys(app.snapshot.incidents).length}；工单数：{Object.keys(app.snapshot.workOrders).length}</li>
          <li>已发布方案：{Object.values(app.snapshot.plans).filter((p) => p.status === 'published').length}；通知数：{Object.keys(app.snapshot.notifications).length}</li>
        </ul>
      </Card>
    </div>
  );
}
