/* eslint-disable react-refresh/only-export-components -- standalone browser fixture */
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CreateGroupDialog, TeamWorkspace } from '../../src/public/team-components.js';
import type { GroupCreateInput, GroupMessageInput, TeamInteractionInput } from '../../src/public/teams.js';
import '../../src/components/teams/teams.css';
import { memberRef, teamSnapshot } from './teams-data.js';

const style = document.createElement('style');
style.textContent = 'html,body,#root{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}#fixture-shell{height:100%;display:flex;flex-direction:column}.fixture-label{background:#f4f5f6;color:#828790;font-size:10px;padding:5px 16px;display:flex;align-items:center;justify-content:space-between}.fixture-label button{font:inherit;background:white;border:1px solid #ddd;border-radius:4px;padding:3px 8px;color:#444}.fixture-content{min-height:0;flex:1;display:flex}.fixture-navigation{width:190px;flex-shrink:0;background:#fafbfc;border-right:1px solid #e8eaed;padding:24px 15px;box-sizing:border-box;font-size:12px;color:#7a8088}.fixture-navigation h3{font-size:13px;color:#292e34;margin:0 0 30px;font-weight:550}.fixture-navigation p{margin:0 0 10px}.fixture-navigation strong{display:block;background:#ecefef;color:#526359;padding:10px;border-radius:7px;font-weight:500}.fixture-workspace{flex:1;min-width:0}@media(max-width:1024px){.fixture-navigation{display:none}}';
document.head.append(style);
const records = { messages: [] as GroupMessageInput[], interactions: [] as TeamInteractionInput[], groups: [] as GroupCreateInput[], controls: [] as string[], acceptances: [] as { teamRunId: string; accepted: boolean; reason?: string }[] };
Object.assign(window, { teamFixtureRecords: records });

function App() {
  const [snapshot, setSnapshot] = useState(() => {
    const value = teamSnapshot();
    if (new URLSearchParams(location.search).has('redesign')) {
      value.messages.forEach(message => { message.teamRunId = 'team-run'; });
      value.teamRuns[0].status = 'awaiting_acceptance';
      value.teamRuns[0].result = '### 接口改造方案已完成\n\n- 保留现有请求字段，新增任务标识用于并行隔离。\n- 已核对审批引用、重连和幂等回执三个边界。\n- 建议先发布兼容接口，再逐步切换任务工作区。';
      value.tasks.forEach(task => { task.status = 'succeeded'; task.reason = undefined; task.attempts.forEach(attempt => { attempt.status = 'succeeded'; }); });
      value.teamRuns[0].policy = { taskAcceptance: 'leader', peerWake: false };
      value.teamRuns.push({ ...value.teamRuns[0], teamRunId: 'parallel-run', goal: '整理产品发布检查清单', status: 'running', goalMessageId: 'parallel-goal' });
      value.messages.push({ ...value.messages[0], messageId: 'parallel-goal', teamRunId: 'parallel-run', parts: [{ kind: 'text', text: '请整理一份发布检查清单，标注需要人工确认的步骤。' }] });
      value.runMembers = value.teamRuns.flatMap(run => value.members.map(member => ({ ...member, runMemberId: `${run.teamRunId}-${member.memberId}`, teamRunId: run.teamRunId, groupRevision: 1, sessionId: `${run.teamRunId}-${member.sessionId}` })));
    }
    if (new URLSearchParams(location.search).has('approval')) value.interactions = ['engineer', 'leader'].map(memberId => ({ ref: { ...memberRef(memberId), interactionId: 'same-approval' }, revision: 1, title: '确认执行受控检查', message: '此操作需要人工确认后才能继续。', kind: 'approval', status: 'pending', createdAt: '2026-09-10T08:04:00Z' }));
    return value;
  });
  const [creating, setCreating] = useState(false);
  return <div id="fixture-shell"><div className="fixture-label"><span>协议模拟数据 · 仅用于验证界面，不代表真实运行</span><button type="button" onClick={() => setCreating(true)}>创建测试团队</button></div><div className="fixture-content"><nav className="fixture-navigation"><h3>Agent Kit Studio</h3><p>团队</p><strong>接口改造协作组</strong><p style={{ marginTop: 28 }}>单聊</p><p>协调助手</p><p>工程师</p></nav><div className="fixture-workspace"><TeamWorkspace snapshot={snapshot} initialSelection={{ teamRunId: 'team-run' }} onAcceptRun={async (run, accepted, reason) => { records.acceptances.push({ teamRunId: run.teamRunId, accepted, reason }); setSnapshot(current => ({ ...current, teamRuns: current.teamRuns.map(row => row.teamRunId === run.teamRunId ? { ...row, status: accepted ? 'succeeded' : 'running', reason: accepted ? undefined : reason } : row) })); }} onSend={async input => {
    records.messages.push(input);
    setSnapshot(current => ({ ...current, messages: [...current.messages, { messageId: input.idempotencyKey, groupId: current.group.groupId, revision: 1, createdAt: new Date().toISOString(), teamRunId: input.teamRunId || snapshot.teamRuns[0].teamRunId, senderPrincipal: 'fixture-owner', senderName: '我', groupRole: 'owner', parts: input.parts, mentions: input.mentions, intent: input.intent, visibility: 'public' }] }));
    return { status: 'accepted', groupId: snapshot.group.groupId };
  }} onControl={async (_run, action) => { records.controls.push(action); }} onTaskAction={async () => {}} onRespondInteraction={async input => { records.interactions.push(input); return { status: 'accepted', groupId: snapshot.group.groupId }; }} /></div></div><CreateGroupDialog open={creating} candidates={snapshot.members.map(member => ({ memberId: member.memberId, name: member.name, binding: member.binding }))} onClose={() => setCreating(false)} onCreate={async input => { records.groups.push(input); }} /></div>;
}
createRoot(document.getElementById('root')!).render(<App />);
