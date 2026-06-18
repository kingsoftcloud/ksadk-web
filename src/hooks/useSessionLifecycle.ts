import { useCallback, useEffect, useRef } from 'react';
import { useSessionStore } from '../stores/session.js';
import { useMessageStore } from '../stores/message.js';
import { useUIStore } from '../stores/ui.js';
import { useCheckpointStore } from '../stores/checkpoint.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { CancelledError } from '../api/client.js';
import { findActiveRunIds } from '../utils/run-state.js';
import {
  buildMessagesFromSessionEvents,
  eventHasTerminalRunStatus,
  maxSeqIdFromEvents,
  mergeSessionEventRecords,
} from '../utils/session-events.js';
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
const SESSION_EVENTS_PAGE_SIZE = 50;

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
  if (rawStatus === 'failed' || rawStatus === 'error') {
    return { status: 'failed', phase: '后台长任务失败' };
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
      initialEvents?: SessionEventRecord[];
    }) => {
      runSubscriptionAbortRef.current?.abort();
      const controller = new AbortController();
      runSubscriptionAbortRef.current = controller;
      let shouldReloadSession = false;
      let terminalStatusSeen = false;
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
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let mergedEvents: SessionEventRecord[] = Array.isArray(options.initialEvents)
          ? options.initialEvents
          : [];
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
              mergedEvents = mergeSessionEventRecords(mergedEvents, [event]) as SessionEventRecord[];
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
              const history = buildMessagesFromSessionEvents(mergedEvents);
              useMessageStore.getState().setMessages(history);
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
        if (runSubscriptionAbortRef.current === controller) {
          runSubscriptionAbortRef.current = null;
        }
        useStreamingStore.getState().setCurrentRunId('');
        if (shouldReloadSession && currentSessionIdRef.current === options.sessionId) {
          void loadSessionRef.current?.(options.sessionId);
        }
        void fetchSessionsRef.current?.(agentIdRef.current, options.sessionId);
      }
    },
    [api],
  );

  const loadSession = useCallback(
    async (sessionId: string) => {
      currentSessionIdRef.current = sessionId;
      useSessionStore.getState().setCurrentSessionId(sessionId);
      resetCompaction();
      runSubscriptionAbortRef.current?.abort();
      if (isMobile) {
        useUIStore.getState().setMobileSidebarOpen(false);
      }

      try {
        const cached = useSessionStore.getState().eventCache[sessionId];
        let data: { Events?: SessionEventRecord[]; Total?: number; Offset?: number; Limit?: number };
        if (cached) {
          data = {
            Events: cached.events,
            Total: cached.total,
            Offset: cached.offset,
            Limit: cached.limit,
          };
        } else {
          const probe = await api.listSessionEvents(sessionId, {
            offset: 0,
            limit: 1,
          });
          const total = Number(probe.Total ?? probe.Events?.length ?? 0);
          const offset = Math.max(0, total - SESSION_EVENTS_PAGE_SIZE);
          data = total <= 1
            ? probe as { Events?: SessionEventRecord[]; Total?: number; Offset?: number; Limit?: number }
            : await api.listSessionEvents(sessionId, {
                offset,
                limit: SESSION_EVENTS_PAGE_SIZE,
              }) as { Events?: SessionEventRecord[]; Total?: number; Offset?: number; Limit?: number };
          useSessionStore.getState().setSessionEventCache(sessionId, {
            events: (data.Events || []) as SessionEventRecord[],
            total,
            offset: Number(data.Offset ?? offset),
            limit: Number(data.Limit ?? data.Events?.length ?? 0),
          });
        }
        const runtimeCapabilities = useBootstrapStore.getState().capabilities || uiCapabilities;
        if (runtimeCapabilities.RunLifecycle.Enabled && runtimeCapabilities.RunLifecycle.Checkpoints) {
          void api.listSessionCheckpoints({
            agentId: agentIdRef.current,
            sessionId,
          }).then((checkpointData) => {
            useCheckpointStore
              .getState()
              .setSessionCheckpoints(sessionId, checkpointData.Checkpoints || []);
          }).catch((error) => {
            console.warn('[SessionLifecycle] checkpoint load failed:', error);
            useCheckpointStore.getState().setSessionCheckpoints(sessionId, []);
          });
          void api.listToolReceipts({
            agentId: agentIdRef.current,
            sessionId,
          }).then((receiptData) => {
            useCheckpointStore
              .getState()
              .setSessionToolReceipts(sessionId, receiptData.ToolReceipts || []);
          }).catch((error) => {
            console.warn('[SessionLifecycle] tool receipt load failed:', error);
            useCheckpointStore.getState().setSessionToolReceipts(sessionId, []);
          });
        } else {
          useCheckpointStore.getState().clearSessionCheckpoints(sessionId);
        }
        const eventsData = data as { Events?: SessionEventRecord[] };
        if (eventsData?.Events) {
          const events = eventsData.Events;
          const history = buildMessagesFromSessionEvents(events);
          useMessageStore.getState().setMessages(history);
          void loadFeedbackForMessages(agentIdRef.current, sessionId, history);
          const activeRuns = findActiveRunIds(events, {
            now: Date.now(),
            staleAfterMs: 30 * 60 * 1000,
          });
          const lastSeqId = maxSeqIdFromEvents(events);
          if (
            runtimeCapabilities.RunLifecycle.Enabled &&
            runtimeCapabilities.RunLifecycle.Resume &&
            activeRuns[0]
          ) {
            void subscribeRunEvents({
              sessionId,
              invocationId: activeRuns[0],
              afterSeqId: lastSeqId,
              initialEvents: events,
            });
          }
        } else {
          useMessageStore.getState().setMessages([]);
          useCheckpointStore.getState().setSessionCheckpoints(sessionId, []);
          useCheckpointStore.getState().setSessionToolReceipts(sessionId, []);
        }
      } catch (error) {
        console.error('Failed to load session events:', error);
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
          currentSessionIdRef.current = null;
          useSessionStore.getState().setCurrentSessionId(null);
          useMessageStore.getState().setMessages([]);
          useCheckpointStore.getState().clearSessionCheckpoints();
        }
      } catch (error) {
        if (error instanceof CancelledError) return;
        console.error('Failed to fetch sessions:', error);
      } finally {
        useSessionStore.getState().setLoadingSessions(false);
      }
    },
    [api, loadSession],
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
      const session = await api.createSession(agentId);
      const newId = session.SessionId;
      if (newId) {
        useSessionStore
          .getState()
          .upsertSessions([{ SessionId: newId, UpdatedAt: new Date().toISOString() } as unknown as Session]);
        currentSessionIdRef.current = newId;
        useSessionStore.getState().setCurrentSessionId(newId);
        useMessageStore.getState().setMessages([]);
        useCheckpointStore.getState().setSessionCheckpoints(newId, []);
        useCheckpointStore.getState().setSessionToolReceipts(newId, []);
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
        useSessionStore.getState().clearSessionEventCache(sessionId);
        if (currentSessionIdRef.current === sessionId) {
          currentSessionIdRef.current = null;
          useMessageStore.getState().setMessages([]);
          useCheckpointStore.getState().clearSessionCheckpoints(sessionId);
          useSessionStore.getState().setCurrentSessionId(null);
          void fetchSessions(agentId);
        }
      } catch (error) {
        if (error instanceof CancelledError) return;
        console.error('Failed to delete session', error);
      }
    },
    [agentId, api, fetchSessions],
  );

  const loadOlderSessionEvents = useCallback(async (sessionId: string) => {
    const cache = useSessionStore.getState().eventCache[sessionId];
    if (!cache || cache.offset <= 0 || cache.isLoadingOlder) {
      return;
    }
    const nextOffset = Math.max(0, cache.offset - SESSION_EVENTS_PAGE_SIZE);
    const nextLimit = cache.offset - nextOffset;
    try {
      useSessionStore.getState().setSessionEventLoadingOlder(sessionId, true);
      const data = await api.listSessionEvents(sessionId, {
        offset: nextOffset,
        limit: nextLimit,
      });
      const incoming = (data.Events || []) as SessionEventRecord[];
      const merged = mergeSessionEventRecords(incoming, cache.events) as SessionEventRecord[];
      useSessionStore.getState().setSessionEventCache(sessionId, {
        events: merged,
        total: Number(data.Total ?? cache.total),
        offset: Number(data.Offset ?? nextOffset),
        limit: merged.length,
      });
      if (currentSessionIdRef.current === sessionId) {
        const history = buildMessagesFromSessionEvents(merged);
        useMessageStore.getState().setMessages(history);
        void loadFeedbackForMessages(agentIdRef.current, sessionId, history);
      }
    } catch (error) {
      if (!(error instanceof CancelledError)) {
        console.error('Failed to load older session events:', error);
      }
    } finally {
      useSessionStore.getState().setSessionEventLoadingOlder(sessionId, false);
    }
  }, [api, loadFeedbackForMessages]);

  return {
    fetchSessions,
    loadMoreSessions,
    loadSession,
    loadOlderSessionEvents,
    createNewSession,
    deleteSession,
    currentSessionIdRef,
    agentIdRef,
    runSubscriptionAbortRef,
  };
}
