import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const FIXTURE_ORIGIN = 'http://127.0.0.1:4182';
const APPROVAL_ID = 'approval-shell-1';
const APPROVAL_REVISION = 7;

type FixtureState = {
  config: { attachmentInputs: boolean };
  inputs: Array<Record<string, unknown>>;
  uploads: Array<{
    filename: string;
    mediaType: string;
    agentId: string;
    contentType: string;
    bodyBytes: number;
    attachmentRef: string;
  }>;
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

async function setFixtureConfig(
  request: APIRequestContext,
  config: Partial<FixtureState['config']>,
): Promise<void> {
  const response = await request.post(`${FIXTURE_ORIGIN}/__fixture/config`, { data: config });
  expect(response.ok()).toBe(true);
}

async function openCanonicalHostedUi(page: Page): Promise<void> {
  await page.goto('/');
  await expect(
    page.getByRole('main').getByText('Canonical Fixture', { exact: true }),
  ).toBeVisible();
}

async function attachThroughComposer(
  page: Page,
  file: { name: string; mimeType: string; buffer: Buffer },
): Promise<void> {
  await page.getByRole('button', { name: '添加附件或选择执行模式' }).click();
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /上传附件/ }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(file);
  await expect(page.getByText(file.name, { exact: true })).toBeVisible();
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
  await openCanonicalHostedUi(page);

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

test('Hosted UI sends an allowed attachment and selected model only through canonical input', async ({ page, request }) => {
  await openCanonicalHostedUi(page);

  const modelButton = page.getByRole('button', { name: /模型 Fixture Model/ });
  await expect(modelButton).toBeVisible();
  await modelButton.click();
  await page.getByRole('menuitemradio', { name: 'Fixture Model Alt' }).click();
  await expect(page.getByRole('button', { name: /模型 Fixture Model Alt/ })).toBeVisible();

  await attachThroughComposer(page, {
    name: 'canonical-notes.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('canonical attachment payload', 'utf8'),
  });
  const composer = page.locator('textarea[placeholder^="发送消息"]');
  await composer.fill('带附件并切换模型');
  await composer.press('Enter');

  await expect.poll(async () => (await fixtureState(request)).inputs.length).toBe(1);
  const current = await fixtureState(request);
  expect(current.uploads).toHaveLength(1);
  expect(current.uploads[0]).toMatchObject({
    filename: 'canonical-notes.txt',
    mediaType: 'text/plain',
    agentId: 'canonical-fixture-agent',
    attachmentRef: 'attachment://canonical/1/canonical-notes.txt',
  });
  expect(current.uploads[0].contentType).toContain('multipart/form-data');
  expect(current.uploads[0].bodyBytes).toBeGreaterThan('canonical attachment payload'.length);

  const input = current.inputs[0];
  expect(input).toEqual({
    apiVersion: 'conversation.ksadk.io/v1',
    kind: 'ConversationInput',
    inputId: expect.stringMatching(/^input:run_/),
    sessionId: 'canonical-fixture-session',
    idempotencyKey: expect.stringMatching(/^conversation:run_/),
    parts: [
      { kind: 'text', text: '带附件并切换模型' },
      {
        kind: 'attachment',
        attachmentRef: 'attachment://canonical/1/canonical-notes.txt',
        mediaType: 'text/plain',
        name: 'canonical-notes.txt',
      },
    ],
    modelRef: 'fixture-model-alt',
    approvalMode: 'risk',
  });
  expect(input.idempotencyKey).toBe(
    `conversation:${String(input.inputId).replace(/^input:/, '')}`,
  );
  expect(current.streamPosts).toBe(1);
  expect(current.legacyRunAgentCalls).toBe(0);
});

test('Hosted UI fails closed before upload when attachment capability is absent', async ({ page, request }) => {
  await setFixtureConfig(request, { attachmentInputs: false });
  await openCanonicalHostedUi(page);
  await attachThroughComposer(page, {
    name: 'not-admitted.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('must not be uploaded', 'utf8'),
  });
  const composer = page.locator('textarea[placeholder^="发送消息"]');
  await composer.fill('禁止附件必须 fail closed');
  await composer.press('Enter');

  await expect(page.getByText('连接断开或生成出错，请重试', { exact: true })).toBeVisible();
  const current = await fixtureState(request);
  expect(current.uploads).toEqual([]);
  expect(current.inputs).toEqual([]);
  expect(current.streamPosts).toBe(0);
  expect(current.legacyRunAgentCalls).toBe(0);
});

test('Hosted UI rejects an oversized attachment before upload or canonical submit', async ({ page, request }) => {
  await openCanonicalHostedUi(page);
  await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error('attachment input missing');
    // Reuse one immutable Blob as 101 parts. This proves the browser File is
    // over 100 MiB without allocating 101 independent payload buffers.
    const oneMiB = new Blob([new Uint8Array(1024 * 1024)]);
    const file = new File(Array.from({ length: 101 }, () => oneMiB), 'oversized.bin', {
      type: 'application/octet-stream',
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(page.getByText('oversized.bin', { exact: true })).toBeVisible();

  const composer = page.locator('textarea[placeholder^="发送消息"]');
  await composer.fill('超大附件必须 fail closed');
  await composer.press('Enter');
  await expect(page.getByText('连接断开或生成出错，请重试', { exact: true })).toBeVisible();

  const current = await fixtureState(request);
  expect(current.uploads).toEqual([]);
  expect(current.inputs).toEqual([]);
  expect(current.streamPosts).toBe(0);
  expect(current.legacyRunAgentCalls).toBe(0);
});

test('independent custom frontend consumes the public conversation API across replay and two turns', async ({ page, request }) => {
  await page.goto('/e2e/fixtures/custom-conversation-consumer.html');
  await expect(page.getByRole('heading', { name: 'Independent Conversation Consumer' })).toBeVisible();

  const message = page.getByLabel('Message');
  await message.fill('独立前端第一轮');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect.poll(async () => (await fixtureState(request)).reconnects).toEqual([
    { after: 3, lastEventId: '3' },
  ]);
  await expect(page.locator('[data-kind="tool"]')).toHaveText('read_config');
  await expect(page.locator('[data-kind="tool"]')).toHaveCount(1);
  await expect(page.locator('[data-kind="approval"]')).toContainText('执行安全检查');
  await expect(page.locator('[data-kind="fallback"]')).toContainText(
    'Unsupported content: This content type is not supported',
  );

  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status')).toHaveText('completed-1');
  await expect(page.locator('[data-kind="assistant_text"]')).toContainText('第一轮完成。');

  await message.fill('独立前端第二轮');
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByRole('status')).toHaveText('completed-2');
  await expect(page.locator('[data-run-id="canonical-run-1"]')).toContainText('第一轮完成。');
  await expect(page.locator('[data-run-id="canonical-run-2"]')).toContainText('第二轮也正常。');

  const current = await fixtureState(request);
  expect(current.inputs).toEqual([
    {
      apiVersion: 'conversation.ksadk.io/v1',
      kind: 'ConversationInput',
      inputId: 'custom-input-1',
      sessionId: 'canonical-fixture-session',
      idempotencyKey: 'custom-turn-1',
      parts: [{ kind: 'text', text: '独立前端第一轮' }],
      modelRef: 'fixture-model',
    },
    {
      apiVersion: 'conversation.ksadk.io/v1',
      kind: 'ConversationInput',
      inputId: 'custom-input-2',
      sessionId: 'canonical-fixture-session',
      idempotencyKey: 'custom-turn-2',
      parts: [{ kind: 'text', text: '独立前端第二轮' }],
      modelRef: 'fixture-model',
    },
  ]);
  expect(current.streamPosts).toBe(2);
  expect(current.legacyRunAgentCalls).toBe(0);
  expect(current.submits).toEqual([{
    InteractionId: APPROVAL_ID,
    ExpectedRevision: APPROVAL_REVISION,
    Action: 'approve',
    IdempotencyKey: `interaction:${APPROVAL_ID}:revision-${APPROVAL_REVISION}`,
  }]);
});
