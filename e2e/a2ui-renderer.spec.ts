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

const themedForm: Operation[] = [
  { version: 'v0.9', createSurface: {
    surfaceId: 's', catalogId: 'https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json',
  } },
  components([
    { id: 'title', component: 'Text', text: '选择参数', variant: 'h2' },
    { id: 'zone', component: 'ChoicePicker', label: '可用区', variant: 'mutuallyExclusive',
      displayStyle: 'chips', filterable: true, options: [{ label: '可用区 A', value: 'a' }, { label: '可用区 B', value: 'b' }],
      value: { path: '/fields/zone' } },
    { id: 'note', component: 'TextField', label: '备注', value: { path: '/fields/note' } },
    { id: 'submit-label', component: 'Text', text: '提交参数' },
    { id: 'submit', component: 'Button', child: 'submit-label', variant: 'primary',
      action: { event: { name: 'submit', context: { note: { path: '/fields/note' }, zone: { path: '/fields/zone' } } } } },
    { id: 'root', component: 'Column', children: ['title', 'zone', 'note', 'submit'] },
  ]),
  data({ fields: { zone: [], note: '' } }),
];

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/fixtures/a2ui-renderer.html');
  await page.waitForFunction(() => Boolean(window.rendererProbe));
});

for (const system of ['dark', 'light'] as const) {
  for (const dark of [false, true]) {
    test(`A2UI theme follows the page (system=${system}, page=${dark ? 'dark' : 'light'})`, async ({ page }, testInfo) => {
      await page.emulateMedia({ colorScheme: system });
      // A library consumer can scope its theme without changing the whole document.
      await page.evaluate(dark => document.getElementById('root')!.classList.toggle('dark', dark), dark);
      await page.evaluate(messages => window.rendererProbe.surfaces(messages), themedForm);
      const input = page.getByRole('textbox', { name: '', exact: true });
      const filter = page.getByPlaceholder('Filter options...');
      const title = page.getByRole('heading', { name: '选择参数' });
      const checkColors = async (isDark: boolean) => {
        await expect(input).toHaveCSS('background-color', isDark ? 'rgb(42, 42, 42)' : 'rgb(255, 255, 255)');
        await expect(filter).toHaveCSS('background-color', isDark ? 'rgb(42, 42, 42)' : 'rgb(255, 255, 255)');
        await expect(title).toHaveCSS('color', isDark ? 'rgb(238, 238, 238)' : 'rgb(51, 51, 51)');
      };
      await checkColors(dark);
      await input.fill('保留输入');
      await page.getByRole('button', { name: '可用区 B', exact: true }).click();
      await expect(page.getByRole('button', { name: '可用区 B', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.evaluate(dark => document.getElementById('root')!.classList.toggle('dark', dark), !dark);
      await checkColors(!dark);
      await expect(input).toHaveValue('保留输入');
      await expect(page.getByRole('button', { name: '可用区 B', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await page.evaluate(dark => document.getElementById('root')!.classList.toggle('dark', dark), dark);
      await checkColors(dark);
      await page.screenshot({ path: testInfo.outputPath('theme.png') });
      await page.getByRole('button', { name: '提交参数', exact: true }).click();
      expect(await page.evaluate(() => window.rendererProbe.actions)).toEqual([{ note: '保留输入', zone: ['b'] }]);
      await page.evaluate(messages => window.rendererProbe.mixedCatalogs(messages, true), themedForm);
      await checkColors(dark);
      await expect(input).toBeDisabled();
      await expect(page.getByRole('button', { name: '提交参数', exact: true })).toBeDisabled();
      expect(await page.evaluate(() => window.rendererProbe.actions)).toHaveLength(1);
    });
  }
}

test('history layout reclaims hidden rows and follows form expand/collapse', async ({ page }) => {
  await page.evaluate(() => window.rendererProbe.layout());
  const rowTop = (id: string) => page.locator(`[data-message-id="${id}"]`).evaluate(el => parseFloat((el as HTMLElement).style.top));
  const history = page.getByTestId('a2ui-input-history');
  await expect(history).toBeVisible();
  await expect.poll(async () => (await rowTop('layout-result')) - await history.evaluate(el => el.parentElement!.offsetHeight)).toBe(0);
  const collapsedTop = await rowTop('layout-result');
  await history.locator('summary').click();
  await expect(history.getByLabel('参数 0', { exact: true })).toHaveValue('已提交 0');
  await expect(history.getByLabel('参数 0', { exact: true })).toBeDisabled();
  await expect.poll(() => rowTop('layout-result')).toBeGreaterThan(collapsedTop + 100);
  await history.locator('summary').click();
  await expect.poll(() => rowTop('layout-result')).toBe(collapsedTop);
  await page.getByRole('button', { name: '显示结果卡', exact: true }).click();
  await expect(page.getByText('后续结果卡', { exact: true })).toBeVisible();
  await expect.poll(() => rowTop('layout-result')).toBeGreaterThan(collapsedTop);
  await page.getByRole('button', { name: '隐藏结果卡', exact: true }).click();
  await expect.poll(() => rowTop('layout-result')).toBe(collapsedTop);
});

test('history layout keeps virtual scrolling and explicit navigation accurate across zero rows', async ({ page }) => {
  await page.evaluate(() => window.rendererProbe.layout(true));
  await page.getByRole('button', { name: '定位最终回答', exact: true }).click();
  const result = page.locator('[data-message-id="layout-result"]');
  await expect(result).toHaveAttribute('data-search-target', 'true');
  await expect(page.getByText('最终回答仍然可见', { exact: true })).toBeVisible();
  await expect.poll(() => result.evaluate(el => Math.abs(el.getBoundingClientRect().top - el.closest('[data-slot="message-list"]')!.getBoundingClientRect().top - 24))).toBeLessThan(2);
  const mounted = await page.locator('[data-message-id]').count();
  expect(mounted).toBeLessThan(30);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '定位最终回答', exact: true }).click();
  await expect(page.getByText('最终回答仍然可见', { exact: true })).toBeVisible();
  const scroller = page.locator('[data-slot="message-list"]');
  await scroller.evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }));
  await expect(page.getByText('早期历史消息 0', { exact: true })).toBeVisible();
  await scroller.evaluate(el => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
  await expect(page.getByText('后续历史消息 29', { exact: true })).toBeVisible();
});

test('history layout rebuilds after refresh without stale form placeholders', async ({ page }) => {
  await page.evaluate(() => window.rendererProbe.layout());
  const height = () => page.locator('[data-message-id="input-row"]').evaluate(el => el.parentElement!.offsetHeight);
  const history = page.getByTestId('a2ui-input-history');
  await expect(history).toBeVisible();
  await expect.poll(() => page.locator('[data-message-id="hidden-0"]').evaluate(el => el.offsetHeight)).toBe(0);
  const collapsedHeight = await height();
  await history.locator('summary').click();
  await expect.poll(height).toBeGreaterThan(collapsedHeight + 100);
  await page.reload();
  await page.waitForFunction(() => Boolean(window.rendererProbe));
  await page.evaluate(() => window.rendererProbe.layout());
  await expect(page.getByTestId('a2ui-input-history')).toBeVisible();
  await expect.poll(height).toBe(collapsedHeight);
  await expect(page.getByText('最终回答仍然可见', { exact: true })).toHaveCount(1);
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

test('approval keeps operation details visible with one declared action entry', async ({ page }) => {
  await page.evaluate(messages => window.rendererProbe.approval(messages), [create(), components([
    { id: 'plan', component: 'Card', body: 'Example operation details' }, { id: 'bar', component: 'ApprovalBar' },
  ])]);
  await expect(page.getByText('Example operation details')).toBeVisible();
  const preview = page.getByTestId('interaction-approval-a2ui');
  await expect(preview.getByRole('button', { name: '批准', exact: true })).toBeEnabled();
  await expect(preview.getByRole('button', { name: '拒绝', exact: true })).toBeEnabled();
  await expect(page.getByTestId('interaction-approve')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '批准', exact: true })).toHaveCount(1);
  await preview.getByRole('button', { name: '批准', exact: true }).click();
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
  const preview = page.getByTestId('interaction-approval-a2ui');
  await expect(preview.getByRole('button', { name: '批准', exact: true })).toBeEnabled();
  await expect(preview.getByRole('button', { name: '拒绝', exact: true })).toBeEnabled();
  await expect(page.getByTestId('interaction-approve')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '拒绝', exact: true })).toHaveCount(1);
  await preview.getByRole('button', { name: '拒绝', exact: true }).click();
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
