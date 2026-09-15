import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Message, ModelCatalogItem } from '../components/chat/types.js';
import type { ApiFacade } from '../core/api/types.js';
import { ApiFacadeImpl } from '../core/api/facade.js';
import type { ConversationClient } from '../core/conversation/types.js';
import type { ConversationController, ConversationId } from '../core/conversation/studio-controller.js';
import { scanConversationHistory, type HistorySearchResult } from '../core/conversation/history-search.js';
import type { PermissionMode, RuntimeExecutionMode } from '../core/run/types.js';
import { useBootstrapStore, type BootstrapStore } from '../stores/bootstrap.js';
import { useMessageStore } from '../stores/message.js';
import { useModelStore, type ModelStore, type ThinkingMode } from '../stores/model.js';
import { usePermissionStore } from '../stores/permission.js';
import { useSessionStore, type SessionStore } from '../stores/session.js';
import { useStreamingStore, type StreamingStore } from '../stores/streaming.js';
import { useUIStore } from '../stores/ui.js';
import type { RuntimeApiFormat } from '../types/api.js';
import type { UiCapabilities } from '../types/capabilities.js';
import { writePersistedSessionId } from '../utils/session.js';
import { useBootstrap } from './useBootstrap.js';
import { useFeedback } from './useFeedback.js';
import { useInteractions } from './useInteractions.js';
import { useResponsiveViewport } from './useResponsiveViewport.js';
import { useRunAgent } from './useRunAgent.js';
import { useSessionLifecycle } from './useSessionLifecycle.js';

export type AgentChatSendOptions = {
  attachments?: File[];
  executionMode?: RuntimeExecutionMode;
};

export type AgentChatOptions = {
  api?: ApiFacade;
  agentId?: string;
  /** Whether opening an Agent should automatically restore its last session. */
  restoreSession?: boolean;
  /** Owner-scoped Studio identity and drafts; omit to retain Hosted UI behavior. */
  conversationController?: ConversationController;
  /**
   * Omit for Hosted UI canonical negotiation. Pass `null` when the embedding
   * host intentionally exposes only `/agentengine/api/v1` actions.
   */
  conversationClient?: ConversationClient | null;
};

/**
 * Shared chat controller used by Hosted UI shells, Studio, and custom hosts.
 * It owns bootstrap, session replay, streaming, interactions, approvals, and
 * feedback while leaving layout and styles to exported components.
 *
 * The current 0.3.x runtime supports one mounted controller per page. A future
 * provider-scoped store can lift this constraint without changing this API.
 */
export function useAgentChat(options: AgentChatOptions = {}) {
  const defaultApi = useMemo(() => new ApiFacadeImpl(), []);
  const api = options.api || defaultApi;
  const explicitAgentId = String(options.agentId || '').trim() || undefined;

  const bootstrapStatus = useBootstrapStore((s: BootstrapStore) => s.status);
  const bootstrapErrorMessage = useBootstrapStore((s: BootstrapStore) => s.errorMessage);
  const agentId = useBootstrapStore((s: BootstrapStore) => s.agentId);
  const agentName = useBootstrapStore((s: BootstrapStore) => s.agentName);
  const agentFramework = useBootstrapStore((s: BootstrapStore) => s.agentFramework);
  const apiFormats = useBootstrapStore((s: BootstrapStore) => s.apiFormats) as RuntimeApiFormat[];
  const uiCapabilities = useBootstrapStore((s: BootstrapStore) => s.capabilities) as UiCapabilities;

  const currentSessionId = useSessionStore((s: SessionStore) => s.currentSessionId);
  const [, setDraftRevision] = useState(0);
  const controller = options.conversationController;
  const identityAgentRef = useRef(explicitAgentId || agentId);
  const identityChanged = identityAgentRef.current !== (explicitAgentId || agentId);
  useEffect(() => { identityAgentRef.current = explicitAgentId || agentId; }, [agentId, explicitAgentId]);
  const conversationId = controller?.getOrCreate(
    explicitAgentId || agentId,
    identityChanged ? null : currentSessionId,
  );
  const activeConversationIdRef = useRef(conversationId);
  activeConversationIdRef.current = conversationId;
  const messageHistory = useSessionStore((s: SessionStore) => currentSessionId ? s.messageHistory[currentSessionId] : undefined);
  const sessions = useSessionStore((s: SessionStore) => s.sessions);
  const isLoadingSessions = useSessionStore((s: SessionStore) => s.isLoadingSessions);
  const hasMoreSessions = useSessionStore((s: SessionStore) => s.hasMoreSessions);
  const messages = useMessageStore((s) => s.messages) as Message[];

  const modelCatalogLoaded = useModelStore((s: ModelStore) => s.modelCatalogLoaded);
  const selectedModel = useModelStore((s: ModelStore) => s.selectedModel);
  const availableModels = useModelStore((s: ModelStore) => s.availableModels);
  const thinkingMode = useModelStore((s: ModelStore) => s.thinkingMode);
  const permissionMode = usePermissionStore((s) => s.permissionMode);
  const queuedDrafts = useUIStore((s) => s.queuedDrafts);

  const activity = useStreamingStore((s: StreamingStore) => s.getSessionActivity(currentSessionId || conversationId));
  const isStreaming = useStreamingStore((s: StreamingStore) => s.isSessionStreaming(currentSessionId || conversationId));
  const { isMobile } = useResponsiveViewport();

  const queuedDraftRef = useRef<Array<{
    text: string;
    attachments: File[];
    executionMode?: RuntimeExecutionMode;
  }>>([]);
  const disconnectRunRef = useRef<(() => void) | null>(null);

  const {
    fetchSessions,
    loadMoreSessions,
    loadSession,
    followAcceptedInteraction,
    loadOlderSessionMessages,
    historySearchSnapshot,
    createNewSession,
    startNewConversation: resetConversationView,
    adoptCreatedSession,
    waitForPendingSessionCreation,
    deleteSession,
    currentSessionIdRef,
    agentIdRef,
    runSubscriptionAbortRef,
  } = useSessionLifecycle({
    agentId,
    currentSessionId,
    isMobile,
    uiCapabilities,
    api,
    resetCompaction: () => {},
    disconnectRun: () => disconnectRunRef.current?.(),
    restoreSession: options.restoreSession,
  });

  const refreshSessionsAfterRun = useCallback((sessionId: string | null, submittedAgentId = agentIdRef.current) => {
    if (!sessionId || submittedAgentId !== agentIdRef.current) return;
    void fetchSessions(submittedAgentId, sessionId);
  }, [agentIdRef, fetchSessions]);

  const selectedModelMetadata = useMemo(
    () => (availableModels as ModelCatalogItem[]).find((model) => model.id === selectedModel) || null,
    [availableModels, selectedModel],
  );

  const {
    submitDraft,
    stopGeneration,
    disconnectRun,
    resumeCheckpoint,
    submitAguiAction,
    respondToAguiApproval,
  } = useRunAgent({
    agentId,
    currentSessionId,
    agentFramework,
    apiFormats,
    selectedModel,
    selectedModelMetadata,
    thinkingMode,
    permissionMode,
    uiCapabilities,
    isMobile,
    api,
    currentSessionIdRef,
    agentIdRef,
    queuedDraftRef,
    onRunSettled: refreshSessionsAfterRun,
    conversationIdRef: controller ? activeConversationIdRef : undefined,
    onSessionCreated: (sessionId, submittedConversationId, submittedAgentId = agentId) => {
      if (controller && submittedConversationId) controller.bindNative(submittedConversationId as ConversationId, sessionId);
      // A late create belongs to the submitted draft, even after navigation.
      // Persist its mapping but never let it take over the selected view.
      if (agentIdRef.current !== submittedAgentId
        || (controller && activeConversationIdRef.current !== submittedConversationId)) return;
      adoptCreatedSession(sessionId, true);
    },
    waitForPendingSessionCreation,
    conversationClient: options.conversationClient,
    outbox: controller?.outbox,
  });

  useEffect(() => {
    disconnectRunRef.current = disconnectRun;
  }, [disconnectRun]);

  const stop = useCallback(() => {
    const sessionId = currentSessionIdRef.current;
    runSubscriptionAbortRef.current?.abort();
    useStreamingStore.getState().stopActivity();
    useStreamingStore.getState().stopSessionActivity(sessionId);
    stopGeneration();
  }, [currentSessionIdRef, runSubscriptionAbortRef, stopGeneration]);

  const cancelRemote = useCallback(async () => {
    const sessionId = currentSessionIdRef.current;
    const streaming = useStreamingStore.getState();
    const invocationId = streaming.getSessionActivity(sessionId)?.runId || '';
    if (!sessionId || !invocationId) return;
    await api.cancelRun(agentId, sessionId, invocationId);
    streaming.stopSessionActivity(sessionId, '取消请求已发送。',
      agentIdRef.current === agentId && currentSessionIdRef.current === sessionId);
    refreshSessionsAfterRun(sessionId, agentId);
  }, [agentId, agentIdRef, api, currentSessionIdRef, refreshSessionsAfterRun]);

  const { submitResponseFeedback, deleteResponseFeedback, respondToApproval } = useFeedback({
    agentId,
    currentSessionId,
    isStreaming,
    api,
    submitDraft,
  });

  const respondToApprovalRef = useRef(respondToApproval);
  const respondToAguiApprovalRef = useRef(respondToAguiApproval);
  useEffect(() => {
    respondToApprovalRef.current = respondToApproval;
    respondToAguiApprovalRef.current = respondToAguiApproval;
  }, [respondToApproval, respondToAguiApproval]);

  const {
    pending: pendingInteractions,
    records: interactionRecords,
    respond: respondInteraction,
    localCatalog,
  } = useInteractions({
    agentId,
    getAgentId: () => agentIdRef.current,
    currentSessionId,
    api,
    interactionV1Enabled: Boolean(uiCapabilities.InteractionV1),
    onAcceptedInteraction: followAcceptedInteraction,
    legacyResponsesApproval: (approvalRequestId, approve) => {
      respondToApprovalRef.current({ approvalRequestId, approve });
    },
    legacyAguiResume: (interruptId, status) => (
      respondToAguiApprovalRef.current({ interruptId, approve: status === 'resolved' })
    ),
  });

  const respondInteractionAndContinue = useCallback(async (
    input: Parameters<typeof respondInteraction>[0],
  ) => {
    const receipt = await respondInteraction(input);
    const feedback = input.action === 'cancel'
      ? String(input.response.feedback || '').trim()
      : '';
    if (receipt.status === 'accepted' && feedback) {
      // Codex-style “tell the Agent what to do differently”: cancel the
      // blocked turn first, then enqueue the feedback as a real user turn.
      // submitDraft queues automatically while the cancelled run settles.
      await submitDraft(feedback, []);
    }
    return receipt;
  }, [respondInteraction, submitDraft]);

  useEffect(() => {
    if (!explicitAgentId) return;
    runSubscriptionAbortRef.current?.abort();
    currentSessionIdRef.current = null;
    agentIdRef.current = explicitAgentId;
    useBootstrapStore.getState().setAgentId(explicitAgentId);
    useSessionStore.getState().resetSessionPagination(explicitAgentId);
    useSessionStore.getState().setCurrentSessionId(null);
    useSessionStore.getState().clearSessionMessageHistory();
    useMessageStore.getState().setMessages([]);
    useStreamingStore.getState().setCurrentRunId('');
    useStreamingStore.getState().clearActivity();
    useModelStore.getState().resetCatalog();
  }, [agentIdRef, currentSessionIdRef, explicitAgentId, runSubscriptionAbortRef]);

  useBootstrap({ fetchSessions }, explicitAgentId, api);

  useEffect(() => {
    agentIdRef.current = agentId;
    writePersistedSessionId(agentId, currentSessionId);
  }, [agentId, currentSessionId, agentIdRef]);

  useEffect(() => () => runSubscriptionAbortRef.current?.abort(), [runSubscriptionAbortRef]);

  const send = useCallback((text: string, sendOptions: AgentChatSendOptions = {}) => {
    void submitDraft(
      text,
      sendOptions.attachments || [],
      undefined,
      undefined,
      sendOptions.executionMode,
    );
  }, [submitDraft]);

  const retryOutbox = useCallback(async (requestId: string): Promise<boolean> => {
    if (!controller || !conversationId) return false;
    const entry = controller.outbox.get(requestId);
    if (!entry || entry.conversationId !== conversationId || entry.agentId !== agentId
      || !['failed', 'unknown'].includes(entry.status)) return false;
    const attachments = controller.outbox.getRuntimeAttachments(requestId);
    if (entry.attachments.length > 0 && attachments.length !== entry.attachments.length) return false;
    // Reuse the same request ID so an explicit retry updates the existing
    // ledger entry instead of creating a second side effect with a new key.
    controller.outbox.requeue(requestId);
    await submitDraft(entry.text, attachments, undefined, undefined,
      entry.executionMode as RuntimeExecutionMode | undefined, requestId);
    return true;
  }, [agentId, controller, conversationId, submitDraft]);

  const selectSession = useCallback((sessionId: string | null) => {
    useSessionStore.getState().setCurrentSessionId(sessionId);
    if (sessionId) void loadSession(sessionId);
  }, [loadSession]);

  const startNewConversation = useCallback(() => {
    controller?.navigate();
    activeConversationIdRef.current = controller?.createDraft(explicitAgentId || agentId);
    resetConversationView();
    // null -> null is still a new draft, so it must update the composer owner.
    setDraftRevision((revision) => revision + 1);
  }, [agentId, controller, explicitAgentId, resetConversationView]);

  const loadOlderMessages = useCallback(
    (sessionId?: string) => loadOlderSessionMessages(sessionId || currentSessionIdRef.current || ''),
    [currentSessionIdRef, loadOlderSessionMessages],
  );

  const searchConversation = useCallback((query: string, signal: AbortSignal,
    onProgress?: (result: HistorySearchResult) => void) => {
    const sessionId = currentSessionIdRef.current || '';
    return scanConversationHistory({ query, signal, onProgress, snapshot: historySearchSnapshot,
      readOlder: searchSignal => loadOlderSessionMessages(sessionId, searchSignal) });
  }, [currentSessionIdRef, historySearchSnapshot, loadOlderSessionMessages]);

  const refresh = useCallback(async () => {
    await fetchSessions(agentIdRef.current, currentSessionIdRef.current);
    if (currentSessionIdRef.current) await loadSession(currentSessionIdRef.current);
  }, [agentIdRef, currentSessionIdRef, fetchSessions, loadSession]);

  const compactContext = useCallback(async () => {
    if (!currentSessionId || !api.compactSession || !uiCapabilities.ContextCompaction) {
      throw new Error('当前会话尚不支持手动压缩');
    }
    const result = await api.compactSession(agentId, currentSessionId);
    if (result.Status !== 'completed') throw new Error('运行时尚未确认压缩完成');
    await fetchSessions(agentId, currentSessionId);
  }, [api, agentId, currentSessionId, uiCapabilities.ContextCompaction, fetchSessions]);

  return {
    bootstrapStatus,
    bootstrapErrorMessage,
    agentId,
    agentName,
    agentFramework,
    uiCapabilities,
    sessions,
    currentSessionId,
    conversationId,
    conversationDrafts: controller?.drafts,
    conversationOutbox: controller?.outbox,
    messageHistory,
    isLoadingSessions,
    hasMoreSessions,
    isMobile,
    selectSession,
    createNewSession,
    startNewConversation,
    deleteSession,
    loadMoreSessions,
    loadOlderMessages,
    refresh,
    searchConversation,
    messages,
    activity,
    compactContext,
    isStreaming,
    queuedDrafts,
    send,
    retryOutbox,
    stop,
    cancelRemote,
    resumeCheckpoint,
    pendingInteractions,
    interactionRecords,
    respondInteraction: respondInteractionAndContinue,
    localCatalog,
    respondToApproval,
    submitAguiAction,
    models: availableModels as ModelCatalogItem[],
    selectedModel,
    setModel: (modelId: string) => useModelStore.getState().setSelectedModel(modelId),
    modelCatalogLoaded,
    thinkingMode,
    setThinkingMode: (mode: ThinkingMode) => useModelStore.getState().setThinkingMode(mode),
    permissionMode,
    setPermissionMode: (mode: PermissionMode) => usePermissionStore.getState().setPermissionMode(mode),
    submitResponseFeedback,
    deleteResponseFeedback,
  };
}

export type AgentChatController = ReturnType<typeof useAgentChat>;
