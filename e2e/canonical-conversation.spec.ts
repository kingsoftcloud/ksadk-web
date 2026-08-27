import { expect, test, type APIRequestContext } from '@playwright/test';

const FIXTURE_ORIGIN = 'http://127.0.0.1:4182';
const APPROVAL_ID = 'approval-shell-1';
const APPROVAL_REVISION = 7;

type FixtureState = {
  inputs: Array<Record<string, unknown>>;
  streamPosts: number;
  legacyRunAgentCalls: number;
  reconnects: Array<{ after: number; lastEventId: string | null }>;
  submits: Array<Record<string, unknown>>;
  winner: { action: string; idempotencyKey: string; revision: number } | null;
};

async function fixtureState(request: APIRequestContext): Promise<FixtureState> {
  const response = await request.get(`${FIXTURE_ORIGIN}/__fixture/state`);
  expect(response.ok()).toBe(true);
  return response.json();
}

test.beforeEach(async ({ request }) => {
  const response = await request.post(`${FIXTURE_ORIGIN}/__fixture/reset`);
  expect(response.ok()).toBe(true);
});

test('canonical Hosted UI survives replay and renders every durable item safely', async ({ page, request }) => {
  const a2uiReplayErrors: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('[A2UI] processMessages error')) {
      a2uiReplayErrors.push(message.text());
    }
  });
  await page.goto('/');
  await expect(
    page.getByRole('main').getByText('Canonical Fixture', { exact: true }),
  ).toBeVisible();

  const composer = page.locator('textarea[placeholder^="发送消息"]');
  await composer.fill('执行第一轮 canonical 会话');
  await composer.press('Enter');

  // The first HTTP stream ends before a terminal item. The browser must
  // reconnect with both cursor forms and never duplicate the replay boundary.
  await expect.poll(async () => (await fixtureState(request)).reconnects).toEqual([
    { after: 3, lastEventId: '3' },
  ]);
  await expect(page.getByText('read_config', { exact: true })).toHaveCount(1);

  // Reasoning, tool, passive A2UI and future/unknown payload fallback all
  // travel through the same canonical stream and real renderer.
  await expect(page.getByText('Canonical A2UI 卡片')).toBeVisible();
  await expect(page.getByText(/Unsupported content: This content type is not supported/)).toBeVisible();
  await expect(page.getByText('<script>never execute</script>', { exact: true })).toHaveCount(0);

  const tray = page.getByTestId('interaction-tray');
  await expect(tray).toBeVisible();
  await expect(page.getByTestId('interaction-tray-title')).toHaveText('执行安全检查');
  await expect(page.getByTestId('interaction-tray-message')).toHaveText('允许执行只读环境检查？');

  // A double click is still one browser submit. The request carries the
  // durable revision and deterministic idempotency key.
  await page.getByTestId('interaction-approve').dblclick();
  await expect.poll(async () => (await fixtureState(request)).submits.length).toBe(1);
  let current = await fixtureState(request);
  expect(current.submits[0]).toMatchObject({
    InteractionId: APPROVAL_ID,
    ExpectedRevision: APPROVAL_REVISION,
    Action: 'approve',
    IdempotencyKey: `interaction:${APPROVAL_ID}:revision-${APPROVAL_REVISION}`,
  });

  // Same idempotency key is a duplicate receipt; a competing decision with a
  // different key loses. Neither can replace the first accepted decision.
  const duplicate = await request.post(
    `${FIXTURE_ORIGIN}/agentengine/api/v1/SubmitInteraction`,
    {
      data: {
        InteractionId: APPROVAL_ID,
        ExpectedRevision: APPROVAL_REVISION,
        Action: 'approve',
        IdempotencyKey: `interaction:${APPROVAL_ID}:revision-${APPROVAL_REVISION}`,
      },
    },
  );
  expect((await duplicate.json()).Data.status).toBe('duplicate');
  const loser = await request.post(
    `${FIXTURE_ORIGIN}/agentengine/api/v1/SubmitInteraction`,
    {
      data: {
        InteractionId: APPROVAL_ID,
        ExpectedRevision: APPROVAL_REVISION,
        Action: 'reject',
        IdempotencyKey: 'competing-decision',
      },
    },
  );
  const loserReceipt = (await loser.json()).Data;
  expect(loserReceipt.status).toBe('rejected');
  expect(loserReceipt.error.code).toBe('interaction_already_resolved');

  await expect(page.getByText('第一轮完成。', { exact: true })).toBeVisible();
  await expect(page.getByText('第一轮完成。', { exact: true })).toHaveCount(1);
  await expect(tray).toHaveCount(0);
  await expect(page.getByTestId('interaction-history-anchor')).toHaveAttribute(
    'data-interaction-status',
    'resolved',
  );

  const thinking = page.getByRole('button', { name: /已思考/ });
  await expect(thinking).toBeVisible();
  await thinking.click();
  await expect(page.getByText('先检查环境。', { exact: true })).toBeVisible();

  // A second user turn uses the same ConversationSurface path and leaves the
  // first turn intact. No legacy RunAgent request is allowed as a hidden
  // fallback once the canonical surface was admitted.
  await composer.fill('继续第二轮');
  await composer.press('Enter');
  await expect(page.getByText('第二轮也正常。', { exact: true })).toBeVisible();
  await expect(page.getByText('第二轮也正常。', { exact: true })).toHaveCount(1);
  await expect(page.getByText('第一轮完成。', { exact: true })).toHaveCount(1);

  current = await fixtureState(request);
  expect(current.streamPosts).toBe(2);
  expect(current.legacyRunAgentCalls).toBe(0);
  expect(current.inputs).toHaveLength(2);
  expect(current.inputs.map((input) => input.parts)).toEqual([
    [{ kind: 'text', text: '执行第一轮 canonical 会话' }],
    [{ kind: 'text', text: '继续第二轮' }],
  ]);
  expect(current.winner).toEqual({
    action: 'approve',
    idempotencyKey: `interaction:${APPROVAL_ID}:revision-${APPROVAL_REVISION}`,
    revision: APPROVAL_REVISION,
  });
  expect(a2uiReplayErrors).toEqual([]);
});
