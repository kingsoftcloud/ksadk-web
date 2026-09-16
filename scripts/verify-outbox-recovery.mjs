import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { build, preview } from 'vite';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output/playwright/outbox-recovery');
await mkdir(output, { recursive: true });
process.chdir(root);
const hash = createHash('sha256');
async function fingerprint(directory) {
  for (const entry of (await readdir(path.join(root, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await fingerprint(file);
    else hash.update(file).update(await readFile(path.join(root, file)));
  }
}
await fingerprint('src');
for (const file of ['e2e/run-owners-fixture.tsx', 'vite.run-owners.config.ts', 'scripts/verify-outbox-recovery.mjs']) {
  hash.update(file).update(await readFile(file));
}
const report = { sourceSha256: hash.digest('hex'), commit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(),
  scope: 'Production React build and real chat controller; deterministic local transport. No cloud or model execution.',
  assertions: [], snapshots: [], passed: false };
await build({ configFile: path.join(root, 'vite.run-owners.config.ts') });
const server = await preview({ configFile: path.join(root, 'vite.run-owners.config.ts'),
  preview: { host: '127.0.0.1', port: 4195, strictPort: true } });
let browser;
let context;
let page;
try {
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:4195/e2e/run-owners.html');
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="selection"]').textContent).status === 'ready');
  const input = page.getByRole('textbox');
  const click = name => page.getByRole('button', { name, exact: true }).click();
  const audit = async () => JSON.parse(await page.getByTestId('audit').textContent());
  const waitStatus = status => page.waitForFunction(expected => {
    const data = JSON.parse(document.querySelector('[data-testid="audit"]').textContent);
    return data.outbox[0]?.status === expected;
  }, status);
  await input.fill('Perform exactly one fixture operation');
  await input.press('Enter');
  await click('Resolve creation 1');
  await click('Emit run 1');
  await page.getByTestId('timeline').getByText('output 1', { exact: false }).waitFor();
  await click('Disconnect run 1');
  await waitStatus('unknown');
  await input.fill('保留下一条草稿');
  await click('Query uncertain delivery');
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="audit"]').textContent).sessionQueries === 1);
  assert.equal((await audit()).runs.length, 1);
  assert.equal((await audit()).outbox[0].status, 'unknown');
  report.assertions.push('Failed state query does not resend');
  await click('Query mode other-run');
  await click('Query uncertain delivery');
  assert.equal((await audit()).outbox[0].status, 'unknown');
  assert.equal((await audit()).runs.length, 1);
  report.assertions.push('Another invocation cannot settle the original request');
  await click('Query mode failed');
  await click('Query uncertain delivery');
  await waitStatus('failed');
  assert.equal((await audit()).runs.length, 1);
  report.assertions.push('Matching failure is shown before a separate retry action');
  report.snapshots.push(await audit());
  await page.screenshot({ path: path.join(output, 'confirmed-failure.png'), fullPage: true });
  await click('Retry failed delivery');
  await page.waitForFunction(() => JSON.parse(document.querySelector('[data-testid="audit"]').textContent).runs.length === 2);
  assert.equal((await audit()).outbox.length, 1);
  assert.equal((await audit()).outbox[0].attempt, 2);
  assert.equal(await input.inputValue(), '保留下一条草稿');
  await click('Finish run 2');
  await waitStatus('completed');
  report.assertions.push('Explicit retry creates one run, reuses its ledger entry, and preserves the draft');
  report.snapshots.push(await audit());
  assert.deepEqual(errors, []);
  report.passed = true;
  console.log('PASS: outbox unknown/reconciliation/retry production browser gate');
} catch (error) {
  report.error = String(error.stack || error);
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
  process.exitCode = 1;
  console.error(report.error);
} finally {
  await context?.tracing.stop({ path: path.join(output, 'trace.zip') });
  await browser?.close();
  await new Promise(resolve => server.httpServer.close(resolve));
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
}
