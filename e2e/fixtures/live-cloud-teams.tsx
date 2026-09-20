import React from 'react';
import { createRoot } from 'react-dom/client';
import { CloudTeamWorkspace } from '../../src/public/team-components.js';
import { HttpCloudTeamsProductClient, HttpCloudWorkspaceClient } from '../../src/public/teams.js';
import '../../src/components/teams/teams.css';

/** Real Server replies only. Fault controls discard/delay bytes; they never invent successful DTOs. */
const state = { dropReceipt: false, skipEvents: 0, snapshots: 0, sends: 0, lookups: 0, pages: 0,
  dropMaterialFinalize: false, materialCreates: [] as string[],
  holdMaterial: false, releaseMaterial: undefined as (() => void) | undefined,
  holdSend: false, releaseSend: undefined as (() => void) | undefined,
  holdPage: false, releasePage: undefined as (() => void) | undefined };
const marker = { 'X-Teams-Live-Fixture': 'local-pg-only' };
const metadata = await (await fetch('/__fixture__/metadata')).json();
const effectsMode = new URLSearchParams(location.search).has('effects');
if (effectsMode) Object.assign(metadata, metadata.effects);
const scope = { ...metadata.scope, origin: location.origin };
Object.assign(window, { liveTeams: { state, metadata } });
async function actualFetch(url: string, init: RequestInit = {}) {
  const path = new URL(url).pathname;
  if (path.endsWith('/workspace')) state.snapshots++;
  if (path.endsWith('/operations/lookup')) state.lookups++;
  if (init.method === 'POST' && (path.endsWith('/messages') || path.endsWith('/reconcile'))) state.sends++;
  if (init.method === 'POST' && path.endsWith('/materials')) state.materialCreates.push(JSON.parse(init.body as string).idempotencyKey);
  const isPage = /\/team-runs\/[^/]+\/(messages|tasks|artifacts|interactions)$/.test(path);
  if (isPage) state.pages++;
  const response = await fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), ...marker } });
  if (init.method === 'PUT' && path.includes('/materials/') && state.holdMaterial) await new Promise<void>(resolve => { state.releaseMaterial = resolve; });
  if (init.method === 'POST' && path.includes('/materials/') && path.endsWith('/finalize') && response.ok && state.dropMaterialFinalize) {
    state.dropMaterialFinalize = false; await response.arrayBuffer(); throw new TypeError('Test fault: finalized material response lost');
  }
  if (isPage && state.holdPage) await new Promise<void>(resolve => { state.releasePage = resolve; });
  if (init.method === 'POST' && (path.endsWith('/messages') || path.endsWith('/reconcile')) && response.ok) {
    if (state.holdSend) await new Promise<void>(resolve => { state.releaseSend = resolve; });
    if (state.dropReceipt) { state.dropReceipt = false; await response.arrayBuffer(); throw new TypeError('Test fault: committed HTTP response lost'); }
  }
  if (path.endsWith('/events') && response.ok && response.body) {
    const reader = response.body.getReader(); const decoder = new TextDecoder(); const encoder = new TextEncoder();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { void (async () => {
        let buffered = '';
        try { while (!cancelled) {
          const part = await reader.read(); if (part.done) { if (!cancelled) controller.close(); return; }
          buffered += decoder.decode(part.value, { stream: true }); let end: number;
          while ((end = buffered.indexOf('\n\n')) >= 0) {
            const frame = buffered.slice(0, end + 2); buffered = buffered.slice(end + 2);
            if (frame.includes('event: workspace.delta') && state.skipEvents > 0) state.skipEvents--;
            else if (!cancelled) controller.enqueue(encoder.encode(frame));
          }
        } } catch (cause) { if (!cancelled) controller.error(cause); }
      })(); },
      async cancel() { cancelled = true; await reader.cancel(); },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  }
  return response;
}
const product = new HttpCloudTeamsProductClient({ origin: location.origin, fetch: actualFetch });
const transport = new HttpCloudWorkspaceClient({ origin: location.origin, fetch: actualFetch });
createRoot(document.getElementById('root')!).render(<React.StrictMode><header style={{ padding: '10px 20px', background: '#fff8ec' }}>本地集成验证 · 真实 PostgreSQL / HTTP / 领域事务 · 执行端受控，未调用云上模型</header><main style={{ height: 'calc(100dvh - 46px)' }}><CloudTeamWorkspace scope={scope} product={product} transport={transport} canWrite={!new URLSearchParams(location.search).has('readonly')} effectsEnabled={effectsMode} initialRunId={metadata.runs[0]} /></main></React.StrictMode>);
