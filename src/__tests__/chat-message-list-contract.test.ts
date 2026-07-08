import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

describe('chat message list contracts', () => {
  it('only auto-scrolls when the user is already near the bottom', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/chat/ConnectedMessageList.tsx'), 'utf8');

    expect(source).toContain('stickToBottomRef');
    expect(source).toContain('userDetachedFromBottomRef');
    expect(source).toContain('scroller.scrollTop < 200');
    expect(source).toContain('isStreamingRef.current && scrolledUp');
    expect(source).toContain('distanceFromBottom <= 12');
    expect(source).toContain('distanceFromBottom < 96');
    expect(source).not.toMatch(/scrollRef\.current\.scrollTop\s*=\s*scrollRef\.current\.scrollHeight/);
  });

  it('bypasses the stickiness gate to pin to the bottom on initial session load', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/chat/ConnectedMessageList.tsx'), 'utf8');

    // Reset hook: switching sessions re-arms the initial-scroll intent and
    // restores stickiness defaults so the gate does not start in a "detached"
    // state carried over from the previous session.
    expect(source).toContain('needsInitialScrollRef');
    expect(source).toMatch(/needsInitialScrollRef\.current\s*=\s*true/);
    expect(source).toMatch(/\},\s*\[currentSessionId\]\);/);

    // Force branch bypasses the gate and pins to bottom. Virtualization
    // settles scrollHeight across frames; we rAF-loop until stable (3
    // consecutive unchanged checks) with a 2s timeout backstop.
    expect(source).toContain('needsInitialScrollRef.current) {');
    expect(source).toContain('requestAnimationFrame(pin)');
    expect(source).toMatch(/stableCount\s*>=\s*3/);
    expect(source).toMatch(/setTimeout\(finish,\s*2000\)/);

    // Stale-session guard: a pending rAF must not scroll a session we no
    // longer own (fast session switching).
    expect(source).toContain('sessionAtStart');
    expect(source).toContain('useSessionStore.getState().currentSessionId !== sessionAtStart');

    // Cleanup cancels the pending rAF so an unmounted/changed session does
    // not receive a deferred scroll.
    expect(source).toContain('cancelAnimationFrame(pendingRaf)');

    // The forbidden inline pattern stays forbidden (also asserted by the test
    // above); the force branch must use a local node reference instead.
    expect(source).not.toMatch(/scrollRef\.current\.scrollTop\s*=\s*scrollRef\.current\.scrollHeight/);
  });

  it('anchors the scroll position when loading older session events', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/chat/ConnectedMessageList.tsx'), 'utf8');

    // Preload trigger near the top of the transcript.
    expect(source).toContain('scroller.scrollTop < 200');
    expect(source).toContain('loadingOlderRef');
    // Keep the viewport anchored when prepending older events: capture the
    // prior scrollHeight and shift scrollTop by the delta.
    expect(source).toContain('previousScrollHeight');
    expect(source).toMatch(/nextScroller\.scrollTop\s*\+=\s*delta/);
    expect(source).toMatch(/previousScrollTopRef\.current\s*=\s*nextScroller\.scrollTop/);
  });

  it('preloads additional session pages before the sidebar reaches the bottom', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/chat/ChatSidebar.tsx'), 'utf8');

    expect(source).toContain('distanceFromBottom < 200');
    expect(source).toContain('onLoadMoreSessions()');
  });

  it('keeps reasoning panels scrollable and lightweight', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/chat/ChatMessageList.tsx'), 'utf8');

    expect(source).toContain('group-open/details:rotate-180');
    expect(source).toContain('max-h-[min(46vh,28rem)]');
    expect(source).toContain('custom-scrollbar');
    expect(source).toContain('border-emerald-200/70');
    expect(source).toContain('生成中');
    expect(source).toContain('leading-7');
  });

  it('virtualizes long message transcripts instead of mapping the full list directly', () => {
    const source = readFileSync(resolve(repoRoot, 'src/components/chat/ChatMessageList.tsx'), 'utf8');

    expect(source).toContain('calculateVirtualMessageWindow');
    expect(source).toContain('visibleItems.map((entry)');
    expect(source).toContain('style={{ height: virtualWindow.totalHeight }}');
    expect(source).not.toContain('messages.map((message, index) =>');
  });

  it('keeps checkpoint resume outside message replay state', () => {
    const connectedSource = readFileSync(resolve(repoRoot, 'src/components/chat/ConnectedMessageList.tsx'), 'utf8');
    const listSource = readFileSync(resolve(repoRoot, 'src/components/chat/ChatMessageList.tsx'), 'utf8');
    const lifecycleSource = readFileSync(resolve(repoRoot, 'src/hooks/useSessionLifecycle.ts'), 'utf8');
    const sessionEventsSource = readFileSync(resolve(repoRoot, 'src/utils/session-events.js'), 'utf8');

    expect(connectedSource).toContain('useCheckpointStore');
    expect(listSource).toContain('CheckpointPanel');
    expect(listSource).toContain('onResumeCheckpoint');
    expect(lifecycleSource).toContain('api.listSessionCheckpoints');
    expect(sessionEventsSource).not.toContain('run_checkpoint');
    expect(sessionEventsSource).not.toContain('run_resume');
  });

  it('renders all checkpoint resume entries instead of truncating the visible list', () => {
    const listSource = readFileSync(resolve(repoRoot, 'src/components/chat/ChatMessageList.tsx'), 'utf8');

    expect(listSource).not.toContain('checkpoints.slice(0, 3)');
    expect(listSource).not.toContain('个可恢复点');
    expect(listSource).toContain('会话恢复区');
    expect(listSource).toContain('选择 LangGraph 状态快照，从对应图状态继续');
    expect(listSource).toContain('checkpoints.map((checkpoint, index)');
    expect(listSource).toContain('checkpointStageBadge(index, checkpoints.length)');
    expect(listSource).toContain('第 ${current}/${Math.max(1, total)} 阶段');
    expect(listSource).toContain('checkpointStepLabel');
    expect(listSource).toContain('恢复后阶段：{checkpoint.nextAction}');
    expect(listSource).toContain('custom-scrollbar');
  });

  it('labels the streaming stop button as runtime cancel when available', () => {
    const composerSource = readFileSync(resolve(repoRoot, 'src/components/chat/ChatComposer.tsx'), 'utf8');
    const listSource = readFileSync(resolve(repoRoot, 'src/components/chat/ChatMessageList.tsx'), 'utf8');

    expect(composerSource).toContain('保留恢复点并结束本次执行');
    expect(composerSource).toContain("onCancelRemote ? '保留恢复点并结束本次执行' : '停止生成'");
    expect(listSource).toContain('aria-label="取消运行并保留恢复点"');
    expect(listSource).toContain('取消运行并保留最近 checkpoint');
  });

  it('loads checkpoint metadata as best effort without blocking session history', () => {
    const lifecycleSource = readFileSync(resolve(repoRoot, 'src/hooks/useSessionLifecycle.ts'), 'utf8');

    expect(lifecycleSource).toContain('loadCompleteSessionEventHistory');
    expect(lifecycleSource).toContain('SESSION_EVENTS_RESTORE_PAGE_SIZE');
    expect(lifecycleSource).toContain('loadOlderSessionEvents');
    expect(lifecycleSource).not.toContain('Promise.all([\\n          api.listSessionEvents(sessionId)');
    expect(lifecycleSource).toContain("console.warn('[SessionLifecycle] checkpoint load failed:'");
    expect(lifecycleSource).toContain("console.warn('[SessionLifecycle] tool receipt load failed:'");
  });

  it('uses current bootstrap capabilities when loading restored sessions', () => {
    const lifecycleSource = readFileSync(resolve(repoRoot, 'src/hooks/useSessionLifecycle.ts'), 'utf8');

    expect(lifecycleSource).toContain('useBootstrapStore.getState().capabilities');
    expect(lifecycleSource).toContain('runtimeCapabilities.RunLifecycle.Enabled');
    expect(lifecycleSource).toContain('runtimeCapabilities.RunLifecycle.Checkpoints');
  });

  it('updates checkpoint panel while subscribing to a background run', () => {
    const lifecycleSource = readFileSync(resolve(repoRoot, 'src/hooks/useSessionLifecycle.ts'), 'utf8');

    expect(lifecycleSource).toContain("event.EventType === 'run_checkpoint'");
    expect(lifecycleSource).toContain('upsertSessionCheckpoint(options.sessionId, event)');
    expect(lifecycleSource).toContain('setCurrentRunId(options.invocationId)');
    expect(lifecycleSource).toContain('后台长任务运行中');
  });

  it('marks background run activity terminal when subscription sees terminal status', () => {
    const lifecycleSource = readFileSync(resolve(repoRoot, 'src/hooks/useSessionLifecycle.ts'), 'utf8');

    expect(lifecycleSource).toContain('terminalActivityForRunEvent');
    expect(lifecycleSource).toContain('后台长任务已完成');
    expect(lifecycleSource).toContain('后台长任务已取消');
    expect(lifecycleSource).toContain('后台长任务失败');
    expect(lifecycleSource).toContain('status: terminalActivity.status');
  });

  it('does not let stale session history overwrite the active transcript', () => {
    const appSource = readFileSync(resolve(repoRoot, 'src/App.tsx'), 'utf8');
    const lifecycleSource = readFileSync(resolve(repoRoot, 'src/hooks/useSessionLifecycle.ts'), 'utf8');

    expect(appSource).not.toContain('void loadSession(sessionId);');
    expect(appSource).toContain('clearSessionEventCache(sessionId)');
    expect(lifecycleSource).toContain('const isStillCurrentSession = () => currentSessionIdRef.current === sessionId;');
    expect(lifecycleSource).toContain('if (!isStillCurrentSession()) {');
    expect(lifecycleSource).toContain('currentSessionIdRef.current === options.sessionId');
    // PR4:重连期间不覆盖消息列表(保持 loadSession 的 ListSessionMessages 结果),
    // run 结束后 shouldReloadSession 重新 loadSession 拿最终消息。
    expect(lifecycleSource).toContain('重连期间不覆盖消息列表');
  });
});
