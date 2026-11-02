import { expect, it, vi } from 'vitest';
import type { RunEvent } from '../core/run/types.js';
const control = vi.hoisted(() => ({ calls: 0, release: () => {} }));
const callbacks = vi.hoisted(() => [] as Array<(event: RunEvent) => void>);
vi.mock('../core/run/agui.js', () => ({ AguiRunClient: class {
  constructor(options: { onEvent: (event: RunEvent) => void }) { callbacks.push(options.onEvent); }
  configure() {} reconcileInteractions() {} abort() {}
  async run() {
    control.calls++;
    if (control.calls === 2) await new Promise<void>(resolve => { control.release = resolve; });
    return { status: 'completed', pendingInterruptIds: [], result: { result: null, newMessages: [] } };
  }
} }));
import { RunEngineImpl } from '../core/run/engine.js';

it('a replaced AG-UI client cannot project its snapshot into the current session', async () => {
  const engine = new RunEngineImpl({} as never);
  engine.updateConfig({ agentId: 'a', apiFormats: ['responses'], agentFramework: 'langgraph', selectedModel: '', thinkingMode: 'auto',
    hostedChatTransport: { Protocol: 'ag-ui', Runtime: 'copilotkit', Endpoint: '/agui', Version: '1.0', Capabilities: { A2UI: true, Interrupt: true, Cancel: true } } });
  const received: RunEvent[] = [];
  engine.subscribe(event => received.push(event));
  engine.start({ text: 'first', attachments: [], sessionId: 'first' });
  await vi.waitFor(() => expect(engine.stage).toBe('idle'));
  engine.start({ text: 'second', attachments: [], sessionId: 'second' });
  await vi.waitFor(() => expect(callbacks).toHaveLength(2));
  expect(engine.stage).toBe('streaming');
  callbacks[0]({ type: 'text_replace', messageId: 'old', text: 'late', sessionId: 'first' });
  callbacks[1]({ type: 'text_replace', messageId: 'new', text: 'current', sessionId: 'second' });
  expect(received.filter(event => event.type === 'text_replace')).toEqual([
    { type: 'text_replace', messageId: 'new', text: 'current', sessionId: 'second' },
  ]);
  control.release();
  await vi.waitFor(() => expect(engine.stage).toBe('idle'));
  callbacks[1]({ type: 'text_replace', messageId: 'new', text: 'after finish', sessionId: 'second' });
  expect(received.filter(event => event.type === 'text_replace')).toHaveLength(1);
});
