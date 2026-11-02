import { expect, test } from '@playwright/test';

/**
 * Interaction/v1 durable-interaction e2e (Web 0.3.2).
 *
 * The fixture is a Responses-transport server that advertises
 * `interaction_v1`. Pending interactions arrive as durable
 * SessionEvents (replayed via ListSessionEvents on session load), and
 * every decision is a single POST /agentengine/api/v1/SubmitInteraction
 * with revision CAS and an idempotency key.
 */

const SESSION_ID = 'session-interaction-e2e';
const AGENT_ID = 'fixture-agent';

function envelope(data) {
  return { Code: 0, Message: 'Success', Data: data };
}

function sse(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function runtimeCapabilityMatrix() {
  const native = { supported: true, mode: 'native' };
  return {
    schema_version: 1,
    cancel: native,
    pause: native,
    resume: native,
    submit_interaction: native,
    attach: native,
    steer: native,
    inject: native,
    checkpoint: native,
    durable_restore: native,
    goal: native,
    loop: native,
    plan: native,
  };
}

function bootstrap(interactionV1 = true, executionModes = false) {
  return {
    Agent: { AgentId: AGENT_ID, Name: 'Interaction Fixture', Framework: 'ksadk' },
    ApiFormats: ['responses'],
    Capabilities: {
      Attachments: false,
      WorkspaceFiles: false,
      Approval: true,
      Thinking: false,
      StopRun: true,
      ResumeRun: false,
      ...(interactionV1 ? { interaction_v1: { enabled: true } } : {}),
      ...(executionModes ? { RuntimeCapabilityMatrix: runtimeCapabilityMatrix() } : {}),
    },
    HostedChat: {
      PreferredTransport: 'responses',
      Transports: [
        {
          Protocol: 'responses',
          Runtime: 'ksadk',
          Endpoint: '/v1/responses',
          Version: 'v1',
          Capabilities: { A2UI: false, Interrupt: true, Cancel: true },
        },
      ],
    },
    Model: { id: 'fixture-model', display_name: 'Fixture Model' },
  };
}

function requestedEvent(overrides = {}) {
  return {
    EventId: `evt-${overrides.interactionId || 'int-1'}-req`,
    SessionId: SESSION_ID,
    SeqId: 10,
    InvocationId: 'inv-1',
    EventType: 'interaction.requested',
    Content: {
      interaction: {
        interaction_id: overrides.interactionId || 'int-1',
        session_id: SESSION_ID,
        run_id: 'run-1',
        kind: overrides.kind || 'approval',
        revision: 1,
        created_at: '2026-08-19T00:00:00Z',
        ...(overrides.expiresAt ? { expires_at: overrides.expiresAt } : {}),
        ...(overrides.requestSchema ? { request_schema: overrides.requestSchema } : {}),
        ...(overrides.presentation ? { presentation: overrides.presentation } : {}),
        ...(overrides.message ? { message: overrides.message } : {}),
        ...(overrides.title ? { title: overrides.title } : {}),
      },
    },
  };
}

function resolvedEvent(interactionId = 'int-1', outcome = 'approved') {
  return {
    EventId: `evt-${interactionId}-res`,
    SessionId: SESSION_ID,
    SeqId: 11,
    InvocationId: 'inv-1',
    EventType: 'interaction.resolved',
    Content: {
      interaction_id: interactionId,
      outcome,
      actor: 'user',
      resolved_at: '2026-08-19T00:01:00Z',
    },
  };
}

/**
 * Installs the fixture on a page. `state` is shared across pages so two
 * tabs hit the same server truth.
 */
async function installFixture(page, state, options = {}) {
  // This suite exercises the pre-ConversationSurface Interaction/v1 path.
  // An explicit 404 is the only valid compatibility signal; allowing Vite's
  // HTML fallback to answer 200 would correctly fail closed as bad JSON.
  await page.route('**/api/v1/agents/**/conversation-surface**', async (route) => {
    await route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'conversation surface unavailable in legacy fixture' }),
    });
  });

  await page.route('**/agentengine/api/v1/**', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').pop();

    if (action === 'SubmitInteraction') {
      const body = route.request().postDataJSON();
      state.submits.push(body);
      const alreadyResolved = state.resolvedIds.has(body.InteractionId);
      const receipt = alreadyResolved
        ? {
            schema_version: 1,
            command_id: `cmd-${state.submits.length}`,
            status: 'rejected',
            error: {
              code: 'interaction_already_resolved',
              message: 'first-wins: another submission resolved this interaction',
              retryable: false,
            },
          }
        : {
            schema_version: 1,
            command_id: `cmd-${state.submits.length}`,
            status: options.receiptStatus || 'accepted',
          };
      if (!alreadyResolved) {
        state.resolvedIds.add(body.InteractionId);
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(envelope(receipt)),
      });
      return;
    }

    if (action === 'RunAgent') {
      state.runs?.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([
          { type: 'response.completed', status: 'completed', output_text: '运行完成。' },
        ]),
      });
      return;
    }

    if (action === 'SubscribeRunEvents' && state.subscriptions) {
      state.subscriptions.push(Object.fromEntries(new URL(route.request().url()).searchParams));
      await route.fulfill({ status: 200, contentType: 'text/event-stream',
        body: sse([resolvedEvent()]) + 'event: __done__\ndata: {}\n\n' });
      return;
    }

    const sessionId = route.request().postDataJSON()?.SessionId
      || new URL(route.request().url()).searchParams.get('SessionId') || SESSION_ID;
    const events = typeof state.events === 'function' ? state.events(sessionId) : state.events;
    const sessions = state.sessions || (state.sessionCreated
      ? [{ SessionId: SESSION_ID, AgentId: AGENT_ID, Title: 'Interaction fixture' }] : []);
    const payloadByAction = {
      GetAgentUiBootstrap: {
        ...bootstrap(options.interactionV1 !== false, options.executionModes === true),
        ...(options.lifecycle ? { Capabilities: {
          ...bootstrap().Capabilities, RunLifecycle: { Enabled: true, Resume: true },
        } } : {}),
      },
      ListSessions: {
        Sessions: sessions,
        Total: sessions.length,
        Page: 1,
        PageSize: 30,
      },
      ListAgentModels: { Models: [{ id: 'fixture-model', display_name: 'Fixture Model' }] },
      CreateSession: { Session: { SessionId: SESSION_ID, AgentId: AGENT_ID } },
      GetSession: { Session: { SessionId: sessionId, AgentId: AGENT_ID, ActiveRunStatus: '' } },
      ListSessionEvents: { Events: events, Total: events.length },
      ListSessionMessages: {
        Messages: typeof state.history === 'function' ? state.history(sessionId) : (state.history || []),
        LatestSeqId: 0,
        HasMore: false,
        NextCursor: null,
      },
      ListSessionCheckpoints: { Checkpoints: [] },
      ListToolReceipts: { ToolReceipts: [] },
      GetResponseFeedback: null,
    };
    if (action === 'CreateSession') state.sessionCreated = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope(payloadByAction[action] ?? {})),
    });
  });
}

function historyWithApproval(status = 'paused') {
  return () => [
    {
      MessageId: 'assistant-approval',
      Role: 'assistant',
      Content: { text: '需要人工确认。' },
      ToolEvents: [
        {
          Name: 'write_file',
          Args: { path: 'demo.txt' },
          Status: status,
          ApprovalRequestId: 'int-1',
          Protocol: 'responses',
        },
      ],
    },
  ];
}

async function createSession(page) {
  await page.goto('/');
  await expect(page.getByText('Interaction Fixture', { exact: true })).toBeVisible();
  const composer = page.getByPlaceholder('发送消息…');
  await composer.fill('hello');
  await composer.press('Enter');
  await expect(page.getByText('运行完成。')).toBeVisible();
}

async function expectComposerApprovalOnly(page) {
  const tray = page.getByTestId('interaction-tray');
  await expect(tray).toHaveCount(1);
  await expect(tray).toBeVisible();
  const timeline = page.locator('[data-slot="message-list"]');
  await expect(timeline.getByRole('button', { name: /允许执行|批准并继续|^拒绝$/ })).toHaveCount(0);
  await expect(timeline.locator('[data-slot="tool-approval-card"]')).toHaveCount(0);
  const trayBounds = await tray.boundingBox();
  const composerBounds = await page.locator('[data-slot="composer"]').boundingBox();
  expect(trayBounds).not.toBeNull();
  expect(composerBounds).not.toBeNull();
  expect(trayBounds.y + trayBounds.height).toBeLessThanOrEqual(composerBounds.y + 1);
}

for (const protocol of ['mcp', 'ksadk']) {
  test(`legacy ${protocol} approval stays above composer across reload, submits once, and stays resolved`, async ({ page }) => {
    const state = { submits: [], resolvedIds: new Set(), sessionCreated: false, events: [], status: 'paused', approvals: [] };
    state.history = () => [{ ...historyWithApproval(state.status)()[0], ResponseId: 'response-original' }];
    await installFixture(page, state, { interactionV1: false });
    await page.route('**/agentengine/api/v1/RunAgent', async route => {
      const body = route.request().postDataJSON();
      const approval = Array.isArray(body.ResponsesInput) && body.ResponsesInput.find(item => item.type === 'mcp_approval_response');
      if (approval) {
        state.approvals.push(body);
        state.status = approval.approve ? 'approved' : 'denied';
      }
      const request = protocol === 'mcp'
        ? { type: 'response.output_item.done', item: { type: 'mcp_approval_request', id: 'int-1',
            name: 'write_file', arguments: '{"path":"demo.txt"}' } }
        : { type: 'response.ksadk.approval_request', interrupt_info: { approval_request_id: 'int-1',
            action_requests: [{ name: 'write_file', args: { path: 'demo.txt' } }] } };
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(approval
        ? [{ type: 'response.completed', output_text: '审批已处理。', status: 'completed' }]
        : [{ type: 'response.created', response: { id: 'response-original' } }, request,
            { type: 'response.incomplete', response: { id: 'response-original', status: 'incomplete' } }]) });
    });
    await page.goto('/');
    const composer = page.getByPlaceholder('发送消息…');
    await composer.fill('执行工具');
    await composer.press('Enter');
    await expectComposerApprovalOnly(page);
    await page.reload();
    await expectComposerApprovalOnly(page);
    await expect(page.locator('[data-slot="tool-approval-status"]')).toHaveCount(1);
    if (protocol === 'mcp') await page.screenshot({ path: test.info().outputPath('approval-above-composer.png') });
    expect(state.approvals).toHaveLength(0);
    await page.getByTestId(protocol === 'mcp' ? 'interaction-approve' : 'interaction-reject').dblclick();
    await expect.poll(() => state.approvals.length).toBe(1);
    expect(state.approvals[0]).toMatchObject({ SessionId: SESSION_ID, PreviousResponseId: 'response-original',
      ResponsesInput: [{ type: 'mcp_approval_response', approval_request_id: 'int-1', approve: protocol === 'mcp' }] });
    await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('需要人工确认。')).toBeVisible();
    await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
    expect(state.approvals).toHaveLength(1);
    expect(state.submits).toHaveLength(0);
  });
}

test('session switching isolates identical legacy approval IDs and never revives a processed decision', async ({ page }) => {
  const otherSession = 'session-other';
  const state = { submits: [], resolvedIds: new Set(), sessionCreated: true, events: [], approvals: [],
    sessions: [{ SessionId: SESSION_ID, Title: '审批会话 A' }, { SessionId: otherSession, Title: '审批会话 B' }],
    statuses: { [SESSION_ID]: 'paused', [otherSession]: 'paused' } };
  state.history = sessionId => [{ ...historyWithApproval(state.statuses[sessionId])()[0],
    ResponseId: `response-${sessionId}`, Content: { text: `历史 ${sessionId}` } }];
  await installFixture(page, state, { interactionV1: false });
  await page.route('**/agentengine/api/v1/RunAgent', async route => {
    const body = route.request().postDataJSON();
    state.approvals.push(body);
    state.statuses[body.SessionId] = 'approved';
    await route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: sse([{ type: 'response.completed', status: 'completed', output_text: '处理完成。' }]) });
  });
  await page.goto('/');
  await page.getByText('审批会话 A', { exact: true }).click();
  await expectComposerApprovalOnly(page);
  await page.getByText('审批会话 B', { exact: true }).click();
  await expect(page.getByText(`历史 ${otherSession}`, { exact: true })).toBeVisible();
  await expectComposerApprovalOnly(page);
  await page.getByText('审批会话 A', { exact: true }).click();
  await expect(page.getByText(`历史 ${SESSION_ID}`, { exact: true })).toBeVisible();
  await expectComposerApprovalOnly(page);
  expect(state.approvals).toHaveLength(0);
  await page.getByTestId('interaction-approve').click();
  await expect.poll(() => state.approvals.length).toBe(1);
  expect(state.approvals[0]).toMatchObject({ SessionId: SESSION_ID, PreviousResponseId: `response-${SESSION_ID}` });
  await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
  // The other session still has its own pending decision despite the shared ID.
  await page.getByText('审批会话 B', { exact: true }).click();
  await expectComposerApprovalOnly(page);
  await page.getByText('审批会话 A', { exact: true }).click();
  await expect(page.getByText(`历史 ${SESSION_ID}`, { exact: true })).toBeVisible();
  await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(`历史 ${SESSION_ID}`, { exact: true })).toBeVisible();
  await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
  expect(state.approvals).toHaveLength(1);
});

test('different historical and current IDs never create approval actions in the body', async ({ page }) => {
  const state = { submits: [], resolvedIds: new Set(), sessionCreated: true,
    events: [requestedEvent({ interactionId: 'int-new' })], history: historyWithApproval() };
  await installFixture(page, state);
  await page.goto('/');
  await expectComposerApprovalOnly(page);
  // Both outstanding IDs remain distinct in a single tray queue; no name-based guessing.
  await expect(page.getByTestId('interaction-tray-count')).toContainText('2');
  await page.reload();
  await expectComposerApprovalOnly(page);
  await expect(page.getByTestId('interaction-tray-count')).toContainText('2');
  expect(state.submits).toHaveLength(0);
});

test('approve sends exactly one SubmitInteraction and replay never resubmits', async ({ page }) => {
  const state = {
    submits: [],
    resolvedIds: new Set(),
    sessionCreated: false,
    events: () => [requestedEvent()],
  };
  state.history = historyWithApproval();
  await installFixture(page, state);
  await createSession(page);

  // Refresh: pending interaction restored from durable history.
  await page.reload();
  const tray = page.getByTestId('interaction-tray');
  await expect(tray).toBeVisible();
  await expect(page.getByTestId('interaction-tray-title')).toHaveText('人工确认');
  expect(state.submits).toHaveLength(0);

  // Double click: exactly one submit leaves the client.
  const approve = page.getByTestId('interaction-approve');
  await approve.dblclick();
  await expect.poll(() => state.submits.length).toBe(1);
  expect(state.submits[0]).toMatchObject({
    AgentId: AGENT_ID,
    SessionId: SESSION_ID,
    InteractionId: 'int-1',
    ExpectedRevision: 1,
    Action: 'approve',
    IdempotencyKey: 'interaction:int-1:revision-1',
  });
  expect(state.submits[0].Response).toMatchObject({ decision: 'approve' });

  // The accepted receipt only proves the command entered the durable
  // Inbox — the UI stays "resolving" until the authoritative
  // interaction.resolved SessionEvent arrives.
  await expect(tray).toHaveAttribute('data-interaction-status', 'resolving');
  await expect(tray.getByTestId('interaction-submit-progress')).toHaveText('已提交，等待 Agent 处理。处理结果将显示在对话中。');

  // Replay after resolution (terminal fact carried by the SessionEvent
  // stream): history shows a read-only anchor, no second request ever
  // leaves the client.
  state.events = () => [requestedEvent(), resolvedEvent('int-1', 'approved')];
  state.history = historyWithApproval('approved');
  await page.reload();
  const anchor = page.getByTestId('interaction-history-anchor');
  await expect(anchor).toBeVisible();
  await expect(anchor).toHaveAttribute('data-interaction-status', 'resolved');
  await expect(page.getByText('操作人：user')).toBeVisible();
  await expect(page.getByText('已同意')).toBeVisible();
  await expect(tray).toHaveCount(0);
  expect(state.submits).toHaveLength(1);
});

test('reject stays resolving after the receipt and resolves on the terminal event', async ({ page }) => {
  const state = {
    submits: [],
    resolvedIds: new Set(),
    sessionCreated: false,
    events: () => [requestedEvent()],
  };
  state.history = historyWithApproval();
  await installFixture(page, state);
  await createSession(page);

  await page.reload();
  const tray = page.getByTestId('interaction-tray');
  await expect(tray).toBeVisible();
  await page.getByTestId('interaction-reject').click();

  await expect.poll(() => state.submits.length).toBe(1);
  expect(state.submits[0]).toMatchObject({
    InteractionId: 'int-1',
    Action: 'reject',
    ExpectedRevision: 1,
  });
  expect(state.submits[0].Response).toMatchObject({ decision: 'reject' });
  // Receipt accepted, terminal state not yet authoritative.
  await expect(tray).toHaveAttribute('data-interaction-status', 'resolving');

  // Terminal fact arrives via the replayed event stream.
  state.events = () => [requestedEvent(), resolvedEvent('int-1', 'rejected')];
  state.history = historyWithApproval('rejected');
  await page.reload();
  await expect(page.getByTestId('interaction-history-anchor')).toHaveAttribute(
    'data-interaction-status',
    'resolved',
  );
  await expect(tray).toHaveCount(0);
  expect(state.submits).toHaveLength(1);
});

for (const receiptStatus of ['accepted', 'duplicate']) {
test(`${receiptStatus} approval follows terminal events without a page reload`, async ({ page }) => {
  const state = {
    submits: [], subscriptions: [], resolvedIds: new Set(), sessionCreated: false,
    events: () => {
      const event = requestedEvent();
      event.Content.interaction.run_id = 'inv-1';
      return [event];
    }, history: historyWithApproval(),
  };
  await installFixture(page, state, { lifecycle: true, receiptStatus });
  await createSession(page);
  await page.reload();
  await expect(page.getByTestId('interaction-tray')).toBeVisible();
  await page.getByTestId('interaction-approve').click();
  await expect.poll(() => state.subscriptions.length).toBe(1);
  expect(state.subscriptions[0]).toMatchObject({
    SessionId: SESSION_ID, InvocationId: 'inv-1', AfterSeqId: '10',
  });
  await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
  await expect(page.getByTestId('interaction-history-anchor')).toHaveAttribute(
    'data-interaction-status', 'resolved',
  );
  expect(state.submits).toHaveLength(1);
});
}

test('structured form submits the full response payload', async ({ page }) => {
  const state = {
    submits: [],
    resolvedIds: new Set(),
    sessionCreated: false,
    events: () => [
      requestedEvent({
        interactionId: 'int-form',
        kind: 'structured_input',
        title: '部署确认',
        message: '请选择部署目标并填写备注。',
        requestSchema: {
          type: 'object',
          properties: {
            deploy_target: { type: 'string', title: '部署目标', enum: ['pre-online', 'online'] },
            note: { type: 'string', title: '备注' },
          },
          required: ['deploy_target'],
        },
      }),
    ],
  };
  await installFixture(page, state);
  await createSession(page);

  await page.reload();
  await expect(page.getByTestId('interaction-schema-form')).toBeVisible();
  await page.getByRole('radio', { name: '2 online', exact: true }).check();
  await page.getByTestId('interaction-field-note').fill('发布 0.3.2');
  await page.getByTestId('interaction-submit').click();

  await expect.poll(() => state.submits.length).toBe(1);
  expect(state.submits[0]).toMatchObject({
    InteractionId: 'int-form',
    Action: 'submit',
  });
  expect(state.submits[0].Response).toEqual({
    deploy_target: 'online',
    note: '发布 0.3.2',
  });
});

test('two tabs: first-wins receipt, second tab never duplicates the decision', async ({ browser }) => {
  const context = await browser.newContext();
  const state = {
    submits: [],
    resolvedIds: new Set(),
    sessionCreated: false,
    events: () => [requestedEvent()],
  };

  state.history = historyWithApproval();
  const tabA = await context.newPage();
  await installFixture(tabA, state);
  await createSession(tabA);
  await tabA.reload();
  await expect(tabA.getByTestId('interaction-tray')).toBeVisible();

  // Stale tab B still sees the pending request (no sync yet).
  const tabB = await context.newPage();
  await installFixture(tabB, state);
  await tabB.goto('/');
  await tabB.reload();
  await expect(tabB.getByTestId('interaction-tray')).toBeVisible();

  await tabA.getByTestId('interaction-approve').click();
  await expect.poll(() => state.submits.length).toBe(1);
  expect(state.submits[0].Action).toBe('approve');
  // First tab: accepted receipt keeps the tray resolving.
  await expect(tabA.getByTestId('interaction-tray')).toHaveAttribute(
    'data-interaction-status',
    'resolving',
  );

  // Second tab submits the same revision: the server is the authority and
  // returns the first-wins rejection receipt.
  await tabB.getByTestId('interaction-reject').click();
  await expect.poll(() => state.submits.length).toBe(2);
  expect(state.resolvedIds.has('int-1')).toBe(true);
  // The rejected receipt is a failed submit — the second tab must show
  // the failure, never a resolved/cancelled state.
  const trayB = tabB.getByTestId('interaction-tray');
  await expect(trayB).toHaveAttribute('data-interaction-status', 'failed');
  await expect(tabB.getByTestId('interaction-tray-error')).toBeVisible();
  await expect(tabB.getByText(/interaction_already_resolved/)).toBeVisible();

  // After replaying the authoritative terminal fact, no third request can
  // be produced even by clicking again.
  state.events = () => [requestedEvent(), resolvedEvent('int-1', 'approved')];
  state.history = historyWithApproval('approved');
  await tabB.reload();
  await expect(tabB.getByTestId('interaction-history-anchor')).toBeVisible();
  await expect(tabB.getByTestId('interaction-tray')).toHaveCount(0);
  expect(state.submits).toHaveLength(2);
});

test('expired interactions disable submission client-side', async ({ page }) => {
  const state = {
    submits: [],
    resolvedIds: new Set(),
    sessionCreated: false,
    events: () => [
      requestedEvent({ expiresAt: '2026-08-18T00:00:00Z' }),
    ],
  };
  await installFixture(page, state);
  await createSession(page);

  await page.reload();
  await expect(page.getByTestId('interaction-tray-expired')).toBeVisible();
  const approve = page.getByTestId('interaction-approve');
  await expect(approve).toBeDisabled();
  await page.evaluate((selector) => {
    document.querySelector(selector)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, '[data-testid="interaction-approve"]');
  await page.waitForTimeout(300);
  expect(state.submits).toHaveLength(0);
});

test('unknown A2UI wire version falls back safely and never approves', async ({ page }) => {
  const state = {
    submits: [],
    resolvedIds: new Set(),
    sessionCreated: false,
    events: () => [
      requestedEvent({
        interactionId: 'int-a2ui',
        kind: 'structured_input',
        requestSchema: { type: 'object', properties: { hint: { type: 'string' } }, required: ['hint'] },
        presentation: {
          a2ui: {
            wire_version: '1.0',
            catalog_digest: 'unknown-digest',
            messages: [{ id: 'm1', inputSchema: { type: 'object', properties: { untrusted: { type: 'string' } } } }],
          },
        },
      }),
    ],
  };
  await installFixture(page, state);
  await createSession(page);

  await page.reload();
  await expect(page.getByTestId('interaction-tray')).toBeVisible();
  // Unknown wire version + catalog: never rendered through A2UI; the JSON
  // schema form fallback appears instead.
  await expect(page.getByTestId('interaction-a2ui-surface')).toHaveCount(0);
  await expect(page.getByTestId('interaction-schema-form')).toBeVisible();
  await expect(page.getByTestId('interaction-field-untrusted')).toHaveCount(0);

  await page.getByTestId('interaction-field-hint').fill('ok');
  await page.getByTestId('interaction-submit').click();
  await expect.poll(() => state.submits.length).toBe(1);
  expect(state.submits[0].Action).toBe('submit');
  expect(state.submits[0].Response).toEqual({ hint: 'ok' });
});

test('servers without interaction_v1 keep the 0.3.1 Responses approval behavior', async ({ page }) => {
  const state = {
    submits: [],
    resolvedIds: new Set(),
    sessionCreated: false,
    events: () => [],
  };
  await installFixture(page, state, { interactionV1: false });
  await createSession(page);

  // Old server: no interaction_v1 capability, no SubmitInteraction calls.
  await page.reload();
  await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
  expect(state.submits).toHaveLength(0);
});

test('multiple pending interactions queue in one tray with count badge and switching', async ({ page }) => {
  const state = {
    submits: [],
    resolvedIds: new Set(),
    sessionCreated: false,
    events: () => [
      requestedEvent({ interactionId: 'int-q1', title: '删除文件', message: '确认删除 demo.txt？' }),
      requestedEvent({ interactionId: 'int-q2', title: '执行命令', message: '确认执行 rm -rf /tmp/cache？' }),
    ],
  };
  await installFixture(page, state);
  await createSession(page);
  await page.reload();

  // One tray, one expanded form at a time — never stacked large forms.
  const trays = page.getByTestId('interaction-tray');
  await expect(trays).toHaveCount(1);
  await expect(trays).toHaveAttribute('data-interaction-count', '2');
  await expect(page.getByTestId('interaction-tray-count')).toHaveText('1 of 2');
  await expect(page.getByTestId('interaction-tray-title')).toHaveText('删除文件');
  await expect(page.getByText('确认删除 demo.txt？')).toBeVisible();
  // Only the current item's action buttons are rendered.
  await expect(page.getByTestId('interaction-approve')).toHaveCount(1);

  // Switch to the second item.
  await page.getByTestId('interaction-tray-next').click();
  await expect(page.getByTestId('interaction-tray-count')).toHaveText('2 of 2');
  await expect(page.getByTestId('interaction-tray-title')).toHaveText('执行命令');
  await expect(page.getByTestId('interaction-tray-prev')).toBeEnabled();
  await expect(page.getByTestId('interaction-tray-next')).toBeDisabled();
});

test('the confirmation tray never obscures the composer', async ({ page }) => {
  const state = {
    submits: [],
    resolvedIds: new Set(),
    sessionCreated: false,
    events: () => [
      requestedEvent({
        interactionId: 'int-q1',
        title: '删除文件',
        message: '确认删除 demo.txt？',
        requestSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      }),
      requestedEvent({
        interactionId: 'int-q2',
        title: '执行命令',
        message: '确认执行 deploy.sh？',
        requestSchema: {
          type: 'object',
          properties: { env: { type: 'string' } },
        },
      }),
    ],
  };
  await installFixture(page, state);
  await createSession(page);
  await page.reload();

  const tray = page.getByTestId('interaction-tray');
  await expect(tray).toBeVisible();
  const composer = page.getByPlaceholder('发送消息…');
  await expect(composer).toBeVisible();

  const trayBox = await tray.boundingBox();
  const composerBox = await composer.boundingBox();
  expect(trayBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  // Layout invariant: the tray sits strictly above the composer — no
  // overlap, and the composer stays fully visible and clickable.
  expect(trayBox.y + trayBox.height).toBeLessThanOrEqual(composerBox.y + 1);
});

test('resolved anchor expands a read-only snapshot with actor, time, and schema keys', async ({ page }) => {
  const state = {
    submits: [],
    resolvedIds: new Set(),
    sessionCreated: false,
    history: [
      {
        MessageId: 'assistant-snap',
        Role: 'assistant',
        Content: { text: '需要部署确认。' },
        ToolEvents: [
          {
            Name: 'deploy',
            Args: { env: 'pre-online' },
            Status: 'approved',
            ApprovalRequestId: 'int-snap',
            Protocol: 'responses',
          },
        ],
      },
    ],
    events: () => [
      requestedEvent({
        interactionId: 'int-snap',
        kind: 'structured_input',
        title: '部署确认',
        requestSchema: {
          type: 'object',
          properties: {
            deploy_target: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['deploy_target'],
        },
      }),
      resolvedEvent('int-snap', 'submitted'),
    ],
  };
  await installFixture(page, state);
  await createSession(page);
  await page.reload();

  const anchor = page.getByTestId('interaction-history-anchor');
  await expect(anchor).toBeVisible();
  await expect(anchor).toHaveAttribute('data-interaction-status', 'resolved');

  // Expand the snapshot.
  await page.getByTestId('interaction-history-detail').locator('summary').click();
  const snapshot = page.getByTestId('interaction-history-snapshot');
  await expect(snapshot).toBeVisible();
  await expect(page.getByTestId('interaction-history-actor-ref')).toHaveText('user');
  await expect(page.getByTestId('interaction-history-schema-keys')).toHaveText('deploy_target、note');

  // Read-only: no editable controls inside the anchor.
  const editable = await anchor.locator('input, textarea, select, form, button').count();
  expect(editable).toBe(0);
});

test('typed Runtime v2 capabilities expose plan and goal without presenting the internal loop as a mode', async ({ page }) => {
  const state = {
    submits: [],
    runs: [],
    resolvedIds: new Set(),
    sessionCreated: false,
    events: [],
  };
  await installFixture(page, state, { executionModes: true });
  await page.goto('/');

  await page.getByRole('button', { name: '添加附件或选择执行模式' }).click();
  const menu = page.getByRole('menu', { name: '附件与执行模式' });
  await expect(menu.getByRole('menuitemradio', { name: /Agent Loop/ })).toHaveCount(0);
  await expect(menu.getByRole('menuitemradio', { name: /计划模式/ })).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: /设定目标/ })).toBeVisible();

  await menu.getByRole('menuitemradio', { name: /计划模式/ }).click();
  const composer = page.getByPlaceholder('描述需要先规划的任务…');
  await composer.fill('先制定发布计划');
  await composer.press('Enter');

  await expect.poll(() => state.runs.length).toBe(1);
  expect(state.runs[0]).toMatchObject({
    Metadata: {
      agentengine: {
        collaboration_mode: 'plan',
      },
    },
  });
});

test('legacy capabilities do not expose Runtime v2 execution controls', async ({ page }) => {
  const state = {
    submits: [],
    resolvedIds: new Set(),
    sessionCreated: false,
    events: [],
  };
  await installFixture(page, state);
  await page.goto('/');

  await expect(page.getByRole('button', { name: '添加附件或选择执行模式' })).toHaveCount(0);
  await expect(page.getByText('Agent Loop')).toHaveCount(0);
  await expect(page.getByText('计划模式')).toHaveCount(0);
  await expect(page.getByText('设定目标')).toHaveCount(0);
});

test('native multi-select preserves custom feedback and Enter never submits an empty answer', async ({ page }) => {
  const state = {
    submits: [], resolvedIds: new Set(), sessionCreated: false,
    events: () => [requestedEvent({
      interactionId: 'native-question', kind: 'structured_input',
      requestSchema: {
        type: 'object', required: ['scope'], properties: {
          scope: { type: 'array', title: '范围', description: '请选择检查范围',
            items: { type: 'string' }, minItems: 1,
            'x-codex-is-other': true,
            'x-codex-options': [{ label: '前端' }, { label: '服务端' }],
          },
        },
      },
    })],
  };
  await installFixture(page, state);
  await createSession(page);
  await page.reload();
  await expect(page.getByTestId('interaction-schema-form')).toBeVisible();
  await page.getByTestId('interaction-submit').click();
  expect(state.submits).toHaveLength(0);
  await page.getByRole('checkbox', { name: /前端/ }).check();
  await page.getByRole('checkbox', { name: /服务端/ }).check();
  const custom = page.getByRole('textbox', { name: '范围：自定义回答' });
  await custom.fill('请改成 echo 你好');
  await page.screenshot({ path: '/tmp/studio-native-question-card.png' });
  await custom.press('Enter');
  await expect.poll(() => state.submits.length).toBe(1);
  expect(state.submits[0].Action).toBe('submit');
  expect(state.submits[0].Response).toEqual({ scope: ['前端', '服务端', '请改成 echo 你好'] });
});

test('SDK 0.8.5 runtime history restores one legacy approval through interruption and terminal replay', async ({ page }) => {
  const id = 'native-approval';
  const native = (type, seq, extra = {}) => ({
    SessionId: SESSION_ID, InvocationId: 'native-run', EventType: type, SeqId: seq,
    Content: { runtime_event: {
      schema_version: 2, event_type: type, run_id: 'native-run', timestamp: 1791967072 + seq,
      source: { framework: 'langgraph' }, ...extra,
    } },
  });
  const detail = { approval_request_id: id, tool_name: 'start_spark_sql_query',
    action_requests: [{ name: 'start_spark_sql_query', args: { plan_id: 'plan-test' } }] };
  const requested = native('interaction.requested', 11, {
    interaction_id: id, interaction_kind: 'approval',
    request: { request_type: 'approval', kind: 'tool', detail },
  });
  const interrupted = native('run.interrupted', 12, { status: 'interrupted', reason: 'input_required' });
  const state = { submits: [], resolvedIds: new Set(), sessionCreated: false, events: [interrupted, requested], approvals: [] };
  await installFixture(page, state, { interactionV1: false });
  await page.route('**/agentengine/api/v1/RunAgent', async route => {
    const body = route.request().postDataJSON();
    const approval = Array.isArray(body.ResponsesInput) && body.ResponsesInput.find(x => x.type === 'mcp_approval_response');
    if (approval) {
      state.approvals.push(body);
      state.events = [native('interaction.resolved', 13, { interaction_id: id,
        interaction_kind: 'approval', response: { response_type: 'approval', decision: 'approved' } }), ...state.events];
    }
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse(approval
      ? [{ type: 'response.completed', output_text: '原生审批已处理。', status: 'completed' }]
      : [{ type: 'response.ksadk.approval_request', interrupt_info: detail },
          { type: 'response.incomplete', response: { id: 'native-response', status: 'incomplete' } }]) });
  });
  await page.goto('/');
  await page.getByPlaceholder('发送消息…').fill('原生审批验证');
  await page.getByPlaceholder('发送消息…').press('Enter');
  await expectComposerApprovalOnly(page);
  await page.reload();
  await expectComposerApprovalOnly(page);
  expect(state.approvals).toHaveLength(0);
  await page.getByTestId('interaction-approve').dblclick();
  await expect.poll(() => state.approvals.length).toBe(1);
  expect(state.approvals[0].ResponsesInput).toEqual([{ type: 'mcp_approval_response', approval_request_id: id, approve: true }]);
  await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Interaction Fixture', { exact: true })).toBeVisible();
  await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
  expect(state.approvals).toHaveLength(1);
  expect(state.submits).toHaveLength(0);
});
