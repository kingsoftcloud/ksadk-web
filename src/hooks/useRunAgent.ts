import { useRef, useCallback, useEffect, useMemo } from 'react';
import { useStreamingStore } from '../stores/streaming.js';
import { useUIStore } from '../stores/ui.js';
import { useSessionStore } from '../stores/session.js';
import { useMessageStore } from '../stores/message.js';
import type { RuntimeApiFormat } from '../types/api.js';
import type { UiCapabilities } from '../types/capabilities.js';
import type { ApiFacade } from '../core/api/types.js';
import { RunEngineImpl, dispatchRunEventToStores, resetDispatcherState } from '../core/run/index.js';
import type { ModelCatalogItem, Session } from '../components/chat/types.js';
import { writePersistedSessionId } from '../utils/session.js';
import { resolveHostedChatTransport } from '../utils/capabilities.js';
import type { A2UIClientEventMessage } from '@copilotkit/a2ui-renderer';
import type { PermissionMode, RuntimeExecutionMode, RunEngineConfig } from '../core/run/types.js';
import { HttpConversationClient, type OutboxStore } from '../core/conversation/index.js';
import type { ConversationClient } from '../core/conversation/types.js';
import type { ConversationId } from '../core/conversation/studio-controller.js';

type QueuedDraft = {
  text: string;
  attachments: File[];
  executionMode?: RuntimeExecutionMode;
  optimisticMessageId?: string;
};

type RunAgentContext = {
  agentId: string;
  currentSessionId: string | null;
  agentFramework: string;
  apiFormats: RuntimeApiFormat[];
  selectedModel: string;
  selectedModelMetadata?: ModelCatalogItem | null;
  thinkingMode: string;
  permissionMode: PermissionMode;
  uiCapabilities: UiCapabilities;
  isMobile: boolean;
  api: ApiFacade;
  currentSessionIdRef: React.MutableRefObject<string | null>;
  agentIdRef: React.MutableRefObject<string>;
  queuedDraftRef: React.MutableRefObject<QueuedDraft[]>;
  onRunSettled?: (sessionId: string | null, agentId?: string, outcome?: import('../core/run/types.js').RunSettlement) => void;
  onSessionCreated?: (sessionId: string, conversationId?: string, agentId?: string) => void;
  /** Stable owner before native creation. Omit for the legacy Hosted shell. */
  conversationIdRef?: React.MutableRefObject<ConversationId | undefined>;
  waitForPendingSessionCreation?: () => Promise<string | null>;
  /** `null` keeps an embedded host on the legacy action transport. */
  conversationClient?: ConversationClient | null;
  outbox?: OutboxStore;
};

type RunOwner = {
  key: string;
  agentId: string;
  conversationId?: ConversationId;
  sessionId: string | null;
  engine: RunEngineImpl;
  queue: Array<{ draft: QueuedDraft; launch: () => boolean }>;
  isVisible: () => boolean;
};

const MAX_IDLE_RUN_OWNERS = 64;

export function useRunAgent(ctx: RunAgentContext) {
  const ownersRef = useRef(new Map<string, RunOwner>());
  const pruneIdleOwners = useCallback((protectedKey?: string) => {
    const owners = ownersRef.current;
    if (owners.size <= MAX_IDLE_RUN_OWNERS) return;
    for (const [key, owner] of owners) {
      if (owners.size <= MAX_IDLE_RUN_OWNERS) break;
      if (key === protectedKey || owner.engine.stage !== 'idle' || owner.queue.length > 0 || owner.isVisible()) continue;
      owners.delete(key);
    }
  }, []);
  // Same-origin canonical transport for Hosted UI. It resolves fetch lazily
  // so importing the library stays Node/SSR safe.
  const defaultConversationClient = useMemo(() => new HttpConversationClient(), []);
  const conversationClient = ctx.conversationClient === undefined
    ? defaultConversationClient
    : ctx.conversationClient;

  const {
    agentId,
    apiFormats,
    agentFramework,
    selectedModel,
    selectedModelMetadata,
    thinkingMode,
    permissionMode,
    currentSessionIdRef,
    queuedDraftRef,
    onRunSettled,
    onSessionCreated,
    waitForPendingSessionCreation,
    uiCapabilities,
    outbox,
  } = ctx;

  const config = useMemo<RunEngineConfig>(() => ({
    agentId, apiFormats, agentFramework, selectedModel, selectedModelMetadata,
    thinkingMode: uiCapabilities.Thinking ? thinkingMode : 'auto', permissionMode,
    runtimeCapabilityMatrix: uiCapabilities.RuntimeCapabilityMatrix,
    hostedChatTransport: resolveHostedChatTransport(uiCapabilities, {
      requireResumableRun: Boolean(uiCapabilities.RunLifecycle?.Enabled && uiCapabilities.RunLifecycle.Resume),
    }),
    checkpointResumePreviewEnabled: Boolean(uiCapabilities.RunLifecycle?.CheckpointResumePreview),
    conversationClient: conversationClient || undefined,
  }), [agentId, apiFormats, agentFramework, selectedModel, selectedModelMetadata, thinkingMode, permissionMode, uiCapabilities, conversationClient]);

  const getOwner = useCallback((sessionId: string | null | undefined = currentSessionIdRef.current): RunOwner => {
    const conversationId = ctx.conversationIdRef?.current;
    const key = JSON.stringify([agentId, conversationId || sessionId || 'new-session']);
    let owner = ownersRef.current.get(key);
    if (!owner) {
      pruneIdleOwners(key);
      const isVisible = () => ctx.agentIdRef.current === agentId && (
        ctx.conversationIdRef
          ? ctx.conversationIdRef.current === conversationId
          : currentSessionIdRef.current === owner!.sessionId
      );
      const engine = new RunEngineImpl(ctx.api, { isVisible, draftId: conversationId });
      owner = { key, agentId, conversationId, sessionId: sessionId || null, engine, queue: [], isVisible };
      engine.subscribe(event => dispatchRunEventToStores(event, { visible: isVisible(), draftId: conversationId }));
      ownersRef.current.set(key, owner);
    }
    return owner;
  }, [agentId, ctx.agentIdRef, ctx.api, ctx.conversationIdRef, currentSessionIdRef, pruneIdleOwners]);

  const getEngine = useCallback((sessionId?: string | null) => {
    const owner = getOwner(sessionId);
    if (owner.engine.stage === 'idle') owner.engine.updateConfig(config);
    return owner.engine;
  }, [config, getOwner]);

  const publishQueue = useCallback((owner: RunOwner) => {
    if (!owner.isVisible()) return;
    const drafts = owner.queue.map(item => item.draft);
    queuedDraftRef.current = drafts;
    useUIStore.getState().setQueuedDrafts(drafts);
  }, [queuedDraftRef]);

  const drainQueue = useCallback((owner: RunOwner) => {
    const next = owner.queue[0];
    if (!next || owner.engine.stage !== 'idle') return;
    owner.queue.shift();
    publishQueue(owner);
    // The closure captured the submitting owner's target and configuration.
    // Never resolve a queued command against the current navigation selection.
    queueMicrotask(() => {
      if (!next.launch()) {
        owner.queue.unshift(next);
        publishQueue(owner);
      }
    });
  }, [publishQueue]);

  useEffect(() => {
    const key = JSON.stringify([agentId, ctx.conversationIdRef?.current || ctx.currentSessionId || 'new-session']);
    const owner = ownersRef.current.get(key);
    if (owner) publishQueue(owner);
    else {
      queuedDraftRef.current = [];
      useUIStore.getState().setQueuedDrafts([]);
    }
  }, [agentId, ctx.currentSessionId, ctx.conversationIdRef?.current, publishQueue, queuedDraftRef]);

  const appendOptimisticMessage = useCallback((draft: Pick<QueuedDraft, 'text' | 'attachments'>) => {
    const trimmedText = draft.text.trim();
    const userAttachments = draft.attachments.map((file) => ({
      name: file.name,
      url: URL.createObjectURL(file),
      type: file.type || 'application/octet-stream',
    }));
    if (!trimmedText && userAttachments.length === 0) return undefined;

    const userMessageId = `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    useMessageStore.getState().patchMessages((prev) => [
      ...prev,
      {
        id: userMessageId,
        role: 'user',
        content: trimmedText,
        timestamp: Date.now(),
        eventType: 'optimistic_user_message',
        attachments: userAttachments.length ? userAttachments : undefined,
      },
    ]);
    return userMessageId;
  }, []);

  const appendOptimisticAssistant = useCallback((userMessageId?: string) => {
    const messageId = `optimistic-assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    useMessageStore.getState().patchMessages((prev) => {
      const userIndex = prev.findIndex(message => message.id === userMessageId);
      const index = userIndex < 0 ? prev.length : userIndex + 1;
      return [...prev.slice(0, index), {
        id: messageId,
        role: 'model' as const,
        content: '',
        reasoning: '',
        timestamp: Date.now(),
        eventType: 'optimistic_assistant_placeholder',
      }, ...prev.slice(index)];
    });
    return messageId;
  }, []);

  const submitDraft = useCallback(async (
    draftText: string, draftAttachments: File[], responsesInput?: unknown,
    previousResponseId?: string, executionMode?: RuntimeExecutionMode,
    outboxRequestId?: string,
  ) => {
    // Capture the owner before the first await. Navigation can happen while a
    // legacy CreateSession or an attachment upload is still pending.
    const owner = getOwner();
    publishQueue(owner);
    const draft = {
      text: draftText, attachments: [...draftAttachments], responsesInput, previousResponseId, executionMode,
      optimisticMessageId: appendOptimisticMessage({ text: draftText, attachments: draftAttachments }),
    };
    const ledger = owner.conversationId && outbox ? outbox : undefined;
    const outboxEntry = owner.conversationId && ledger
      ? ledger.enqueue({
          requestId: outboxRequestId,
          conversationId: owner.conversationId,
          agentId: owner.agentId,
          text: draftText,
          attachments: draftAttachments.map(file => ({ name: file.name, type: file.type, size: file.size })),
          executionMode,
        })
      : undefined;
    if (outboxEntry && ledger) ledger.setRuntimeAttachments(outboxEntry.requestId, draftAttachments);
    const pendingSessionId = await waitForPendingSessionCreation?.();
    if (!owner.sessionId && pendingSessionId) owner.sessionId = pendingSessionId;

    const launch = (): boolean => {
      if (owner.engine.stage !== 'idle') return false;
      owner.engine.updateConfig(config);
      if (outboxEntry && ledger) ledger.markSending(outboxEntry.requestId);
      if (owner.isVisible()) {
        useUIStore.getState().setMobileActionsOpen(false);
        // Queued turns already have user echoes, but their assistant row must
        // be created only when that turn starts and next to its own input.
        appendOptimisticAssistant(draft.optimisticMessageId);
      }
      useStreamingStore.getState().setSessionStreaming(owner.sessionId || owner.conversationId, true);
      const accepted = owner.engine.start({
        ...draft,
        sessionId: owner.sessionId,
        onSessionCreated: sessionId => {
          const wasVisible = owner.isVisible();
          const previousKey = owner.sessionId || owner.conversationId;
          owner.sessionId = sessionId;
          if (outboxEntry && ledger) ledger.update(outboxEntry.requestId, { nativeSessionId: sessionId });
          useStreamingStore.getState().setSessionStreaming(sessionId, true);
          if (previousKey !== sessionId) useStreamingStore.getState().setSessionStreaming(previousKey, false);
          // Legacy shells acquire a native ID without changing the execution owner.
          if (!owner.conversationId) ownersRef.current.set(JSON.stringify([owner.agentId, sessionId]), owner);
          onSessionCreated?.(sessionId, owner.conversationId, owner.agentId);
          if (!onSessionCreated && wasVisible) {
            useSessionStore.getState().upsertSessions([{ SessionId: sessionId, UpdatedAt: new Date().toISOString() } as unknown as Session]);
            currentSessionIdRef.current = sessionId;
            useSessionStore.getState().setCurrentSessionId(sessionId);
          }
          if (wasVisible) writePersistedSessionId(owner.agentId, sessionId);
        },
        onSessionUpsert: () => {},
        onSettled: (sessionId, outcome = 'unknown') => {
          if (outboxEntry && ledger) ledger.update(outboxEntry.requestId, {
            status: outcome === 'completed' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'unknown',
          });
          onRunSettled?.(sessionId, owner.agentId, outcome);
          if (outcome === 'completed') drainQueue(owner);
        },
      });
      if (accepted && outboxEntry && ledger && owner.engine.activeInvocationId) {
        ledger.update(outboxEntry.requestId, { invocationId: owner.engine.activeInvocationId });
      }
      if (!accepted) useStreamingStore.getState().setSessionStreaming(owner.sessionId || owner.conversationId, false);
      return accepted;
    };
    if (!launch() && responsesInput === undefined) {
      owner.queue.push({ draft, launch });
      publishQueue(owner);
    }
  }, [appendOptimisticAssistant, appendOptimisticMessage, config, currentSessionIdRef, drainQueue, getOwner, onRunSettled, onSessionCreated, outbox, publishQueue, waitForPendingSessionCreation]);

  const stopGeneration = useCallback(() => {
    const engine = getEngine(currentSessionIdRef.current);
    engine.stop();
  }, [currentSessionIdRef, getEngine]);

  const disconnectRun = useCallback(() => {
    const engine = getEngine(currentSessionIdRef.current);
    engine.disconnect();
  }, [currentSessionIdRef, getEngine]);

  const resumeCheckpoint = useCallback(
    (params: { sessionId: string; runId: string; checkpointId: string }) => {
      const owner = getOwner(params.sessionId);
      const engine = getEngine(params.sessionId);
      if (engine.stage !== 'idle') {
        return false;
      }

      resetDispatcherState();
      useUIStore.getState().setMobileActionsOpen(false);
      useStreamingStore.getState().setSessionStreaming(params.sessionId, true);

      const accepted = engine.resumeCheckpoint({
        ...params,
        onSettled: (sessionId) => {
          onRunSettled?.(sessionId, owner.agentId);
          drainQueue(owner);
        },
      });
      if (!accepted) {
        useStreamingStore.getState().setSessionStreaming(params.sessionId, false);
      }
      return accepted;
    },
    [drainQueue, getEngine, getOwner, onRunSettled],
  );

  const resetCompaction = useCallback(() => {
    resetDispatcherState();
  }, []);

  const submitAguiAction = useCallback((message: A2UIClientEventMessage) => {
    const action = message.userAction;
    if (!action) return false;
    const context = action.context || {};
    const interruptId = String(context.interruptId || context.interrupt_id || '');
    if (!interruptId) return false;
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return false;
    const owner = getOwner(sessionId);
    const engine = getEngine(sessionId);
    const status = context.status === 'cancelled' ? 'cancelled' : 'resolved';
    const payload = Object.prototype.hasOwnProperty.call(context, 'payload')
      ? context.payload
      : {
          action: action.name,
          sourceComponentId: action.sourceComponentId,
          context,
        };
    return engine.resumeAguiInterrupt({
      sessionId,
      interruptId,
      status,
      payload,
      onSettled: id => {
        onRunSettled?.(id, owner.agentId);
        drainQueue(owner);
      },
    });
  }, [currentSessionIdRef, drainQueue, getEngine, getOwner, onRunSettled]);

  const respondToAguiApproval = useCallback((options: {
    interruptId: string;
    approve: boolean;
  }) => {
    if (!options.interruptId) return false;
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return false;
    const owner = getOwner(sessionId);
    const engine = getEngine(sessionId);
    if (engine.stage !== 'idle') return false;

    useStreamingStore.getState().setSessionStreaming(sessionId, true);
    const accepted = engine.resumeAguiInterrupt({
      sessionId,
      interruptId: options.interruptId,
      status: 'resolved',
      payload: { decision: options.approve ? 'approve' : 'reject' },
      onSettled: id => {
        onRunSettled?.(id, owner.agentId);
        drainQueue(owner);
      },
    });
    if (!accepted) {
      useStreamingStore.getState().setSessionStreaming(sessionId, false);
    }
    return accepted;
  }, [currentSessionIdRef, drainQueue, getEngine, getOwner, onRunSettled]);

  return {
    submitDraft,
    stopGeneration,
    disconnectRun,
    resumeCheckpoint,
    submitAguiAction,
    respondToAguiApproval,
    resetCompaction,
  };
}
