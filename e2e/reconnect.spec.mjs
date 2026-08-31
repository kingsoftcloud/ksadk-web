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
            ActiveRunStatus: '',
            ActiveInvocationId: INVOCATION_ID,
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
              ActiveRunStatus: '',
              ActiveInvocationId: INVOCATION_ID,
              UpdatedAt: updatedAt,
            }
          : { SessionId: OTHER_SESSION_ID, AgentId: 'fixture-agent', ActiveRunStatus: 'completed' },
      };
    }
    if (action === 'ListSessionMessages') {
      if (options.delayListMessagesMs) {
        await new Promise((resolve) => setTimeout(resolve, options.delayListMessagesMs));
      }
      payload = body.SessionId === SESSION_ID
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
