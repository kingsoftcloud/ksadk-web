import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HarnessRunView } from '../components/chat/HarnessRunView';
import { projectConversationStreamForHostedUi } from '../core/conversation/hosted';
import { projectConversationItems } from '../core/conversation/presentation';
import { RuntimeConversationIngress } from '../core/conversation/runtime-ingress';
import { mergeHarnessViewMessage } from '../core/conversation/harness-view';
import { ResponsesProtocol } from '../core/stream/responses-protocol';
import { rebuildPersistedSessionHistory } from '../utils/persisted-session-history';

describe('independent Harness task view', () => {
  it('shows the Studio Responses view once during streaming and after history reload beside the final answer', () => {
    const sha256 = 'a'.repeat(64), invocation = 'public-invocation';
    const view = { contract: 'agentkit.engine-view/v1', sha256,
      event: { schema: 'agentkit.engine-event/v1', seq: 8, kind: 'tool.completed', title: 'write_workspace_file' } };
    const protocol = new ResponsesProtocol();
    const [action] = protocol.parse({ eventName: 'response.harness_view', data: { run_id: invocation, harness_view: view } }, protocol.createState());
    if (action?.type !== 'harness_view') throw new Error('missing view action');
    const answer = { id: 'answer', role: 'model' as const, content: 'Final answer', timestamp: 300, invocationId: invocation,
      historyOrder: { seq: 10 } };
    const live = mergeHarnessViewMessage([answer], action.runId, action.view, { anchorId: 'answer', timestamp: 200, seq: 9 });
    expect(live.map(row => row.id)).toEqual([`harness-view:${invocation}`, 'answer']);
    const replayed = rebuildPersistedSessionHistory([answer], [{ SessionId: 'session', SeqId: 9, Timestamp: 200,
      InvocationId: invocation, EventType: 'harness_view', Content: { harness_view: view } }], 'session');
    expect(replayed.messages.map(row => row.id)).toEqual(live.map(row => row.id));
    expect(replayed.messages[0].harnessView).toEqual(live[0].harnessView);
    expect(replayed.messages[1].content).toBe('Final answer');
  });
  it('keeps one pinned view per run across raw-event replay and uses a scripts-only iframe', () => {
    const sha256 = 'a'.repeat(64);
    const ingress = new RuntimeConversationIngress('session-1');
    const frame = (seq: number, eventType: string, view = sha256) => ({
      schema_version: 2, seq, run_id: 'run-1', scope_id: 'run-1',
      event_id: 'event-' + seq, event_type: eventType,
      source: { framework: 'ksadk', metadata: { harness_service_presentation: {
        contract: 'agentkit.engine-view/v1', sha256: view,
        event: { schema: 'agentkit.engine-event/v1', kind: eventType, seq },
      } } },
    });
    const events = [frame(1, 'run.started'), frame(2, 'run.progress'),
      frame(3, 'run.progress', 'b'.repeat(64)), frame(4, 'run.completed')];
    events.forEach(item => ingress.apply(item));
    events.forEach(item => ingress.apply(item));

    const state = ingress.snapshot();
    const presentation = projectConversationItems(state);
    const { messages } = projectConversationStreamForHostedUi({
      state, presentation, cursor: 4, runId: 'run-1',
    });
    expect(messages).toHaveLength(1);
    const view = messages[0].harnessView!;
    expect(view.sha256).toBe(sha256);
    expect(view.events.map(event => event.seq)).toEqual([1, 2, 4]);
    const html = renderToStaticMarkup(<HarnessRunView view={view} />);
    expect(html).toContain(`src="/_ksadk/harness/v1/views/${sha256}"`);
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).not.toContain('allow-same-origin');
  });
});
