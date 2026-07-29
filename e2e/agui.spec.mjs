import { expect, test } from '@playwright/test';

const SESSION_ID = 'session-agui-e2e';
const CATALOG_ID = 'https://a2ui.org/specification/v0_9/basic_catalog.json';

function envelope(data) {
  return { Code: 0, Message: 'Success', Data: data };
}

function statusOperations() {
  return [
    {
      version: 'v0.9',
      createSurface: { surfaceId: 'fixture-status', catalogId: CATALOG_ID },
    },
    {
      version: 'v0.9',
      updateComponents: {
        surfaceId: 'fixture-status',
        components: [
          { id: 'root', component: 'Column', children: ['fixture-status-title'] },
          {
            id: 'fixture-status-title',
            component: 'Text',
            variant: 'h3',
            text: 'E2E 状态卡',
          },
        ],
      },
    },
  ];
}

function sse(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

function bootstrap() {
  return {
    Agent: { AgentId: 'fixture-agent', Name: 'AG-UI Fixture', Framework: 'langgraph' },
    ApiFormats: ['responses'],
    Capabilities: {
      Attachments: false,
      WorkspaceFiles: false,
      Approval: true,
      Thinking: true,
      StopRun: true,
      ResumeRun: true,
    },
    HostedChat: {
      PreferredTransport: 'ag-ui',
      Transports: [
        {
          Protocol: 'ag-ui',
          Runtime: 'copilotkit',
          Endpoint: '/agentengine/agui',
          Version: '0.1.19',
          Capabilities: { A2UI: true, Interrupt: true, Cancel: true },
        },
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

async function installFixture(page) {
  const state = { approved: false, created: false, aguiBodies: [] };

  await page.route('**/agentengine/agui', async (route) => {
    const body = route.request().postDataJSON();
    state.aguiBodies.push(body);
    const isResume = Array.isArray(body.resume) && body.resume.length > 0;
    const events = isResume
      ? [
          { type: 'RUN_STARTED', threadId: SESSION_ID, runId: body.runId },
          { type: 'TEXT_MESSAGE_START', messageId: 'assistant-resumed', role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'assistant-resumed', delta: '审批已完成。' },
          { type: 'TEXT_MESSAGE_END', messageId: 'assistant-resumed' },
          { type: 'RUN_FINISHED', threadId: SESSION_ID, runId: body.runId, outcome: { type: 'success' } },
        ]
      : [
          { type: 'RUN_STARTED', threadId: SESSION_ID, runId: body.runId },
          { type: 'TEXT_MESSAGE_START', messageId: 'assistant-approval', role: 'assistant' },
          { type: 'TEXT_MESSAGE_CONTENT', messageId: 'assistant-approval', delta: '需要人工确认。' },
          { type: 'TOOL_CALL_START', toolCallId: 'tool-write', toolCallName: 'write_file' },
          { type: 'TOOL_CALL_ARGS', toolCallId: 'tool-write', delta: '{"path":"demo.txt"}' },
          {
            type: 'ACTIVITY_SNAPSHOT',
            messageId: 'activity-status',
            activityType: 'a2ui-surface',
            content: { surfaceId: 'fixture-status', a2ui_operations: statusOperations() },
          },
          { type: 'TEXT_MESSAGE_END', messageId: 'assistant-approval' },
          { type: 'TOOL_CALL_END', toolCallId: 'tool-write' },
          {
            type: 'RUN_FINISHED',
            threadId: SESSION_ID,
            runId: body.runId,
            outcome: {
              type: 'interrupt',
              interrupts: [{
                id: 'approval-write',
                reason: 'approval',
                message: '确认写入 demo.txt？',
                toolCallId: 'tool-write',
                metadata: {
                  tool_name: 'write_file',
                  arguments: { path: 'demo.txt' },
                  approval_level: 'elevated',
                },
              }],
            },
          },
        ];
    await route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: sse(events),
    });
  });

  await page.route('**/agentengine/api/v1/**', async (route) => {
    const action = new URL(route.request().url()).pathname.split('/').pop();
    if (action === 'CreateSession') state.created = true;
    const history = state.approved
      ? [
          {
            MessageId: 'assistant-approval',
            Role: 'assistant',
            Content: { text: '需要人工确认。' },
            ToolEvents: [{
              Name: 'write_file',
              Args: { path: 'demo.txt' },
              Status: 'approved',
              ApprovalRequestId: 'approval-write',
              Protocol: 'ag-ui',
            }],
            Activities: [{
              SurfaceId: 'fixture-status',
              Content: { a2ui_operations: statusOperations() },
            }],
          },
          {
            MessageId: 'assistant-resumed',
            Role: 'assistant',
            Content: { text: '审批已完成。' },
          },
        ]
      : [];
    const payloadByAction = {
      GetAgentUiBootstrap: bootstrap(),
      ListSessions: {
        Sessions: state.created
          ? [{ SessionId: SESSION_ID, AgentId: 'fixture-agent', Title: 'AG-UI fixture' }]
          : [],
        Total: state.created ? 1 : 0,
        Page: 1,
        PageSize: 30,
      },
      ListAgentModels: { Models: [{ id: 'fixture-model', display_name: 'Fixture Model' }] },
      CreateSession: { Session: { SessionId: SESSION_ID, AgentId: 'fixture-agent' } },
      GetSession: { Session: { SessionId: SESSION_ID, AgentId: 'fixture-agent' } },
      ListSessionMessages: { Messages: history, LatestSeqId: history.length, HasMore: false, NextCursor: null },
      ListSessionCheckpoints: { Checkpoints: [] },
      ListToolReceipts: { ToolReceipts: [] },
      GetResponseFeedback: null,
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(envelope(payloadByAction[action] ?? {})) });
  });
  return state;
}

test('projects AG-UI activity, resumes approval, and replays terminal state', async ({ page }) => {
  const fixture = await installFixture(page);
  await page.goto('/');

  await expect(page.getByText('AG-UI Fixture')).toBeVisible();
  const composer = page.getByPlaceholder('发送消息...');
  await composer.fill('请写入 demo.txt');
  await composer.press('Enter');

  await expect(page.getByText('E2E 状态卡')).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: '等待审批' })).toBeVisible();
  await expect(page.getByRole('button', { name: '批准并继续' })).toBeVisible();
  await page.getByRole('button', { name: '批准并继续' }).click();

  await expect.poll(() => fixture.aguiBodies.length).toBe(2);
  expect(fixture.aguiBodies[1].resume).toEqual([
    {
      interruptId: 'approval-write',
      status: 'resolved',
      payload: { decision: 'approve' },
    },
  ]);
  await expect(page.getByText('审批已完成。')).toBeVisible();
  await expect(page.locator('summary').filter({ hasText: '已批准' })).toBeVisible();

  fixture.approved = true;
  await page.reload();
  await expect(page.getByText('E2E 状态卡')).toBeVisible();
  await expect(page.getByText('审批已完成。')).toBeVisible();
  await expect(page.getByRole('button', { name: '批准并继续' })).toHaveCount(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(composer).toBeInViewport();
  await expect(page.getByText('E2E 状态卡')).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
