import { expect, test } from '@playwright/test';
import type {} from './fixtures/agui-text-snapshot.js';

test('a true text rewrite retains visible history, thinking, tools and A2UI in production components', async ({ page }, info) => {
  await page.goto('/e2e/fixtures/agui-text-snapshot.html');
  await page.waitForFunction(() => Boolean(window.textSnapshotProbe));
  await page.evaluate(() => window.textSnapshotProbe.run());
  const messages = await page.evaluate(() => window.textSnapshotProbe.messages());
  const target = messages.find(message => message.id === 'answer')!;
  expect(target.content).toBe('Initial revised answer.');
  expect(target.blocks?.filter(block => block.type === 'text').map(block => block.content).join('')).toBe(target.content);
  expect(target.reasoning).toBe('Thinking retained');
  expect(target.tools?.lookup.output).toBe('Tool retained');
  expect(target.aguiActivities?.[0].surfaceId).toBe('card');
  await expect(page.getByText('History retained', { exact: true })).toBeVisible();
  await expect(page.getByText('revised answer.', { exact: true })).toBeVisible();
  await expect(page.getByText('Card retained', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: '已完成 lookup' })).toBeVisible();
  await expect(page.getByText('draft', { exact: true })).toHaveCount(0);
  await info.attach('message-state', { body: JSON.stringify(messages, null, 2), contentType: 'application/json' });
  await page.screenshot({ path: info.outputPath('corrected-with-retained-content.png'), fullPage: true });
});
