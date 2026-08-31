import { expect, test } from '@playwright/test';

const SESSION_ID = 'session-active';
const OTHER_SESSION_ID = 'session-other';
const INVOCATION_ID = 'invocation-active';
const SKILL_TABLE_RESPONSE = [
  '当前 Skill Space 下共有 **4 个技能**：',
  '',
  '| # | 技能名称 | 说明 | 版本 |',
  '|---|---------|------|------|',
  '| 1 | **ppt-translator** | 保留原始排版。 | v1 |',
  '| 2 | **skill-creator** | 创建自定义技能。 | v1 |',
].join('\n');

function envelope(data) {
  return { Code: 0, Message: 'Success', Data: data };
}

function bootstrap() {
  return {
    Agent: { AgentId: 'fixture-agent', Name: 'Reconnect Fixture', Framework: 'langgraph' },
    ApiFormats: ['responses'],
    Capabilities: {
      HostedChat: {
        Enabled: true,
        ApiFormats: ['responses'],
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
      RunLifecycle: {
        Enabled: true,
        Resume: true,
        Abort: true,
        Checkpoints: false,
        CheckpointResume: false,
        CheckpointResumePreview: false,
      },
      Thinking: true,
      StopRun: true,
      ResumeRun: true,
    },
    Model: { id: 'fixture-model', display_name: 'Fixture Model' },
  };
}

function runtimeEvent(eventType, payload, seqId) {
  return {
    EventId: `runtime-${seqId}`,
    SessionId: SESSION_ID,
    InvocationId: INVOCATION_ID,
    EventType: eventType,
    Content: { phase: eventType.includes('.delta') ? 'commentary' : null, payload },
    SeqId: seqId,
    Timestamp: Date.now(),
    Metadata: { ksadk_runtime_event: true, schema_version: 1 },
  };
}

function assistantSnapshot(text, seqId) {
  return {
    EventId: `snapshot-${seqId}`,
    SessionId: SESSION_ID,
    InvocationId: INVOCATION_ID,
    EventType: 'assistant_stream_snapshot',
    Content: { role: 'assistant', parts: [{ text }] },
    SeqId: seqId,
    Timestamp: Date.now(),
    Metadata: { stream_snapshot: true, snapshot_index: seqId },
  };
}

function canonicalRuntimeRecord({
  seqId,
  eventType,
  itemId,
  itemKind,
  nativeKind,
  text = '',
  operation = 'replace',
}) {
  const runtimeEvent = {
    schema_version: 2,
    event_id: `canonical-${seqId}`,
    seq: seqId,
    timestamp: 1788180974 + seqId,
    run_id: INVOCATION_ID,
    scope_id: `scope-${INVOCATION_ID}`,
    source: {
      framework: 'codex',
      metadata: { native_item_kind: nativeKind },
    },
    event_type: eventType,
    item_id: itemId,
    item_kind: itemKind,
    ...(eventType === 'item.updated'
      ? {
          op: operation,
          update: {
            content_type: 'text',
            part_id: `${itemId}-part`,
            text,
          },
        }
      : {
          snapshot: {
            parts: [{
              content_type: 'text',
              part_id: `${itemId}-part`,
              text,
              data: nativeKind === 'userMessage'
                ? { type: 'userMessage', content: [{ text }] }
                : undefined,
            }],
          },
        }),
  };
  const sessionEvent = {
    schema_version: 1,
    event_id: `session-${seqId}`,
    session_id: SESSION_ID,
    seq: seqId,
    timestamp: new Date(1788180974000 + seqId * 1000).toISOString(),
    family: 'runtime',
    family_version: 2,
    event_type: eventType,
    payload: runtimeEvent,
    run_id: INVOCATION_ID,
  };
  return {
    EventId: `record-${seqId}`,
    SessionId: SESSION_ID,
    Author: 'codex',
    EventType: eventType,
    Content: { session_event: sessionEvent, runtime_event: runtimeEvent },
    Metadata: {
      ksadk_session_event_envelope: true,
      schema_version: 1,
      family: 'runtime',
      family_version: 2,
      canonical_event_id: sessionEvent.event_id,
      run_id: INVOCATION_ID,
    },
    SeqId: seqId,
    Timestamp: sessionEvent.timestamp,
  };
}

async function installReconnectFixture(page, options = {}) {
  let releaseSubscription;
  const subscriptionGate = options.holdSubscription
    ? new Promise((resolve) => { releaseSubscription = resolve; })
    : null;
  const state = {
    subscriptionRequests: [],
    releaseSubscription: () => releaseSubscription?.(),
  };
  const updatedAt = new Date().toISOString();

  await page.route('**/agentengine/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const action = url.pathname.split('/').pop();

    if (action === 'SubscribeRunEvents') {
      state.subscriptionRequests.push(Object.fromEntries(url.searchParams.entries()));
      if (subscriptionGate) await subscriptionGate;
      const subscriptionEvents = options.subscriptionEvents ?? [
        runtimeEvent('text.delta', { text: '这是一段已经恢复并继续增长的完整回复。' }, 3),
        runtimeEvent('run.completed', { status: 'completed' }, 4),
      ];
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: subscriptionEvents
          .map((event) => `event: conversation.event\ndata: ${JSON.stringify(event)}\n\n`)
          .join(''),
      });
      return;
    }

    const body = request.method() === 'POST' ? request.postDataJSON() : {};
    const payloadByAction = {
      GetAgentUiBootstrap: bootstrap(),
      ListSessions: {
        Sessions: [
          {
            SessionId: SESSION_ID,
            AgentId: 'fixture-agent',
            Title: '正在生成的会话',
            UpdatedAt: updatedAt,
            ActiveRunStatus: options.completedSession ? 'completed' : '',
            ActiveInvocationId: options.completedSession ? '' : INVOCATION_ID,
          },
          {
            SessionId: OTHER_SESSION_ID,
            AgentId: 'fixture-agent',
            Title: '另一个会话',
            UpdatedAt: '2026-07-28T09:00:00Z',
          },
        ],
        Total: 2,
        Page: 1,
        PageSize: 30,
      },
      ListAgentModels: { Models: [{ id: 'fixture-model', display_name: 'Fixture Model' }] },
      GetResponseFeedback: null,
    };
    let payload = payloadByAction[action] ?? {};
    if (action === 'GetSession') {
      payload = {
        Session: body.SessionId === SESSION_ID
          ? {
              SessionId: SESSION_ID,
              AgentId: 'fixture-agent',
              ActiveRunStatus: options.completedSession ? 'completed' : '',
              ActiveInvocationId: options.completedSession ? '' : INVOCATION_ID,
              UpdatedAt: updatedAt,
            }
          : { SessionId: OTHER_SESSION_ID, AgentId: 'fixture-agent', ActiveRunStatus: 'completed' },
      };
    }
    if (action === 'ListSessionMessages') {
      if (options.delayListMessagesMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayListMessagesMs));
      }
      payload = body.SessionId === SESSION_ID && options.persistedSnapshots
        ? {
            Messages: options.persistedSnapshots,
            LatestSeqId: options.sessionEvents?.at(-1)?.SeqId ?? options.persistedSnapshots.length,
            HasMore: false,
            NextCursor: null,
          }
        : body.SessionId === SESSION_ID
        ? {
            Messages: [{
              MessageId: 'partial-runtime-message',
              Role: 'assistant',
              Content: { text: options.initialAssistantText ?? '' },
              SeqId: 1,
              InvocationId: INVOCATION_ID,
            }],
            LatestSeqId: 1,
            HasMore: false,
            NextCursor: null,
          }
        : {
            Messages: [{
              MessageId: 'other-message',
              Role: 'assistant',
              Content: { text: '另一个会话的历史回复。' },
              SeqId: 1,
            }],
            LatestSeqId: 1,
            HasMore: false,
            NextCursor: null,
          };
    }
    if (action === 'ListSessionEvents') {
      const sourceEvents = body.SessionId === SESSION_ID
        ? (options.sessionEvents ?? [])
        : [];
      const offset = Number(body.Offset ?? 0);
      const limit = Number(body.Limit ?? (sourceEvents.length || 1));
      const end = Math.max(sourceEvents.length - offset, 0);
      const start = Math.max(end - limit, 0);
      payload = {
        Events: sourceEvents.slice(start, end),
        Total: sourceEvents.length,
        Offset: offset,
        Limit: limit,
      };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(envelope(payload)),
    });
  });

  return state;
}

test('continues a LangGraph RuntimeEvent run after reload', async ({ page }) => {
  const fixture = await installReconnectFixture(page);

  await page.goto('/');

  await expect(page.getByText('这是一段已经恢复并继续增长的完整回复。')).toBeVisible();
  await expect(page.getByText('连接断开或生成出错，请重试')).toHaveCount(0);
  await expect.poll(() => fixture.subscriptionRequests.length).toBeGreaterThanOrEqual(1);
  expect(fixture.subscriptionRequests[0]).toMatchObject({
    SessionId: SESSION_ID,
    InvocationId: INVOCATION_ID,
    AfterSeqId: '1',
  });

  await page.reload();
  await expect(page.getByText('这是一段已经恢复并继续增长的完整回复。')).toBeVisible();
  await expect(page.getByText('连接断开或生成出错，请重试')).toHaveCount(0);
  await expect.poll(() => fixture.subscriptionRequests.length).toBeGreaterThanOrEqual(2);

  await page.getByText('另一个会话', { exact: true }).click();
  await expect(page.getByText('另一个会话的历史回复。')).toBeVisible();
  await page.getByText('正在生成的会话', { exact: true }).click();
  await expect(page.getByText('这是一段已经恢复并继续增长的完整回复。')).toBeVisible();
  await expect(page.getByText('连接断开或生成出错，请重试')).toHaveCount(0);
  await expect.poll(() => fixture.subscriptionRequests.length).toBeGreaterThanOrEqual(3);
});

test('keeps the recovered assistant snapshot visible until the next snapshot arrives', async ({ page }) => {
  const fixture = await installReconnectFixture(page, {
    holdSubscription: true,
    initialAssistantText: '第一段正在生成。',
    subscriptionEvents: [
      assistantSnapshot('第一段正在生成。第二段继续生成。', 4),
      runtimeEvent('run.completed', { status: 'completed' }, 5),
    ],
  });

  await page.goto('/');
  await expect(page.getByText('第一段正在生成。', { exact: true })).toBeVisible();
  await expect.poll(() => fixture.subscriptionRequests.length).toBe(1);
  expect(fixture.subscriptionRequests[0]).toMatchObject({
    SessionId: SESSION_ID,
    InvocationId: INVOCATION_ID,
    AfterSeqId: '1',
  });

  fixture.releaseSubscription();
  await expect(page.getByText('第一段正在生成。第二段继续生成。', { exact: true })).toBeVisible();
  await expect(page.getByText('连接断开或生成出错，请重试')).toHaveCount(0);
});

test('does not lose restored history when bootstrap state rerenders during a delayed load', async ({ page }) => {
  const fixture = await installReconnectFixture(page, {
    holdSubscription: true,
    delayListMessagesMs: 350,
    initialAssistantText: '刷新后仍应恢复的完整历史。',
  });

  await page.goto('/');
  await expect(page.getByText('刷新后仍应恢复的完整历史。', { exact: true })).toBeVisible();
  fixture.releaseSubscription();
});

test('rebuilds persisted canonical history once instead of rendering every cumulative message snapshot', async ({ page }) => {
  const sessionEvents = [
    canonicalRuntimeRecord({
      seqId: 1,
      eventType: 'item.completed',
      itemId: 'user-1',
      itemKind: 'message',
      nativeKind: 'userMessage',
      text: '请继续。',
    }),
    canonicalRuntimeRecord({
      seqId: 2,
      eventType: 'item.updated',
      itemId: 'reasoning-1',
      itemKind: 'reasoning',
      nativeKind: 'reasoning',
      text: '唯一思考过程',
      operation: 'append',
    }),
    canonicalRuntimeRecord({
      seqId: 3,
      eventType: 'item.completed',
      itemId: 'message-1',
      itemKind: 'message',
      nativeKind: 'agentMessage',
      text: '唯一最终答复',
    }),
  ];
  await installReconnectFixture(page, {
    completedSession: true,
    sessionEvents,
    persistedSnapshots: [
      {
        MessageId: 'snapshot-1',
        Role: 'assistant',
        Content: { text: '唯一最终答复' },
        InvocationId: INVOCATION_ID,
        Reasoning: [{ text: '唯一思考过程' }],
        SeqId: 2,
      },
      {
        MessageId: 'snapshot-2',
        Role: 'assistant',
        Content: { text: '唯一最终答复' },
        InvocationId: INVOCATION_ID,
        Reasoning: [{ text: '唯一思考过程' }],
        SeqId: 3,
      },
    ],
  });

  await page.goto('/');

  await expect(page.getByText('唯一最终答复', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /已思考 · 6 字/ })).toHaveCount(1);
  await page.getByRole('button', { name: /已思考 · 6 字/ }).click();
  await expect(page.getByText('唯一思考过程', { exact: true })).toHaveCount(1);
  await page.reload();
  await expect(page.getByText('唯一最终答复', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: /已思考 · 6 字/ })).toHaveCount(1);
  await page.getByRole('button', { name: /已思考 · 6 字/ }).click();
  await expect(page.getByText('唯一思考过程', { exact: true })).toHaveCount(1);
});

test('renders a recovered numbered skill table as GFM instead of raw pipe text', async ({ page }) => {
  await installReconnectFixture(page);
  await page.route('**/agentengine/api/v1/SubscribeRunEvents**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        `event: conversation.event\ndata: ${JSON.stringify(runtimeEvent('text.delta', { text: SKILL_TABLE_RESPONSE }, 3))}\n\n`,
        `event: conversation.event\ndata: ${JSON.stringify(runtimeEvent('run.completed', { status: 'completed' }, 4))}\n\n`,
      ].join(''),
    });
  });

  await page.goto('/');

  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '#' })).toBeVisible();
  await expect(page.getByRole('columnheader', { name: '技能名称' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'ppt-translator' })).toBeVisible();
  await expect(page.getByText('| # | 技能名称 | 说明 | 版本 |', { exact: true })).toHaveCount(0);
  await expect(page.getByText('当前 Skill Space 下共有', { exact: false })).toHaveCSS('font-size', '14px');
});
