/** Real Runtime + native PG checkpoint + production components; no API/SSE stubs. */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = process.env.KSADK_TEST_CUSTOM_RUNTIMES;
test.skip(!manifest, 'Explicit disposable local Runtime manifest required');
const runtimeManifest = manifest ? JSON.parse(readFileSync(manifest, 'utf8')) : { containers: [] };
const runtimes = runtimeManifest.containers;
const endpoint = '/e2e/fixtures/custom-catalog.html';
const evidence = async (page, runtime) => (await page.request.post(runtime.url + '/test/evidence')).json();
const count = (rows, phase) => rows.executions.filter(row => row.phase === phase).length;

async function ask(page, runtime, text = 'Collect information for this request') {
  await page.goto(runtime.url + endpoint);
  await page.getByRole('button', { name: /新对话/ }).click();
  await page.getByPlaceholder('发送消息…').fill(text);
  await page.getByPlaceholder('发送消息…').press('Enter');
  const form = page.getByTestId('interaction-a2ui-surface');
  await expect(form.getByRole('button', { name: 'Submit request', exact: true })).toBeVisible({ timeout: 25000 });
  await expect(form.getByTestId('custom-feedback-input')).toHaveCount(2);
  return form;
}

async function fill(form, value, secret = 'synthetic-private-note') {
  await form.getByTestId('custom-feedback-input').first().locator('input').fill(value);
  await form.getByTestId('custom-feedback-input').last().locator('input').fill(secret);
  await form.getByRole('checkbox', { name: 'Confirm details', exact: true }).check();
  await form.getByText('Standard', { exact: true }).click();
}

for (const runtime of runtimes) {
  test(`${runtime.mode}: custom card, correction, original resume, history, dedupe and multiple turns`, async ({ page }, info) => {
    const before = await evidence(page, runtime);
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/SubmitInteraction')) requests.push(request.postDataJSON());
    });
    let form = await ask(page, runtime);
    for (let round = 1; round <= 2; round++) {
      if (round === 2) {
        await page.getByPlaceholder('发送消息…').fill('Collect another independent request');
        await page.getByPlaceholder('发送消息…').press('Enter');
        form = page.getByTestId('interaction-a2ui-surface');
        await expect(form.getByTestId('custom-feedback-input')).toHaveCount(2);
      }
      const waiting = await evidence(page, runtime);
      expect(count(waiting, 'initialize')).toBe(count(before, 'initialize') + round);
      expect(waiting.native_checkpoints.at(-1).next).toContain('wait');
      await fill(form, 'x');
      await form.getByRole('button', { name: 'Submit request', exact: true }).click();
      await expect(page.getByTestId('interaction-tray-error')).toBeVisible();
      expect(count(await evidence(page, runtime), 'tool')).toBe(count(before, 'tool') + round - 1);
      const value = `custom-${runtime.mode}-${round}`;
      await fill(form, value);
      await form.getByRole('button', { name: 'Submit request', exact: true }).click();
      await expect(page.getByText('Completed: ' + value, { exact: true })).toHaveCount(1, { timeout: 20000 });
      await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
      const after = await evidence(page, runtime);
      expect(count(after, 'initialize')).toBe(count(before, 'initialize') + round);
      expect(count(after, 'tool')).toBe(count(before, 'tool') + round);
      expect(after.native_checkpoints.at(-1).config.configurable.thread_id)
        .toBe(waiting.native_checkpoints.at(-1).config.configurable.thread_id);
      expect(after.native_checkpoints.at(-1).config.configurable.checkpoint_id)
        .not.toBe(waiting.native_checkpoints.at(-1).config.configurable.checkpoint_id);
      expect(after.executions.filter(row => row.phase === 'tool').at(-1).answer)
        .toEqual({ resource: value, confirmed: true, tier: ['standard'], secret: 'synthetic-private-note' });
      const history = page.getByTestId('a2ui-input-history').last();
      await history.locator('summary').click();
      await expect(history.getByTestId('custom-feedback-input').locator('input')).toHaveValue(value);
      await expect(history.getByRole('checkbox', { name: 'Confirm details', exact: true })).toBeChecked();
      await expect(history.getByTestId('custom-feedback-input').locator('input')).toBeDisabled();
      await expect(history).toContainText('已隐藏');
      await expect(history).not.toContainText('synthetic-private-note');
      const response = await page.request.post(runtime.url + '/agentengine/api/v1/SubmitInteraction', { data: requests.at(-1) });
      expect((await response.json()).Code).toBe(0);
      await page.reload();
      await expect(page.getByText('Completed: ' + value, { exact: true })).toHaveCount(1);
      await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
      expect(count(await evidence(page, runtime), 'tool')).toBe(count(after, 'tool'));
    }
    expect(errors).toEqual([]);
    await info.attach('original-interrupt-and-tool-count', { contentType: 'application/json',
      body: JSON.stringify({ mode: runtime.mode, before, after: await evidence(page, runtime), submissionCount: requests.length }) });
  });

  test(`${runtime.mode}: unextended built-in page falls back to its business Schema`, async ({ page }) => {
    await page.goto(runtime.url + '/');
    await page.getByPlaceholder('发送消息…').fill('Collect parameters with an unknown display catalog');
    await page.getByPlaceholder('发送消息…').press('Enter');
    await expect(page.getByTestId('interaction-schema-form')).toBeVisible({ timeout: 25000 });
    await expect(page.getByTestId('interaction-schema-form').getByTestId('interaction-field-resource')).toBeVisible();
    await expect(page.getByTestId('custom-feedback-input')).toHaveCount(0);
  });
}

const registered = runtimes.find(runtime => runtime.mode === 'registered');
test('custom pending interaction survives a backend restart without executing START again', async ({ page }, info) => {
  test.skip(!registered, 'Registered Runtime required');
  const before = await evidence(page, registered);
  await ask(page, registered, 'Pause this custom request until restart');
  const waiting = await evidence(page, registered);
  const owned = JSON.parse(execFileSync('docker', ['inspect', registered.id], { encoding: 'utf8' }))[0];
  expect(owned.Config.Labels['codex.test.run']).toBe(runtimeManifest.network);
  execFileSync('docker', ['restart', registered.id], { timeout: 30000, stdio: 'ignore' });
  await expect.poll(async () => {
    try { return (await page.request.get(registered.url + '/health')).status(); } catch { return 0; }
  }, { timeout: 25000 }).toBe(200);
  await page.reload();
  const form = page.getByTestId('interaction-a2ui-surface');
  await expect(form.getByTestId('custom-feedback-input')).toHaveCount(2, { timeout: 25000 });
  await fill(form, 'custom-after-restart');
  await form.getByRole('button', { name: 'Submit request', exact: true }).click();
  await expect(page.getByText('Completed: custom-after-restart', { exact: true })).toHaveCount(1, { timeout: 20000 });
  const after = await evidence(page, registered);
  expect(count(after, 'initialize')).toBe(count(before, 'initialize') + 1);
  expect(count(after, 'tool')).toBe(count(before, 'tool') + 1);
  expect(after.native_checkpoints.at(-1).config.configurable.thread_id)
    .toBe(waiting.native_checkpoints.at(-1).config.configurable.thread_id);
  await info.attach('restart-resume', { contentType: 'application/json', body: JSON.stringify({ waiting, after }) });
});
