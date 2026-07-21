import { create } from 'zustand';
import type { Session } from '../components/chat/types.js';
import { buildSessionPaginationState, mergeLoadedPages } from '../utils/session-pagination.js';

export type SessionState = {
  sessions: Session[];
  currentSessionId: string | null;
  sessionsAgentId: string;
  sessionsTotal: number;
  sessionsPage: number;
  sessionsPageSize: number;
  loadedPages: Set<number>;
  hasMoreSessions: boolean;
  isLoadingSessions: boolean;
  pinnedSessionIds: string[];
  messageHistory: Record<string, {
    nextCursor: number | null;
    hasMore: boolean;
    isLoadingOlder: boolean;
  }>;
};

export type SessionActions = {
  setSessions: (sessions: Session[]) => void;
  setCurrentSessionId: (id: string | null) => void;
  upsertSessions: (incoming: Session[], meta?: {
    agentId?: string;
    total?: number;
    page?: number;
    pageSize?: number;
    replace?: boolean;
  }) => void;
  removeSession: (id: string) => void;
  setLoadingSessions: (loading: boolean) => void;
  resetSessionPagination: (agentId: string) => void;
  togglePinnedSession: (id: string) => void;
  setSessionMessageHistory: (sessionId: string, history: {
    nextCursor: number | null;
    hasMore: boolean;
    isLoadingOlder?: boolean;
  }) => void;
  setSessionMessageHistoryLoading: (sessionId: string, loading: boolean) => void;
  clearSessionMessageHistory: (sessionId?: string) => void;
};

function sessionUpdatedAtValue(session: Session): number {
  const raw = session.UpdatedAt;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? (raw > 1e11 ? raw : raw * 1000) : 0;
  }
  return 0;
}

const PINNED_SESSIONS_STORAGE_KEY = 'ksadk.pinnedSessionIds';

function readPinnedSessionIds(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(PINNED_SESSIONS_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function writePinnedSessionIds(ids: string[]) {
  try {
    globalThis.localStorage?.setItem(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Ignore unavailable storage, e.g. private mode.
  }
}

function sortSessions(sessions: Session[], pinnedSessionIds: string[]): Session[] {
  const pinned = new Set(pinnedSessionIds);
  return sessions.slice().sort((left, right) => {
    const leftPinned = pinned.has(left.SessionId) ? 1 : 0;
    const rightPinned = pinned.has(right.SessionId) ? 1 : 0;
    if (leftPinned !== rightPinned) {
      return rightPinned - leftPinned;
    }
    return sessionUpdatedAtValue(right) - sessionUpdatedAtValue(left);
  });
}

function upsertSessions(current: Session[], incoming: Session[], pinnedSessionIds: string[]): Session[] {
  const merged = new Map<string, Session>();
  for (const session of current) {
    if (!session?.SessionId) continue;
    merged.set(session.SessionId, session);
  }
  for (const session of incoming) {
    if (!session?.SessionId) continue;
    merged.set(session.SessionId, { ...(merged.get(session.SessionId) || {}), ...session });
  }
  return sortSessions(Array.from(merged.values()), pinnedSessionIds);
}

export type SessionStore = SessionState & SessionActions;

export const useSessionStore = create<SessionStore>()((set) => ({
  sessions: [],
  currentSessionId: null,
  sessionsAgentId: '',
  sessionsTotal: 0,
  sessionsPage: 0,
  sessionsPageSize: 30,
  loadedPages: new Set(),
  hasMoreSessions: false,
  isLoadingSessions: false,
  pinnedSessionIds: readPinnedSessionIds(),
  messageHistory: {},
  setSessions: (sessions) =>
    set((s) => ({ sessions: sortSessions(sessions, s.pinnedSessionIds) })),
  setCurrentSessionId: (id) => set({ currentSessionId: id }),
  upsertSessions: (incoming, meta) =>
    set((s) => {
      const base = meta?.replace ? [] : s.sessions;
      const nextSessions = upsertSessions(base, incoming, s.pinnedSessionIds);
      const page = meta?.page ?? s.sessionsPage;
      const pageSize = meta?.pageSize ?? s.sessionsPageSize;
      const total = meta?.total ?? Math.max(s.sessionsTotal, nextSessions.length);
      const loadedPages = meta?.replace
        ? mergeLoadedPages(new Set(), [page])
        : mergeLoadedPages(s.loadedPages, [page]);
      const pagination = buildSessionPaginationState({
        sessionsLength: nextSessions.length,
        total,
        page,
        pageSize,
        loadedPages,
      });
      return {
        sessions: nextSessions,
        sessionsAgentId: meta?.agentId ?? s.sessionsAgentId,
        sessionsTotal: pagination.total,
        sessionsPage: pagination.page,
        sessionsPageSize: pagination.pageSize,
        loadedPages: pagination.loadedPages,
        hasMoreSessions: pagination.hasMore,
      };
    }),
  removeSession: (id) =>
    set((s) => {
      const sessions = s.sessions.filter((session) => session.SessionId !== id);
      const sessionsTotal = Math.max(0, s.sessionsTotal - 1);
      const pagination = buildSessionPaginationState({
        sessionsLength: sessions.length,
        total: sessionsTotal,
        page: s.sessionsPage,
        pageSize: s.sessionsPageSize,
        loadedPages: s.loadedPages,
      });
      return {
        sessions,
        sessionsTotal,
        hasMoreSessions: pagination.hasMore,
        pinnedSessionIds: s.pinnedSessionIds.filter((pinnedId) => pinnedId !== id),
      };
    }),
  setLoadingSessions: (loading) => set({ isLoadingSessions: loading }),
  resetSessionPagination: (agentId) =>
    set({
      sessions: [],
      sessionsAgentId: agentId,
      sessionsTotal: 0,
      sessionsPage: 0,
      loadedPages: new Set(),
      hasMoreSessions: false,
      isLoadingSessions: false,
    }),
  togglePinnedSession: (id) =>
    set((s) => {
      const pinned = new Set(s.pinnedSessionIds);
      if (pinned.has(id)) {
        pinned.delete(id);
      } else {
        pinned.add(id);
      }
      const pinnedSessionIds = Array.from(pinned);
      writePinnedSessionIds(pinnedSessionIds);
      return {
        pinnedSessionIds,
        sessions: sortSessions(s.sessions, pinnedSessionIds),
      };
    }),
  setSessionMessageHistory: (sessionId, history) =>
    set((s) => ({
      messageHistory: {
        ...s.messageHistory,
        [sessionId]: {
          nextCursor: history.nextCursor,
          hasMore: history.hasMore,
          isLoadingOlder: history.isLoadingOlder ?? false,
        },
      },
    })),
  setSessionMessageHistoryLoading: (sessionId, loading) =>
    set((s) => {
      const existing = s.messageHistory[sessionId];
      if (!existing) return {};
      return {
        messageHistory: {
          ...s.messageHistory,
          [sessionId]: { ...existing, isLoadingOlder: loading },
        },
      };
    }),
  clearSessionMessageHistory: (sessionId) =>
    set((s) => {
      if (!sessionId) {
        return { messageHistory: {} };
      }
      const next = { ...s.messageHistory };
      delete next[sessionId];
      return { messageHistory: next };
    }),
}));
