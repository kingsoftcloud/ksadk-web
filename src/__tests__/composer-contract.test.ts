import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function readSource(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../${relativePath}`, import.meta.url)),
    'utf-8',
  );
}

describe('ChatComposer interaction contract', () => {
  it('keeps running controls consolidated in the primary action button', () => {
    const source = readSource('components/chat/ChatComposer.tsx');

    expect(source).not.toContain('停止接收');
    expect(source).not.toContain('取消运行');
    expect(source).not.toContain('终止后台');
    expect(source).toContain("const activeStopTitle = onCancelRemote ? '保留恢复点并结束本次执行' : '停止生成'");
    expect(source).toContain("title={isStreaming ? activeStopTitle : '发送消息'}");
    expect(source).toContain('isStreaming ? <StopCircle');
  });

  it('does not block image sends based on stale model capability metadata', () => {
    const source = readSource('components/chat/ConnectedComposer.tsx');

    expect(source).not.toContain('multimodal_input_image === false');
    expect(source).not.toContain('不支持图片输入');
    expect(source).toContain('void submitDraft(draftText, draftAttachments)');
  });

  it('refreshes the active session after runtime cancel so checkpoint controls can appear', () => {
    const source = readSource('App.tsx');
    const cancelHandlerStart = source.indexOf('const handleCancelRemote = useCallback');
    const cancelHandlerEnd = source.indexOf('const { submitResponseFeedback', cancelHandlerStart);
    const cancelHandler = source.slice(cancelHandlerStart, cancelHandlerEnd);

    expect(cancelHandler).toContain('const sessionId = currentSessionIdRef.current');
    expect(cancelHandler).toContain('api.cancelRun(agentId, sessionId, invocationId)');
    expect(cancelHandler).toContain('refreshSettledRun(sessionId)');
    expect(cancelHandler).toContain('取消请求已发送');
    expect(cancelHandler).toMatch(/stopSessionActivity\(\s*sessionId/);
    expect(cancelHandler).not.toContain("status: 'waiting'");
    expect(cancelHandler).not.toContain('handleStopGeneration()');
  });

  it('settles the active session banner when the user stops generation', () => {
    const source = readSource('App.tsx');
    const stopHandlerStart = source.indexOf('const handleStopGeneration = useCallback');
    const stopHandlerEnd = source.indexOf('const handleCancelRemote', stopHandlerStart);
    const stopHandler = source.slice(stopHandlerStart, stopHandlerEnd);

    expect(stopHandler).toMatch(/stopSessionActivity\(\s*sessionId/);
  });
});
