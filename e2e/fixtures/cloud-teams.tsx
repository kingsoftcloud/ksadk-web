import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CloudTeamWorkspace } from '../../src/public/team-components.js';
import { HttpCloudTeamsProductClient, HttpCloudWorkspaceClient, digestTeamsJson } from '../../src/public/teams.js';
import { teamSnapshot } from './teams-data.js';
import { cloudTeamScope, cloudTeamSnapshot } from './cloud-teams-data.js';
import '../../src/components/teams/teams.css';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const counters = { lookup: 0, send: 0, details: 0, page: 0, snapshots: 0 };
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
let uncertain = false; let watermark = 10;
let sendGate: Promise<void> | undefined; let releaseSend: (() => void) | undefined;
let pageGate: Promise<void> | undefined; let releasePage: (() => void) | undefined;
const controls = {
  counters, setUncertain: (value: boolean) => { uncertain = value; },
  disconnect: () => { streams.forEach(stream => stream.close()); streams.clear(); },
  holdSend: () => { sendGate = new Promise(resolve => { releaseSend = resolve; }); },
  releaseSend: () => { releaseSend?.(); sendGate = undefined; },
  holdPage: () => { pageGate = new Promise(resolve => { releasePage = resolve; }); },
  releasePage: () => { releasePage?.(); pageGate = undefined; },
  emitGap: () => {
    watermark += 3; const snapshot = cloudTeamSnapshot('run-a', watermark);
    const event = { apiVersion: snapshot.apiVersion, viewVersion: snapshot.viewVersion, scope: snapshot.scope, eventId: `gap-${watermark}`, groupSeq: watermark, type: 'workspace.delta', createdAt: '2026-09-18T08:01:00.000Z', changes: [] };
    const bytes = new TextEncoder().encode(`event: workspace.delta\ndata: ${JSON.stringify(event)}\n\n`);
    streams.forEach(stream => stream.enqueue(bytes));
  },
};
(window as unknown as { fixtureCloud: typeof controls }).fixtureCloud = controls;
async function fixtureFetch(url: string, init: RequestInit = {}) {
  const request = new URL(url); const scope = cloudTeamScope(location.origin);
  if (request.pathname.endsWith('/events')) {
    let active: ReadableStreamDefaultController<Uint8Array>;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { active = controller; streams.add(controller); init.signal?.addEventListener('abort', () => { if (streams.delete(controller)) controller.close(); }, { once: true }); }, cancel() { streams.delete(active); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (request.pathname.endsWith('/workspace')) { counters.snapshots++; const snapshot = cloudTeamSnapshot(request.searchParams.get('teamRunId') || 'run-a', watermark); return json({ ...snapshot, snapshotId: `${snapshot.snapshotId}-${watermark}` }); }
  if (request.pathname.endsWith('/operations/lookup')) {
    counters.lookup++; const body = JSON.parse(String(init.body)); const stored = localStorage.getItem(`cloud-fixture:${body.idempotencyKey}`);
    return json(stored ? JSON.parse(stored) : { status: 'missing' });
  }
  if (init.method === 'POST') {
    counters.send++; const { idempotencyKey, ...payload } = JSON.parse(String(init.body)); const operation = request.pathname.replace('/api/v1/', '');
    const receipt = { status: 'confirmed', operationId: 'op-fixture', payloadDigest: await digestTeamsJson({ operation, payload }), receipt: { status: 'accepted', groupId: scope.groupId, teamRunId: payload.teamRunId || 'run-a', watermark: 10 } };
    localStorage.setItem(`cloud-fixture:${idempotencyKey}`, JSON.stringify(receipt));
    if (sendGate) await sendGate;
    if (uncertain) throw new TypeError('controlled lost response');
    return json(receipt);
  }
  if (request.pathname.includes('/interactions/question-a')) { counters.details++; return json({ ...cloudTeamSnapshot().pendingInteractions[0], message: '选择本次调研的范围后继续。', requestSchema: { type: 'object', properties: { scope: { type: 'string', title: '调研范围', enum: ['端云协同', '任务派发'] } }, required: ['scope'] } }); }
  if (/\/tasks\/[^/]+$/.test(request.pathname)) { counters.details++; return json({ ...teamSnapshot().tasks[1], taskId: request.pathname.split('/').at(-1), teamRunId: request.searchParams.get('teamRunId'), title: '核对接口契约' }); }
  const match = /\/team-runs\/([^/]+)\/(messages|tasks|artifacts|interactions)$/.exec(request.pathname);
  if (match || request.pathname.endsWith('/team-runs')) {
    counters.page++; const runId = match?.[1] || null; const collection = match ? ({ messages: 'recentMessages', tasks: 'taskSummaries', artifacts: 'artifactSummaries', interactions: 'pendingInteractions' })[match[2]] : 'runSummaries'; const snap = cloudTeamSnapshot(runId || 'run-a');
    const items = collection === 'recentMessages' ? [{ ...snap.recentMessages[0], messageId: `${runId}-older`, createdSeq: 2, parts: [{ kind: 'text', text: '这是一条按需加载的更早消息。' }] }] : [];
    if (pageGate) await pageGate;
    return json({ apiVersion: snap.apiVersion, viewVersion: snap.viewVersion, scope: snap.scope, snapshotId: request.searchParams.get('snapshotId'), watermark: Number(request.searchParams.get('watermark')), teamRunId: runId, collection, cursor: request.searchParams.get('cursor'), items, nextCursor: null });
  }
  throw new Error(`Unimplemented controlled test endpoint: ${request.pathname}`);
}
const product = new HttpCloudTeamsProductClient({ origin: location.origin, fetch: fixtureFetch });
const transport = new HttpCloudWorkspaceClient({ origin: location.origin, fetch: fixtureFetch });
function Fixture() { const [writable, setWritable] = useState(true); return <><header style={{ padding: '8px 20px', background: '#fff8ec' }}>受控 UI 测试数据 · 不代表真实 Server 已联调 <button onClick={() => setWritable(value => !value)}>切换只读</button></header><main style={{ height: 'calc(100dvh - 42px)' }}><CloudTeamWorkspace scope={cloudTeamScope(location.origin)} product={product} transport={transport} canWrite={writable} /></main></>; }
createRoot(document.getElementById('root')!).render(<React.StrictMode><Fixture /></React.StrictMode>);
