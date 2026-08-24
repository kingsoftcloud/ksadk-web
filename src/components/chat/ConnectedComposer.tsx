import React, { useEffect, useMemo, useRef, useCallback, useState } from 'react';
import { useUIStore } from '../../stores/ui.js';
import { useStreamingStore } from '../../stores/streaming.js';
import { useMessageStore } from '../../stores/message.js';
import { useModelStore } from '../../stores/model.js';
import { useSessionStore } from '../../stores/session.js';
import { ChatComposer } from './ChatComposer';
import { InteractionTray } from './InteractionTray';
import type { InteractionTrayRespondInput } from './InteractionTray';
import type { Interaction } from '../../core/interaction/types.js';
import { mergeAttachmentFiles, extractClipboardFiles } from '../../utils/attachment.js';
import { buildComposerContextIndicator } from '../../utils/context.js';
import type { ModelStore } from '../../stores/model.js';
import type { SessionStore } from '../../stores/session.js';
import type { StreamingStore } from '../../stores/streaming.js';
import type { UIStore } from '../../stores/ui.js';
import type { ComposerContextIndicator } from './types';
import type { ApprovalPolicyCapability } from '../../types/capabilities.js';
import type { RuntimeCapabilityMatrix } from '../../types/agent-control.js';
import type { RuntimeExecutionMode } from '../../core/run/types.js';
import type { RuntimeExecutionModeSupport } from './ExecutionModeMenu';

type ConnectedComposerProps = {
  composerMaxHeight: number;
  submitDraft: (
    text: string,
    attachments: File[],
    responsesInput?: unknown,
    previousResponseId?: string,
    executionMode?: RuntimeExecutionMode,
  ) => Promise<void>;
  stopGeneration: () => void;
  cancelRemote?: () => void;
  isMobile: boolean;
  attachmentsEnabled?: boolean;
  approvalEnabled?: boolean;
  approvalPolicy?: ApprovalPolicyCapability;
  thinkingEnabled?: boolean;
  runtimeCapabilityMatrix?: RuntimeCapabilityMatrix;
  /** Pending interactions rendered in the tray above the composer. */
  pendingInteractions?: readonly Interaction[];
  onRespondInteraction?: (input: InteractionTrayRespondInput) => void;
  localCatalog?: unknown;
};

export function ConnectedComposer({
  composerMaxHeight,
  submitDraft,
  stopGeneration,
  cancelRemote,
  isMobile,
  attachmentsEnabled = true,
  approvalEnabled = false,
  approvalPolicy,
  thinkingEnabled = false,
  runtimeCapabilityMatrix,
  pendingInteractions,
  onRespondInteraction,
  localCatalog,
}: ConnectedComposerProps) {
  const [activeInteractionIndex, setActiveInteractionIndex] = useState(0);
  const [selectedExecutionMode, setSelectedExecutionMode] = useState<RuntimeExecutionMode>('loop');
  const input = useUIStore((s: UIStore) => s.input);
  const attachments = useUIStore((s: UIStore) => s.attachments);
  const currentSessionId = useSessionStore((s: SessionStore) => s.currentSessionId);
  const isStreaming = useStreamingStore((s: StreamingStore) => Boolean(s.getSessionActivity(currentSessionId) && s.isSessionStreaming(currentSessionId)));
  const queuedDrafts = useUIStore((s: UIStore) => s.queuedDrafts);
  const messages = useMessageStore(s => s.messages);
  const availableModels = useModelStore((s: ModelStore) => s.availableModels);
  const selectedModel = useModelStore((s: ModelStore) => s.selectedModel);
  const setThinkingMode = useModelStore((s: ModelStore) => s.setThinkingMode);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectedModelMetadata = useMemo(
    () => availableModels.find((model) => model.id === selectedModel) || null,
    [availableModels, selectedModel],
  );
  const composerContextIndicator = useMemo<ComposerContextIndicator>(
    () =>
      buildComposerContextIndicator({
        messages,
        draftInput: input,
        selectedModel: selectedModelMetadata,
      }) as ComposerContextIndicator,
    [input, messages, selectedModelMetadata],
  );
  const executionModeSupport = useMemo<RuntimeExecutionModeSupport>(() => ({
    loop: Boolean(runtimeCapabilityMatrix?.loop?.supported),
    plan: Boolean(runtimeCapabilityMatrix?.plan?.supported),
    goal: Boolean(runtimeCapabilityMatrix?.goal?.supported),
  }), [runtimeCapabilityMatrix]);
  const executionMode = executionModeSupport[selectedExecutionMode]
    ? selectedExecutionMode
    : executionModeSupport.loop ? 'loop' : undefined;

  const handleSubmit = useCallback((draftText: string, draftAttachments: File[]) => {
    if (!draftText && draftAttachments.length === 0) return;
    useUIStore.getState().setInput('');
    useUIStore.getState().setAttachments([]);
    void submitDraft(draftText, draftAttachments, undefined, undefined, executionMode);
    if (executionMode === 'goal') {
      setSelectedExecutionMode('loop');
    }
  }, [executionMode, submitDraft]);

  useEffect(() => {
    if (!textareaRef.current) return;
    textareaRef.current.style.height = 'auto';
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, composerMaxHeight)}px`;
  }, [input, composerMaxHeight]);

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    useUIStore.getState().setInput(event.target.value);
    event.target.style.height = 'auto';
    event.target.style.height = `${Math.min(event.target.scrollHeight, composerMaxHeight)}px`;
  };

  const appendAttachments = (incoming: File[]) => {
    if (!attachmentsEnabled || !incoming.length) return;
    useUIStore.getState().setAttachments((prev: File[]) => mergeAttachmentFiles(prev, incoming));
  };

  const handleComposerPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachmentsEnabled) return;
    const pastedFiles = extractClipboardFiles(event);
    if (!pastedFiles.length) return;
    event.preventDefault();
    event.stopPropagation();
    appendAttachments(pastedFiles);
  };

  const trayInteractions = pendingInteractions || [];
  const trayIndex = Math.min(activeInteractionIndex, Math.max(trayInteractions.length - 1, 0));

  useEffect(() => {
    if (!thinkingEnabled) setThinkingMode('auto');
  }, [setThinkingMode, thinkingEnabled]);

  return (
    <div className="flex w-full flex-col justify-center">
      {trayInteractions.length > 0 && onRespondInteraction ? (
        <InteractionTray
          interactions={trayInteractions}
          activeIndex={trayIndex}
          onSelectIndex={setActiveInteractionIndex}
          onRespond={onRespondInteraction}
          localCatalog={localCatalog}
        />
      ) : null}
      <ChatComposer
      attachments={attachments}
      composerContextIndicator={composerContextIndicator}
      composerMaxHeight={composerMaxHeight}
      fileInputRef={fileInputRef}
      input={input}
      isMobile={isMobile}
      isStreaming={isStreaming}
      attachmentsEnabled={attachmentsEnabled}
      approvalEnabled={approvalEnabled}
      approvalPolicy={approvalPolicy}
      thinkingEnabled={thinkingEnabled}
      executionMode={executionMode}
      executionModeSupport={executionModeSupport}
      queuedDrafts={queuedDrafts}
      onAppendAttachments={appendAttachments}
      onInputChange={handleInputChange}
      onSelectExecutionMode={setSelectedExecutionMode}
      onPaste={handleComposerPaste}
      onRemoveAttachment={(index) =>
        useUIStore.getState().setAttachments((prev: File[]) =>
          prev.filter((_, attachmentIndex) => attachmentIndex !== index),
        )
      }
      onStopGeneration={stopGeneration}
      onCancelRemote={cancelRemote}
      onSubmit={handleSubmit}
      textareaRef={textareaRef}
      />
    </div>
  );
}
