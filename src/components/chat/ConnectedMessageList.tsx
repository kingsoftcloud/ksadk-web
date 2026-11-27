import type { AgentBlockActions } from '../../core/conversation/agent.js';
import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useUIStore } from '../../stores/ui.js';
import { useStreamingStore } from '../../stores/streaming.js';
import { useMessageStore } from '../../stores/message.js';
import { useSessionStore } from '../../stores/session.js';
import { useModelStore } from '../../stores/model.js';
import { useCheckpointStore } from '../../stores/checkpoint.js';
import { useBootstrapStore } from '../../stores/bootstrap.js';
import { ChatMessageList } from './ChatMessageList';
import { AttachmentPreview } from './AttachmentPreview';
import { buildComposerContextIndicator } from '../../utils/context.js';
import { ownsOlderMessageScrollRequest, prefetchHistoryCursor } from '../../utils/session-message-history.js';
import type { ComposerContextIndicator, Message, MessageAttachment } from './types';
import type { ModelStore } from '../../stores/model.js';
import type { SessionStore } from '../../stores/session.js';
import type { StreamingStore } from '../../stores/streaming.js';
import type { UIStore } from '../../stores/ui.js';
import type { A2UIClientEventMessage } from '../../core/a2ui/catalog.js';

export type ConnectedMessageListProps = {
  agentName: string;
  /** Replace the welcome surface without replacing the conversation renderer. */
  emptyState?: ReactNode;
  isMobile: boolean;
  onDeleteFeedback: (message: Message) => void;
  onSubmitFeedback: (options: { message: Message; rating: 'up' | 'down'; comment?: string }) => void;
  onRespondToApproval: (options: { approvalRequestId: string; approve: boolean; previousResponseId?: string }) => void;
  onRespondToAguiApproval?: (options: { interruptId: string; approve: boolean }) => void;
  onSubmitAguiAction?: (message: A2UIClientEventMessage) => void;
  onStopGeneration?: () => void;
  onCancelRemote?: () => void;
  agentBlockActions?: AgentBlockActions;
  checkpointResumeEnabled?: boolean;
  onResumeCheckpoint?: (params: { sessionId: string; runId: string; checkpointId: string }) => void;
  onLoadOlderSessionMessages?: (sessionId: string) => Promise<void>;
  onPrefetchOlderSessionMessages?: (sessionId: string) => void;
  onRetryHistory?: (sessionId: string) => Promise<void>;
  interactionRecords?: readonly import('../../core/interaction/types.js').Interaction[];
  className?: string;
  revealMessage?: { id: string; request: number } | null;
};

export function ConnectedMessageList({
  agentName,
  emptyState,
  isMobile,
  onDeleteFeedback,
  onSubmitFeedback,
  onRespondToApproval,
  onRespondToAguiApproval,
  onSubmitAguiAction,
  onStopGeneration,
  onCancelRemote,
  agentBlockActions,
  checkpointResumeEnabled = false,
  onResumeCheckpoint,
  onLoadOlderSessionMessages,
  onPrefetchOlderSessionMessages,
  onRetryHistory,
  interactionRecords,
  className,
  revealMessage,
}: ConnectedMessageListProps) {
  const messages = useMessageStore(s => s.messages);
  const currentSessionId = useSessionStore((s: SessionStore) => s.currentSessionId);
  const isLoadingSessions = useSessionStore((s: SessionStore) => s.isLoadingSessions);
  const activity = useStreamingStore((s: StreamingStore) => currentSessionId
    ? s.getSessionActivity(currentSessionId) : s.activity);
  const isStreaming = useStreamingStore((s: StreamingStore) => currentSessionId
    ? s.isSessionStreaming(currentSessionId)
    // Visible draft activity is cleared on navigation; global isStreaming alone
    // would incorrectly show an offscreen session's run on a new empty draft.
    : Boolean(s.isStreaming && s.activity && ['connecting', 'running', 'waiting'].includes(s.activity.status)));
  const checkpoints = useCheckpointStore(s => s.getSessionCheckpoints(currentSessionId));
  const currentMessageHistory = useSessionStore((s: SessionStore) =>
    currentSessionId ? s.messageHistory[currentSessionId] : null,
  );
  const hostedRuntime = useBootstrapStore(s => s.capabilities.HostedRuntime);
  // Checkpoint storage does not establish whether session history is durable.
  const persistenceWarning = hostedRuntime === false
    ? '当前会话历史的持久恢复尚未确认。本地恢复取决于所用存储及数据文件是否保留，不保证跨实例恢复。'
    : hostedRuntime === true
      ? '当前会话历史处于持久化降级状态。刷新、重启或切换实例后，部分消息可能无法恢复。'
      : '当前会话历史的持久恢复尚未确认。刷新或切换设备后，部分消息可能无法恢复。';
  const isLoadingInitialHistory = isLoadingSessions || Boolean(currentMessageHistory?.isLoadingInitial);
  const contextUsage = useSessionStore(s => s.sessions.find(item => item.SessionId === currentSessionId)?.ContextUsage);
  const availableModels = useModelStore((s: ModelStore) => s.availableModels);
  const selectedModel = useModelStore((s: ModelStore) => s.selectedModel);
  const previewAttachment = useUIStore((s: UIStore) => s.previewAttachment);
  const previewImageSize = useUIStore((s: UIStore) => s.previewImageSize);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const previousScrollTopRef = useRef(0);
  const isStreamingRef = useRef(isStreaming);
  const loadingOlderRef = useRef(false);
  const olderLoadTokenRef = useRef<symbol | null>(null);
  const needsInitialScrollRef = useRef(true);
  const previousLastMessageIdRef = useRef('');
  const revealRef = useRef(revealMessage);
  useEffect(() => {
    revealRef.current = revealMessage;
  });
  const selectedModelMetadata = useMemo(
    () => availableModels.find((model) => model.id === selectedModel) || null,
    [availableModels, selectedModel],
  );
  const contextIndicator = useMemo<ComposerContextIndicator>(
    () =>
      buildComposerContextIndicator({
        selectedModel: selectedModelMetadata,
        contextUsage,
      }) as ComposerContextIndicator,
    [selectedModelMetadata, contextUsage],
  );
  const lastUserIndex = messages.reduce((index, message, currentIndex) => message.role === 'user' ? currentIndex : index, -1);
  const hasModelOutput = (message: Message) => Boolean(message.role === 'model' && (
    message.content || message.reasoning || message.blocks?.some(block => (
      block.type === 'text' || block.type === 'thinking' ? block.content : true
    )) || message.attachments?.length || message.a2ui || message.aguiActivity
    || message.aguiActivities?.length || Object.keys(message.tools || {}).length
  ));
  const showWaitingIndicator = isStreaming && !messages.slice(lastUserIndex + 1).some(hasModelOutput);

  const scrollToBottom = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    stickToBottomRef.current = true;
    userDetachedFromBottomRef.current = false;
    const previousScrollBehavior = node.style.scrollBehavior;
    node.style.scrollBehavior = 'auto';
    let frameCount = 0;
    let stableCount = 0;
    let lastScrollHeight = -1;
    const pin = () => {
      if (scrollRef.current !== node) return;
      node.scrollTop = node.scrollHeight;
      previousScrollTopRef.current = node.scrollTop;
      node.dispatchEvent(new Event('scroll'));
      stableCount = node.scrollHeight === lastScrollHeight ? stableCount + 1 : 0;
      lastScrollHeight = node.scrollHeight;
      frameCount += 1;
      if (stableCount >= 3 || frameCount >= 12) {
        node.style.scrollBehavior = previousScrollBehavior;
        return;
      }
      requestAnimationFrame(pin);
    };
    pin();
  }, []);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  // Reset stickiness state whenever the active session changes so the next
  // history injection is treated as "should be at the bottom" rather than
  // "user scrolled up". Without this, effect A's updateStickiness() flips
  // stickToBottomRef to false on the empty->history transition (scrollTop=0
  // against a large scrollHeight) and effect B then refuses to scroll.
  useEffect(() => {
    needsInitialScrollRef.current = true;
    stickToBottomRef.current = true;
    userDetachedFromBottomRef.current = false;
    previousScrollTopRef.current = 0;
    loadingOlderRef.current = false;
    olderLoadTokenRef.current = null;
    previousLastMessageIdRef.current = '';
  }, [currentSessionId]);

  useEffect(() => {
    if (!revealMessage) return;
    stickToBottomRef.current = false;
    userDetachedFromBottomRef.current = true;
    needsInitialScrollRef.current = false;
  }, [revealMessage]);

  // Sending a new user turn always returns the viewport to the live edge.
  // This is an explicit user action, so it overrides a previous manual
  // detachment and makes the jump indicator disappear immediately.
  useEffect(() => {
    const lastMessage = messages.at(-1);
    const previousId = previousLastMessageIdRef.current;
    previousLastMessageIdRef.current = String(lastMessage?.id || '');
    if (
      lastMessage?.role === 'user'
      && lastMessage.id !== previousId
      && !needsInitialScrollRef.current
    ) {
      scrollToBottom();
    }
  }, [messages, scrollToBottom]);

  const loadOlderHistory = useCallback(() => {
    if (!scrollRef.current || !currentSessionId || !currentMessageHistory?.hasMore
      || currentMessageHistory.isLoadingOlder || loadingOlderRef.current
      || !onLoadOlderSessionMessages) return;
    const requestToken = Symbol(currentSessionId);
    loadingOlderRef.current = true;
    olderLoadTokenRef.current = requestToken;
    stickToBottomRef.current = false;
    userDetachedFromBottomRef.current = true;
    void onLoadOlderSessionMessages(currentSessionId).finally(() => {
      // A layout adjustment can dispatch a native scroll event after the
      // history store has committed. Do not treat it as another gesture.
      requestAnimationFrame(() => {
        if (!ownsOlderMessageScrollRequest({ requestedSessionId: currentSessionId,
          activeSessionId: useSessionStore.getState().currentSessionId,
          requestToken, activeRequestToken: olderLoadTokenRef.current })) return;
        previousScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;
        olderLoadTokenRef.current = null;
        loadingOlderRef.current = false;
      });
    });
  }, [currentMessageHistory, currentSessionId, onLoadOlderSessionMessages]);

  const prefetchCursor = prefetchHistoryCursor(currentMessageHistory ?? undefined);
  const canPrefetchHistory = prefetchCursor !== null && Boolean(onPrefetchOlderSessionMessages);
  const canAutoLoadHistory = Boolean(currentSessionId && currentMessageHistory?.hasMore
    && !currentMessageHistory.retryOlderPage && !isLoadingInitialHistory && onLoadOlderSessionMessages);

  useEffect(() => {
    if (!currentSessionId || !canPrefetchHistory || isLoadingInitialHistory || isStreaming
      || currentMessageHistory?.isLoadingOlder || revealMessage) return;
    // Let the first paint settle, then keep one batch ahead of the reader.
    const timer = window.setTimeout(() => onPrefetchOlderSessionMessages?.(currentSessionId), 120);
    return () => window.clearTimeout(timer);
  }, [currentSessionId, canPrefetchHistory, prefetchCursor, currentMessageHistory?.isLoadingOlder,
    isLoadingInitialHistory, isStreaming, onPrefetchOlderSessionMessages, revealMessage]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;

    const updateStickiness = (event?: Event) => {
      const distanceFromBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const scrolledUp = scroller.scrollTop < previousScrollTopRef.current - 2;
      const scrolledDown = scroller.scrollTop > previousScrollTopRef.current + 2;
      previousScrollTopRef.current = scroller.scrollTop;
      // A short viewport may be at both edges while older messages load.
      // Its resize/scroll events cannot reattach it to the live edge.
      if (loadingOlderRef.current) return;

      const historyLoadDistance = canPrefetchHistory ? Math.max(200, scroller.clientHeight) : 200;
      if (
        event &&
        !needsInitialScrollRef.current &&
        scrolledUp &&
        scroller.scrollTop < historyLoadDistance &&
        canAutoLoadHistory &&
        !currentMessageHistory?.isLoadingOlder &&
        !loadingOlderRef.current
      ) {
        loadOlderHistory();
      }

      if (isStreamingRef.current && scrolledUp) {
        userDetachedFromBottomRef.current = true;
        stickToBottomRef.current = false;
        return;
      }

      if (userDetachedFromBottomRef.current) {
        const returnedToBottom = Boolean(event && scrolledDown && distanceFromBottom <= 12);
        userDetachedFromBottomRef.current = !returnedToBottom;
        stickToBottomRef.current = returnedToBottom;
        return;
      }

      stickToBottomRef.current = distanceFromBottom < 96;
    };

    const loadAtTop = () => {
      if (canAutoLoadHistory && scroller.scrollTop <= 1) loadOlderHistory();
    };
    const onWheel = (event: WheelEvent) => {
      // A scroller already at its upper edge emits no further scroll events.
      if (event.deltaY < 0) loadAtTop();
    };
    let touchY: number | undefined;
    const onTouchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y != null && touchY != null && y > touchY) loadAtTop();
      touchY = y;
    };
    updateStickiness();
    scroller.addEventListener('scroll', updateStickiness, { passive: true });
    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('touchstart', onTouchStart, { passive: true });
    scroller.addEventListener('touchmove', onTouchMove, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', updateStickiness);
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('touchstart', onTouchStart);
      scroller.removeEventListener('touchmove', onTouchMove);
    };
  }, [canAutoLoadHistory, canPrefetchHistory, currentMessageHistory, loadOlderHistory]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || typeof ResizeObserver === 'undefined') return undefined;

    // Markdown, virtual row measurement and async code highlighting can grow
    // the content after the initial message render. Keep following that growth
    // only while the reader is attached to the bottom; a manual upward scroll
    // flips stickToBottomRef and leaves the viewport alone.
    const keepAttachedToBottom = () => {
      if (loadingOlderRef.current || (!needsInitialScrollRef.current && !stickToBottomRef.current)) return;
      scroller.scrollTop = scroller.scrollHeight;
      previousScrollTopRef.current = scroller.scrollTop;
      scroller.dispatchEvent(new Event('scroll'));
    };
    const observer = new ResizeObserver(keepAttachedToBottom);
    observer.observe(scroller);
    if (scroller.firstElementChild instanceof HTMLElement) {
      observer.observe(scroller.firstElementChild);
    }
    return () => observer.disconnect();
  }, [currentSessionId]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || loadingOlderRef.current) return;

    // Initial session load: bypass the stickiness gate. The gate is unreliable
    // here because effect A (updateStickiness) runs first and, seeing scrollTop=0
    // against the freshly-injected history's large scrollHeight, flips
    // stickToBottomRef to false before this effect can scroll. Virtualization
    // also means scrollHeight grows across frames as off-screen rows are
    // measured, so we pin to bottom on every scrollHeight change until it
    // stabilizes (or a 2s timeout elapses).
    if (messages.length > 0 && needsInitialScrollRef.current) {
      const revealAtStart = revealRef.current;
      const sessionAtStart = useSessionStore.getState().currentSessionId;
      const node = scrollRef.current;
      const prevScrollBehavior = node ? node.style.scrollBehavior : '';
      if (node) {
        node.style.scrollBehavior = 'auto';
        node.scrollTop = node.scrollHeight;
        previousScrollTopRef.current = node.scrollTop;
      }
      let stableCount = 0;
      let lastScrollHeight = node?.scrollHeight ?? -1;
      let finished = false;
      let pendingRaf = 0;
      const pinToBottom = () => {
        const el = scrollRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        previousScrollTopRef.current = el.scrollTop;
        // Programmatic scrollTop updates are not guaranteed to dispatch a
        // scroll event before React reads ChatMessageList's viewport state.
        // Dispatch one explicitly so the bottom-arrow calculation observes
        // the same final position as the stickiness controller.
        el.dispatchEvent(new Event('scroll'));
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        if (revealRef.current !== revealAtStart) {
          if (node) node.style.scrollBehavior = prevScrollBehavior;
          return;
        }
        pinToBottom();
        if (node) node.style.scrollBehavior = prevScrollBehavior;
        stickToBottomRef.current = true;
        userDetachedFromBottomRef.current = false;
        needsInitialScrollRef.current = false;
      };
      const pin = () => {
        if (finished) return;
        if (revealRef.current !== revealAtStart) { finish(); return; }
        if (useSessionStore.getState().currentSessionId !== sessionAtStart) {
          finished = true;
          return;
        }
        const el = scrollRef.current;
        if (!el) return;
        if (el.scrollHeight !== lastScrollHeight) {
          lastScrollHeight = el.scrollHeight;
          pinToBottom();
          stableCount = 0;
        } else {
          stableCount += 1;
          // scrollHeight stable for 3 consecutive checks → done
          if (stableCount >= 3) {
            finish();
            return;
          }
        }
        pendingRaf = requestAnimationFrame(pin);
      };
      // 超时兜底:2s 内必须结束,防 ResizeObserver 不触发
      const timeoutId = window.setTimeout(finish, 2000);
      pendingRaf = requestAnimationFrame(pin);
      return () => {
        cancelAnimationFrame(pendingRaf);
        window.clearTimeout(timeoutId);
        if (useSessionStore.getState().currentSessionId !== sessionAtStart) {
          finish();
          return;
        }
        // The durable message fallback is replaced by canonical RuntimeEvent
        // history shortly after a cold switch. Keep the initial-pin intent
        // alive across that same-session effect restart; otherwise cleanup
        // marks the list settled before virtual rows finish measuring.
        if (node) node.style.scrollBehavior = prevScrollBehavior;
      };
    }

    if (!stickToBottomRef.current) return;
    scroller.scrollTop = scroller.scrollHeight;
    previousScrollTopRef.current = scroller.scrollTop;
  }, [messages, isStreaming, revealMessage]);

  const openAttachmentPreview = (attachment: MessageAttachment) => {
    useUIStore.getState().setPreviewAttachment(attachment);
    useUIStore.getState().setPreviewImageSize(null);
  };

  const closeAttachmentPreview = () => {
    useUIStore.getState().setPreviewAttachment(null);
    useUIStore.getState().setPreviewImageSize(null);
  };

  return (
    <>
      {currentMessageHistory?.dataSource === 'control_fallback' && currentMessageHistory.degraded && (
        <div role="status" data-testid="history-fallback-warning" className="mx-auto w-full max-w-3xl px-6 py-2 text-sm text-amber-700 dark:text-amber-300">
          完整历史暂时不可用，当前仅显示已恢复的消息。你可以继续对话。
          {onRetryHistory && currentSessionId && !currentMessageHistory.error && (
            <button type="button" className="ml-3 underline" disabled={isLoadingInitialHistory || isStreaming}
              onClick={() => void onRetryHistory(currentSessionId)}>重试完整历史</button>
          )}
        </div>
      )}
      {currentMessageHistory?.persistenceDegraded && (
        <div role="status" data-testid="history-persistence-warning" className="mx-auto w-full max-w-3xl px-6 py-2 text-sm text-amber-700 dark:text-amber-300">
          {persistenceWarning}
        </div>
      )}
      {currentMessageHistory?.error && (
        <div role="alert" data-testid="history-reload-error" className="mx-auto w-full max-w-3xl px-6 py-2 text-sm text-red-700 dark:text-red-300">
          {currentMessageHistory.error}
          {currentMessageHistory.retryOlderPage && onLoadOlderSessionMessages ? (
            <button type="button" className="ml-3 underline" disabled={currentMessageHistory.isLoadingOlder}
              onClick={loadOlderHistory}>重试</button>
          ) : onRetryHistory && currentSessionId && (
            <button type="button" className="ml-3 underline" onClick={() => void onRetryHistory(currentSessionId)}>重试</button>
          )}
        </div>
      )}
      {currentMessageHistory?.preparing && (
        <div role="status" data-testid="history-preparing" className="mx-auto w-full max-w-3xl px-6 py-2 text-sm">历史正在准备，请稍候。</div>
      )}
      {currentMessageHistory?.hasMore && onLoadOlderSessionMessages && !isLoadingInitialHistory && (
        <div className="mx-auto w-full max-w-3xl px-6 py-2 text-center">
          <button type="button" data-testid="history-load-older"
            className="text-sm text-text-secondary underline disabled:opacity-50"
            disabled={currentMessageHistory.isLoadingOlder || currentMessageHistory.preparing}
            onClick={loadOlderHistory}>
            {currentMessageHistory.isLoadingOlder || currentMessageHistory.preparing ? '正在加载…' : '加载更早的消息'}
          </button>
        </div>
      )}
      <ChatMessageList
        revealMessage={revealMessage}
        emptyState={currentMessageHistory?.error || currentMessageHistory?.preparing ? null : emptyState}
        agentName={agentName}
        isMobile={isMobile}
        isStreaming={isStreaming}
        activity={activity}
        contextIndicator={contextIndicator}
        messages={messages}
        showWaitingIndicator={showWaitingIndicator}
        isLoadingInitialHistory={isLoadingInitialHistory}
        onDeleteFeedback={onDeleteFeedback}
        onOpenAttachmentPreview={openAttachmentPreview}
        onRespondToApproval={onRespondToApproval}
        onRespondToAguiApproval={onRespondToAguiApproval}
        interactionRecords={interactionRecords}
        onScrollToBottom={scrollToBottom}
        onSubmitFeedback={onSubmitFeedback}
        onSubmitAguiAction={onSubmitAguiAction}
        onStopGeneration={onStopGeneration}
        onCancelRemote={onCancelRemote}
        agentBlockActions={agentBlockActions}
        checkpoints={checkpointResumeEnabled ? checkpoints : []}
        onResumeCheckpoint={onResumeCheckpoint}
        scrollRef={scrollRef}
        historyScrollPending={loadingOlderRef}
        sessionId={currentSessionId}
        className={className}
      />
      <AttachmentPreview
        attachment={previewAttachment}
        isMobile={isMobile}
        previewImageSize={previewImageSize}
        onClose={closeAttachmentPreview}
        onImageLoad={(size) => useUIStore.getState().setPreviewImageSize(size)}
      />
    </>
  );
}
