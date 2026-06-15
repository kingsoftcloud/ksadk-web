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
}: ConnectedMessageListProps) {
  const messages = useMessageStore(s => s.messages);
  const currentSessionId = useSessionStore((s: SessionStore) => s.currentSessionId);
  const isStreaming = useStreamingStore((s: StreamingStore) => Boolean(s.getSessionActivity(currentSessionId) && s.isSessionStreaming(currentSessionId)));
  const activity = useStreamingStore((s: StreamingStore) => s.getSessionActivity(currentSessionId));
  const checkpoints = useCheckpointStore(s => s.getSessionCheckpoints(currentSessionId));
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

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return undefined;

    const updateStickiness = () => {
      const distanceFromBottom =
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      const scrolledUp = scroller.scrollTop < previousScrollTopRef.current - 2;
      previousScrollTopRef.current = scroller.scrollTop;

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
  }, []);

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !stickToBottomRef.current) return;
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
