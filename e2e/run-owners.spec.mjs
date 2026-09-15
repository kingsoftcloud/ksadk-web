import { expect, test } from '@playwright/test';

const audit = async page => JSON.parse(await page.getByTestId('audit').textContent());
const selection = async page => JSON.parse(await page.getByTestId('selection').textContent());
const send = async (page, text) => {
  await page.getByRole('textbox').fill(text);
  await page.getByRole('textbox').press('Enter');
  await expect(page.getByRole('textbox')).toHaveValue('');
};
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/run-owners.html');
  await expect.poll(async () => (await selection(page)).status).toBe('ready');
});

test('four drafts bind in reverse order; background queue and cancellation keep their owner', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await send(page, 'A first');
  await send(page, 'A queued');
  for (const label of ['B', 'C', 'D']) {
    await click(page, 'New conversation');
    await send(page, `${label} first`);
  }
  await expect.poll(async () => (await audit(page)).creations.length).toBe(4);
  const selectedDraft = (await selection(page)).conversationId;
  await page.getByRole('textbox').fill('D unsent input');
  for (const id of [4, 3, 2, 1]) await click(page, `Resolve creation ${id}`);
  await expect.poll(async () => (await audit(page)).runs.length).toBe(4);
  expect((await audit(page)).runs.map(run => [run.sessionId, run.text])).toEqual([
    ['native-4', 'D first'], ['native-3', 'C first'], ['native-2', 'B first'], ['native-1', 'A first'],
  ]);
  expect(await selection(page)).toMatchObject({ conversationId: selectedDraft, sessionId: 'native-4', isStreaming: true });
  await expect(page.getByRole('textbox')).toHaveValue('D unsent input');
  await click(page, 'Emit run 4');
  await click(page, 'Finish run 4');
  await expect.poll(async () => (await audit(page)).runs.length).toBe(5);
  expect((await audit(page)).runs[4]).toMatchObject({ sessionId: 'native-1', text: 'A queued', agentId: 'agent-a' });
  for (const id of [2, 3, 5]) {
    await click(page, `Emit run ${id}`);
    await click(page, `Finish run ${id}`);
  }
  await expect.poll(async () => (await audit(page)).streaming).toEqual(['native-4']);
  await expect(page.getByTestId('timeline')).not.toContainText('A queued');
  await expect(page.getByTestId('timeline')).not.toContainText('output 4');
  await click(page, 'Emit run 1');
  await expect(page.getByTestId('timeline')).toContainText('output 1');
  await page.getByTitle('停止生成', { exact: true }).click();
  await expect.poll(async () => (await audit(page)).cancellations.length).toBe(1);
  const state = await audit(page);
  expect(state.cancellations[0]).toEqual({ agentId: 'agent-a', sessionId: 'native-4', invocationId: state.runs[0].invocationId });
  await expect(page.getByRole('textbox')).toHaveValue('D unsent input');
  await expect.poll(async () => (await audit(page)).streaming).toEqual([]);
  expect(errors).toEqual([]);
  await testInfo.attach('run-audit', { body: JSON.stringify(await audit(page), null, 2), contentType: 'application/json' });
});

test('late native creation keeps the submitted Agent and does not replace the new Agent draft', async ({ page }, testInfo) => {
  await send(page, 'old Agent task');
  await click(page, 'Switch Agent');
  await expect.poll(async () => (await selection(page)).agentId).toBe('agent-b');
  await expect.poll(async () => (await selection(page)).status).toBe('ready');
  const draftB = (await selection(page)).conversationId;
  await page.getByRole('textbox').fill('new Agent draft');
  await click(page, 'Resolve creation 1');
  await expect.poll(async () => (await audit(page)).runs.length).toBe(1);
  expect((await audit(page)).runs[0]).toMatchObject({ agentId: 'agent-a', sessionId: 'native-1' });
  expect(JSON.stringify((await audit(page)).runs[0].body)).toContain('model-agent-a');
  expect(await selection(page)).toMatchObject({ agentId: 'agent-b', conversationId: draftB, sessionId: null, isStreaming: false });
  await expect(page.getByRole('textbox')).toHaveValue('new Agent draft');
  await page.getByRole('textbox').press('Enter');
  await click(page, 'Resolve creation 2');
  await expect.poll(async () => (await audit(page)).runs.length).toBe(2);
  expect((await audit(page)).runs[1]).toMatchObject({ agentId: 'agent-b', sessionId: 'native-2', text: 'new Agent draft' });
  await click(page, 'Emit run 1');
  await click(page, 'Finish run 1');
  await expect(page.getByTestId('timeline')).not.toContainText('output 1');
  await expect.poll(async () => (await selection(page)).isStreaming).toBe(true);
  await click(page, 'Finish run 2');
  await testInfo.attach('agent-audit', { body: JSON.stringify(await audit(page), null, 2), contentType: 'application/json' });
});

test('failed native creation surfaces an error without inventing an execution identity', async ({ page }) => {
  await send(page, 'failed submission stays visible');
  await click(page, 'Fail creation 1');
  await expect(page.getByTestId('timeline')).toContainText('CreateSession unavailable');
  await expect(page.getByTestId('timeline')).toContainText('failed submission stays visible');
  expect((await audit(page)).runs).toEqual([]);
  expect((await selection(page)).sessionId).toBeNull();
  await expect(page.getByRole('textbox')).toBeEditable();
});

test('IME confirmation and empty Enter neither submit nor stop a running conversation', async ({ page }) => {
  const input = page.getByRole('textbox');
  await input.fill('中文候选词');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(input).toHaveValue('中文候选词');
  expect((await audit(page)).creations).toEqual([]);
  await input.press('Enter');
  await click(page, 'Resolve creation 1');
  await expect.poll(async () => (await audit(page)).runs.length).toBe(1);
  await input.press('Enter');
  await input.fill('第二条消息');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
  await expect(input).toHaveValue('第二条消息');
  expect((await audit(page)).cancellations).toEqual([]);
  expect((await audit(page)).runs).toHaveLength(1);
  await input.press('Enter');
  await expect(input).toHaveValue('');
  await click(page, 'Finish run 1');
  await expect.poll(async () => (await audit(page)).runs.length).toBe(2);
  expect((await audit(page)).runs[1]).toMatchObject({ text: '第二条消息', sessionId: 'native-1' });
  await click(page, 'Finish run 2');
});
