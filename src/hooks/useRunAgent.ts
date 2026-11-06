import { bootstrapPresentationProfile } from '../core/conversation/agent.js';
import { agentBlockRendererCatalog } from '../core/conversation/renderer-registry.js';
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
import type { A2UIClientEventMessage } from '../core/a2ui/catalog.js';
import type { PermissionMode, RuntimeExecutionMode, RunEngineConfig, RunSettlement } from '../core/run/types.js';
import { HttpConversationClient, type OutboxStore } from '../core/conversation/index.js';
import type { ConversationClient } from '../core/conversation/types.js';
import type { ConversationId } from '../core/conversation/studio-controller.js';
import { useA2uiCatalogRegistry } from '../core/a2ui/provider.js';

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
  onRunSettled?: (sessionId: string | null, agentId?: string, outcome?: RunSettlement) => void;
  onSessionCreated?: (sessionId: string, conversationId?: string, agentId?: string) => void;
  /** Stable owner before native creation. Omit for the legacy Hosted shell. */
  conversationIdRef?: React.MutableRefObject<ConversationId | undefined>;
  /** Reactive selected owner, including null-to-null native draft switches. */
  conversationId?: ConversationId;
  waitForPendingSessionCreation?: () => Promise<string | null>;
  /** `null` keeps an embedded host on the legacy action transport. */
  conversationClient?: ConversationClient | null;
  outbox?: OutboxStore;
};

type QueuedRun = {
  draft: QueuedDraft;
  launch: () => boolean;
  /** Durable feedback: mark the persisted outbox row when the draft is dropped. */
  discard?: (reason: string) => void;
};

type RunOwner = {
  key: string;
  agentId: string;
  conversationId?: ConversationId;
  sessionId: string | null;
  engine: RunEngineImpl;
  queue: QueuedRun[];
  /** Consecutive failed/unknown settlements that still had queued work waiting. */
  failures: number;
  /** Consecutive drain launches rejected by the engine. */
  launchFailures: number;
  retryTimer?: ReturnType<typeof setTimeout>;
  isVisible: () => boolean;
};

const MAX_IDLE_RUN_OWNERS = 64;
/** Backoff base for a queue that could not start (multiplied by the attempt). */
const QUEUE_RETRY_DELAY_MS = 300;
/** Consecutive retries before the queue is dropped loudly instead of stalling. */
const MAX_QUEUE_RETRIES = 3;

function bindNativeOwner(owners: Map<string, RunOwner>, owner: RunOwner, sessionId: string) {
  owner.sessionId = sessionId;
  if (owner.conversationId) return;
  const nativeKey = JSON.stringify([owner.agentId, sessionId]);
  owners.set(nativeKey, owner);
  // Retain the native run, but free its draft alias for a later conversation.
  if (owner.key !== nativeKey && owners.get(owner.key) === owner) owners.delete(owner.key);
  owner.key = nativeKey;
}

export function useRunAgent(ctx: RunAgentContext) {
  const a2uiCatalogRegistry = useA2uiCatalogRegistry();
  const ownersRef = useRef(new Map<string, RunOwner>());
  // Transient ownership distinguishes a live queue from restored pending intent.
  const outboxRequestsRef = useRef(new Set<string>());
  const isOutboxRequestActive = useCallback((requestId: string) => outboxRequestsRef.current.has(requestId), []);
  const pruneIdleOwners = useCallback((protectedKey?: string) => {
    const owners = ownersRef.current;
    if (owners.size <= MAX_IDLE_RUN_OWNERS) return;
    for (const [key, owner] of owners) {
      if (owners.size <= MAX_IDLE_RUN_OWNERS) break;
      if (key === protectedKey || owner.engine.stage !== 'idle' || owner.queue.length > 0 || owner.isVisible()) continue;
      owners.delete(key);
    }
  }, []);
  // Only an advertised ConversationSurface selects the same-origin canonical
  // transport. Older hosted Agents (for example Hermes) expose the legacy
  // action transport, while their local Studio routes require a local session.
  const defaultConversationClient = useMemo(() => new HttpConversationClient({rendererCatalog:agentBlockRendererCatalog}), []);
  const conversationClient = ctx.conversationClient === undefined
    ? (ctx.uiCapabilities.ConversationSurface == null ? null : defaultConversationClient)
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
    conversationIdRef,
    queuedDraftRef,
    onRunSettled,
    onSessionCreated,
    waitForPendingSessionCreation,
    uiCapabilities,
    outbox,
  } = ctx;

  const config = useMemo<RunEngineConfig>(() => ({
    a2uiCatalogRegistry,
    agentId, apiFormats, agentFramework, selectedModel, selectedModelMetadata,
    thinkingMode: uiCapabilities.Thinking ? thinkingMode : 'auto', permissionMode,
    runtimeCapabilityMatrix: uiCapabilities.RuntimeCapabilityMatrix,
    hostedChatTransport: resolveHostedChatTransport(uiCapabilities, {
      requireResumableRun: Boolean(uiCapabilities.RunLifecycle?.Enabled && uiCapabilities.RunLifecycle.Resume),
    }),
    checkpointResumePreviewEnabled: Boolean(uiCapabilities.RunLifecycle?.CheckpointResumePreview),
    kernelSessionEventsEnabled: uiCapabilities.KernelSessionEvents === true || uiCapabilities.KernelSessionEventsByCommand === true,
    kernelCommandEventsEnabled: uiCapabilities.KernelSessionEventsByCommand === true,
    presentationProfile: bootstrapPresentationProfile(uiCapabilities.ConversationSurface, agentBlockRendererCatalog),
    conversationClient: conversationClient || undefined,
  }), [agentId, apiFormats, agentFramework, selectedModel, selectedModelMetadata, thinkingMode, permissionMode, uiCapabilities, conversationClient, a2uiCatalogRegistry]);

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
      owner = {
        key, agentId, conversationId, sessionId: sessionId || null, engine, queue: [],
        failures: 0, launchFailures: 0, isVisible,
      };
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

  const queueControl = useMemo(() => {
    const clearRetry = (owner: RunOwner) => {
      if (owner.retryTimer === undefined) return;
      clearTimeout(owner.retryTimer);
      owner.retryTimer = undefined;
    };

    /** Drop queued drafts only with explicit user-visible feedback. */
    const abandon = (owner: RunOwner, reason: string) => {
      clearRetry(owner);
      owner.failures = 0;
      owner.launchFailures = 0;
      if (!owner.queue.length) return;
      const count = owner.queue.length;
      for (const item of owner.queue.splice(0, count)) item.discard?.(reason);
      publishQueue(owner);
      useUIStore.getState().pushToast(`队列已停止：${reason}，${count} 条待发消息已取消。`, 'error');
    };

    const scheduleRetry = (owner: RunOwner, attempt: number) => {
      if (owner.retryTimer !== undefined) return;
      owner.retryTimer = setTimeout(() => {
        owner.retryTimer = undefined;
        drain(owner);
      }, QUEUE_RETRY_DELAY_MS * attempt);
    };

    function drain(owner: RunOwner) {
      clearRetry(owner);
      const next = owner.queue[0];
      if (!next || owner.engine.stage !== 'idle') return;
      owner.queue.shift();
      publishQueue(owner);
      // The closure captured the submitting owner's target and configuration.
      // Never resolve a queued command against the current navigation selection.
      queueMicrotask(() => {
        if (next.launch()) {
          owner.launchFailures = 0;
          return;
        }
        owner.queue.unshift(next);
        publishQueue(owner);
        // A rejected launch used to strand the queue here until the next settlement.
        retryLaunch(owner);
      });
    }

    function retryLaunch(owner: RunOwner) {
      owner.launchFailures += 1;
      if (owner.launchFailures > MAX_QUEUE_RETRIES) {
        abandon(owner, `待发消息连续 ${MAX_QUEUE_RETRIES} 次无法启动`);
        return;
      }
      scheduleRetry(owner, owner.launchFailures);
    }

    /**
     * Continue one owner queue after its run settles. A settlement is the only
     * reliable "engine idle again" signal, but it is not always a success:
     * - completed / cancelled: the turn ended (cancel is user intent), send next.
     * - awaiting-input: a pending approval/question can only be answered while
     *   this engine is idle (respondToAguiApproval and the Responses resume both
     *   reject otherwise), so the queue waits for that interaction round.
     * - failed / unknown: back off and retry, then drop loudly after three tries.
     */
    function settle(owner: RunOwner, outcome?: RunSettlement) {
      if (outcome === 'failed' || outcome === 'unknown') {
        if (!owner.queue.length) {
          owner.failures = 0;
          return;
        }
        owner.failures += 1;
        if (owner.failures > MAX_QUEUE_RETRIES) {
          abandon(owner, `连续 ${MAX_QUEUE_RETRIES} 次发送失败`);
          return;
        }
        scheduleRetry(owner, owner.failures);
        return;
      }
      if (outcome === 'awaiting-input') return;
      owner.failures = 0;
      drain(owner);
    }

    return { drain, retryLaunch, settle, abandon };
  }, [publishQueue]);

  useEffect(() => {
    const key = JSON.stringify([agentId, ctx.conversationId || conversationIdRef?.current || ctx.currentSessionId || 'new-session']);
    const owner = ownersRef.current.get(key);
    if (owner) publishQueue(owner);
    else {
      queuedDraftRef.current = [];
      useUIStore.getState().setQueuedDrafts([]);
    }
  }, [agentId, ctx.currentSessionId, ctx.conversationId, conversationIdRef, publishQueue, queuedDraftRef]);

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
  ): Promise<boolean> => {
    if (outboxRequestId && outboxRequestsRef.current.has(outboxRequestId)) return false;
    // Capture the owner before the first await. Navigation can happen while a
    // legacy CreateSession or an attachment upload is still pending.
    const owner = getOwner();
    publishQueue(owner);
    const draft = {
      text: draftText, attachments: [...draftAttachments], responsesInput, previousResponseId, executionMode,
      optimisticMessageId: appendOptimisticMessage({ text: draftText, attachments: draftAttachments }),
    };
    // Legacy approval/resume inputs are tracked by the interaction store, not
    // the text outbox, which cannot persist their protocol payload for replay.
    const ledger = responsesInput === undefined && owner.conversationId && outbox ? outbox : undefined;
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
    if (outboxEntry && ledger) {
      outboxRequestsRef.current.add(outboxEntry.requestId);
      ledger.setRuntimeAttachments(outboxEntry.requestId, draftAttachments);
    }
    let pendingSessionId: string | null | undefined;
    try { pendingSessionId = await waitForPendingSessionCreation?.(); }
    catch (error) {
      if (outboxEntry && ledger) {
        outboxRequestsRef.current.delete(outboxEntry.requestId);
        ledger.update(outboxEntry.requestId, { status: 'unknown', error: '创建会话的结果待确认。' });
      }
      throw error;
    }
    if (!owner.sessionId && pendingSessionId) bindNativeOwner(ownersRef.current, owner, pendingSessionId);

    let confirmDispatch: ((accepted: boolean) => void) | undefined;
    const dispatch = responsesInput !== undefined
      ? new Promise<boolean>(resolve => { confirmDispatch = resolve; })
      : null;

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
        onInvocationCreated: invocationId => {
          if (outboxEntry && ledger) ledger.update(outboxEntry.requestId, { invocationId });
          // Bind the submitted input by identity, never by text or by the last
          // user row (which can belong to a queued turn or another session).
          if (owner.isVisible()) {
            useMessageStore.getState().patchMessages(rows => rows.map(message =>
              message.id === draft.optimisticMessageId ? { ...message, invocationId } : message));
          }
        },
        onSessionCreated: sessionId => {
          const wasVisible = owner.isVisible();
          const previousKey = owner.sessionId || owner.conversationId;
          bindNativeOwner(ownersRef.current, owner, sessionId);
          if (outboxEntry && ledger) ledger.update(outboxEntry.requestId, { nativeSessionId: sessionId });
          useStreamingStore.getState().setSessionStreaming(sessionId, true);
          if (previousKey !== sessionId) useStreamingStore.getState().setSessionStreaming(previousKey, false);
          onSessionCreated?.(sessionId, owner.conversationId, owner.agentId);
          if (!onSessionCreated && wasVisible) {
            useSessionStore.getState().upsertSessions([{ SessionId: sessionId, UpdatedAt: new Date().toISOString() } as unknown as Session]);
            currentSessionIdRef.current = sessionId;
            useSessionStore.getState().setCurrentSessionId(sessionId);
          }
          if (wasVisible) writePersistedSessionId(owner.agentId, sessionId);
        },
        onSessionUpsert: () => {},
        onDispatchResult: confirmDispatch,
        onSettled: (sessionId, outcome = 'unknown') => {
          if (outboxEntry) outboxRequestsRef.current.delete(outboxEntry.requestId);
          if (outboxEntry && ledger) ledger.update(outboxEntry.requestId, {
            // The outbox tracks delivery: an actionable approval proves the input was accepted.
            status: outcome === 'completed' || outcome === 'awaiting-input' ? 'completed' : outcome === 'cancelled' ? 'cancelled' : outcome === 'failed' ? 'failed' : 'unknown',
          });
          onRunSettled?.(sessionId, owner.agentId, outcome);
          queueControl.settle(owner, outcome);
        },
      });
      if (!accepted) useStreamingStore.getState().setSessionStreaming(owner.sessionId || owner.conversationId, false);
      return accepted;
    };
    const started = launch();
    if (!started && responsesInput === undefined) {
      owner.queue.push({
        draft,
        launch,
        discard: reason => {
          if (!outboxEntry || !ledger) return;
          outboxRequestsRef.current.delete(outboxEntry.requestId);
          ledger.update(outboxEntry.requestId, { status: 'cancelled', error: reason });
        },
      });
      publishQueue(owner);
      // Ordinary user turns are accepted into the owner queue even when the
      // engine is busy.  Resume/approval inputs are deliberately never queued
      // because replaying them against a later run could approve the wrong
      // request; callers need the false result to keep the interaction retryable.
      // A launch refused while already idle would otherwise never be retried.
      if (owner.engine.stage === 'idle') queueControl.retryLaunch(owner);
      return true;
    }
    if (dispatch) {
      if (!started) confirmDispatch?.(false);
      return dispatch;
    }
    return started;
  }, [appendOptimisticAssistant, appendOptimisticMessage, config, currentSessionIdRef, getOwner, onRunSettled, onSessionCreated, outbox, publishQueue, queueControl, waitForPendingSessionCreation]);

  const stopGeneration = useCallback(() => {
    const engine = getEngine(currentSessionIdRef.current);
    engine.stop();
  }, [currentSessionIdRef, getEngine]);

  /**
   * Abandon this owner's live run. `disconnect()` bypasses `onSettled`, so the
   * owner queue would otherwise be stranded silently:
   * - `switch` (navigation/guard): the session still exists and each owner has
   *   its own engine, so keep sending the queued drafts in the background.
   * - `delete`: the native session is gone; drop the drafts with a visible toast
   *   instead of launching runs against a deleted session.
   */
  const disconnectRun = useCallback((reason: 'switch' | 'delete' = 'switch') => {
    const owner = getOwner(currentSessionIdRef.current);
    owner.engine.disconnect();
    if (!owner.queue.length) return;
    if (reason === 'delete') {
      queueControl.abandon(owner, '会话已删除');
      return;
    }
    queueControl.drain(owner);
  }, [currentSessionIdRef, getOwner, queueControl]);

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
        onSettled: (sessionId, outcome) => {
          onRunSettled?.(sessionId, owner.agentId, outcome);
          queueControl.settle(owner, outcome);
        },
      });
      if (!accepted) {
        useStreamingStore.getState().setSessionStreaming(params.sessionId, false);
      }
      return accepted;
    },
    [getEngine, getOwner, onRunSettled, queueControl],
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
      onSettled: (id, outcome) => {
        onRunSettled?.(id, owner.agentId);
        queueControl.settle(owner, outcome);
      },
    });
  }, [currentSessionIdRef, getEngine, getOwner, onRunSettled, queueControl]);

  const respondToAguiApproval = useCallback((options: {
    interruptId: string;
    approve: boolean;
    status?: 'resolved' | 'cancelled';
    payload?: unknown;
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
      status: options.status || 'resolved',
      payload: Object.hasOwn(options, 'payload')
        ? options.payload : { decision: options.approve ? 'approve' : 'reject' },
      onSettled: (id, outcome) => {
        onRunSettled?.(id, owner.agentId);
        queueControl.settle(owner, outcome);
      },
    });
    if (!accepted) {
      useStreamingStore.getState().setSessionStreaming(sessionId, false);
    }
    return accepted;
  }, [currentSessionIdRef, getEngine, getOwner, onRunSettled, queueControl]);

  return {
    submitDraft,
    isOutboxRequestActive,
    stopGeneration,
    disconnectRun,
    resumeCheckpoint,
    submitAguiAction,
    respondToAguiApproval,
    resetCompaction,
  };
}
