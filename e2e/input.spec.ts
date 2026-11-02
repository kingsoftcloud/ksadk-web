import { expect, test } from '@playwright/test';

// UI regression only. Runtime/Agent acceptance uses the independent real E2E.
test('nested values keep false, zero, null and empty arrays; invalid JSON cannot submit stale data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/e2e/fixtures/input.html');
  await page.getByTestId('interaction-field-count').fill('0');
  await page.getByTestId('interaction-field-enabled').selectOption('false');
  await page.getByRole('button', { name: '设为 null' }).click();
  await page.getByTestId('interaction-field-items').fill('[]');
  await page.getByTestId('interaction-submit').click();
  await expect(page.getByTestId('answers')).toHaveText('[{"count":0,"enabled":false,"note":null,"items":[]}]');
  await page.getByTestId('interaction-field-items').fill('[bad');
  await page.getByTestId('interaction-field-enabled').selectOption('true');
  await page.getByTestId('interaction-submit').click();
  await expect(page.getByTestId('answers')).toHaveText('[{"count":0,"enabled":false,"note":null,"items":[]}]');
  await expect(page.getByText('请先修正 JSON 草稿。')).toBeVisible();
  await page.getByTestId('interaction-field-items').fill('[0]');
  await page.getByTestId('interaction-submit').click();
  await expect(page.getByTestId('answers')).toContainText('"items":[0]');
  expect(errors).toEqual([]);
});

test('root answers remain JSON values across new interactions', async ({ page }) => {
  await page.goto('/e2e/fixtures/input.html');
  for (const [scenario, value] of [['arbitrary', 'null'], ['boolean', 'false'], ['integer', '0'], ['string', ''], ['array', '[]']]) {
    await page.getByLabel('Scenario').selectOption(scenario);
    const field = page.getByTestId('interaction-field-value');
    if (scenario === 'boolean') await field.selectOption(value);
    else if (scenario === 'string') { await field.fill('x'); await field.fill(''); }
    else await field.fill(value);
    await page.getByTestId('interaction-submit').click();
  }
  await expect(page.getByTestId('answers')).toHaveText('[null,false,0,"",[]]');
});
