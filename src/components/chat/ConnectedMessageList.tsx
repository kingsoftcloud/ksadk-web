import { useEffect, useMemo, useRef } from 'react';
import { useUIStore } from '../../stores/ui.js';
import { useStreamingStore } from '../../stores/streaming.js';
import { useMessageStore } from '../../stores/message.js';
import { useSessionStore } from '../../stores/session.js';
import { useModelStore } from '../../stores/model.js';
import { useCheckpointStore } from '../../stores/checkpoint.js';
import { ChatMessageList } from './ChatMessageList';
import { AttachmentPreview } from './AttachmentPreview';
import { buildComposerContextIndicator } from '../../utils/context.js';
import type { ComposerContextIndicator, Message, MessageAttachment } from './types';
import type { ModelStore } from '../../stores/model.js';
import type { SessionStore } from '../../stores/session.js';
import type { StreamingStore } from '../../stores/streaming.js';
import type { UIStore } from '../../stores/ui.js';

type ConnectedMessageListProps = {
  agentName: string;
  isMobile: boolean;
  onDeleteFeedback: (message: Message) => void;
  onSubmitFeedback: (options: { message: Message; rating: 'up' | 'down'; comment?: string }) => void;
  onRespondToApproval: (options: { approvalRequestId: string; approve: boolean; previousResponseId?: string }) => void;
  onStopGeneration?: () => void;
  onCancelRemote?: () => void;
  checkpointResumeEnabled?: boolean;
  onResumeCheckpoint?: (params: { sessionId: string; runId: string; checkpointId: string }) => void;
  onLoadOlderSessionEvents?: (sessionId: string) => Promise<void>;
};

export function ConnectedMessageList({
  agentName,
  isMobile,
  onDeleteFeedback,
  onSubmitFeedback,
  onRespondToApproval,
  onStopGeneration,
  onCancelRemote,
  checkpointResumeEnabled = false,
  onResumeCheckpoint,
  onLoadOlderSessionEvents,
}: ConnectedMessageListProps) {
  const messages = useMessageStore(s => s.messages);
  const currentSessionId = useSessionStore((s: SessionStore) => s.currentSessionId);
  const isStreaming = useStreamingStore((s: StreamingStore) => Boolean(s.getSessionActivity(currentSessionId) && s.isSessionStreaming(currentSessionId)));
  const activity = useStreamingStore((s: StreamingStore) => s.getSessionActivity(currentSessionId));
  const checkpoints = useCheckpointStore(s => s.getSessionCheckpoints(currentSessionId));
  const currentEventCache = useSessionStore((s: SessionStore) =>
    currentSessionId ? s.eventCache[currentSessionId] : null,
  );
  const input = useUIStore((s: UIStore) => s.input);
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
  const needsInitialScrollRef = useRef(true);
  const selectedModelMetadata = useMemo(
    () => availableModels.find((model) => model.id === selectedModel) || null,
    [availableModels, selectedModel],
  );
  const contextIndicator = useMemo<ComposerContextIndicator>(
    () =>
      buildComposerContextIndicator({
        messages,
        draftInput: input,
        selectedModel: selectedModelMetadata,
      }) as ComposerContextIndicator,
    [input, messages, selectedModelMetadata],
  );

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
  }, [currentSessionId]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;

    const updateStickiness = () => {
      const distanceFromBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const scrolledUp = scroller.scrollTop < previousScrollTopRef.current - 2;
      previousScrollTopRef.current = scroller.scrollTop;

      if (
        scroller.scrollTop < 200 &&
        currentSessionId &&
        currentEventCache &&
        currentEventCache.offset > 0 &&
        !currentEventCache.isLoadingOlder &&
        !loadingOlderRef.current &&
        onLoadOlderSessionEvents
      ) {
        const previousScrollHeight = scroller.scrollHeight;
        loadingOlderRef.current = true;
        void onLoadOlderSessionEvents(currentSessionId)
          .then(() => {
            requestAnimationFrame(() => {
              const nextScroller = scrollRef.current;
              if (!nextScroller) return;
              const delta = nextScroller.scrollHeight - previousScrollHeight;
              nextScroller.scrollTop += delta;
              previousScrollTopRef.current = nextScroller.scrollTop;
            });
          })
          .finally(() => {
            loadingOlderRef.current = false;
          });
      }

      if (isStreamingRef.current && scrolledUp) {
        userDetachedFromBottomRef.current = true;
        stickToBottomRef.current = false;
        return;
      }

      if (userDetachedFromBottomRef.current) {
        const returnedToBottom = distanceFromBottom <= 12;
        userDetachedFromBottomRef.current = !returnedToBottom;
        stickToBottomRef.current = returnedToBottom;
        return;
      }

      stickToBottomRef.current = distanceFromBottom < 96;
    };

    updateStickiness();
    scroller.addEventListener('scroll', updateStickiness, { passive: true });
    return () => scroller.removeEventListener('scroll', updateStickiness);
  }, [currentEventCache, currentSessionId, onLoadOlderSessionEvents]);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;

    // Initial session load: bypass the stickiness gate. The gate is unreliable
    // here because effect A (updateStickiness) runs first and, seeing scrollTop=0
    // against the freshly-injected history's large scrollHeight, flips
    // stickToBottomRef to false before this effect can scroll. Virtualization
    // also means scrollHeight grows across frames as off-screen rows are
    // measured, so we rAF-loop, pinning to the bottom until scrollHeight
    // stabilizes (or the attempt budget is exhausted).
    if (messages.length > 0 && needsInitialScrollRef.current) {
      // Capture the session that owns this scroll. If the user switches
      // sessions while a rAF is pending, the new session owns its own
      // initial-scroll effect and we must not stomp on its viewport.
      const sessionAtStart = useSessionStore.getState().currentSessionId;
      let pendingRaf = 0;
      let lastScrollHeight = -1;
      let attempts = 0;
      const pinToBottom = () => {
        if (useSessionStore.getState().currentSessionId !== sessionAtStart) {
          return;
        }
        const node = scrollRef.current;
        if (!node) return;
        if (node.scrollHeight !== lastScrollHeight) {
          lastScrollHeight = node.scrollHeight;
          node.scrollTop = node.scrollHeight;
          previousScrollTopRef.current = node.scrollTop;
          attempts += 1;
          if (attempts < 8) {
            pendingRaf = requestAnimationFrame(pinToBottom);
            return;
          }
        }
        // scrollHeight stable (or budget exhausted) — hand control back to
        // the stickiness gate so subsequent streamed chunks keep following.
        stickToBottomRef.current = true;
        userDetachedFromBottomRef.current = false;
        needsInitialScrollRef.current = false;
      };
      pendingRaf = requestAnimationFrame(pinToBottom);
      return () => {
        cancelAnimationFrame(pendingRaf);
      };
    }

    if (!stickToBottomRef.current) return;
    scroller.scrollTop = scroller.scrollHeight;
    previousScrollTopRef.current = scroller.scrollTop;
  }, [messages, isStreaming]);

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
      <ChatMessageList
        agentName={agentName}
        isMobile={isMobile}
        isStreaming={isStreaming}
        activity={activity}
        contextIndicator={contextIndicator}
        messages={messages}
        onDeleteFeedback={onDeleteFeedback}
        onOpenAttachmentPreview={openAttachmentPreview}
        onRespondToApproval={onRespondToApproval}
        onSubmitFeedback={onSubmitFeedback}
        onStopGeneration={onStopGeneration}
        onCancelRemote={onCancelRemote}
        checkpoints={checkpointResumeEnabled ? checkpoints : []}
        onResumeCheckpoint={onResumeCheckpoint}
        scrollRef={scrollRef}
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
