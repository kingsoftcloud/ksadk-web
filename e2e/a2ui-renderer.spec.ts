import { expect, test } from '@playwright/test';
import type {} from './fixtures/a2ui-renderer.js';

type Operation = Record<string, unknown>;
const create = (surfaceId = 's'): Operation => ({ version: 'v0.9', createSurface: {
  surfaceId, catalogId: 'a2ui.org/catalogs/basic/v1.0',
} });
const components = (entries: Record<string, unknown>[], surfaceId = 's'): Operation => ({
  version: 'v0.9', updateComponents: { surfaceId, components: entries },
});
const data = (value: unknown, path = '/', surfaceId = 's'): Operation => ({
  version: 'v0.9', updateDataModel: { surfaceId, path, value },
});
const form = (names: string[]) => ({ id: 'form', component: 'Form', fields: names.map(name => ({ name, label: name, type: 'string' })) });

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/fixtures/a2ui-renderer.html');
  await page.waitForFunction(() => Boolean(window.rendererProbe));
});

for (const disabled of [false, true]) {
  test(`legacy and custom surfaces share messages with isolated controls (readonly=${disabled})`, async ({ page }) => {
    const messages = [create(), components([form(['region'])]), data({ region: 'initial' }),
      { version: 'v0.9.1', createSurface: { surfaceId: 'custom', catalogId: 'https://example.test/catalogs/forms/v1' } },
      { version: 'v0.9.1', updateComponents: { surfaceId: 'custom', components: [
        { id: 'root', component: 'Text', text: 'Custom catalog result' },
      ] } },
    ];
    await page.evaluate(({ messages, disabled }) => window.rendererProbe.mixedCatalogs(messages, disabled), { messages, disabled });
    await expect(page.getByText('Custom catalog result', { exact: true })).toBeVisible();
    const legacy = page.getByTestId('legacy-a2ui-surface');
    await expect(legacy.getByLabel('region', { exact: true })).toHaveValue('initial');
    await expect(page.getByRole('alert')).toHaveCount(0);
    if (disabled) {
      await expect(legacy.getByLabel('region', { exact: true })).toBeDisabled();
      await expect(legacy.getByRole('button', { name: '提交', exact: true })).toBeDisabled();
      expect(await page.evaluate(() => window.rendererProbe.actions)).toEqual([]);
    } else {
      await legacy.getByLabel('region', { exact: true }).fill('submitted-region');
      await legacy.getByRole('button', { name: '提交', exact: true }).click();
      expect(await page.evaluate(() => window.rendererProbe.actions)).toMatchObject([
        { userAction: { surfaceId: 's', context: { payload: { region: 'submitted-region' } } } },
      ]);
    }
  });
}

test('approval keeps operation details visible and only the tray can approve', async ({ page }) => {
  await page.evaluate(messages => window.rendererProbe.approval(messages), [create(), components([
    { id: 'plan', component: 'Card', body: 'Example operation details' }, { id: 'bar', component: 'ApprovalBar' },
  ])]);
  await expect(page.getByText('Example operation details')).toBeVisible();
  const preview = page.getByTestId('legacy-a2ui-surface');
  await expect(preview.getByRole('button', { name: '批准', exact: true })).toBeDisabled();
  await expect(preview.getByRole('button', { name: '拒绝', exact: true })).toBeDisabled();
  await page.getByTestId('interaction-approve').click();
  expect(await page.evaluate(() => window.rendererProbe.actions)).toMatchObject([{ action: 'approve' }]);
});

test('server updates merge changed fields, preserve other drafts and submit current values', async ({ page }) => {
  const initial = [create(), components([form(['city', 'note', 'removed'])]), data({ city: 'first', note: 'initial', removed: 'gone' })];
  await page.evaluate(messages => window.rendererProbe.legacy(messages), initial);
  await page.getByLabel('note', { exact: true }).fill('draft');
  const updated = [...initial, components([form(['city', 'note', 'added'])]), data('second', '/city'), data('new', '/added')];
  await page.evaluate(messages => window.rendererProbe.legacy(messages), updated);
  await expect(page.getByLabel('city', { exact: true })).toHaveValue('second');
  await expect(page.getByLabel('note', { exact: true })).toHaveValue('draft');
  await expect(page.getByLabel('added', { exact: true })).toHaveValue('new');
  await expect(page.getByLabel('removed', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '提交', exact: true }).click();
  expect(await page.evaluate(() => window.rendererProbe.actions)).toMatchObject([
    { userAction: { context: { payload: { city: 'second', note: 'draft', added: 'new' } } } },
  ]);
  expect(JSON.stringify(await page.evaluate(() => window.rendererProbe.actions))).not.toContain('removed');
});

test('selection value updates preserve JSON false/zero and do not emit an action', async ({ page }) => {
  const initial = [create(), components([{ id: 'choice', component: 'Select', label: 'Choice', value: false,
    options: [{ value: false, label: 'False' }, { value: 0, label: 'Zero' }] }])];
  await page.evaluate(messages => window.rendererProbe.legacy(messages), initial);
  await expect(page.getByLabel('Choice')).toHaveValue('false');
  await page.evaluate(messages => window.rendererProbe.legacy(messages), [...initial, components([
    { id: 'choice', component: 'Select', label: 'Choice', value: 0,
      options: [{ value: false, label: 'False' }, { value: 0, label: 'Zero' }] },
  ])]);
  await expect(page.getByLabel('Choice')).toHaveValue('0');
  expect(await page.evaluate(() => window.rendererProbe.actions)).toEqual([]);
});

test('delete and recreate resets a draft and only displays the live surface', async ({ page }) => {
  const initial = [create(), components([form(['city'])]), data({ city: 'initial' })];
  await page.evaluate(messages => window.rendererProbe.surfaces(messages), initial);
  await page.getByLabel('city', { exact: true }).fill('draft');
  const recreated = [...initial, { version: 'v0.9', deleteSurface: { surfaceId: 's' } },
    create(), components([form(['city'])]), data({ city: 'initial' })];
  await page.evaluate(messages => window.rendererProbe.surfaces(messages), recreated);
  await expect(page.getByLabel('city', { exact: true })).toHaveValue('initial');
  const replaced = [...recreated, { version: 'v0.9', deleteSurface: { surfaceId: 's' } },
    create('next'), components([form(['new field'])], 'next')];
  await page.evaluate(messages => window.rendererProbe.surfaces(messages), replaced);
  await expect(page.getByLabel('city', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('new field', { exact: true })).toBeVisible();
});

test('switching pending interactions does not inherit another form draft', async ({ page }) => {
  const messages = [create(), components([form(['city'])]), data({ city: 'initial' })];
  await page.evaluate(messages => window.rendererProbe.input(messages, 'first'), messages);
  await page.getByLabel('city', { exact: true }).fill('draft');
  await page.evaluate(messages => window.rendererProbe.input(messages, 'second'), messages);
  await expect(page.getByLabel('city', { exact: true })).toHaveValue('initial');
  expect(await page.evaluate(() => window.rendererProbe.actions)).toEqual([]);
});


test('restored approval presentation needs no live Activity and keeps one action entry', async ({ page }) => {
  await page.evaluate(messages => window.rendererProbe.approval(messages, false), [create(), components([
    { id: 'plan', component: 'Card', body: 'Persisted operation details' }, { id: 'bar', component: 'ApprovalBar' },
  ])]);
  await expect(page.getByText('Persisted operation details', { exact: true })).toHaveCount(1);
  const preview = page.getByTestId('interaction-approval-preview');
  await expect(preview.getByRole('button', { name: '批准', exact: true })).toBeDisabled();
  await expect(preview.getByRole('button', { name: '拒绝', exact: true })).toBeDisabled();
  await expect(page.getByTestId('interaction-approve')).toHaveCount(1);
  await page.getByTestId('interaction-reject').click();
  expect(await page.evaluate(() => window.rendererProbe.actions)).toMatchObject([{ action: 'reject' }]);
});


test('a short history page with only an A2UI Activity still renders the approval snapshot', async ({ page }) => {
  await page.evaluate(messages => window.rendererProbe.approvalHistoryOnly(messages), [create(), components([
    { id: 'plan', component: 'Card', body: 'Only Activity approval plan' }, { id: 'bar', component: 'ApprovalBar' },
  ])]);
  const anchor = page.getByTestId('interaction-history-anchor');
  await expect(anchor).toHaveCount(1);
  await anchor.locator('summary').click();
  await expect(anchor.getByText('Only Activity approval plan', { exact: true })).toBeVisible();
  await expect(page.getByText('Only Activity approval plan', { exact: true })).toHaveCount(1);
  await expect(anchor.getByRole('button', { name: '批准', exact: true })).toBeDisabled();
  await expect(anchor.getByRole('button', { name: '拒绝', exact: true })).toBeDisabled();
});
