import { useEffect, useMemo, useRef } from 'react';
import { useUIStore } from '../../stores/ui.js';
import { useStreamingStore } from '../../stores/streaming.js';
import { useMessageStore } from '../../stores/message.js';
import { useSessionStore } from '../../stores/session.js';
import { useModelStore } from '../../stores/model.js';
import { ChatMessageList } from './ChatMessageList';
import { AttachmentPreview } from './AttachmentPreview';
import { buildComposerContextIndicator } from '../../utils/context.js';
import type { Message, MessageAttachment } from './types';

type ConnectedMessageListProps = {
  agentName: string;
  isMobile: boolean;
  onDeleteFeedback: (message: Message) => void;
  onSubmitFeedback: (options: { message: Message; rating: 'up' | 'down'; comment?: string }) => void;
  onRespondToApproval: (options: { approvalRequestId: string; approve: boolean; previousResponseId?: string }) => void;
  onStopGeneration?: () => void;
  onCancelRemote?: () => void;
};

export function ConnectedMessageList({
  agentName,
  isMobile,
  onDeleteFeedback,
  onSubmitFeedback,
  onRespondToApproval,
  onStopGeneration,
  onCancelRemote,
}: ConnectedMessageListProps) {
  const messages = useMessageStore(s => s.messages);
  const currentSessionId = useSessionStore(s => s.currentSessionId);
  const isStreaming = useStreamingStore(s => Boolean(s.getSessionActivity(currentSessionId) && s.isSessionStreaming(currentSessionId)));
  const activity = useStreamingStore(s => s.getSessionActivity(currentSessionId));
  const input = useUIStore(s => s.input);
  const availableModels = useModelStore(s => s.availableModels);
  const selectedModel = useModelStore(s => s.selectedModel);
  const previewAttachment = useUIStore(s => s.previewAttachment);
  const previewImageSize = useUIStore(s => s.previewImageSize);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const previousScrollTopRef = useRef(0);
  const isStreamingRef = useRef(isStreaming);
  const selectedModelMetadata = useMemo(
    () => availableModels.find((model) => model.id === selectedModel) || null,
    [availableModels, selectedModel],
  );
  const contextIndicator = useMemo(
    () =>
      buildComposerContextIndicator({
        messages,
        draftInput: input,
        selectedModel: selectedModelMetadata,
      }),
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
