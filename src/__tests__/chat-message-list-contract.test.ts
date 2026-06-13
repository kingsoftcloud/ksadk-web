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
    expect(source).toContain('isStreamingRef.current && scrolledUp');
    expect(source).toContain('distanceFromBottom <= 12');
    expect(source).toContain('distanceFromBottom < 96');
    expect(source).not.toMatch(/scrollRef\.current\.scrollTop\s*=\s*scrollRef\.current\.scrollHeight/);
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

    expect(lifecycleSource).toContain('const data = await api.listSessionEvents(sessionId)');
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
});
