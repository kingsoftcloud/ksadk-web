import { useRef, useCallback, useEffect } from 'react';
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

type QueuedDraft = {
  text: string;
  attachments: File[];
};

type RunAgentContext = {
  agentId: string;
  currentSessionId: string | null;
  agentFramework: string;
  apiFormats: RuntimeApiFormat[];
  selectedModel: string;
  selectedModelMetadata?: ModelCatalogItem | null;
  thinkingMode: string;
  uiCapabilities: UiCapabilities;
  isMobile: boolean;
  api: ApiFacade;
  currentSessionIdRef: React.MutableRefObject<string | null>;
  agentIdRef: React.MutableRefObject<string>;
  queuedDraftRef: React.MutableRefObject<Array<{ text: string; attachments: File[] }>>;
  onRunSettled?: (sessionId: string | null) => void;
};

export function useRunAgent(ctx: RunAgentContext) {
  const enginesRef = useRef(new Map<string, RunEngineImpl>());
  const drainQueueRef = useRef<() => void>(() => {});

  const {
    agentId,
    apiFormats,
    agentFramework,
    selectedModel,
    selectedModelMetadata,
    thinkingMode,
    currentSessionIdRef,
    queuedDraftRef,
    onRunSettled,
    uiCapabilities,
  } = ctx;

  const configureEngine = useCallback((engine: RunEngineImpl) => {
    engine.updateConfig({
      agentId,
      apiFormats,
      agentFramework,
      selectedModel,
      selectedModelMetadata,
      thinkingMode,
      hostedChatTransport: resolveHostedChatTransport(uiCapabilities),
      checkpointResumePreviewEnabled: Boolean(uiCapabilities.RunLifecycle?.CheckpointResumePreview),
    });
  }, [agentId, apiFormats, agentFramework, selectedModel, selectedModelMetadata, thinkingMode, uiCapabilities]);

  const getEngine = useCallback((sessionId: string | null | undefined) => {
    const key = String(sessionId || 'new-session');
    let engine = enginesRef.current.get(key);
    if (!engine) {
      engine = new RunEngineImpl(ctx.api);
      configureEngine(engine);
      engine.subscribe(dispatchRunEventToStores);
      enginesRef.current.set(key, engine);
    } else {
      configureEngine(engine);
    }
    return engine;
  }, [ctx.api, configureEngine]);

  useEffect(() => {
    for (const engine of enginesRef.current.values()) {
      configureEngine(engine);
    }
  }, [configureEngine]);

  const enqueueDraft = useCallback((draft: QueuedDraft) => {
    queuedDraftRef.current.push(draft);
    useUIStore.getState().setQueuedDrafts((prev) => [...prev, draft]);
  }, [queuedDraftRef]);

  const startDraft = useCallback(
    (draft: QueuedDraft & { responsesInput?: unknown; previousResponseId?: string }) => {
      const targetSessionId = currentSessionIdRef.current;
      const engine = getEngine(targetSessionId);
      if (engine.stage !== 'idle') {
        return false;
      }

      resetDispatcherState();
      useUIStore.getState().setMobileActionsOpen(false);
      useStreamingStore.getState().setSessionStreaming(targetSessionId, true);

      const trimmedText = draft.text.trim();
      const userMessageId = String(Date.now());
      const userAttachments = draft.attachments.map((file) => ({
        name: file.name,
        url: URL.createObjectURL(file),
        type: file.type || 'application/octet-stream',
      }));

      if (trimmedText || userAttachments.length > 0) {
        useMessageStore.getState().patchMessages((prev) => [
          ...prev,
          {
            id: userMessageId,
            role: 'user',
            content: trimmedText,
            timestamp: Date.now(),
            attachments: userAttachments.length ? userAttachments : undefined,
          },
        ]);
      }

      const accepted = engine.start({
        text: draft.text,
        attachments: draft.attachments,
        responsesInput: draft.responsesInput,
        previousResponseId: draft.previousResponseId,
        sessionId: targetSessionId,
        onSessionCreated: (sessionId: string) => {
          useSessionStore.getState().upsertSessions([{ SessionId: sessionId, UpdatedAt: new Date().toISOString() } as unknown as Session]);
          currentSessionIdRef.current = sessionId;
          writePersistedSessionId(agentId, sessionId);
          useSessionStore.getState().setCurrentSessionId(sessionId);
          if (targetSessionId !== sessionId) {
            enginesRef.current.set(sessionId, engine);
          }
        },
        onSessionUpsert: () => {},
        onSettled: (sessionId) => {
          onRunSettled?.(sessionId);
          drainQueueRef.current();
        },
      });
      if (!accepted) {
        useStreamingStore.getState().setSessionStreaming(targetSessionId, false);
      }
      return accepted;
    },
    [agentId, currentSessionIdRef, getEngine, onRunSettled],
  );

  useEffect(() => {
    drainQueueRef.current = () => {
      const next = queuedDraftRef.current.shift();
      if (!next) {
        useUIStore.getState().setQueuedDrafts([]);
        return;
      }

      useUIStore.getState().setQueuedDrafts((prev) => prev.slice(1));
      queueMicrotask(() => {
        if (!startDraft(next)) {
          queuedDraftRef.current.unshift(next);
          useUIStore.getState().setQueuedDrafts((prev) => [next, ...prev]);
        }
      });
    };
  }, [queuedDraftRef, startDraft]);

  const submitDraft = useCallback(
    async (
      draftText: string,
      draftAttachments: File[],
      responsesInput?: unknown,
      previousResponseId?: string,
    ) => {
      const draft = {
        text: draftText,
        attachments: draftAttachments,
        responsesInput,
        previousResponseId,
      };

      const engine = getEngine(currentSessionIdRef.current);
      if (engine.stage !== 'idle' && useStreamingStore.getState().isSessionStreaming(currentSessionIdRef.current)) {
        if (responsesInput === undefined) {
          enqueueDraft({ text: draftText, attachments: draftAttachments });
        }
        return;
      }

      if (!startDraft(draft) && responsesInput === undefined) {
        enqueueDraft({ text: draftText, attachments: draftAttachments });
      }
    },
    [currentSessionIdRef, enqueueDraft, getEngine, startDraft],
  );

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
          onRunSettled?.(sessionId);
          drainQueueRef.current();
        },
      });
      if (!accepted) {
        useStreamingStore.getState().setSessionStreaming(params.sessionId, false);
      }
      return accepted;
    },
    [getEngine, onRunSettled],
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
      onSettled: onRunSettled,
    });
  }, [currentSessionIdRef, getEngine, onRunSettled]);

  const respondToAguiApproval = useCallback((options: {
    interruptId: string;
    approve: boolean;
  }) => {
    if (!options.interruptId) return false;
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return false;
    const engine = getEngine(sessionId);
    if (engine.stage !== 'idle') return false;

    useStreamingStore.getState().setSessionStreaming(sessionId, true);
    const accepted = engine.resumeAguiInterrupt({
      sessionId,
      interruptId: options.interruptId,
      status: 'resolved',
      payload: { decision: options.approve ? 'approve' : 'reject' },
      onSettled: onRunSettled,
    });
    if (!accepted) {
      useStreamingStore.getState().setSessionStreaming(sessionId, false);
    }
    return accepted;
  }, [currentSessionIdRef, getEngine, onRunSettled]);

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
