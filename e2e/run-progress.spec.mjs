import { expect, test } from '@playwright/test';

const audit = async page => JSON.parse(await page.getByTestId('audit').textContent());
const progress = page => page.getByTestId('run-progress-indicator');
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
const begin = async page => {
  await page.goto('/e2e/run-progress.html');
  await expect.poll(async () => JSON.parse(await page.getByTestId('selection').textContent()).sessionId).toBe('a');
  await page.getByRole('textbox').fill('查询最近一周的记录');
  await page.getByRole('textbox').press('Enter');
  await expect(progress(page)).toHaveText('正在等待工具返回…');
  await expect(page.getByTestId('timeline')).toContainText('lookup');
  await expect(page.getByTestId('timeline')).toContainText('已思考');
};

test('a quiet tool keeps a single animated footer and survives session switches and full reload', async ({ page }, testInfo) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await begin(page);
  await expect(progress(page).locator('span').first()).toHaveCSS('animation-name', 'pulse');
  await page.waitForTimeout(1200); // Deliberately no tool or network frames.
  await expect(progress(page)).toHaveText('正在等待工具返回…');
  await click(page, 'Session B');
  await expect(progress(page)).toHaveCount(0);
  await expect(page.getByTestId('timeline')).not.toContainText('lookup');
  await click(page, 'Session A');
  await expect(progress(page)).toHaveText('正在等待工具返回…');
  await page.reload();
  await expect(progress(page)).toHaveText('正在等待工具返回…');
  await expect(progress(page)).toHaveCount(1);
  await expect(page.getByTestId('timeline')).toContainText('lookup');
  await expect(page.getByTestId('timeline')).toContainText('已思考');
  expect(await audit(page)).toEqual({ submissions: 1, cancellations: 0 });
  await page.screenshot({ path: testInfo.outputPath('minimal-running-feedback.png'), fullPage: true });
  await click(page, 'Finish A in backend');
  await expect(progress(page)).toHaveCount(0);
  await expect(page.getByTestId('timeline')).toContainText('任务已完成');
  expect(errors).toEqual([]);
});

test('background completion settles a recovered observer when returning, including after refresh', async ({ page }) => {
  await begin(page);
  await page.reload();
  await expect(progress(page)).toHaveText('正在等待工具返回…');
  await click(page, 'Session B');
  await click(page, 'Finish A in backend');
  await expect(progress(page)).toHaveCount(0);
  await click(page, 'Session A');
  await expect(page.getByTestId('timeline')).toContainText('任务已完成');
  await expect(progress(page)).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('timeline')).toContainText('任务已完成');
  await expect(progress(page)).toHaveCount(0);
  expect(await audit(page)).toEqual({ submissions: 1, cancellations: 0 });
});

test('network retry is visible without resubmitting the run; narrow layout stays usable', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 820 });
  await begin(page);
  await click(page, 'Disconnect subscriptions');
  await expect(progress(page)).toHaveText('连接中断，正在重连…');
  await expect(progress(page)).toHaveText('正在等待工具返回…');
  expect(await audit(page)).toEqual({ submissions: 1, cancellations: 0 });
  const bounds = await progress(page).boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(375);
  await page.screenshot({ path: testInfo.outputPath('minimal-running-feedback-mobile.png'), fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(progress(page).locator('span').first()).toHaveCSS('animation-name', 'none');
  await expect(progress(page)).toHaveText('正在等待工具返回…');
});
