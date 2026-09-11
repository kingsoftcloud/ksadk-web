import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GroupComposer, GroupTimeline, MemberInspector, TaskBoard, TaskDetail, TeamWorkspace } from '../public/team-components.js';
import { InteractionMessage } from '../components/teams/InteractionMessage.js';
import { ExecutionTree } from '../public/team-execution.js';
import { memberRef, teamSnapshot } from '../../e2e/fixtures/teams-data.js';

describe('Teams presentation boundaries', () => {
  it('defaults to chat and progress, with no graph or sidepanel', () => {
    const markup = renderToStaticMarkup(<TeamWorkspace snapshot={teamSnapshot()} onSend={async () => {}} />);
    expect(markup).toContain('team-progress-card');
    expect(markup).not.toContain('team-sidepanel');
    expect(markup).not.toContain('team-graph-node');
    expect(markup).toContain('描述目标');
  });
  it('does not expose internal messages or treat message text as executable markup', () => {
    const snapshot = teamSnapshot(); snapshot.messages.push({ ...snapshot.messages[0], messageId: 'private', visibility: 'internal', parts: [{ kind: 'text', text: 'private-only-marker' }] });
    snapshot.messages[0].parts = [{ kind: 'text', text: '<script>runPlugin()</script>' }];
    const markup = renderToStaticMarkup(<GroupTimeline messages={snapshot.messages} />);
    expect(markup).not.toContain('private-only-marker');
    expect(markup).not.toContain('<script>');
  });
  it('renders member detail as an observer, without a normal chat composer or deletion', () => {
    const markup = renderToStaticMarkup(<MemberInspector member={teamSnapshot().members[1]} />);
    expect(markup).toContain('只读');
    expect(markup).not.toContain('<textarea');
    expect(markup).not.toContain('删除会话');
  });
  it('offers shared artifacts that have not yet been included in a task result', () => {
    const snapshot = teamSnapshot();
    snapshot.artifacts = [{ artifactId: 'shared-file', name: 'shared-review.md', mediaType: 'text/markdown', source: memberRef() }];
    const markup = renderToStaticMarkup(<TeamWorkspace snapshot={snapshot} onSend={async () => {}} />);
    expect(markup).toContain('shared-review.md');
    expect(markup).toContain('引用本群交付物');
  });
  it('presents structured approval arguments with a full inert content preview and keeps plain descriptions', () => {
    const markup = renderToStaticMarkup(<InteractionMessage message={JSON.stringify({ arguments: { path: 'review.md', content: '<script>doNotRun()</script>\nFull report' }, risk: 'high' })} />);
    expect(markup).toContain('文件位置');
    expect(markup).toContain('review.md');
    expect(markup).toContain('查看待写入的文件内容');
    expect(markup).toContain('&lt;script&gt;doNotRun()&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
    expect(markup).toContain('Full report');
    expect(renderToStaticMarkup(<InteractionMessage message="请确认本次操作" />)).toBe('<p>请确认本次操作</p>');
  });
  it('shows real execution failure details and leaves tool payloads inspectable without executing them', () => {
    const ref = memberRef();
    const base = { apiVersion: 'conversation.ksadk.io/v1' as const, kindVersion: 1, itemId: 'failed-item', sourceEventIds: ['event-failed'], sessionId: ref.sessionId, runId: ref.runId, operation: 'append' as const, lifecycle: 'failed' as const, visibility: 'public' as const, payloadSchemaRef: 'test/v1', nativeRef: {} };
    const markup = renderToStaticMarkup(<MemberInspector member={teamSnapshot().members[1]} observation={{ ref, cursor: 1, connection: 'connected', items: [{ ...base, kind: 'error', payload: { error: 'token budget exhausted' } }, { ...base, itemId: 'tool-item', kind: 'tool_call', payload: { tool: 'write_workspace_file', args: { path: 'review.md' } } }] }} />);
    expect(markup).toContain('token budget exhausted');
    expect(markup).toContain('write_workspace_file');
    expect(markup).toContain('review.md');
  });
  it('shows current candidate status without an obsolete approval wait while preserving source and failure reasons', () => {
    for (const status of ['awaiting_acceptance', 'succeeded', 'running', 'failed'] as const) {
      const task = { ...teamSnapshot().tasks[0], status, reason: '等待人工审批' };
      const markup = renderToStaticMarkup(<><TaskBoard tasks={[task]} members={[]} onSelect={() => {}} /><TaskDetail task={task} members={[]} /><ExecutionTree tasks={[task]} members={[]} onSelect={() => {}} /></>);
      if (status === 'awaiting_acceptance' || status === 'succeeded') {
        expect(markup).not.toContain('等待人工审批');
        expect(markup).toContain(status === 'succeeded' ? '已验收' : '待验收');
      } else expect(markup).toContain('等待人工审批');
      expect(task.reason).toBe('等待人工审批');
    }
    const failed = { ...teamSnapshot().tasks[0], status: 'failed' as const, reason: 'token budget exhausted' };
    expect(renderToStaticMarkup(<TaskDetail task={failed} members={[]} />)).toContain('token budget exhausted');
  });
  it('does not manufacture nodes for an empty execution', () => {
    const markup = renderToStaticMarkup(<ExecutionTree tasks={[]} members={[]} onSelect={() => {}} />);
    expect(markup).toContain('尚无执行数据');
    expect(markup).not.toContain('team-graph-node');
  });
  it('gives independent composers different accessible control IDs', () => {
    const markup = renderToStaticMarkup(<><GroupComposer members={[]} activeRun={null} value="" onChange={() => {}} onSend={async () => {}} /><GroupComposer members={[]} activeRun={null} value="" onChange={() => {}} onSend={async () => {}} /></>);
    const ids = [...markup.matchAll(/id="([^"]+)"/g)].map(match => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
