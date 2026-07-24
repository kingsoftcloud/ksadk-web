import { useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/session.js';
import { useMessageStore } from '../stores/message.js';
import { useUIStore } from '../stores/ui.js';
import { useCheckpointStore } from '../stores/checkpoint.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { CancelledError } from '../api/client.js';
import {
  eventHasTerminalRunStatus,
} from '../utils/session-events.js';
import { mapBackendMessages } from '../utils/messages.js';
import { useStreamingStore } from '../stores/streaming.js';
import { shouldRenderFeedbackControls, normalizeFeedback } from '../utils/feedback.js';
import { readPersistedSessionId, resolveSessionToRestore } from '../utils/session.js';
import { resolveNextSessionsPage } from '../utils/session-pagination.js';
import type { Message, Session } from '../components/chat/types.js';
import type { SessionEventRecord } from '../types/session-events.js';
import type { UiCapabilities } from '../types/capabilities.js';
import type { ApiFacade } from '../core/api/types.js';

const RESTORE_SUBSCRIPTION_TIMEOUT_MS = 90_000;
const SESSION_LIST_PAGE_SIZE = 30;
const SESSION_MESSAGES_PAGE_SIZE = 50;

// 重连判据:ActiveRunStatus 属于这些态时认为有活跃 run(对齐后端 RUN_STATUS_ACTIVE)。
const ACTIVE_RUN_STATUSES = new Set([
  'in_progress',
  'running',
  'resuming',
  'starting',
]);

function terminalActivityForRunEvent(event: SessionEventRecord): {
  status: 'completed' | 'failed' | 'stopped';
  phase: string;
} | null {
  if (event.EventType !== 'run_status') return null;
  const rawStatus = String((event.Content as { status?: unknown } | undefined)?.status || '').trim().toLowerCase();
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
};

export function useSessionLifecycle(ctx: SessionLifecycleContext) {
  const {
    agentId,
    api,
    isMobile,
    resetCompaction,
    uiCapabilities,
    disconnectRun,
  } = ctx;
  const currentSessionIdRef = useRef<string | null>(ctx.currentSessionId);
  const agentIdRef = useRef(ctx.agentId);
  const runSubscriptionAbortRef = useRef<AbortController | null>(null);
  const loadSessionGenerationRef = useRef(0);
  const olderMessageRequestRef = useRef(new Map<string, symbol>());
  const loadSessionRef = useRef<((sessionId: string) => Promise<void>) | null>(null);
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
      const isCurrentSubscription = () => (
        runSubscriptionAbortRef.current === controller
        && currentSessionIdRef.current === options.sessionId
      );
      const stopRestoreSubscription = () => {
        if (runSubscriptionAbortRef.current !== controller || controller.signal.aborted) {
          return;
        }
        controller.abort();
      };
      const timeoutTimer = globalThis.setTimeout(() => {
        stopRestoreSubscription();
      }, RESTORE_SUBSCRIPTION_TIMEOUT_MS);

      try {
        const stream = await api.subscribeRunEvents(
          {
            sessionId: options.sessionId,
            invocationId: options.invocationId,
            afterSeqId: options.afterSeqId,
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
        useStreamingStore.getState().setCurrentRunId(options.invocationId);
        useStreamingStore.getState().updateActivity({
          sessionId: options.sessionId,
          status: 'running',
          phase: '后台长任务运行中',
          detail: options.invocationId,
          countEvent: false,
        });

        while (!terminalStatusSeen) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() || '';

          for (const chunk of chunks) {
            if (!chunk.trim()) continue;
            const dataLines: string[] = [];
            for (const line of chunk.split('\n')) {
              if (line.startsWith('data:')) {
                dataLines.push(line.substring(5).trim());
              }
            }
            const dataString = dataLines.join('\n').trim();
            if (!dataString || dataString === '[DONE]') {
              terminalStatusSeen = dataString === '[DONE]';
              shouldReloadSession = shouldReloadSession || terminalStatusSeen;
              continue;
            }
            try {
              const event = JSON.parse(dataString) as SessionEventRecord;
              if (!isCurrentSubscription()) {
                stopRestoreSubscription();
                break;
              }
              terminalStatusSeen = terminalStatusSeen || eventHasTerminalRunStatus(event);
              shouldReloadSession = shouldReloadSession || terminalStatusSeen;
              if (event.EventType === 'run_checkpoint') {
                useCheckpointStore.getState().upsertSessionCheckpoint(options.sessionId, event);
              }
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
              // 重连期间不覆盖消息列表(保持 loadSession 的 ListSessionMessages 结果)。
              // run 结束后 shouldReloadSession 会重新 loadSession 拿最终消息。
              // 增量事件仅更新 streaming activity(上方 terminalActivity 已处理)。
            } catch (error) {
              console.warn('Failed to parse run event data', dataString, error);
            }
          }
        }
      } catch (error) {
        const isAbortError = error instanceof DOMException && error.name === 'AbortError';
        if (!isAbortError) {
          console.error('Failed to subscribe run events:', error);
        }
      } finally {
        globalThis.clearTimeout(timeoutTimer);
        const ownedCurrentSubscription = runSubscriptionAbortRef.current === controller;
        if (ownedCurrentSubscription) {
          runSubscriptionAbortRef.current = null;
        }
        if (ownedCurrentSubscription && currentSessionIdRef.current === options.sessionId) {
          useStreamingStore.getState().setCurrentRunId('');
          if (shouldReloadSession) {
            void loadSessionRef.current?.(options.sessionId);
          }
          void fetchSessionsRef.current?.(agentIdRef.current, options.sessionId);
        }
      }
    },
    [api],
  );

  const loadSession = useCallback(
    async (sessionId: string) => {
      const previousSessionId = currentSessionIdRef.current;
      const generation = ++loadSessionGenerationRef.current;
      if (previousSessionId !== sessionId) {
        disconnectRun?.();
        useMessageStore.getState().setMessages([]);
        useSessionStore.getState().clearSessionMessageHistory(sessionId);
        useCheckpointStore.getState().setSessionCheckpoints(sessionId, []);
        useCheckpointStore.getState().setSessionToolReceipts(sessionId, []);
        useStreamingStore.getState().setCurrentRunId('');
        useStreamingStore.getState().clearActivity();
        useStreamingStore.getState().clearSessionActivity(previousSessionId);
      }
      currentSessionIdRef.current = sessionId;
      const isStillCurrentSession = () => (
        currentSessionIdRef.current === sessionId
        && loadSessionGenerationRef.current === generation
      );
      useSessionStore.getState().setCurrentSessionId(sessionId);
      useSessionStore.getState().setSessionInitialMessageHistoryLoading(sessionId, true);
      resetCompaction();
      runSubscriptionAbortRef.current?.abort();
      if (isMobile) {
        useUIStore.getState().setMobileSidebarOpen(false);
      }

      try {
        const messagesData = await api.listSessionMessages(sessionId, {
          limit: SESSION_MESSAGES_PAGE_SIZE,
          includeReasoning: true,
          includeToolEvents: true,
          includeAttachments: true,
        });
        if (!isStillCurrentSession()) {
          return;
        }
        const history = mapBackendMessages(messagesData.Messages);
        useMessageStore.getState().setMessages(history);
        useSessionStore.getState().setSessionMessageHistory(sessionId, {
          nextCursor: messagesData.NextCursor,
          hasMore: messagesData.HasMore,
        });
        void loadFeedbackForMessages(agentIdRef.current, sessionId, history);
        const lastSeqId = messagesData.LatestSeqId || 0;

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

        // 重连判据:读 GetSession.ActiveRunStatus(不靠扫 events 反推)。
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
            const isActive = ACTIVE_RUN_STATUSES.has(status) && !!session.ActiveInvocationId;
            if (isActive) {
              void subscribeRunEvents({
                sessionId,
                invocationId: session.ActiveInvocationId!,
                afterSeqId: lastSeqId,
              });
            }
          } catch (error) {
            console.warn('[SessionLifecycle] getSession for reconnect failed:', error);
          }
        }
      } catch (error) {
        console.error('Failed to load session messages:', error);
      } finally {
        if (isStillCurrentSession()) {
          useSessionStore.getState().setSessionInitialMessageHistoryLoading(sessionId, false);
        }
      }
    },
    [
      api,
      disconnectRun,
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
      try {
        const store = useSessionStore.getState();
        if (store.sessionsAgentId && store.sessionsAgentId !== targetAgentId) {
          store.resetSessionPagination(targetAgentId);
        }
        useSessionStore.getState().setLoadingSessions(true);
        const data = await api.listSessions(targetAgentId, {
          page: 1,
          pageSize: SESSION_LIST_PAGE_SIZE,
        });
        useSessionStore.getState().upsertSessions((data.Sessions || []) as Session[], {
          agentId: targetAgentId,
          total: Number(data.Total ?? data.Sessions?.length ?? 0),
          page: Number(data.Page ?? 1),
          pageSize: Number(data.PageSize ?? SESSION_LIST_PAGE_SIZE),
          replace: true,
        });
        const sorted = useSessionStore.getState().sessions;
        const activeSessionId = currentSessionIdRef.current;
        const restoredSessionId = resolveSessionToRestore(
          sorted,
          activeSessionId || preferredSessionId || readPersistedSessionId(targetAgentId),
        );
        if (restoredSessionId && restoredSessionId !== activeSessionId) {
          void loadSession(restoredSessionId);
        } else if (!restoredSessionId && activeSessionId) {
          loadSessionGenerationRef.current += 1;
          runSubscriptionAbortRef.current?.abort();
          disconnectRun?.();
          currentSessionIdRef.current = null;
          useSessionStore.getState().setCurrentSessionId(null);
          useMessageStore.getState().setMessages([]);
          useSessionStore.getState().clearSessionMessageHistory();
          useCheckpointStore.getState().clearSessionCheckpoints();
          useStreamingStore.getState().setCurrentRunId('');
          useStreamingStore.getState().clearActivity();
        }
      } catch (error) {
        if (error instanceof CancelledError) return;
        console.error('Failed to fetch sessions:', error);
      } finally {
        useSessionStore.getState().setLoadingSessions(false);
      }
    },
    [api, disconnectRun, loadSession],
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
    try {
      useSessionStore.getState().setLoadingSessions(true);
      const data = await api.listSessions(targetAgentId, {
        page: nextPage,
        pageSize,
      });
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
      useSessionStore.getState().setLoadingSessions(false);
    }
  }, [api]);

  useEffect(() => {
    loadSessionRef.current = loadSession;
  }, [loadSession]);

  useEffect(() => {
    fetchSessionsRef.current = fetchSessions;
  }, [fetchSessions]);

  const createNewSession = useCallback(async () => {
    try {
      disconnectRun?.();
      loadSessionGenerationRef.current += 1;
      runSubscriptionAbortRef.current?.abort();
      const session = await api.createSession(agentId);
      const newId = session.SessionId;
      if (newId) {
        useSessionStore
          .getState()
          .upsertSessions([{ SessionId: newId, UpdatedAt: new Date().toISOString() } as unknown as Session]);
        currentSessionIdRef.current = newId;
        useSessionStore.getState().setCurrentSessionId(newId);
        useMessageStore.getState().setMessages([]);
        useSessionStore.getState().clearSessionMessageHistory(newId);
        useCheckpointStore.getState().setSessionCheckpoints(newId, []);
        useCheckpointStore.getState().setSessionToolReceipts(newId, []);
        useStreamingStore.getState().setCurrentRunId('');
        useStreamingStore.getState().clearActivity();
        if (isMobile) {
          useUIStore.getState().setMobileSidebarOpen(false);
          useUIStore.getState().setMobileActionsOpen(false);
        }
        void fetchSessions(agentId, newId);
      }
    } catch (error) {
      if (error instanceof CancelledError) return;
      console.error('Failed to create session:', error);
    }
  }, [agentId, api, disconnectRun, fetchSessions, isMobile]);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await api.deleteSession(sessionId);
        useSessionStore.getState().removeSession(sessionId);
        useSessionStore.getState().clearSessionMessageHistory(sessionId);
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
      } catch (error) {
        if (error instanceof CancelledError) return;
        console.error('Failed to delete session', error);
      }
    },
    [agentId, api, disconnectRun, fetchSessions],
  );

  const loadOlderSessionMessages = useCallback(async (sessionId: string) => {
    const historyState = useSessionStore.getState().messageHistory[sessionId];
    if (
      !historyState
      || !historyState.hasMore
      || historyState.nextCursor === null
      || historyState.isLoadingOlder
    ) {
      return;
    }
    const generation = loadSessionGenerationRef.current;
    const requestToken = Symbol(sessionId);
    olderMessageRequestRef.current.set(sessionId, requestToken);
    try {
      useSessionStore.getState().setSessionMessageHistoryLoading(sessionId, true);
      const data = await api.listSessionMessages(sessionId, {
        beforeSeqId: historyState.nextCursor,
        limit: SESSION_MESSAGES_PAGE_SIZE,
        includeReasoning: true,
        includeToolEvents: true,
        includeAttachments: true,
      });
      if (
        currentSessionIdRef.current !== sessionId
        || loadSessionGenerationRef.current !== generation
        || olderMessageRequestRef.current.get(sessionId) !== requestToken
      ) {
        return;
      }
      const olderMessages = mapBackendMessages(data.Messages);
      const olderIds = new Set(olderMessages.map((message) => message.id));
      const mergedHistory = [
        ...olderMessages,
        ...useMessageStore.getState().messages.filter((message) => !olderIds.has(message.id)),
      ];
      useMessageStore.getState().setMessages(mergedHistory);
      useSessionStore.getState().setSessionMessageHistory(sessionId, {
        nextCursor: data.NextCursor,
        hasMore: data.HasMore,
      });
      void loadFeedbackForMessages(agentIdRef.current, sessionId, olderMessages);
    } catch (error) {
      if (!(error instanceof CancelledError)) {
        console.error('Failed to load older session messages:', error);
      }
    } finally {
      if (olderMessageRequestRef.current.get(sessionId) === requestToken) {
        olderMessageRequestRef.current.delete(sessionId);
        useSessionStore.getState().setSessionMessageHistoryLoading(sessionId, false);
      }
    }
  }, [api, loadFeedbackForMessages]);

  return {
    fetchSessions,
    loadMoreSessions,
    loadSession,
    loadOlderSessionMessages,
    createNewSession,
    deleteSession,
    currentSessionIdRef,
    agentIdRef,
    runSubscriptionAbortRef,
  };
}
