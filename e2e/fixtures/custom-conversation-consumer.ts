import {
  HttpConversationClient,
  buildConversationInput,
  type ConversationPresentation,
} from '@kingsoftcloud/ksadk-web/conversation';

const AGENT_ID = 'canonical-fixture-agent';
const SESSION_ID = 'canonical-fixture-session';

const composer = document.querySelector<HTMLFormElement>('#composer');
const message = document.querySelector<HTMLTextAreaElement>('#message');
const status = document.querySelector<HTMLElement>('#status');
const timeline = document.querySelector<HTMLElement>('#timeline');

if (!composer || !message || !status || !timeline) {
  throw new Error('custom conversation fixture DOM is incomplete');
}

const client = new HttpConversationClient({ retryDelayMs: () => 1 });
const presentations = new Map<string, ConversationPresentation>();
let turn = 0;

function node(tag: string, text: string, kind: string): HTMLElement {
  const element = document.createElement(tag);
  element.textContent = text;
  element.dataset.kind = kind;
  return element;
}

function render(): void {
  timeline.replaceChildren();
  for (const presentation of presentations.values()) {
    const turnNode = document.createElement('article');
    turnNode.dataset.runId = presentation.runId;
    for (const item of presentation.textItems) {
      turnNode.append(node('p', item.text, item.kind));
    }
    for (const item of presentation.toolItems) {
      turnNode.append(node('div', String(item.payload.tool || 'Tool'), 'tool'));
    }
    for (const item of presentation.approvalItems) {
      const approval = node(
        'div',
        String(item.payload.title || item.payload.prompt || 'Approval'),
        'approval',
      );
      if (item.lifecycle !== 'completed') {
        const approve = node('button', 'Approve', 'approval-action') as HTMLButtonElement;
        approve.type = 'button';
        const interactionId = String(item.payload.interactionId || '');
        const revision = Number(item.payload.revision);
        approve.disabled = !interactionId || !Number.isInteger(revision) || revision < 1;
        approve.addEventListener('click', () => {
          void (async () => {
            const response = await fetch('/agentengine/api/v1/SubmitInteraction', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                InteractionId: interactionId,
                ExpectedRevision: revision,
                Action: 'approve',
                IdempotencyKey: `interaction:${interactionId}:revision-${revision}`,
              }),
            });
            if (!response.ok) throw new Error(`approval failed with HTTP ${response.status}`);
          })().catch((error: unknown) => {
            status.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
          });
        });
        approval.append(approve);
      }
      turnNode.append(approval);
    }
    for (const fallback of presentation.fallbacks) {
      turnNode.append(node('div', `${fallback.title}: ${fallback.detail}`, 'fallback'));
    }
    timeline.append(turnNode);
  }
}

composer.addEventListener('submit', (event) => {
  event.preventDefault();
  const text = message.value.trim();
  if (!text) return;
  message.value = '';
  turn += 1;
  const currentTurn = turn;
  status.textContent = `streaming-${currentTurn}`;
  void (async () => {
    const bootstrap = await client.getSurface(AGENT_ID, SESSION_ID);
    const input = buildConversationInput({
      inputId: `custom-input-${currentTurn}`,
      sessionId: SESSION_ID,
      idempotencyKey: `custom-turn-${currentTurn}`,
      parts: [{ kind: 'text', text }],
      modelRef: 'fixture-model',
    });
    const result = await client.streamTurn({
      bootstrap,
      input,
      onUpdate(snapshot) {
        presentations.set(snapshot.runId, snapshot.presentation);
        render();
      },
    });
    presentations.set(result.runId, result.presentation);
    render();
    status.textContent = `completed-${currentTurn}`;
  })().catch((error: unknown) => {
    status.textContent = `failed: ${error instanceof Error ? error.message : String(error)}`;
  });
});
