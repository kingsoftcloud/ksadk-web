import { mergeHistoryWithLive } from '../utils/transcript-order.js';
import { isHistoryPreparing, readPreparedHistory } from '../utils/history-preparation.js';
import { bootstrapPresentationProfile } from '../core/conversation/agent.js';
import { agentBlockRendererCatalog } from '../core/conversation/renderer-registry.js';
import { RuntimeConversationIngress } from '../core/conversation/runtime-ingress.js';
import { projectConversationItems } from '../core/conversation/presentation.js';
import { hydrateKernelRunHistory } from '../utils/kernel-run-history.js';
import { hydrateVisibleInteractionHistory } from '../utils/interaction-history.js';
import { useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/session.js';
import { useMessageStore } from '../stores/message.js';
import { useUIStore } from '../stores/ui.js';
import { useCheckpointStore } from '../stores/checkpoint.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { ApiError, CancelledError } from '../api/client.js';
import {
  eventHasTerminalRunStatus,
  maxSeqIdFromEvents,
  mergeSessionEventRecords,
  sessionEventRunStatus,
} from '../utils/session-events.js';
import { mapBackendMessages } from '../utils/messages.js';
import { rebuildPersistedSessionHistory } from '../utils/persisted-session-history.js';
import { useStreamingStore } from '../stores/streaming.js';
import { shouldRenderFeedbackControls, normalizeFeedback } from '../utils/feedback.js';
import {
  mergePendingSessions,
  readPersistedSessionId,
  resolveSessionToRestore,
} from '../utils/session.js';
import { resolveNextSessionsPage } from '../utils/session-pagination.js';
import type { Message, Session } from '../components/chat/types.js';
import type { SessionEventRecord } from '../types/session-events.js';
import type { UiCapabilities } from '../types/capabilities.js';
import type { ApiFacade } from '../core/api/types.js';
import type { ListSessionMessagesResponse } from '../api/messages.js';
import { dispatchRunEventToStores } from '../core/run/dispatcher.js';
import { parseSseChunk, splitSseBuffer } from '../core/transport/sse-parser.js';
import {
  createSessionEventCursor,
} from '../utils/session-event-history.js';
import { ingestLegacyApprovalHistory, ingestSessionEventRecord } from '../core/interaction/index.js';
import type { Interaction } from '../core/interaction/types.js';

const RESTORE_RECONNECT_DELAY_MS = 500;
const SESSION_LIST_PAGE_SIZE = 30;
const SESSION_MESSAGES_PAGE_SIZE = 50;
// Tool-heavy runs can make 200 canonical events exceed half a MiB. The
// durable Messages projection paints the readable transcript first; hydrate
// a smaller newest-event window and page older runtime detail on upward scroll.
// A partial run keeps its complete Messages projection until enough canonical
// events arrive; smaller detail pages therefore do not truncate visible text.
const SESSION_EVENTS_PAGE_SIZE = 64;
const SESSION_TRANSCRIPT_CACHE_SIZE = 8;
const SESSION_METADATA_CACHE_SIZE = 128;
const EMPTY_STATUS_RECOVERY_WINDOW_MS = 30 * 60 * 1000;

type SessionEventHistoryCache = {
  events: SessionEventRecord[];
  loadedCount: number;
  total: number;
  cursorSource?: string;
  historyEpoch?: string;
  snapshotSeqId?: number;
};

type HistorySource = {
  CursorSource?: string;
  HistoryEpoch?: string;
  SnapshotSeqId?: number;
  CursorCompatibleWithRuntime?: boolean;
};

function compatibleHistorySource(left: HistorySource, right: HistorySource): boolean {
  // Missing provenance is compatible only with another legacy, untagged page.
  // A tagged control fallback must never absorb an untagged runtime page.
  if (left.CursorSource !== right.CursorSource) return false;
  if (left.HistoryEpoch !== right.HistoryEpoch) return false;
  if (left.SnapshotSeqId !== undefined && right.SnapshotSeqId !== undefined
    && left.SnapshotSeqId !== right.SnapshotSeqId) return false;
  if (!left.CursorSource && (left.CursorCompatibleWithRuntime === false
    || right.CursorCompatibleWithRuntime === false)) return false;
  return true;
}

function eventCacheSource(cache: SessionEventHistoryCache): HistorySource {
  return { CursorSource: cache.cursorSource, HistoryEpoch: cache.historyEpoch,
    SnapshotSeqId: cache.snapshotSeqId };
}

function historyErrorReason(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.detail || typeof error.detail !== 'object') return undefined;
  const detail = error.detail as { ReasonCode?: unknown };
  return typeof detail.ReasonCode === 'string' ? detail.ReasonCode : undefined;
}

function isHistoryReloadRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === 409
    && historyErrorReason(error) === 'HISTORY_RELOAD_REQUIRED';
}

function reloadRequiredError(): ApiError {
  return new ApiError(409, '历史来源已变化', {
    Code: 409, ReasonCode: 'HISTORY_RELOAD_REQUIRED', Data: null,
  });
}

function historyPageMetadata(page: Omit<ListSessionMessagesResponse, 'Messages'>) {
  return {
    dataSource: page.DataSource,
    degraded: page.Degraded,
    cursorSource: page.CursorSource,
    cursorCompatibleWithRuntime: page.CursorCompatibleWithRuntime,
    sessionContractVersion: page.SessionContractVersion,
    historyEpoch: page.HistoryEpoch,
    persistenceDegraded: page.PersistenceDegraded,
    snapshotSeqId: page.SnapshotSeqId,
    error: undefined,
    preparing: false,
  };
}

/** Keep per-session read caches bounded while retaining the currently visible session. */
function rememberSessionCache<T>(
  cache: Map<string, T>,
  sessionId: string,
  value: T,
  protectedSessionId: string | null,
  maxEntries = SESSION_METADATA_CACHE_SIZE,
): void {
  cache.delete(sessionId);
  cache.set(sessionId, value);
  while (cache.size > maxEntries) {
    const candidate = [...cache.keys()].find(key => key !== protectedSessionId);
    if (!candidate) break;
    cache.delete(candidate);
  }
}

function waitForRestoreRetry(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = globalThis.setTimeout(resolve, RESTORE_RECONNECT_DELAY_MS);
    signal.addEventListener('abort', () => {
      globalThis.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

// 重连判据:ActiveRunStatus 属于这些态时认为有活跃 run(对齐后端 RUN_STATUS_ACTIVE)。
const ACTIVE_RUN_STATUSES = new Set([
  'in_progress',
  'running',
  'resuming',
  'starting',
]);

function isRecentlyUpdatedSession(session: { UpdatedAt?: string; ActiveRunUpdatedAt?: string }): boolean {
  const rawTimestamp = session.ActiveRunUpdatedAt || session.UpdatedAt;
  const timestamp = typeof rawTimestamp === 'number'
    ? (rawTimestamp > 1e11 ? rawTimestamp : rawTimestamp * 1000)
    : Date.parse(String(rawTimestamp || ''));
  return Number.isFinite(timestamp)
    && timestamp <= Date.now() + EMPTY_STATUS_RECOVERY_WINDOW_MS
    && Date.now() - timestamp <= EMPTY_STATUS_RECOVERY_WINDOW_MS;
}

function terminalActivityForRunEvent(event: SessionEventRecord): {
  status: 'completed' | 'failed' | 'stopped';
  phase: string;
} | null {
  const rawStatus = sessionEventRunStatus(event);
  if (!rawStatus) return null;
  if (rawStatus === 'completed') {
    return { status: 'completed', phase: '后台长任务已完成' };
  }
  if (rawStatus === 'cancelled' || rawStatus === 'canceled' || rawStatus === 'aborted') {
    return { status: 'stopped', phase: '后台长任务已取消' };
  }
  if (rawStatus === 'interrupted') {
    return { status: 'stopped', phase: '后台长任务已中断' };
  }
  if (rawStatus === 'failed' || rawStatus === 'error') {
    return { status: 'failed', phase: '后台长任务失败' };
  }
  if (rawStatus === 'resume_failed') {
    return { status: 'failed', phase: '后台长任务恢复失败' };
  }
  return null;
}

type SessionLifecycleContext = {
  agentId: string;
  currentSessionId: string | null;
  isMobile: boolean;
  uiCapabilities: UiCapabilities;
  api: ApiFacade;
  resetCompaction: () => void;
  disconnectRun?: () => void;
  restoreSession?: boolean;
};

export function useSessionLifecycle(ctx: SessionLifecycleContext) {
  const {
    agentId,
    api,
    isMobile,
    resetCompaction,
    uiCapabilities,
    disconnectRun,
    restoreSession = true,
  } = ctx;
  const currentSessionIdRef = useRef<string | null>(ctx.currentSessionId);
  const agentIdRef = useRef(ctx.agentId);
  const uiCapabilitiesRef = useRef(uiCapabilities);
  uiCapabilitiesRef.current = uiCapabilities;
  const runSubscriptionAbortRef = useRef<AbortController | null>(null);
  // agent-kernel/v1 unified cursor: only the Session seq dedupes/orders and
  // drives reconnects; Responses/AG-UI/A2A internal event ids are ignored.
  const sessionEventCursorRef = useRef(createSessionEventCursor());
  const loadSessionGenerationRef = useRef(0);
  // The readable fallback can paint before RuntimeEvent hydration finishes.
  // Search must wait for stable canonical message identities, independently
  // of the loading skeleton (which should disappear as soon as text is ready).
  const historyHydrationGenerationRef = useRef<number | null>(null);
  const historyReadFailureRef = useRef<{ generation: number; message: string } | null>(null);
  const olderMessageRequestRef = useRef(new Map<string, symbol>());
  const canonicalRunIdsBySessionRef = useRef(new Map<string, Set<string>>());
  const persistedTranscriptBySessionRef = useRef(new Map<string, Message[]>());
  const sessionTranscriptCacheRef = useRef(new Map<string, Message[]>());
  const historyProfileBySessionRef = useRef(new Map<string, 'flat-v1' | 'agent-block-v1'>());
  const fallbackHistoryBySessionRef = useRef(new Map<string, Message[]>());
  const eventHistoryBySessionRef = useRef(new Map<string, SessionEventHistoryCache>());
  // CreateSession can become usable before ListSessions' projection catches up.
  // Keep those optimistic rows until the server returns them so a settled-run
  // refresh cannot evict the active transcript in that short window.
  const pendingCreatedSessionAgentsRef = useRef(new Map<string, string>());
  const sessionCreationPromiseRef = useRef<Promise<string | null> | null>(null);
  const localDraftAgentRef = useRef<string | null>(null);
  const loadSessionRef = useRef<((sessionId: string, historyReload?: boolean, signal?: AbortSignal) => Promise<void>) | null>(null);
  const fetchSessionsRef = useRef<
    ((
      targetAgentId?: string,
      preferredSessionId?: string | null,
    ) => Promise<void>) | null
  >(null);

  const loadFeedbackForMessages = useCallback(
    async (targetAgentId: string, sessionId: string, history: Message[]) => {
      const targets = history.filter((message) =>
        shouldRenderFeedbackControls(message, false, false),
      );
      if (!targets.length) {
        return;
      }

      const entries = await Promise.all(
        targets.map(async (message) => {
          try {
            const data = await api.getResponseFeedback({
              AgentId: targetAgentId,
              SessionId: sessionId,
              ResponseId: message.responseId,
              EventId: message.eventId,
            });
            const rawData = data as Record<string, unknown> | null;
            const feedbackData = rawData?.Feedback
              ? normalizeFeedback(rawData.Feedback)
              : null;
            return feedbackData ? { messageId: message.id, feedback: feedbackData } : null;
          } catch (error) {
            console.error('Failed to load response feedback:', error);
            return null;
          }
        }),
      );

      if (currentSessionIdRef.current !== sessionId) {
        return;
      }
      const feedbackByMessageId = new Map(
        entries
          .filter(
            (entry): entry is { messageId: string; feedback: NonNullable<Message['feedback']> } =>
              Boolean(entry),
          )
          .map((entry) => [entry.messageId, entry.feedback]),
      );
      if (!feedbackByMessageId.size) {
        return;
      }
      useMessageStore.getState().patchMessages((prev) =>
        prev.map((message) =>
          feedbackByMessageId.has(message.id)
            ? { ...message, feedback: feedbackByMessageId.get(message.id) }
            : message,
        ),
      );
    },
    [api],
  );

  const subscribeRunEvents = useCallback(
    async (options: {
      sessionId: string;
      invocationId: string;
      afterSeqId: number;
    }) => {
      runSubscriptionAbortRef.current?.abort();
      const controller = new AbortController();
      runSubscriptionAbortRef.current = controller;
      let shouldReloadSession = false;
      let terminalStatusSeen = false;
      let cancelledByCaller = false;
      const bootstrap = useBootstrapStore.getState();
      const capabilities = bootstrap.agentId === agentIdRef.current ? bootstrap.capabilities : uiCapabilitiesRef.current;
      const nativeRecovery = capabilities.KernelSessionEventsByCommand === true;
      const profile = bootstrapPresentationProfile(capabilities.ConversationSurface, agentBlockRendererCatalog);
      const canonical = new RuntimeConversationIngress(options.sessionId, undefined, profile);
      // This endpoint is explicitly bound to InvocationId by Server. Start
      // from that run's boundary so its descriptor precedes remote children;
      // reconnects then keep the last observed cursor and the same reducer.
      let afterSeqId = nativeRecovery ? 0 : options.afterSeqId;
      const isCurrentSubscription = () => (
        runSubscriptionAbortRef.current === controller
        && currentSessionIdRef.current === options.sessionId
      );

      try {
        useStreamingStore.getState().setCurrentRunId(options.invocationId);
        useStreamingStore.getState().setActiveInvocationId(options.invocationId);
        useStreamingStore.getState().setSessionStreaming(options.sessionId, true);
        useStreamingStore.getState().updateActivity({
          sessionId: options.sessionId,
          runId: options.invocationId,
          source: 'restore',
          status: 'running',
          phase: '正在同步任务进展',
          detail: options.invocationId,
          countEvent: false,
        });

        while (!terminalStatusSeen && isCurrentSubscription()) {
          try {
            const stream = await api.subscribeRunEvents(
              {
                sessionId: options.sessionId,
                invocationId: options.invocationId,
                afterSeqId,
              },
              { signal: controller.signal },
            );
            if (!isCurrentSubscription()) {
              controller.abort();
              return;
            }
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            while (!terminalStatusSeen && isCurrentSubscription()) {
              const { value, done } = await reader.read();
              if (done) break;
              buffer += decoder.decode(value, { stream: true });
              const split = splitSseBuffer(buffer);
              buffer = split.remainder;

              for (const chunk of split.chunks) {
                if (!chunk.trim()) continue;
                for (const transportEvent of parseSseChunk(chunk)) {
                  if (transportEvent.eventName === '__ping__') {
                    // SubscribeRunEvents heartbeats mean the recovery stream is still
                    // open even when the runtime has not produced a new durable event.
                    useStreamingStore.getState().updateActivity({
                      sessionId: options.sessionId,
                      status: 'running',
                      phase: '正在处理',
                      countEvent: false,
                    });
                    continue;
                  }
                  if (transportEvent.eventName === '__done__') {
                    terminalStatusSeen = true;
                    shouldReloadSession = true;
                    break;
                  }
                  if (!transportEvent.data || typeof transportEvent.data !== 'object') continue;
                  const event = transportEvent.data as SessionEventRecord;
                  if (!isCurrentSubscription()) break;
                  if (event.InvocationId && event.InvocationId !== options.invocationId) continue;

                  useStreamingStore.getState().updateActivity({
                    sessionId: options.sessionId,
                    status: 'running',
                    phase: '正在处理',
                    countEvent: false,
                  });

                  const kernelSeq = (event as { seq?: unknown }).seq;
                  if (typeof kernelSeq === 'number') {
                    // agent-kernel/v1 envelope: fold into the unified cursor.
                    try {
                      sessionEventCursorRef.current.accept(event);
                    } catch (cursorError) {
                      console.error('[SessionLifecycle] session event cursor conflict:', cursorError);
                    }
                    afterSeqId = Math.max(afterSeqId, sessionEventCursorRef.current.reconnectAfterSeq());
                    dispatchRunEventToStores({
                      type: 'stream_event',
                      sessionId: options.sessionId,
                      event,
                    });
                    terminalStatusSeen = terminalStatusSeen || eventHasTerminalRunStatus(event);
                    shouldReloadSession = shouldReloadSession || terminalStatusSeen;
                    const kernelTerminal = terminalActivityForRunEvent(event);
                    if (kernelTerminal) {
                      useStreamingStore.getState().updateActivity({
                        sessionId: options.sessionId,
                        status: kernelTerminal.status,
                        phase: kernelTerminal.phase,
                        detail: options.invocationId,
                        countEvent: false,
                      });
                    }
                    continue;
                  }

                  const seqId = Number(event.SeqId || 0);
                  if (Number.isFinite(seqId)) {
                    afterSeqId = Math.max(afterSeqId, seqId);
                  }
                  const frame = (event.Content as { runtime_event?: Record<string, unknown> } | undefined)?.runtime_event;
                  if (nativeRecovery && frame?.schema_version === 2 && frame.run_id === options.invocationId) {
                    if (canonical.apply(frame)) {
                      const state = canonical.snapshot();
                      dispatchRunEventToStores({
                        type: 'conversation_snapshot', sessionId: options.sessionId,
                        result: { state, presentation: projectConversationItems(state, { profile }),
                          runId: options.invocationId, cursor: afterSeqId },
                      });
                    }
                  }
                  dispatchRunEventToStores({
                    type: 'stream_event',
                    sessionId: options.sessionId,
                    event,
                  });
                  terminalStatusSeen = terminalStatusSeen || eventHasTerminalRunStatus(event);
                  shouldReloadSession = shouldReloadSession || terminalStatusSeen;
                  const terminalActivity = terminalActivityForRunEvent(event);
                  if (terminalActivity) {
                    useStreamingStore.getState().updateActivity({
                      sessionId: options.sessionId,
                      status: terminalActivity.status,
                      phase: terminalActivity.phase,
                      detail: options.invocationId,
                      countEvent: false,
                    });
                  }
                  if (terminalStatusSeen) break;
                }
                if (terminalStatusSeen) break;
              }
            }
            if (terminalStatusSeen) {
              void reader.cancel().catch(() => {});
            }
          } catch (error) {
            const isAbortError = error instanceof DOMException && error.name === 'AbortError';
            const isCancelledSubscription = isAbortError
              || error instanceof CancelledError
              || controller.signal.aborted;
            if (isCancelledSubscription) {
              // AgentEngineClient maps an aborted fetch to CancelledError.
              // Treat that as explicit lifecycle cleanup, rather than a
              // transient disconnect: otherwise the already-aborted signal
              // is retried immediately forever (waitForRestoreRetry resolves
              // synchronously for an aborted signal).
              terminalStatusSeen = true;
              cancelledByCaller = true;
              if (isCurrentSubscription()) {
                useStreamingStore.getState().stopSessionActivity(
                  options.sessionId,
                  '恢复事件订阅已取消。',
                );
              }
              break;
            }
            if (!isCurrentSubscription()) break;
            // Authentication, authorization, and invalid-session responses
            // cannot be repaired by replaying the same subscription. Retrying
            // them forever left the UI in a permanent "恢复连接中" state and
            // generated a request every 500ms after a session expired. Surface
            // the existing run error/banner path and stop this subscription;
            // transient network failures and server errors still reconnect.
            const isPermanentClientError = error instanceof ApiError
              && error.code >= 400
              && error.code < 500
              && error.code !== 408
              && error.code !== 429;
            if (isPermanentClientError) {
              terminalStatusSeen = true;
              shouldReloadSession = false;
              dispatchRunEventToStores({
                type: 'error',
                sessionId: options.sessionId,
                error,
              });
              break;
            }
            console.warn('Run event subscription disconnected; retrying:', error);
            useStreamingStore.getState().updateActivity({
              sessionId: options.sessionId,
              status: 'waiting',
              phase: '恢复连接中',
              detail: options.invocationId,
              countEvent: false,
            });
          }

          if (!terminalStatusSeen && isCurrentSubscription()) {
            await waitForRestoreRetry(controller.signal);
          }
        }

        if (terminalStatusSeen && !cancelledByCaller && isCurrentSubscription()) {
          dispatchRunEventToStores({ type: 'stream_ended', sessionId: options.sessionId });
        }
      } catch (error) {
        const isAbortError = error instanceof DOMException && error.name === 'AbortError';
        if (!isAbortError) {
          console.error('Failed to subscribe run events:', error);
        }
      } finally {
        const ownedCurrentSubscription = runSubscriptionAbortRef.current === controller;
        if (ownedCurrentSubscription) {
          runSubscriptionAbortRef.current = null;
        }
        if (ownedCurrentSubscription && currentSessionIdRef.current === options.sessionId) {
          useStreamingStore.getState().setCurrentRunId('');
          useStreamingStore.getState().setActiveInvocationId('');
          if (shouldReloadSession) {
            void loadSessionRef.current?.(options.sessionId);
          }
          void fetchSessionsRef.current?.(agentIdRef.current, options.sessionId);
        }
      }
    },
    [api],
  );

  const followAcceptedInteraction = useCallback((interaction: Interaction) => {
    // The inbox receipt does not mean the run has finished resuming. Follow
    // its durable identity even while GetSession still projects waiting_input.
    if (!uiCapabilitiesRef.current.RunLifecycle.Enabled || !interaction.runId
      || agentIdRef.current !== agentId
      || currentSessionIdRef.current !== interaction.sessionId
      || runSubscriptionAbortRef.current) return;
    const activity = useStreamingStore.getState().getSessionActivity(interaction.sessionId);
    if (uiCapabilitiesRef.current.KernelSessionEventsByCommand === true
      && useStreamingStore.getState().isSessionStreaming(interaction.sessionId)
      && activity?.source === 'run' && activity.runId === interaction.runId
      && ['connecting', 'running', 'waiting'].includes(activity.status)) return;
    void subscribeRunEvents({
      sessionId: interaction.sessionId,
      invocationId: interaction.runId,
      afterSeqId: maxSeqIdFromEvents(
        eventHistoryBySessionRef.current.get(interaction.sessionId)?.events || [],
      ),
    });
  }, [agentId, subscribeRunEvents]);

  const loadSession = useCallback(
    async (sessionId: string, historyReload = false, signal?: AbortSignal) => {
      if (signal?.aborted) return;
      localDraftAgentRef.current = null;
      // Bootstrap can invoke the initial list callback before React replaces
      // its closure. Read the committed capabilities for this Agent, then
      // freeze the selected profile for this history read and its pages.
      const bootstrap = useBootstrapStore.getState();
      const capabilities = bootstrap.agentId === agentIdRef.current ? bootstrap.capabilities : uiCapabilitiesRef.current;
      const profile = bootstrapPresentationProfile(capabilities.ConversationSurface, agentBlockRendererCatalog);
      historyProfileBySessionRef.current.set(sessionId, profile);
      const previousSessionId = currentSessionIdRef.current;
      const generation = ++loadSessionGenerationRef.current;
      historyHydrationGenerationRef.current = generation;
      historyReadFailureRef.current = null;
      const cacheTranscript = (targetSessionId: string, transcript: Message[]) => {
        rememberSessionCache(
          sessionTranscriptCacheRef.current,
          targetSessionId,
          transcript,
          currentSessionIdRef.current,
          SESSION_TRANSCRIPT_CACHE_SIZE,
        );
      };
      const cachedHistory = sessionTranscriptCacheRef.current.get(sessionId);
      // 只切换可见 transcript；每个 session 的 RunEngine 独立运行。
      // 切回时用历史快照和 afterSeqId 订阅追平遗漏内容。
      if (previousSessionId && previousSessionId !== sessionId) {
        cacheTranscript(previousSessionId, useMessageStore.getState().messages as Message[]);
        useMessageStore.getState().setMessages(cachedHistory || []);
        useSessionStore.getState().clearSessionMessageHistory(sessionId);
        useCheckpointStore.getState().setSessionCheckpoints(sessionId, []);
        useCheckpointStore.getState().setSessionToolReceipts(sessionId, []);
        useStreamingStore.getState().setCurrentRunId('');
        useStreamingStore.getState().clearActivity();
      }
      currentSessionIdRef.current = sessionId;
      const isStillCurrentSession = () => (
        currentSessionIdRef.current === sessionId
        && loadSessionGenerationRef.current === generation
        && !signal?.aborted
      );
      useSessionStore.getState().setCurrentSessionId(sessionId);
      useSessionStore
        .getState()
        .setSessionInitialMessageHistoryLoading(sessionId, !cachedHistory);
      const streaming = useStreamingStore.getState();
      if (streaming.isSessionStreaming(sessionId)) {
        streaming.updateActivity({ sessionId, phase: '正在同步任务进展', countEvent: false });
      }
      resetCompaction();
      let visibleBaseline = useMessageStore.getState().messages;
      runSubscriptionAbortRef.current?.abort();
      if (isMobile) {
        useUIStore.getState().setMobileSidebarOpen(false);
      }

      try {
        const messageOptions = {
          limit: SESSION_MESSAGES_PAGE_SIZE,
          includeReasoning: true,
          includeToolEvents: true,
          includeAttachments: true,
          signal,
        };
        const messagesData = await readPreparedHistory(
          () => api.listSessionMessages(sessionId, messageOptions),
          { isCurrent: isStillCurrentSession, signal, onPreparing: () => {
            const previous = useSessionStore.getState().messageHistory[sessionId];
            useSessionStore.getState().setSessionMessageHistory(sessionId, {
              ...previous, nextCursor: previous?.nextCursor ?? null, hasMore: previous?.hasMore ?? false,
              preparing: true, error: undefined,
            });
            useSessionStore.getState().setSessionInitialMessageHistoryLoading(sessionId, !cachedHistory);
          } },
        );
        if (!isStillCurrentSession()) {
          return;
        }
        const fallbackHistory = mapBackendMessages(messagesData.Messages) as Message[];
        rememberSessionCache(
          fallbackHistoryBySessionRef.current,
          sessionId,
          fallbackHistory,
          currentSessionIdRef.current,
        );
        let history = fallbackHistory;
        let latestEventSeqId = 0;
        let canonicalRunIds: string[] = [];

        // Durable message rows are small and sufficient for the readable
        // transcript. Paint them immediately on a cold switch instead of
        // holding the entire conversation behind RuntimeEvent hydration,
        // which can be hundreds of kilobytes for tool-heavy runs. A warm
        // switch keeps the cached canonical transcript visible until the
        // background refresh is complete.
        if (!cachedHistory) {
          const painted = mergeHistoryWithLive(
            fallbackHistory, visibleBaseline, useMessageStore.getState().messages);
          useMessageStore.getState().setMessages(painted);
          visibleBaseline = fallbackHistory;
          cacheTranscript(sessionId, painted);
        }
        useSessionStore.getState().setSessionMessageHistory(sessionId, {
          nextCursor: messagesData.NextCursor,
          hasMore: messagesData.HasMore,
          ...historyPageMetadata(messagesData),
        });
        useSessionStore.getState().setSessionInitialMessageHistoryLoading(sessionId, false);

        // RuntimeEvent/v2 is the transcript source of truth. Persisted
        // ListSessionMessages rows are cumulative snapshots and therefore only
        // a compatibility fallback for runs without canonical item identity.
        try {
          const eventPage = await api.listSessionEvents(sessionId, {
            offset: 0,
            limit: SESSION_EVENTS_PAGE_SIZE,
            signal,
            // A control message page can coexist with a recovered Runtime.
            // Probe events independently and merge only after their returned
            // source/epoch agrees; a control epoch must not constrain Runtime.
            historyEpoch: messagesData.CursorSource === 'runtime' ? messagesData.HistoryEpoch : undefined,
            snapshotSeqId: messagesData.CursorSource === 'runtime' ? messagesData.SnapshotSeqId : undefined,
          });
          if (!isStillCurrentSession()) return;
          const compatible = compatibleHistorySource(messagesData, eventPage);
          let hydratedEvents = eventPage.Events as SessionEventRecord[];
          const remoteRun = [...fallbackHistory].reverse().find(message => message.invocationId
            && Object.values(message.tools || {}).some(tool => tool.name === 'call_a2a_agent'))?.invocationId;
          if (compatible && capabilities.KernelSessionEventsByCommand === true
            && eventPage.CursorSource === 'runtime' && remoteRun) {
            hydratedEvents = await hydrateKernelRunHistory(api, sessionId, remoteRun, eventPage, isStillCurrentSession, signal);
            if (!isStillCurrentSession()) return;
          }
          const eventHistory = {
            events: compatible ? hydratedEvents : [],
            loadedCount: compatible ? hydratedEvents.length : 0,
            total: compatible ? Math.max(0, Number(eventPage.Total ?? eventPage.Events?.length ?? 0) || 0) : 0,
            cursorSource: compatible ? eventPage.CursorSource : undefined,
            historyEpoch: compatible ? eventPage.HistoryEpoch : undefined,
            snapshotSeqId: compatible ? eventPage.SnapshotSeqId : undefined,
          };
          rememberSessionCache(
            eventHistoryBySessionRef.current,
            sessionId,
            eventHistory,
            currentSessionIdRef.current,
          );
          useSessionStore.getState().setSessionMessageHistory(sessionId, {
            nextCursor: messagesData.NextCursor,
            hasMore: Boolean(messagesData.HasMore || eventHistory.loadedCount < eventHistory.total),
          });
          if (eventHistory.events.length > 0) {
            latestEventSeqId = maxSeqIdFromEvents(eventHistory.events);
            for (const record of eventHistory.events) {
              ingestSessionEventRecord(record, sessionId);
            }
            const rebuilt = rebuildPersistedSessionHistory(
              fallbackHistory,
              eventHistory.events,
              sessionId,
              profile,
            );
            canonicalRunIds = rebuilt.canonicalRunIds;
            history = rebuilt.messages;
          }
          if (compatible) {
            const interactionHistory = await hydrateVisibleInteractionHistory(
              api, sessionId, fallbackHistory, eventPage, isStillCurrentSession, signal,
            );
            if (!isStillCurrentSession()) return;
            for (const record of interactionHistory.events) ingestSessionEventRecord(record, sessionId);
            if (interactionHistory.incomplete) {
              historyReadFailureRef.current = {
                generation, message: '部分交互历史尚未恢复完整，旧卡片保持只读。请加载较早消息后重试。',
              };
              useSessionStore.getState().setSessionMessageHistory(sessionId, {
                ...useSessionStore.getState().messageHistory[sessionId],
                nextCursor: messagesData.NextCursor, hasMore: Boolean(messagesData.HasMore
                  || eventHistory.loadedCount < eventHistory.total),
                error: '部分交互历史尚未恢复完整，旧卡片保持只读。请加载较早消息后重试。',
              });
            }
          }
        } catch (error) {
          if (isHistoryReloadRequired(error)) throw error;
          if (isStillCurrentSession()) historyReadFailureRef.current = {
            generation, message: '完整事件历史读取失败，请刷新会话后重新查找。当前结果只包含已读取的正文。',
          };
          console.warn('[SessionLifecycle] canonical history replay failed:', error);
        }
        if (!isStillCurrentSession()) return;
        ingestLegacyApprovalHistory(history, sessionId);
        rememberSessionCache(
          canonicalRunIdsBySessionRef.current,
          sessionId,
          new Set(canonicalRunIds),
          currentSessionIdRef.current,
        );
        rememberSessionCache(persistedTranscriptBySessionRef.current, sessionId, history, currentSessionIdRef.current);
        history = mergeHistoryWithLive(
          history, visibleBaseline, useMessageStore.getState().messages);
        useMessageStore.getState().setMessages(history);
        cacheTranscript(sessionId, history);
        historyHydrationGenerationRef.current = null;
        void loadFeedbackForMessages(agentIdRef.current, sessionId, history);
        const lastSeqId = Math.max(messagesData.LatestSeqId || 0, latestEventSeqId);

        const runtimeCapabilities = useBootstrapStore.getState().capabilities || uiCapabilities;
        if (runtimeCapabilities.RunLifecycle.Enabled && runtimeCapabilities.RunLifecycle.Checkpoints) {
          void api.listSessionCheckpoints({
            agentId: agentIdRef.current,
            sessionId,
          }).then((checkpointData) => {
            if (!isStillCurrentSession()) return;
            useCheckpointStore
              .getState()
              .setSessionCheckpoints(sessionId, checkpointData.Checkpoints || []);
          }).catch((error) => {
            if (!isStillCurrentSession()) return;
            console.warn('[SessionLifecycle] checkpoint load failed:', error);
            useCheckpointStore.getState().setSessionCheckpoints(sessionId, []);
          });
          void api.listToolReceipts({
            agentId: agentIdRef.current,
            sessionId,
          }).then((receiptData) => {
            if (!isStillCurrentSession()) return;
            useCheckpointStore
              .getState()
              .setSessionToolReceipts(sessionId, receiptData.ToolReceipts || []);
          }).catch((error) => {
            if (!isStillCurrentSession()) return;
            console.warn('[SessionLifecycle] tool receipt load failed:', error);
            useCheckpointStore.getState().setSessionToolReceipts(sessionId, []);
          });
        } else {
          useCheckpointStore.getState().clearSessionCheckpoints(sessionId);
        }

        // 正式判据是后端的 ActiveRunStatus。旧本地 runtime 会漏投该字段，
        // 此时仅对近期更新、仍带 invocation 的会话做一次兼容恢复。
        if (
          runtimeCapabilities.RunLifecycle.Enabled &&
          runtimeCapabilities.RunLifecycle.Resume
        ) {
          try {
            const session = await api.getSession(sessionId);
            if (!isStillCurrentSession()) {
              return;
            }
            const status = String(session.ActiveRunStatus || '').toLowerCase();
            const isActive = !!session.ActiveInvocationId && (
              ACTIVE_RUN_STATUSES.has(status)
              || (status === '' && isRecentlyUpdatedSession(session))
            );
            if (isActive) {
              const activity = useStreamingStore.getState().getSessionActivity(sessionId);
              const nativeOwner = capabilities.KernelSessionEventsByCommand === true
                && useStreamingStore.getState().isSessionStreaming(sessionId)
                && activity?.source === 'run' && activity.runId === session.ActiveInvocationId
                && ['connecting', 'running', 'waiting'].includes(activity.status);
              if (nativeOwner) {
                useStreamingStore.getState().updateActivity({
                  sessionId, phase: '正在处理', countEvent: false,
                });
              }
              if (!nativeOwner) void subscribeRunEvents({
                sessionId, invocationId: session.ActiveInvocationId!, afterSeqId: lastSeqId,
              });
            } else {
              const store = useStreamingStore.getState();
              const activity = store.getSessionActivity(sessionId);
              // An older session projection must not settle a newly submitted
              // turn. A matching durable terminal (including history when the
              // active pointer has already cleared) can settle its observer.
              const terminal = session.ActiveInvocationId && activity?.runId === session.ActiveInvocationId
                ? terminalActivityForRunEvent({ EventType: 'run_status', Content: { status } })
                : null;
              const historyTerminal = activity?.runId
                ? [...(eventHistoryBySessionRef.current.get(sessionId)?.events || [])].reverse()
                  .find(event => {
                    const frame = (event.Content as { runtime_event?: Record<string, unknown> } | undefined)?.runtime_event;
                    return event.InvocationId === activity.runId && !frame?.parent_scope_id && eventHasTerminalRunStatus(event);
                  })
                : undefined;
              const settled = terminal || (historyTerminal && terminalActivityForRunEvent(historyTerminal));
              if (settled) {
                store.setSessionStreaming(sessionId, false);
                store.updateActivity({ sessionId, ...settled, countEvent: false });
              }
            }
          } catch (error) {
            console.warn('[SessionLifecycle] getSession for reconnect failed:', error);
            if (isStillCurrentSession()) {
              const store = useStreamingStore.getState();
              if (store.isSessionStreaming(sessionId) && store.getSessionActivity(sessionId)?.phase === '正在同步任务进展') {
                store.updateActivity({ sessionId, phase: '正在确认任务状态', countEvent: false });
              }
            }
          }
        }
      } catch (error) {
        if (isHistoryReloadRequired(error) && !historyReload && isStillCurrentSession()) {
          useSessionStore.getState().setSessionMessageHistory(sessionId, {
            nextCursor: null, hasMore: false, cursorSource: undefined,
            historyEpoch: undefined, snapshotSeqId: undefined,
            dataSource: undefined, degraded: undefined,
            cursorCompatibleWithRuntime: undefined,
            sessionContractVersion: undefined,
          });
          queueMicrotask(() => {
            if (isStillCurrentSession()) void loadSessionRef.current?.(sessionId, true);
          });
          return;
        }
        if (isStillCurrentSession() && !(error instanceof CancelledError)) {
          const message = historyReload
            ? '历史来源已变化，重新加载失败。原有消息已保留，请手动刷新会话。'
            : isHistoryPreparing(error) ? '历史仍在准备，请稍后重试。'
              : '会话历史读取失败，请重试。已有消息已保留。';
          historyReadFailureRef.current = { generation, message };
            const previous = useSessionStore.getState().messageHistory[sessionId];
            useSessionStore.getState().setSessionMessageHistory(sessionId, {
              ...previous,
              nextCursor: previous?.nextCursor ?? null, hasMore: previous?.hasMore ?? false,
              ...(historyReload ? { nextCursor: null, hasMore: false,
                cursorSource: undefined, historyEpoch: undefined, snapshotSeqId: undefined } : {}),
              preparing: false,
              error: message,
            });
          if (historyReload) useUIStore.getState().pushToast(message, 'error');
        }
        if (!(error instanceof CancelledError)) console.error('Failed to load session messages:', error);
      } finally {
        if (historyHydrationGenerationRef.current === generation) historyHydrationGenerationRef.current = null;
        if (isStillCurrentSession()) {
          useSessionStore.getState().setSessionInitialMessageHistoryLoading(sessionId, false);
        }
      }
    },
    [
      api,
      isMobile,
      loadFeedbackForMessages,
      resetCompaction,
      subscribeRunEvents,
      uiCapabilities,
    ],
  );

  const fetchSessions = useCallback(
    async (
      targetAgentId = 'default-agent',
      preferredSessionId: string | null = null,
    ) => {
      const store = useSessionStore.getState();
      if (store.sessionsAgentId && store.sessionsAgentId !== targetAgentId) {
        store.resetSessionPagination(targetAgentId);
      }
      const generation = useSessionStore.getState().sessionsGeneration;
      const isCurrentList = () => useBootstrapStore.getState().agentId === targetAgentId
        && useSessionStore.getState().sessionsGeneration === generation;
      try {
        useSessionStore.getState().setLoadingSessions(true);
        const data = await api.listSessions(targetAgentId, {
          page: 1,
          pageSize: SESSION_LIST_PAGE_SIZE,
        });
        if (!isCurrentList()) return;
        const listedSessions = (data.Sessions || []) as Session[];
        for (const listedSession of listedSessions) {
          pendingCreatedSessionAgentsRef.current.delete(listedSession.SessionId);
        }
        const pendingSessionIds = new Set(
          Array.from(pendingCreatedSessionAgentsRef.current.entries())
            .filter(([, pendingAgentId]) => pendingAgentId === targetAgentId)
            .map(([sessionId]) => sessionId),
        );
        const refreshedSessions = mergePendingSessions(
          listedSessions,
          useSessionStore.getState().sessions,
          pendingSessionIds,
        ) as Session[];
        useSessionStore.getState().upsertSessions(refreshedSessions, {
          agentId: targetAgentId,
          total: Number(data.Total ?? data.Sessions?.length ?? 0),
          page: Number(data.Page ?? 1),
          pageSize: Number(data.PageSize ?? SESSION_LIST_PAGE_SIZE),
          replace: true,
        });
        // A manual “new conversation” can overlap the initial ListSessions
        // request. Do not let that older response restore a previous session
        // while CreateSession is resolving or a local draft is selected: a
        // draft intentionally has no server session until its first send.
        if (sessionCreationPromiseRef.current || localDraftAgentRef.current === targetAgentId) {
          return;
        }
        const sorted = useSessionStore.getState().sessions;
        const activeSessionId = currentSessionIdRef.current;
        // Page 1 is not an existence check. An older selected session (or a
        // newly-created one still awaiting indexing) may be absent from it.
        const restoredSessionId = activeSessionId || (restoreSession
          ? resolveSessionToRestore(sorted, preferredSessionId || readPersistedSessionId(targetAgentId))
          : null);
        if (restoredSessionId && restoredSessionId !== activeSessionId) {
          void loadSession(restoredSessionId);
        }
      } catch (error) {
        if (error instanceof CancelledError) return;
        console.error('Failed to fetch sessions:', error);
      } finally {
        if (isCurrentList()) {
          useSessionStore.getState().setLoadingSessions(false);
        }
      }
    },
    [api, loadSession, restoreSession],
  );

  const loadMoreSessions = useCallback(async () => {
    const store = useSessionStore.getState();
    if (store.isLoadingSessions || !store.hasMoreSessions) {
      return;
    }
    const nextPage = resolveNextSessionsPage({
      total: store.sessionsTotal,
      pageSize: store.sessionsPageSize || SESSION_LIST_PAGE_SIZE,
      loadedPages: store.loadedPages,
    });
    if (!nextPage) {
      return;
    }
    const pageSize = store.sessionsPageSize || SESSION_LIST_PAGE_SIZE;
    const targetAgentId = store.sessionsAgentId || agentIdRef.current || 'default-agent';
    const isCurrentList = () => useBootstrapStore.getState().agentId === targetAgentId
      && useSessionStore.getState().sessionsGeneration === store.sessionsGeneration;
    try {
      useSessionStore.getState().setLoadingSessions(true);
      const data = await api.listSessions(targetAgentId, {
        page: nextPage,
        pageSize,
      });
      // Pagination can finish after navigation, just like the first page.
      // Keep the former Agent's rows and pagination out of the selected list.
      if (!isCurrentList()) return;
      useSessionStore.getState().upsertSessions((data.Sessions || []) as Session[], {
        agentId: targetAgentId,
        total: Number(data.Total ?? store.sessionsTotal),
        page: Number(data.Page ?? nextPage),
        pageSize: Number(data.PageSize ?? pageSize),
      });
    } catch (error) {
      if (error instanceof CancelledError) return;
      console.error('Failed to load more sessions:', error);
    } finally {
      if (isCurrentList()) useSessionStore.getState().setLoadingSessions(false);
    }
  }, [api]);

  useEffect(() => {
    loadSessionRef.current = loadSession;
  }, [loadSession]);

  useEffect(() => {
    fetchSessionsRef.current = fetchSessions;
  }, [fetchSessions]);

  const adoptCreatedSession = useCallback((newId: string, preserveMessages = false) => {
    localDraftAgentRef.current = null;
    // Responses can announce the existing session on every turn. That is an
    // acknowledgement, not navigation: keep its fixed snapshot and in-flight
    // older page so another turn cannot strand the remaining history.
    if (preserveMessages && currentSessionIdRef.current === newId) {
      useSessionStore.getState().upsertSessions([
        { SessionId: newId, UpdatedAt: new Date().toISOString() } as unknown as Session,
      ]);
      return;
    }
    loadSessionGenerationRef.current += 1;
    runSubscriptionAbortRef.current?.abort();
    pendingCreatedSessionAgentsRef.current.set(newId, agentIdRef.current);
    useSessionStore
      .getState()
      .upsertSessions([{ SessionId: newId, UpdatedAt: new Date().toISOString() } as unknown as Session]);
    currentSessionIdRef.current = newId;
    useSessionStore.getState().setCurrentSessionId(newId);
    if (!preserveMessages) {
      useMessageStore.getState().setMessages([]);
      useStreamingStore.getState().setCurrentRunId('');
      useStreamingStore.getState().clearActivity();
    }
    useSessionStore.getState().clearSessionMessageHistory(newId);
    useCheckpointStore.getState().setSessionCheckpoints(newId, []);
    useCheckpointStore.getState().setSessionToolReceipts(newId, []);
    if (isMobile) {
      useUIStore.getState().setMobileSidebarOpen(false);
      useUIStore.getState().setMobileActionsOpen(false);
    }
  }, [isMobile]);

  const startNewConversation = useCallback(() => {
    localDraftAgentRef.current = agentIdRef.current;
    loadSessionGenerationRef.current += 1;
    runSubscriptionAbortRef.current?.abort();
    // Navigation creates a local draft; it must not disconnect an execution
    // that belongs to the previous conversation. The broker/engine keeps that
    // run alive offscreen and its terminal state is reconciled on return.
    currentSessionIdRef.current = null;
    useSessionStore.getState().setCurrentSessionId(null);
    useMessageStore.getState().setMessages([]);
    useStreamingStore.getState().setCurrentRunId('');
    useStreamingStore.getState().clearActivity();
    if (isMobile) useUIStore.getState().setMobileSidebarOpen(false);
  }, [isMobile]);

  const createNewSession = useCallback(async () => {
    if (sessionCreationPromiseRef.current) {
      await sessionCreationPromiseRef.current;
      return;
    }
    // Invalidate an older session hydrate immediately. A fast user can type
    // and send while CreateSession is in flight; submitDraft waits on this
    // exact promise instead of starting a second session or using the prior one.
    loadSessionGenerationRef.current += 1;
    runSubscriptionAbortRef.current?.abort();
    currentSessionIdRef.current = null;
    useSessionStore.getState().setCurrentSessionId(null);
    useMessageStore.getState().setMessages([]);
    const creation = api.createSession(agentId)
      .then((session) => {
        const newId = session.SessionId || null;
        if (newId && useBootstrapStore.getState().agentId === agentId) {
          const preserveMessages = useMessageStore.getState().messages.some((message) => (
            message.eventType === 'optimistic_user_message'
            || message.eventType === 'optimistic_assistant_placeholder'
          ));
          adoptCreatedSession(newId, preserveMessages);
        }
        return newId;
      })
      .catch((error) => {
        if (!(error instanceof CancelledError)) {
          console.error('Failed to create session:', error);
        }
        return null;
      });
    sessionCreationPromiseRef.current = creation;
    try {
      await creation;
    } finally {
      if (sessionCreationPromiseRef.current === creation) {
        sessionCreationPromiseRef.current = null;
      }
    }
  }, [adoptCreatedSession, agentId, api]);

  const waitForPendingSessionCreation = useCallback(async () => {
    const pending = sessionCreationPromiseRef.current;
    return pending ? await pending : currentSessionIdRef.current;
  }, []);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      try {
        const result = await api.deleteSession(sessionId);
        if (useBootstrapStore.getState().agentId !== agentId) return result.Deleted !== false;
        if (result.Deleted === false) {
          useUIStore.getState().pushToast(
            '会话暂未删除，云端运行时仍在同步，请稍后重试。',
            'error',
          );
          void fetchSessions(agentId, currentSessionIdRef.current ?? undefined);
          return false;
        }
        useSessionStore.getState().removeSession(sessionId);
        useSessionStore.getState().clearSessionMessageHistory(sessionId);
        sessionTranscriptCacheRef.current.delete(sessionId);
        fallbackHistoryBySessionRef.current.delete(sessionId);
        historyProfileBySessionRef.current.delete(sessionId);
        eventHistoryBySessionRef.current.delete(sessionId);
        canonicalRunIdsBySessionRef.current.delete(sessionId);
        persistedTranscriptBySessionRef.current.delete(sessionId);
        pendingCreatedSessionAgentsRef.current.delete(sessionId);
        if (currentSessionIdRef.current === sessionId) {
          loadSessionGenerationRef.current += 1;
          runSubscriptionAbortRef.current?.abort();
          disconnectRun?.();
          currentSessionIdRef.current = null;
          useMessageStore.getState().setMessages([]);
          useCheckpointStore.getState().clearSessionCheckpoints(sessionId);
          useSessionStore.getState().setCurrentSessionId(null);
          useStreamingStore.getState().setCurrentRunId('');
          useStreamingStore.getState().clearActivity();
          void fetchSessions(agentId);
        }
        return true;
      } catch (error) {
        if (error instanceof CancelledError) return false;
        console.error('Failed to delete session', error);
        useUIStore.getState().pushToast('删除会话失败，请稍后重试。', 'error');
        return false;
      }
    },
    [agentId, api, disconnectRun, fetchSessions],
  );

  const loadOlderSessionMessages = useCallback(async (sessionId: string, signal?: AbortSignal) => {
    signal?.throwIfAborted();
    const historyState = useSessionStore.getState().messageHistory[sessionId];
    const cachedEvents = eventHistoryBySessionRef.current.get(sessionId);
    const canLoadOlderMessages = Boolean(historyState?.hasMore && historyState.nextCursor !== null);
    const canLoadOlderEvents = Boolean(
      cachedEvents && cachedEvents.loadedCount < cachedEvents.total,
    );
    if (!historyState || historyState.isLoadingOlder || (!canLoadOlderMessages && !canLoadOlderEvents)) {
      return;
    }
    const generation = loadSessionGenerationRef.current;
    const visibleBaseline = persistedTranscriptBySessionRef.current.get(sessionId)
      || useMessageStore.getState().messages;
    const requestToken = Symbol(sessionId);
    olderMessageRequestRef.current.set(sessionId, requestToken);
    const isCurrent = () => currentSessionIdRef.current === sessionId
      && loadSessionGenerationRef.current === generation
      && olderMessageRequestRef.current.get(sessionId) === requestToken
      && !signal?.aborted;
    const preparation = { isCurrent, signal, onPreparing: () => {
      useSessionStore.getState().setSessionMessageHistory(sessionId, {
        ...historyState, preparing: true, error: undefined, isLoadingOlder: true,
      });
    } };
    try {
      useSessionStore.getState().setSessionMessageHistoryLoading(sessionId, true);
      const [messageResult, eventResult] = await Promise.allSettled([
        canLoadOlderMessages
          ? readPreparedHistory(() => api.listSessionMessages(sessionId, {
              signal,
              beforeSeqId: historyState.nextCursor ?? undefined,
              cursorSource: historyState.cursorSource,
              historyEpoch: historyState.historyEpoch,
              snapshotSeqId: historyState.snapshotSeqId,
              limit: SESSION_MESSAGES_PAGE_SIZE,
              includeReasoning: true,
              includeToolEvents: true,
              includeAttachments: true,
            }), preparation)
          : Promise.resolve(null),
        canLoadOlderEvents && cachedEvents
          ? readPreparedHistory(() => api.listSessionEvents(sessionId, {
              signal,
              offset: cachedEvents.loadedCount,
              limit: SESSION_EVENTS_PAGE_SIZE,
              cursorSource: cachedEvents.cursorSource,
              historyEpoch: cachedEvents.historyEpoch,
              snapshotSeqId: cachedEvents.snapshotSeqId,
            }), preparation)
          : Promise.resolve(null),
      ]);
      signal?.throwIfAborted();
      if (
        currentSessionIdRef.current !== sessionId
        || loadSessionGenerationRef.current !== generation
        || olderMessageRequestRef.current.get(sessionId) !== requestToken
      ) {
        return;
      }
      // A transient failure of supplemental canonical detail must not discard
      // a successfully authorized Messages page. Keep its detail offset for a
      // later explicit read. Authorization, source changes and cancellation
      // still fail the operation before either result is applied.
      const detailUnavailable = eventResult.status === 'rejected'
        && eventResult.reason instanceof ApiError
        && [429, 502, 503, 504].includes(eventResult.reason.code);
      if (eventResult.status === 'rejected' && !detailUnavailable) throw eventResult.reason;
      if (messageResult.status === 'rejected') throw messageResult.reason;
      const messagePage = messageResult.value;
      const eventPage = eventResult.status === 'fulfilled' ? eventResult.value : null;
      let detailWarning = detailUnavailable
        ? '消息正文已加载，部分事件详情暂时读取失败，请重试加载更早记录。'
        : undefined;
      if (messagePage && !compatibleHistorySource({
        CursorSource: historyState.cursorSource,
        HistoryEpoch: historyState.historyEpoch,
        SnapshotSeqId: historyState.snapshotSeqId,
        CursorCompatibleWithRuntime: historyState.cursorCompatibleWithRuntime,
      }, messagePage)) throw reloadRequiredError();
      if (eventPage && cachedEvents && !compatibleHistorySource(eventCacheSource(cachedEvents), eventPage)) {
        throw reloadRequiredError();
      }
      if (detailWarning) historyReadFailureRef.current = { generation, message: detailWarning };
      else if (eventPage) historyReadFailureRef.current = null;
      const olderMessages = messagePage
        ? mapBackendMessages(messagePage.Messages) as Message[]
        : [];
      const olderIds = new Set(olderMessages.map((message) => message.id));
      const fallbackHistory = [
        ...olderMessages,
        ...(fallbackHistoryBySessionRef.current.get(sessionId) || [])
          .filter((message) => !olderIds.has(message.id)),
      ];
      rememberSessionCache(
        fallbackHistoryBySessionRef.current,
        sessionId,
        fallbackHistory,
        currentSessionIdRef.current,
      );

      let mergedEvents = cachedEvents?.events || [];
      let loadedEventCount = cachedEvents?.loadedCount || 0;
      let totalEventCount = cachedEvents?.total || 0;
      if (eventPage) {
        const olderEvents = (eventPage.Events || []) as SessionEventRecord[];
        mergedEvents = mergeSessionEventRecords(olderEvents, mergedEvents) as SessionEventRecord[];
        totalEventCount = Math.max(totalEventCount, Number(eventPage.Total ?? 0) || 0);
        loadedEventCount = olderEvents.length > 0
          ? Math.min(totalEventCount, loadedEventCount + olderEvents.length)
          : totalEventCount;
        rememberSessionCache(
          eventHistoryBySessionRef.current,
          sessionId,
          {
            events: mergedEvents,
            loadedCount: loadedEventCount,
            total: totalEventCount,
            cursorSource: eventPage.CursorSource ?? cachedEvents?.cursorSource,
            historyEpoch: eventPage.HistoryEpoch ?? cachedEvents?.historyEpoch,
            snapshotSeqId: eventPage.SnapshotSeqId ?? cachedEvents?.snapshotSeqId,
          },
          currentSessionIdRef.current,
        );
        for (const record of olderEvents) {
          ingestSessionEventRecord(record, sessionId);
        }
      }
      if (olderMessages.length && cachedEvents) {
        const interactionHistory = await hydrateVisibleInteractionHistory(api, sessionId, olderMessages, {
          Events: mergedEvents, CursorSource: cachedEvents.cursorSource,
          HistoryEpoch: cachedEvents.historyEpoch, SnapshotSeqId: cachedEvents.snapshotSeqId,
        }, isCurrent, signal);
        if (!isCurrent()) return;
        for (const record of interactionHistory.events) ingestSessionEventRecord(record, sessionId);
        if (interactionHistory.incomplete) {
          detailWarning = '部分交互历史尚未恢复完整，旧卡片保持只读。请加载较早消息后重试。';
          historyReadFailureRef.current = { generation, message: detailWarning };
        }
      }

      const rebuilt = rebuildPersistedSessionHistory(fallbackHistory, mergedEvents, sessionId,
        historyProfileBySessionRef.current.get(sessionId) || 'flat-v1');
      ingestLegacyApprovalHistory(rebuilt.messages, sessionId);
      rememberSessionCache(persistedTranscriptBySessionRef.current, sessionId, rebuilt.messages, currentSessionIdRef.current);
      const mergedHistory = mergeHistoryWithLive(
        rebuilt.messages, visibleBaseline, useMessageStore.getState().messages);
      rememberSessionCache(
        canonicalRunIdsBySessionRef.current,
        sessionId,
        new Set(rebuilt.canonicalRunIds),
        currentSessionIdRef.current,
      );
      useMessageStore.getState().setMessages(mergedHistory);
      rememberSessionCache(
        sessionTranscriptCacheRef.current,
        sessionId,
        mergedHistory,
        currentSessionIdRef.current,
        SESSION_TRANSCRIPT_CACHE_SIZE,
      );
      useSessionStore.getState().setSessionMessageHistory(sessionId, {
        nextCursor: messagePage ? messagePage.NextCursor : historyState.nextCursor,
        hasMore: Boolean(
          (messagePage ? messagePage.HasMore : false)
          || loadedEventCount < totalEventCount
        ),
        ...(messagePage ? historyPageMetadata(messagePage) : {}),
        ...(messagePage ? {
          dataSource: messagePage.DataSource ?? historyState.dataSource,
          degraded: messagePage.Degraded ?? historyState.degraded,
          cursorSource: messagePage.CursorSource ?? historyState.cursorSource,
          cursorCompatibleWithRuntime: messagePage.CursorCompatibleWithRuntime ?? historyState.cursorCompatibleWithRuntime,
          sessionContractVersion: messagePage.SessionContractVersion ?? historyState.sessionContractVersion,
          historyEpoch: messagePage.HistoryEpoch ?? historyState.historyEpoch,
          persistenceDegraded: messagePage.PersistenceDegraded ?? historyState.persistenceDegraded,
          snapshotSeqId: messagePage.SnapshotSeqId ?? historyState.snapshotSeqId,
        } : {}),
        preparing: false,
        error: detailWarning,
      });
      void loadFeedbackForMessages(agentIdRef.current, sessionId, olderMessages);
    } catch (error) {
      if (isHistoryReloadRequired(error)
        && currentSessionIdRef.current === sessionId
        && loadSessionGenerationRef.current === generation
        && olderMessageRequestRef.current.get(sessionId) === requestToken
        && !signal?.aborted) {
        // Invalidate every part of the old pagination contract before a single
        // fresh first-page read. loadSession does not recursively reload 409s.
        useSessionStore.getState().setSessionMessageHistory(sessionId, {
          nextCursor: null,
          hasMore: false,
          cursorSource: undefined,
          historyEpoch: undefined,
          snapshotSeqId: undefined,
          dataSource: undefined,
          degraded: undefined,
          cursorCompatibleWithRuntime: undefined,
          sessionContractVersion: undefined,
          persistenceDegraded: undefined,
          error: undefined,
        });
        await loadSession(sessionId, true, signal);
        return;
      }
      if (isCurrent() && !(error instanceof CancelledError)) {
        useSessionStore.getState().setSessionMessageHistory(sessionId, {
          ...historyState, preparing: false,
          error: error instanceof Error ? error.message : '历史加载失败，请重试',
        });
      }
      if (signal) throw error;
      if (!(error instanceof CancelledError)) {
        console.error('Failed to load older session messages:', error);
      }
    } finally {
      if (olderMessageRequestRef.current.get(sessionId) === requestToken) {
        olderMessageRequestRef.current.delete(sessionId);
        if (loadSessionGenerationRef.current === generation) {
          const current = useSessionStore.getState().messageHistory[sessionId];
          useSessionStore.getState().setSessionMessageHistory(sessionId, {
            ...current, nextCursor: current?.nextCursor ?? null,
            hasMore: current?.hasMore ?? false, preparing: false, isLoadingOlder: false,
          });
        } else {
          useSessionStore.getState().setSessionMessageHistoryLoading(sessionId, false);
        }
      }
    }
  }, [api, loadFeedbackForMessages, loadSession]);

  const historySearchSnapshot = useCallback(() => {
    const sessionId = currentSessionIdRef.current || '';
    const history = useSessionStore.getState().messageHistory[sessionId];
    const events = eventHistoryBySessionRef.current.get(sessionId);
    return {
      owner: JSON.stringify([agentIdRef.current, sessionId, loadSessionGenerationRef.current]),
      messages: useMessageStore.getState().messages as Message[],
      hasMore: Boolean(history?.hasMore),
      loading: Boolean(historyHydrationGenerationRef.current === loadSessionGenerationRef.current
        || useSessionStore.getState().isLoadingSessions || history?.isLoadingInitial || history?.isLoadingOlder),
      checkpoint: `${history?.nextCursor}:${events?.loadedCount}`,
      error: historyReadFailureRef.current?.generation === loadSessionGenerationRef.current
        ? historyReadFailureRef.current.message : undefined,
    };
  }, []);

  return {
    historySearchSnapshot,
    followAcceptedInteraction,
    fetchSessions,
    loadMoreSessions,
    loadSession,
    loadOlderSessionMessages,
    createNewSession,
    startNewConversation,
    adoptCreatedSession,
    waitForPendingSessionCreation,
    deleteSession,
    currentSessionIdRef,
    agentIdRef,
    runSubscriptionAbortRef,
  };
}
