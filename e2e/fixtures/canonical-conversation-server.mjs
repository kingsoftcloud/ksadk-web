import { createServer } from 'node:http';

const HOST = '127.0.0.1';
const PORT = 4182;
const AGENT_ID = 'canonical-fixture-agent';
const SESSION_ID = 'canonical-fixture-session';
const BUILD_ID = 'canonical-fixture-build';
const APPROVAL_ID = 'approval-shell-1';
const APPROVAL_REVISION = 7;
const CATALOG_ID = 'https://a2ui.org/specification/v0_9/basic_catalog.json';

const delay = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

function createState() {
  return {
    config: {
      attachmentInputs: true,
    },
    inputs: [],
    uploads: [],
    streamPosts: 0,
    legacyRunAgentCalls: 0,
    reconnects: [],
    submits: [],
    winner: null,
    continueFirstRun: null,
  };
}

let state = createState();

function envelope(data) {
  return { Code: 0, Message: 'Success', Data: data };
}

function sendJson(response, value, status = 200) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function receipt(status, commandId, error = null) {
  return envelope({
    schema_version: 1,
    command_id: commandId,
    status,
    message_id: null,
    run_id: status === 'accepted' || status === 'duplicate' ? 'canonical-run-1' : null,
    accepted_seq: status === 'accepted' ? 8 : null,
    error,
  });
}

async function readJson(request) {
  const body = await readBody(request);
  if (body.length === 0) return {};
  return JSON.parse(body.toString('utf8'));
}

async function handleUpload(request, response) {
  const contentType = request.headers['content-type'] || '';
  const body = await readBody(request);
  const text = body.toString('latin1');
  const filename = /name="file"; filename="([^"]+)"/i.exec(text)?.[1] || 'attachment.bin';
  const mediaType = /name="file"; filename="[^"]+"\r?\nContent-Type: ([^\r\n]+)/i.exec(text)?.[1]
    || 'application/octet-stream';
  const agentId = /name="AgentId"\r?\n\r?\n([^\r\n]+)/i.exec(text)?.[1] || '';
  const uploadNumber = state.uploads.length + 1;
  const attachmentRef = `attachment://canonical/${uploadNumber}/${encodeURIComponent(filename)}`;
  state.uploads.push({
    filename,
    mediaType,
    agentId,
    contentType,
    bodyBytes: body.length,
    attachmentRef,
  });
  sendJson(response, envelope({
    FileData: {
      fileUri: attachmentRef,
      displayName: filename,
      mimeType: mediaType,
    },
  }));
}

function bootstrap() {
  return {
    Agent: { AgentId: AGENT_ID, Name: 'Canonical Fixture', Framework: 'codex' },
    ApiFormats: ['responses'],
    Capabilities: {
      Attachments: true,
      WorkspaceFiles: false,
      Approval: true,
      Thinking: true,
      StopRun: true,
      ResumeRun: false,
      interaction_v1: { enabled: true },
      RunLifecycle: { Enabled: false },
    },
    HostedChat: {
      PreferredTransport: 'responses',
      Transports: [{
        Protocol: 'responses',
        Runtime: 'codex',
        Endpoint: '/v1/responses',
        Version: 'v1',
        Capabilities: { A2UI: true, Interrupt: true, Cancel: true },
      }],
    },
    Model: { id: 'fixture-model', display_name: 'Fixture Model' },
  };
}

function surface() {
  return {
    apiVersion: 'conversation.ksadk.io/v1',
    kind: 'ConversationSurface',
    surfaceId: 'canonical-hosted-ui',
    sessionId: SESSION_ID,
    providerRef: 'agent.provider/v1:fixture-codex',
    inputs: [
      { name: 'text', mode: 'native' },
      { name: 'model.select', mode: 'native' },
      { name: 'approval', mode: 'native' },
      ...(state.config.attachmentInputs ? [
        { name: 'attachment.file', mode: 'native' },
        { name: 'attachment.image', mode: 'native' },
      ] : []),
    ],
    outputs: [
      { name: 'text', mode: 'native' },
      { name: 'reasoning', mode: 'native' },
      { name: 'tool.read_config', mode: 'native' },
      { name: 'approval', mode: 'native' },
      { name: 'a2ui', mode: 'native' },
    ],
  };
}

function item({
  runId,
  itemId,
  sourceEventId,
  kind,
  schema,
  payload = {},
  operation = 'append',
  lifecycle = 'streaming',
}) {
  return {
    apiVersion: 'conversation.ksadk.io/v1',
    kindVersion: 1,
    itemId,
    sourceEventIds: [sourceEventId],
    sessionId: SESSION_ID,
    runId,
    kind,
    operation,
    lifecycle,
    visibility: 'public',
    payloadSchemaRef: schema,
    payload,
    nativeRef: { fixture: true },
  };
}

function writeFrame(response, cursor, conversationItem) {
  response.write(`id: ${cursor}\ndata: ${JSON.stringify({ conversationItem })}\n\n`);
}

function beginSse(response) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  response.flushHeaders();
}

function a2uiOperations() {
  return [
    {
      version: 'v0.9',
      createSurface: { surfaceId: 'canonical-status', catalogId: CATALOG_ID },
    },
    {
      version: 'v0.9',
      updateComponents: {
        surfaceId: 'canonical-status',
        components: [
          { id: 'root', component: 'Column', children: ['canonical-status-title'] },
          {
            id: 'canonical-status-title',
            component: 'Text',
            variant: 'h3',
            text: 'Canonical A2UI 卡片',
          },
        ],
      },
    },
  ];
}

function firstToolStreaming() {
  return item({
    runId: 'canonical-run-1',
    itemId: 'tool-config',
    sourceEventId: 'event-tool-start',
    kind: 'tool_call',
    schema: 'conversation.item.tool-call/v1',
    payload: { callId: 'call-config', tool: 'read_config', args: { path: 'agent.yaml' } },
  });
}

async function streamFirstTurn(response) {
  beginSse(response);
  writeFrame(response, 1, item({
    runId: 'canonical-run-1',
    itemId: 'reasoning-main',
    sourceEventId: 'event-reasoning-1',
    kind: 'reasoning',
    schema: 'conversation.item.reasoning/v1',
    payload: { text: '先检查' },
  }));
  await delay(35);
  writeFrame(response, 2, item({
    runId: 'canonical-run-1',
    itemId: 'reasoning-main',
    sourceEventId: 'event-reasoning-2',
    kind: 'reasoning',
    schema: 'conversation.item.reasoning/v1',
    payload: { text: '环境。' },
  }));
  await delay(35);
  writeFrame(response, 3, firstToolStreaming());
  await delay(35);
  // A clean early EOF is the deterministic disconnect. The client has a run
  // identity and cursor, so it must continue through the replay endpoint.
  response.end();
}

async function streamFirstReconnect(response, requestUrl, request) {
  const after = Number(requestUrl.searchParams.get('after') || '0');
  state.reconnects.push({
    after,
    lastEventId: request.headers['last-event-id'] || null,
  });
  beginSse(response);
  // Deliberately replay the boundary source. Identity reduction must prevent
  // a duplicate tool card even if the transport repeats the last event.
  writeFrame(response, 3, firstToolStreaming());
  writeFrame(response, 4, item({
    runId: 'canonical-run-1',
    itemId: 'tool-config',
    sourceEventId: 'event-tool-completed',
    kind: 'tool_call',
    schema: 'conversation.item.tool-call/v1',
    payload: {
      callId: 'call-config',
      tool: 'read_config',
      args: { path: 'agent.yaml' },
      output: { ok: true, model: 'fixture-model' },
    },
    operation: 'completed',
    lifecycle: 'completed',
  }));
  writeFrame(response, 5, item({
    runId: 'canonical-run-1',
    itemId: 'approval-shell',
    sourceEventId: 'event-approval-requested',
    kind: 'approval',
    schema: 'conversation.item.approval/v1',
    payload: {
      interactionId: APPROVAL_ID,
      revision: APPROVAL_REVISION,
      kind: 'shell',
      title: '执行安全检查',
      prompt: '允许执行只读环境检查？',
      detail: { command: 'env --version' },
      createdAt: '2026-08-28T00:00:00Z',
    },
    lifecycle: 'pending',
  }));
  writeFrame(response, 6, item({
    runId: 'canonical-run-1',
    itemId: 'a2ui-status',
    sourceEventId: 'event-a2ui',
    kind: 'a2ui',
    schema: 'conversation.item.a2ui/v1',
    payload: { data: a2uiOperations() },
    operation: 'completed',
    lifecycle: 'completed',
  }));
  writeFrame(response, 7, item({
    runId: 'canonical-run-1',
    itemId: 'future-game-card',
    sourceEventId: 'event-future-kind',
    kind: 'vendor_game_card',
    schema: 'vendor.game-card/v9',
    payload: { html: '<script>never execute</script>' },
    operation: 'completed',
    lifecycle: 'completed',
  }));

  await new Promise((resolve) => {
    const finish = () => {
      writeFrame(response, 8, item({
        runId: 'canonical-run-1',
        itemId: 'approval-shell',
        sourceEventId: 'event-approval-resolved',
        kind: 'approval',
        schema: 'conversation.item.approval/v1',
        payload: {
          interactionId: APPROVAL_ID,
          revision: APPROVAL_REVISION,
          kind: 'shell',
          title: '执行安全检查',
          prompt: '允许执行只读环境检查？',
          detail: { command: 'env --version' },
          outcome: 'approved',
          actor: 'fixture-user',
          resolvedAt: '2026-08-28T00:00:01Z',
        },
        operation: 'completed',
        lifecycle: 'completed',
      }));
      writeFrame(response, 9, item({
        runId: 'canonical-run-1',
        itemId: 'assistant-answer-1',
        sourceEventId: 'event-answer-1a',
        kind: 'assistant_text',
        schema: 'conversation.item.assistant_text/v1',
        payload: { text: '第一轮' },
      }));
      writeFrame(response, 10, item({
        runId: 'canonical-run-1',
        itemId: 'assistant-answer-1',
        sourceEventId: 'event-answer-1b',
        kind: 'assistant_text',
        schema: 'conversation.item.assistant_text/v1',
        payload: { text: '完成。' },
        lifecycle: 'completed',
      }));
      writeFrame(response, 11, item({
        runId: 'canonical-run-1',
        itemId: 'run-terminal-1',
        sourceEventId: 'event-terminal-1',
        kind: 'progress',
        schema: 'conversation.item.progress/v1',
        payload: { status: 'completed' },
        operation: 'completed',
        lifecycle: 'completed',
      }));
      response.end();
      state.continueFirstRun = null;
      resolve();
    };
    state.continueFirstRun = finish;
    response.once('close', () => {
      if (!response.writableEnded) {
        state.continueFirstRun = null;
        resolve();
      }
    });
  });
}

async function streamSecondTurn(response) {
  beginSse(response);
  writeFrame(response, 1, item({
    runId: 'canonical-run-2',
    itemId: 'assistant-answer-2',
    sourceEventId: 'event-answer-2a',
    kind: 'assistant_text',
    schema: 'conversation.item.assistant_text/v1',
    payload: { text: '第二轮' },
  }));
  await delay(45);
  writeFrame(response, 2, item({
    runId: 'canonical-run-2',
    itemId: 'assistant-answer-2',
    sourceEventId: 'event-answer-2b',
    kind: 'assistant_text',
    schema: 'conversation.item.assistant_text/v1',
    payload: { text: '也正常。' },
    lifecycle: 'completed',
  }));
  await delay(25);
  writeFrame(response, 3, item({
    runId: 'canonical-run-2',
    itemId: 'run-terminal-2',
    sourceEventId: 'event-terminal-2',
    kind: 'progress',
    schema: 'conversation.item.progress/v1',
    payload: { status: 'completed' },
    operation: 'completed',
    lifecycle: 'completed',
  }));
  response.end();
}

async function handleAgentApi(request, response, requestUrl) {
  const action = requestUrl.pathname.split('/').pop();
  if (action === 'UploadFile' && request.method === 'POST') {
    await handleUpload(request, response);
    return;
  }
  const body = request.method === 'POST' ? await readJson(request) : {};

  if (action === 'SubmitInteraction') {
    state.submits.push(body);
    const commandId = `fixture-command-${state.submits.length}`;
    if (body.InteractionId !== APPROVAL_ID || body.ExpectedRevision !== APPROVAL_REVISION) {
      sendJson(response, receipt('rejected', commandId, {
        code: 'interaction_revision_conflict',
        message: 'The durable interaction revision does not match.',
        retryable: false,
      }));
      return;
    }
    if (state.winner) {
      if (state.winner.idempotencyKey === body.IdempotencyKey) {
        sendJson(response, receipt('duplicate', commandId));
      } else {
        sendJson(response, receipt('rejected', commandId, {
          code: 'interaction_already_resolved',
          message: 'first-wins: another submission already resolved this interaction',
          retryable: false,
        }));
      }
      return;
    }
    state.winner = {
      action: body.Action,
      idempotencyKey: body.IdempotencyKey,
      revision: body.ExpectedRevision,
    };
    sendJson(response, receipt('accepted', commandId));
    setImmediate(() => state.continueFirstRun?.());
    return;
  }

  if (action === 'RunAgent') {
    state.legacyRunAgentCalls += 1;
  }
  const payloads = {
    GetAgentUiBootstrap: bootstrap(),
    ListSessions: {
      Sessions: [{
        SessionId: SESSION_ID,
        AgentId: AGENT_ID,
        Title: 'Canonical fixture session',
        UpdatedAt: '2026-08-28T00:00:00Z',
      }],
      Total: 1,
      Page: 1,
      PageSize: 30,
    },
    ListAgentModels: {
      Models: [
        { id: 'fixture-model', display_name: 'Fixture Model' },
        { id: 'fixture-model-alt', display_name: 'Fixture Model Alt' },
      ],
      Current: 'fixture-model',
      Source: 'fixture',
    },
    GetSession: { Session: { SessionId: SESSION_ID, AgentId: AGENT_ID, ActiveRunStatus: '' } },
    ListSessionMessages: { Messages: [], LatestSeqId: 0, HasMore: false, NextCursor: null },
    ListSessionEvents: { Events: [], Total: 0 },
    ListSessionCheckpoints: { Checkpoints: [] },
    ListToolReceipts: { ToolReceipts: [] },
    GetResponseFeedback: null,
  };
  sendJson(response, envelope(payloads[action] ?? {}));
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || '/', `http://${HOST}:${PORT}`);
    if (requestUrl.pathname === '/__fixture/health') {
      sendJson(response, { ok: true });
      return;
    }
    if (requestUrl.pathname === '/__fixture/reset' && request.method === 'POST') {
      state.continueFirstRun?.();
      state = createState();
      sendJson(response, { ok: true });
      return;
    }
    if (requestUrl.pathname === '/__fixture/config' && request.method === 'POST') {
      const body = await readJson(request);
      state.config = {
        ...state.config,
        ...(typeof body.attachmentInputs === 'boolean'
          ? { attachmentInputs: body.attachmentInputs }
          : {}),
      };
      sendJson(response, { ok: true, config: state.config });
      return;
    }
    if (requestUrl.pathname === '/__fixture/state') {
      sendJson(response, {
        config: state.config,
        inputs: state.inputs,
        uploads: state.uploads,
        streamPosts: state.streamPosts,
        legacyRunAgentCalls: state.legacyRunAgentCalls,
        reconnects: state.reconnects,
        submits: state.submits,
        winner: state.winner,
      });
      return;
    }
    if (requestUrl.pathname.startsWith('/agentengine/api/v1/')) {
      await handleAgentApi(request, response, requestUrl);
      return;
    }
    if (requestUrl.pathname === `/api/v1/agents/${AGENT_ID}/conversation-surface`) {
      if (requestUrl.searchParams.get('sessionId') !== SESSION_ID) {
        sendJson(response, { error: 'session mismatch' }, 404);
        return;
      }
      sendJson(response, { buildId: BUILD_ID, surface: surface() });
      return;
    }
    if (requestUrl.pathname === `/api/v1/builds/${BUILD_ID}/conversation:stream`
      && request.method === 'POST') {
      const body = await readJson(request);
      state.inputs.push(body.input);
      state.streamPosts += 1;
      if (state.streamPosts === 1) {
        await streamFirstTurn(response);
      } else {
        await streamSecondTurn(response);
      }
      return;
    }
    if (requestUrl.pathname === '/api/v1/runs/canonical-run-1/events') {
      await streamFirstReconnect(response, requestUrl, request);
      return;
    }
    sendJson(response, { error: `unhandled fixture route: ${requestUrl.pathname}` }, 404);
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, { error: error instanceof Error ? error.message : String(error) }, 500);
    } else if (!response.writableEnded) {
      response.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`canonical conversation fixture listening on http://${HOST}:${PORT}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
