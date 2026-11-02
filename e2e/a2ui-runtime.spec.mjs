import { test, expect } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const web = path.resolve(import.meta.dirname, '..');
const sdk = process.env.KSADK_TEST_SDK_DIR || path.resolve(web, '../ksadk-python');
const runtimePython = process.env.KSADK_TEST_RUNTIME_PYTHON || path.join(sdk, '.venv/bin/python');
const runtimeAppDir = process.env.KSADK_TEST_RUNTIME_APP_DIR || sdk;

async function startRuntime(project, kind, logFile, port = 0, overrides = {}) {
  const dockerImage = process.env.KSADK_TEST_RUNTIME_DOCKER_IMAGE;
  const containerName = `codex-a2ui-e2e-${randomUUID()}`;
  let publishedPort = port;
  if (dockerImage && !publishedPort) {
    const listener = createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    publishedPort = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
  }
  const environment = { ...process.env };
  for (const key of ['KSADK_AGENT_KERNEL', 'AGENT_KERNEL_ENABLED', 'KSADK_CHECKPOINT_BACKEND',
    'KSADK_CHECKPOINT_PATH', 'KSADK_CHECKPOINT_DSN', 'KSADK_DEPLOYMENT_MODE',
    'KSADK_LANGGRAPH_LOCAL_AUTO_CHECKPOINT', 'AGENT_INSTANCE_ID', 'AGENT_CONTROL_JWKS_URL']) delete environment[key];
  Object.assign(environment, {
    KSADK_SESSION_BACKEND: 'local', AGENT_KERNEL_AUTHORITY_MODE: 'local',
    KSADK_LANGGRAPH_AUTO_CHECKPOINT: '1',
    KSADK_TEST_A2UI_PROJECT: dockerImage ? '/a2ui-project' : project,
    KSADK_TEST_A2UI_WEB: dockerImage
      ? '/usr/local/lib/python3.12/site-packages/ksadk/server/static'
      : process.env.KSADK_TEST_A2UI_WEB || path.join(web, 'dist-ksadk'),
    KSADK_TEST_A2UI_AGENT: kind,
  }, overrides);
  const log = createWriteStream(logFile);
  delete environment.PYTHONPATH;
  const module = process.env.KSADK_TEST_RUNTIME_APP_DIR ? 'a2ui_runtime_app' : 'tests.e2e.a2ui_runtime_app';
  const localArgs = [
    '-m', 'uvicorn', `${module}:create_app`, '--factory', '--host', '127.0.0.1',
    '--port', String(port),
  ];
  if (dockerImage && !existsSync(path.join(runtimeAppDir, 'a2ui_runtime_app.py'))) {
    throw new Error('Docker E2E requires a standalone KSADK_TEST_RUNTIME_APP_DIR fixture');
  }
  mkdirSync(project, { recursive: true });
  const dockerArgs = ['run', '--rm', '--name', containerName,
    '-p', `127.0.0.1:${publishedPort}:8080`, '-v', `${project}:/a2ui-project`,
    '-v', `${runtimeAppDir}:/a2ui-fixture:ro`, '-w', '/a2ui-fixture'];
  for (const key of ['KSADK_SESSION_BACKEND', 'AGENT_KERNEL_AUTHORITY_MODE',
    'KSADK_LANGGRAPH_AUTO_CHECKPOINT',
    'KSADK_TEST_A2UI_PROJECT', 'KSADK_TEST_A2UI_WEB', 'KSADK_TEST_A2UI_AGENT',
    'KSADK_TEST_A2UI_MCP', 'KSADK_TEST_A2UI_SUBGRAPH',
    'KSADK_TEST_A2UI_PRESENTATION', 'KSADK_TEST_A2UI_BAD_CATALOG']) {
    if (environment[key] !== undefined) dockerArgs.push('-e', `${key}=${environment[key]}`);
  }
  dockerArgs.push(dockerImage || '', 'python', '-m', 'uvicorn', 'a2ui_runtime_app:create_app',
    '--factory', '--host', '0.0.0.0', '--port', '8080');
  const processHandle = spawn(dockerImage ? 'docker' : runtimePython, dockerImage ? dockerArgs : localArgs,
    { cwd: runtimeAppDir, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  const childClosed = new Promise(resolve => processHandle.once('close', resolve));
  processHandle.stdout.pipe(log, { end: false });
  processHandle.stderr.pipe(log, { end: false });
  async function stop() {
    if (dockerImage) {
      try { execFileSync('docker', ['stop', '--time', '3', containerName], { stdio: 'ignore', timeout: 8000 }); }
      catch {
        // --rm may already have removed a container that failed to start.
        try { execFileSync('docker', ['rm', '-f', containerName], { stdio: 'ignore', timeout: 8000 }); }
        catch { /* Nothing remains to clean up. */ }
      }
    }
    if (processHandle.exitCode === null && processHandle.signalCode === null && processHandle.pid) {
      const exited = new Promise(resolve => processHandle.once('exit', resolve));
      processHandle.kill('SIGTERM');
      const timer = setTimeout(() => processHandle.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    // Docker's attach pipes can remain open after its client has exited.
    // Release only this stopped runtime's streams so the test worker exits.
    const streamsClosed = [processHandle.stdout, processHandle.stderr, log].map(stream =>
      stream.closed ? Promise.resolve() : new Promise((resolve, reject) => {
        stream.once('close', resolve);
        stream.once('error', reject);
      }));
    processHandle.stdout.unpipe(log);
    processHandle.stderr.unpipe(log);
    processHandle.stdout.destroy();
    processHandle.stderr.destroy();
    if (!log.writableEnded) log.end();
    await Promise.all([childClosed, ...streamsClosed]);
    processHandle.unref();
    if (process.env.KSADK_TEST_LIFECYCLE_DIAGNOSTICS) {
      await new Promise(resolve => setImmediate(resolve));
      appendFileSync(process.env.KSADK_TEST_LIFECYCLE_DIAGNOSTICS, JSON.stringify({
        phase: 'runtime-stopped', containerName, pid: processHandle.pid,
        exitCode: processHandle.exitCode, signalCode: processHandle.signalCode,
        childHandlePresent: Boolean(processHandle._handle),
        childHandleReferenced: processHandle._handle?.hasRef?.(),
        stdoutDestroyed: processHandle.stdout.destroyed,
        stderrDestroyed: processHandle.stderr.destroyed, logClosed: log.closed,
        activeHandles: process._getActiveHandles().map(handle => ({
          type: handle.constructor.name, pid: handle.pid,
          exitCode: handle.exitCode, signalCode: handle.signalCode,
          referenced: handle.hasRef?.() ?? handle._handle?.hasRef?.(),
          fd: handle.fd, destroyed: handle.destroyed,
        })),
      }) + '\n');
    }
  }
  let output = '';
  let address;
  try {
    address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Runtime startup timeout; see ${logFile}`)), 20_000);
    processHandle.once('error', error => { clearTimeout(timer); reject(error); });
    processHandle.once('exit', code => {
      clearTimeout(timer); reject(new Error(`Runtime exited during startup (${code}); see ${logFile}`));
    });
    const onOutput = chunk => {
      output = (output + chunk.toString()).slice(-8192);
      const url = output.match(/Uvicorn running on (http:\/\/(?:127\.0\.0\.1|0\.0\.0\.0):\d+)/)?.[1];
      if (url) { clearTimeout(timer); resolve(dockerImage ? `http://127.0.0.1:${publishedPort}` : url); }
    };
    processHandle.stderr.on('data', onOutput);
    processHandle.stdout.on('data', onOutput);
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return {
    url: address + (process.env.KSADK_TEST_A2UI_ENTRY_PATH || ''),
    stop,
  };
}

function executions(project) {
  const file = path.join(project, 'execution.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
}

function checkpoints(project) {
  return JSON.parse(execFileSync(runtimePython, ['-c',
    'import json,sqlite3,sys; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True); print(json.dumps(c.execute("SELECT thread_id,checkpoint_ns,checkpoint_id FROM checkpoints ORDER BY checkpoint_id").fetchall()))',
    path.join(project, '.agentengine/ui/checkpoints.sqlite'),
  ], { encoding: 'utf8' }));
}

function verifyOriginalThread(before, after) {
  const threads = [...new Set(before.map(row => row[0]))];
  expect(threads).toHaveLength(1);
  expect([...new Set(after.map(row => row[0]))]).toEqual(threads);
  expect(after.length).toBeGreaterThan(before.length);
  for (const row of before) expect(after).toContainEqual(row);
}

function trackSubmissions(page) {
  const submissions = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/SubmitInteraction')) {
      submissions.push(request.postDataJSON());
    }
  });
  return submissions;
}

async function attachEvidence(info, project, before, submissions) {
  const after = checkpoints(project);
  expect(submissions.length).toBeGreaterThan(0);
  expect(submissions.every(row => row.SessionId === before[0][0])).toBe(true);
  await info.attach('native-resume-evidence', { contentType: 'application/json', body: JSON.stringify({
    before, after, executions: executions(project), submissions,
  }, null, 2) });
}

async function openAndAsk(page, url, question, attachment) {
  const bootstrap = page.waitForResponse(response => response.url().endsWith('/GetAgentUiBootstrap'));
  await page.goto(url);
  const data = await (await bootstrap).json();
  expect(data.Data.HostedChat.Transports[0].Capabilities.SessionEventReplay).toBe(true);
  await page.getByText('a2ui-e2e', { exact: true }).first().waitFor();
  if (attachment) {
    await page.getByRole('button', { name: '添加附件或选择执行模式' }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: /上传附件/ }).click();
    await (await chooser).setFiles(attachment);
    await expect(page.getByText(attachment.name, { exact: true })).toBeVisible();
  }
  await page.getByPlaceholder('发送消息…').fill(question);
  await page.getByPlaceholder('发送消息…').press('Enter');
  const form = page.getByTestId('interaction-a2ui-surface');
  await expect(form).toHaveCount(1, { timeout: process.env.KSADK_TEST_A2UI_MODEL_ENV ? 150_000 : 15_000 });
  await expect(form.getByRole('button', { name: 'Submit request', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('sdk-internal-context-must-not-be-chat');
  return form;
}

for (const [kind, question, value] of [
  ['resource', '帮我查一个没说明清楚的资源', 'resource-demo'],
  ['trip', '我想换个城市看看，先把需要的信息问清楚', 'Hangzhou'],
  ['ticket', '需要让支持同事跟进这个事情', 'Investigate timeout'],
]) {
  test(`${kind}: live card, correction, native resume and refresh without duplicates`, async ({ page }, info) => {
    if (process.env.KSADK_TEST_A2UI_MODEL_ENV) test.setTimeout(180_000);
    const project = info.outputPath('project');
    const runtime = await startRuntime(project, kind, info.outputPath('runtime.log'));
    const pageErrors = [];
    const submissions = trackSubmissions(page);
    page.on('pageerror', error => pageErrors.push(error.message));
    try {
      const form = await openAndAsk(page, runtime.url, question);
      const waitingCheckpoints = checkpoints(project);
      expect(executions(project).filter(row => row.phase === 'initialize')).toHaveLength(1);
      await form.locator('input').fill('x');
      await form.getByRole('button', { name: 'Submit request', exact: true }).click();
      await expect(page.getByTestId('interaction-tray-error')).toBeVisible();
      expect(executions(project).filter(row => row.phase === 'tool')).toHaveLength(0);
      await form.locator('input').fill(value);
      const timing = { submittedAt: Date.now() };
      await form.getByRole('button', { name: 'Submit request', exact: true }).dblclick();
      if (process.env.KSADK_TEST_A2UI_MCP === '1') {
        // Cold stdio initialization is business-tool time. Keep the original
        // five-second UI delivery assertion after that bounded tool result.
        await expect.poll(() => executions(project).filter(row => row.phase === 'tool').length,
          { timeout: 15_000 }).toBe(1);
        timing.businessToolObservedAt = Date.now();
      }
      await expect(page.getByText(`Completed: ${value}`, { exact: true })).toHaveCount(1);
      timing.completedVisibleAt = Date.now();
      await info.attach('interaction-latency', { contentType: 'application/json',
        body: JSON.stringify(timing) });
      await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
      expect(executions(project).filter(row => row.phase === 'initialize')).toHaveLength(1);
      expect(executions(project).filter(row => row.phase === 'tool')).toHaveLength(1);
      if (process.env.KSADK_TEST_A2UI_MCP === '1') {
        expect(executions(project).filter(row => row.phase === 'mcp')).toHaveLength(1);
      }
      verifyOriginalThread(waitingCheckpoints, checkpoints(project));
      await page.reload();
      await expect(page.getByText(`Completed: ${value}`, { exact: true })).toHaveCount(1);
      await expect(page.getByRole('button', { name: 'Submit request', exact: true })).toHaveCount(0);
      expect(executions(project).filter(row => row.phase === 'tool')).toHaveLength(1);
      expect(pageErrors).toEqual([]);
      await attachEvidence(info, project, waitingCheckpoints, submissions);
    } finally { await page.close(); await runtime.stop(); }
  });
}

test('pending input survives backend restart and resumes the original checkpoint', async ({ page }, info) => {
  const project = info.outputPath('project');
  let runtime = await startRuntime(project, 'resource', info.outputPath('runtime-first.log'));
  const submissions = trackSubmissions(page);
  try {
    await openAndAsk(page, runtime.url, '先问清楚资源，再执行查询');
    const waitingCheckpoints = checkpoints(project);
    const port = Number(new URL(runtime.url).port);
    await runtime.stop();
    runtime = await startRuntime(project, 'resource', info.outputPath('runtime-restart.log'), port);
    await page.reload();
    const form = page.getByTestId('interaction-a2ui-surface');
    await expect(form).toHaveCount(1);
    await form.locator('input').fill('after-restart');
    await form.getByRole('button', { name: 'Submit request', exact: true }).click();
    await expect(page.getByText('Completed: after-restart', { exact: true })).toHaveCount(1);
    expect(executions(project).filter(row => row.phase === 'initialize')).toHaveLength(1);
    expect(executions(project).filter(row => row.phase === 'tool')).toHaveLength(1);
    verifyOriginalThread(waitingCheckpoints, checkpoints(project));
    await attachEvidence(info, project, waitingCheckpoints, submissions);
  } finally { await page.close(); await runtime.stop(); }
});

test('same session continues for three turns after canonical submits, with acceptance feedback', async ({ page }, info) => {
  const project = info.outputPath('project');
  const runtime = await startRuntime(project, 'resource', info.outputPath('runtime.log'));
  const submissions = trackSubmissions(page);
  const starts = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/agui')) {
      starts.push(request.postDataJSON());
    }
  });
  try {
    for (let round = 1; round <= 3; round++) {
      const form = round === 1
        ? await openAndAsk(page, runtime.url, '先确认资源，再查询')
        : page.getByTestId('interaction-a2ui-surface');
      if (round > 1) {
        await page.getByPlaceholder('发送消息…').fill(`继续查询第 ${round} 个资源`);
        await page.getByPlaceholder('发送消息…').press('Enter');
        await expect(form).toHaveCount(1);
      }
      const value = `resource-${round}`;
      await form.locator('input').fill(value);
      await form.getByRole('button', { name: 'Submit request', exact: true }).click();
      if (process.env.KSADK_TEST_A2UI_TOOL_DELAY) {
        await expect(page.getByTestId('interaction-submit-progress')).toContainText('已提交，等待 Agent 处理');
        await expect(form.getByRole('button', { name: 'Submit request', exact: true })).toBeDisabled();
      }
      await expect(page.getByText(`Completed: ${value}`, { exact: true })).toHaveCount(1);
      await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
      expect(executions(project).filter(row => row.phase === 'initialize')).toHaveLength(round);
      expect(executions(project).filter(row => row.phase === 'tool')).toHaveLength(round);
      await expect(page.locator('body')).not.toContainText('pending interrupt(s) not addressed by resume');
      await expect(page.locator('body')).not.toContainText('sdk-internal-context-must-not-be-chat');
    }
    expect(submissions).toHaveLength(3);
    expect(starts).toHaveLength(3);
    expect(new Set(submissions.map(row => row.SessionId)).size).toBe(1);
    expect(new Set(starts.map(row => row.threadId))).toEqual(new Set(submissions.map(row => row.SessionId)));
    await page.reload();
    await expect(page.getByText('Completed: resource-3', { exact: true })).toHaveCount(1);
    await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
    expect(executions(project).filter(row => row.phase === 'tool')).toHaveLength(3);
    expect(submissions).toHaveLength(3);
    await info.attach('same-session-evidence', { contentType: 'application/json', body: JSON.stringify({
      starts: starts.map(row => ({ threadId: row.threadId, runId: row.runId })), submissions,
      executions: executions(project), checkpoints: checkpoints(project),
    }, null, 2) });
  } finally { await page.close(); await runtime.stop(); }
});

test('attachment foreground fallback uses the same durable input and original checkpoint', async ({ page }, info) => {
  const project = info.outputPath('project');
  const runtime = await startRuntime(project, 'resource', info.outputPath('runtime.log'));
  const starts = [];
  const submissions = trackSubmissions(page);
  page.on('request', request => {
    if (request.method() === 'POST' && /\/(RunAgent|agui)$/.test(new URL(request.url()).pathname)) {
      starts.push(new URL(request.url()).pathname);
    }
  });
  try {
    const form = await openAndAsk(page, runtime.url, '请参考这个附件，先确认资源再查询', {
      name: 'resource-notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic resource notes'),
    });
    const waiting = checkpoints(project);
    await form.locator('input').fill('attached-resource');
    await form.getByRole('button', { name: 'Submit request', exact: true }).click();
    await expect(page.getByText('Completed: attached-resource', { exact: true })).toHaveCount(1);
    await attachEvidence(info, project, waiting, submissions);
    expect(starts).toEqual(['/agentengine/api/v1/RunAgent']);
    expect(executions(project).filter(row => row.phase === 'initialize')).toHaveLength(1);
    expect(executions(project).filter(row => row.phase === 'tool')).toHaveLength(1);
    verifyOriginalThread(waiting, checkpoints(project));
    await page.reload();
    await expect(page.getByText('Completed: attached-resource', { exact: true })).toHaveCount(1);
  } finally { await page.close(); await runtime.stop(); }
});

for (const mode of ['schema', 'invalid-catalog']) {
  test(`${mode}: default form, correction, pending refresh, native resume and next turn`, async ({ page }, info) => {
    const project = info.outputPath('project');
    const options = mode === 'schema' ? { KSADK_TEST_A2UI_PRESENTATION: 'schema' }
      : { KSADK_TEST_A2UI_BAD_CATALOG: '1' };
    const runtime = await startRuntime(project, 'resource', info.outputPath('runtime.log'), 0, options);
    const submissions = trackSubmissions(page);
    try {
      await page.goto(runtime.url);
      await page.getByText('a2ui-e2e', { exact: true }).first().waitFor();
      await page.getByPlaceholder('发送消息…').fill('先填写资源，再查询');
      await page.getByPlaceholder('发送消息…').press('Enter');
      const input = page.getByTestId('interaction-tray').getByTestId('interaction-field-resource');
      await expect(input).toBeVisible();
      await expect(page.getByTestId('interaction-a2ui-surface')).toHaveCount(0);
      const before = checkpoints(project);
      await input.fill('x');
      await page.getByTestId('interaction-submit').click();
      await expect(page.getByTestId('interaction-schema-form').getByRole('alert')).toBeVisible();
      expect(submissions).toHaveLength(0);
      await page.reload();
      await expect(input).toHaveCount(1);
      await input.fill('schema-resource');
      await page.getByTestId('interaction-submit').click();
      await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
      await expect(page.getByText('Completed: schema-resource', { exact: true })).toHaveCount(1);
      expect(executions(project).filter(row => row.phase === 'initialize')).toHaveLength(1);
      expect(executions(project).filter(row => row.phase === 'tool')).toHaveLength(1);
      verifyOriginalThread(before, checkpoints(project));
      await page.getByPlaceholder('发送消息…').fill('继续填写下一个资源');
      await page.getByPlaceholder('发送消息…').press('Enter');
      await expect(input).toHaveCount(1);
      await input.fill('second-resource');
      await page.getByTestId('interaction-submit').click();
      await expect(page.getByText('Completed: second-resource', { exact: true })).toHaveCount(1);
      await page.reload();
      await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
      await expect(page.getByText('Completed: second-resource', { exact: true })).toHaveCount(1);
      expect(submissions).toHaveLength(2);
      expect(executions(project).filter(row => row.phase === 'tool')).toHaveLength(2);
      await expect(page.locator('body')).not.toContainText('sdk-internal-context-must-not-be-chat');
    } finally { await page.close(); await runtime.stop(); }
  });
}

for (const mode of ['schema', 'a2ui']) {
  test(`${mode}: cancelling pending input never executes a business tool or revives on refresh`, async ({ page }, info) => {
    const project = info.outputPath('project');
    const runtime = await startRuntime(project, 'resource', info.outputPath('runtime.log'), 0,
      mode === 'schema' ? { KSADK_TEST_A2UI_PRESENTATION: 'schema' } : {});
    try {
      await page.goto(runtime.url);
      await page.getByText('a2ui-e2e', { exact: true }).first().waitFor();
      await page.getByPlaceholder('发送消息…').fill('这个查询需要我填写资源');
      await page.getByPlaceholder('发送消息…').press('Enter');
      await expect(page.getByTestId('interaction-tray')).toBeVisible();
      await page.getByTestId('interaction-cancel').click();
      await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
      expect(executions(project).filter(row => row.phase === 'tool')).toHaveLength(0);
      await page.reload();
      await expect(page.getByText('a2ui-e2e', { exact: true }).first()).toBeVisible();
      await expect(page.getByTestId('interaction-tray')).toHaveCount(0);
      expect(executions(project).filter(row => row.phase === 'tool')).toHaveLength(0);
    } finally { await page.close(); await runtime.stop(); }
  });
}
