import { useCallback, useEffect, useMemo, useRef } from 'react';

import type { Message, ModelCatalogItem } from '../components/chat/types.js';
import type { ApiFacade } from '../core/api/types.js';
import { ApiFacadeImpl } from '../core/api/facade.js';
import type { ConversationClient } from '../core/conversation/types.js';
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

  const activity = useStreamingStore((s: StreamingStore) => s.getSessionActivity(currentSessionId));
  const isStreaming = useStreamingStore((s: StreamingStore) => s.isSessionStreaming(currentSessionId));
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
    loadOlderSessionMessages,
    createNewSession,
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
  });

  const refreshSessionsAfterRun = useCallback((sessionId: string | null) => {
    if (!sessionId) return;
    void fetchSessions(agentIdRef.current, sessionId);
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
    conversationClient: options.conversationClient,
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
    const invocationId = streaming.getSessionActivity(sessionId)?.runId || streaming.currentRunId || '';
    if (!sessionId || !invocationId) return;
    await api.cancelRun(agentId, sessionId, invocationId);
    streaming.stopSessionActivity(sessionId, '取消请求已发送。');
    refreshSessionsAfterRun(sessionId);
  }, [agentId, api, currentSessionIdRef, refreshSessionsAfterRun]);

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
    legacyResponsesApproval: (approvalRequestId, approve) => {
      respondToApprovalRef.current({ approvalRequestId, approve });
    },
    legacyAguiResume: (interruptId, status) => (
      respondToAguiApprovalRef.current({ interruptId, approve: status === 'resolved' })
    ),
  });

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

  const selectSession = useCallback((sessionId: string | null) => {
    useSessionStore.getState().setCurrentSessionId(sessionId);
    if (sessionId) void loadSession(sessionId);
  }, [loadSession]);

  const loadOlderMessages = useCallback(
    (sessionId?: string) => loadOlderSessionMessages(sessionId || currentSessionIdRef.current || ''),
    [currentSessionIdRef, loadOlderSessionMessages],
  );

  const refresh = useCallback(async () => {
    await fetchSessions(agentIdRef.current, currentSessionIdRef.current);
    if (currentSessionIdRef.current) await loadSession(currentSessionIdRef.current);
  }, [agentIdRef, currentSessionIdRef, fetchSessions, loadSession]);

  return {
    bootstrapStatus,
    bootstrapErrorMessage,
    agentId,
    agentName,
    agentFramework,
    uiCapabilities,
    sessions,
    currentSessionId,
    isLoadingSessions,
    hasMoreSessions,
    isMobile,
    selectSession,
    createNewSession,
    deleteSession,
    loadMoreSessions,
    loadOlderMessages,
    refresh,
    messages,
    activity,
    isStreaming,
    queuedDrafts,
    send,
    stop,
    cancelRemote,
    resumeCheckpoint,
    pendingInteractions,
    interactionRecords,
    respondInteraction,
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
