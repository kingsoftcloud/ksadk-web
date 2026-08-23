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

function bootstrap(interactionV1 = true) {
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
            status: 'accepted',
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
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sse([
          { type: 'response.completed', status: 'completed', output_text: '运行完成。' },
        ]),
      });
      return;
    }

    const events = typeof state.events === 'function' ? state.events() : state.events;
    const payloadByAction = {
      GetAgentUiBootstrap: bootstrap(options.interactionV1 !== false),
      ListSessions: {
        Sessions: state.sessionCreated
          ? [{ SessionId: SESSION_ID, AgentId: AGENT_ID, Title: 'Interaction fixture' }]
          : [],
        Total: state.sessionCreated ? 1 : 0,
        Page: 1,
        PageSize: 30,
      },
      ListAgentModels: { Models: [{ id: 'fixture-model', display_name: 'Fixture Model' }] },
      CreateSession: { Session: { SessionId: SESSION_ID, AgentId: AGENT_ID } },
      GetSession: { Session: { SessionId: SESSION_ID, AgentId: AGENT_ID, ActiveRunStatus: '' } },
      ListSessionEvents: { Events: events, Total: events.length },
      ListSessionMessages: {
        Messages: typeof state.history === 'function' ? state.history() : (state.history || []),
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
  await expect(page.getByText('Interaction Fixture')).toBeVisible();
  const composer = page.getByPlaceholder('发送消息…');
  await composer.fill('hello');
  await composer.press('Enter');
  await expect(page.getByText('运行完成。')).toBeVisible();
}

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
  await expect(page.getByText('正在提交，请稍候…')).toBeVisible();

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
  await page.getByTestId('interaction-field-deploy_target').selectOption('online');
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
        presentation: {
          a2ui: {
            wire_version: '1.0',
            catalog_digest: 'unknown-digest',
            messages: [{ id: 'm1', inputSchema: { type: 'object', properties: { hint: { type: 'string' } } } }],
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
  await expect(page.getByTestId('interaction-tray-count')).toHaveText('1/2');
  await expect(page.getByTestId('interaction-tray-title')).toHaveText('删除文件');
  // Only the current item's action buttons are rendered.
  await expect(page.getByTestId('interaction-approve')).toHaveCount(1);

  // Switch to the second item.
  await page.getByTestId('interaction-tray-next').click();
  await expect(page.getByTestId('interaction-tray-count')).toHaveText('2/2');
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
