import type { RunEvent } from './types.js';
import { useMessageStore } from '../../stores/message.js';
import { useStreamingStore } from '../../stores/streaming.js';
import { useSessionStore } from '../../stores/session.js';
import { useCheckpointStore } from '../../stores/checkpoint.js';
import { buildCompactionMessage } from '../../utils/session-events.js';
import { isFailedToolOutput } from '../../utils/tool-display.js';
import type { Message } from '../../components/chat/types.js';

const TERMINAL_COMPLETE_STATUSES = new Set(['completed']);
const TERMINAL_ERROR_STATUSES = new Set(['failed', 'error', 'cancelled', 'canceled', 'aborted', 'incomplete']);

function ensureAssistantMessage(id: string) {
  useMessageStore.getState().patchMessages((prev) => {
    if (prev.some((message) => message.id === id)) return prev;
    return [
      ...prev,
      { id, role: 'model', content: '', timestamp: Date.now(), reasoning: '' },
    ];
  });
}

function settleRunningToolsForTerminalStatus(status: string) {
  const normalizedStatus = String(status || '').trim().toLowerCase();
  const nextStatus = TERMINAL_COMPLETE_STATUSES.has(normalizedStatus)
    ? 'completed'
    : TERMINAL_ERROR_STATUSES.has(normalizedStatus)
      ? 'error'
      : null;
  if (!nextStatus) return;

  useMessageStore.getState().patchMessages((prev) =>
    prev.map((msg) => {
      if (!msg.tools) return msg;
      let changed = false;
      const tools = Object.fromEntries(
        Object.entries(msg.tools).map(([name, tool]) => {
          if (tool.status !== 'running') return [name, tool];
          changed = true;
          return [name, { ...tool, status: nextStatus }];
        }),
      ) as NonNullable<Message['tools']>;
      return changed ? { ...msg, tools } : msg;
    }),
  );
}

export function dispatchRunEventToStores(event: RunEvent) {
  if (event.sessionId && useSessionStore.getState().currentSessionId !== event.sessionId) {
    return;
  }

  const ms = useMessageStore.getState();

  switch (event.type) {
    case 'activity':
      useStreamingStore.getState().updateActivity({
        sessionId: event.sessionId,
        source: event.source,
        status: event.status,
        phase: event.phase,
        detail: event.detail,
        countEvent: event.countEvent,
      });
      break;

    case 'user_message_added':
      ms.patchMessages((prev) => [
        ...prev,
        { id: event.messageId, role: 'user', content: '', timestamp: Date.now() },
      ]);
      break;

    case 'assistant_message_created':
      ensureAssistantMessage(event.messageId);
      break;

    case 'text_delta':
      ensureAssistantMessage(event.messageId);
      ms.patchMessages((prev) =>
        prev.map((msg) =>
          msg.id === event.messageId
            ? { ...msg, content: msg.content + event.delta }
            : msg,
        ),
      );
      break;

    case 'text_final':
      ensureAssistantMessage(event.messageId);
      ms.patchMessages((prev) =>
        prev.map((msg) =>
          msg.id === event.messageId
            ? { ...msg, content: event.text }
            : msg,
        ),
      );
      break;

    case 'reasoning_delta':
      ensureAssistantMessage(event.messageId);
      ms.patchMessages((prev) =>
        prev.map((msg) =>
          msg.id === event.messageId
            ? { ...msg, reasoning: (msg.reasoning || '') + event.delta }
            : msg,
        ),
      );
      break;

    case 'tool_upsert': {
      ensureAssistantMessage(event.messageId);
      ms.patchMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== event.messageId) return msg;
          const current = msg.tools?.[event.name];
          const currentApprovalResolved = current?.approvalStatus === 'approved'
            || current?.approvalStatus === 'rejected';
          return {
            ...msg,
            tools: {
              ...(msg.tools || {}),
              [event.name]: {
                ...(current || { name: event.name, args: '' }),
                name: event.name,
                args: event.args,
                status: currentApprovalResolved
                  ? 'completed'
                  : event.status as NonNullable<Message['tools']>[string]['status'],
                ...(event.extra || {}),
                ...(event.extra?.approvalRequestId && !currentApprovalResolved
                  ? { approvalStatus: 'pending' as const }
                  : {}),
              },
            },
          };
        }),
      );
      break;
    }

    case 'tool_result':
      ensureAssistantMessage(event.messageId);
      ms.patchMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== event.messageId) return msg;
          return {
            ...msg,
            tools: {
              ...(msg.tools || {}),
              [event.name]: {
                ...(msg.tools?.[event.name] || { name: event.name, args: '' }),
                output: event.output,
                status: isFailedToolOutput(event.output) ? 'error' : 'completed',
              },
            },
          };
        }),
      );
      break;

    case 'approval_requested': {
      ensureAssistantMessage(event.messageId);
      ms.patchMessages((prev) =>
        prev.map((msg) => {
          if (msg.id !== event.messageId) return msg;
          const existing = msg.tools?.[event.approvalRequestId];
          const alreadyResolved = existing?.approvalStatus === 'approved'
            || existing?.approvalStatus === 'rejected';
          return {
            ...msg,
            tools: {
              ...(msg.tools || {}),
              [event.approvalRequestId]: {
                ...(existing || {}),
                name: event.name,
                args: event.args,
                status: alreadyResolved ? 'completed' : 'paused',
                approvalRequestId: event.approvalRequestId,
                approvalProtocol: event.protocol,
                approvalStatus: alreadyResolved ? existing.approvalStatus : 'pending',
                ...(event.message ? { approvalMessage: event.message } : {}),
                ...(event.approvalLevel ? { approvalLevel: event.approvalLevel } : {}),
              },
            },
          };
        }),
      );
      break;
    }

    case 'approval_resolved':
      ms.patchMessages((prev) =>
        prev.map((msg) => {
          if (!msg.tools) return msg;
          let changed = false;
          const tools = Object.fromEntries(
            Object.entries(msg.tools).map(([key, tool]) => {
              if (tool.approvalRequestId !== event.approvalRequestId) return [key, tool];
              changed = true;
              return [key, {
                ...tool,
                status: 'completed' as const,
                approvalStatus: event.decision,
              }];
            }),
          ) as NonNullable<Message['tools']>;
          return changed ? { ...msg, tools } : msg;
        }),
      );
      break;

    case 'system_message':
      ms.patchMessages((prev) => [
        ...prev,
        {
          id: String(Date.now() + Math.random()),
          role: 'system',
          content: event.content,
          timestamp: Date.now(),
        },
      ]);
      break;

    case 'compaction': {
      const compactionId = `compaction-${Date.now()}`;
      const status: Message['status'] =
        event.phase === 'start' ? 'running'
          : event.phase === 'failed' ? 'failed'
          : 'completed';
      const compactionMsg = buildCompactionMessage({
        id: compactionId,
        timestamp: Date.now(),
        status,
        trigger: event.trigger,
        compactedUntilSeqId: event.compactedUntilSeqId,
      });
      ms.patchMessages((prev) => {
        const existingIndex = prev.findIndex((m) => m.id === compactionId);
        if (existingIndex < 0) return [...prev, compactionMsg as Message];
        return prev.map((m) => (m.id === compactionId ? { ...m, ...compactionMsg } : m));
      });
      break;
    }

    case 'stage_changed':
      if (event.stage === 'streaming' || event.stage === 'connecting') {
        useStreamingStore.getState().setSessionStreaming(event.sessionId, true);
      } else if (event.stage === 'completing' || event.stage === 'error' || event.stage === 'cancelled') {
        useStreamingStore.getState().setSessionStreaming(event.sessionId, false);
      }
      break;

    case 'stream_ended':
      useStreamingStore.getState().setSessionStreaming(event.sessionId, false);
      globalThis.setTimeout(() => {
        const state = useStreamingStore.getState();
        const activity = state.getSessionActivity(event.sessionId);
        if (activity?.status === 'completed') {
          state.clearSessionActivity(event.sessionId);
        }
      }, 2400);
      break;

    case 'error':
      useStreamingStore.getState().setSessionStreaming(event.sessionId, false);
      useStreamingStore.getState().updateActivity({
        sessionId: event.sessionId,
        status: 'failed',
        phase: '连接断开或生成出错',
        countEvent: false,
      });
      ms.patchMessages((prev) => [
        ...prev,
        {
          id: String(Date.now()),
          role: 'model',
          content: '连接断开或生成出错。',
          timestamp: Date.now(),
        },
      ]);
      break;

    case 'terminal':
      settleRunningToolsForTerminalStatus(event.status);
      break;

    case 'stream_event': {
      const streamSessionId = event.sessionId || event.event.SessionId;
      if (event.event.EventType === 'run_checkpoint' && streamSessionId) {
        useCheckpointStore.getState().upsertSessionCheckpoint(streamSessionId, event.event);
      }
      if (event.event.EventType === 'run_status') {
        const status = String((event.event.Content as { status?: unknown } | undefined)?.status || '').trim().toLowerCase();
        if (status === 'completed') {
          useStreamingStore.getState().updateActivity({
            sessionId: streamSessionId,
            status: 'completed',
            phase: '后台长任务已完成',
            countEvent: false,
          });
        } else if (status === 'cancelled' || status === 'canceled' || status === 'aborted') {
          useStreamingStore.getState().updateActivity({
            sessionId: streamSessionId,
            status: 'stopped',
            phase: '后台长任务已取消',
            countEvent: false,
          });
        } else if (status === 'failed' || status === 'error') {
          useStreamingStore.getState().updateActivity({
            sessionId: streamSessionId,
            status: 'failed',
            phase: '后台长任务失败',
            countEvent: false,
          });
        }
      }
      break;
    }

    case 'a2ui_surface_begin': {
      const msgId = `a2ui-${event.surfaceId}`;
      useMessageStore.getState().patchMessages((prev) => {
        const without = prev.filter((m) => m.id !== msgId);
        return [
          ...without,
          {
            id: msgId,
            role: 'a2ui' as const,
            content: '',
            timestamp: Date.now(),
            a2ui: {
              surfaceId: event.surfaceId,
              surface: event.surface,
            },
          },
        ];
      });
      break;
    }

    case 'a2ui_surface_update': {
      const msgId = `a2ui-${event.surfaceId}`;
      useMessageStore.getState().patchMessages((prev) =>
        prev.map((m) =>
          m.id === msgId && m.a2ui
            ? { ...m, a2ui: { ...m.a2ui, surface: event.surface } }
            : m,
        ),
      );
      break;
    }

    case 'a2ui_surface_end': {
      const msgId = `a2ui-${event.surfaceId}`;
      useMessageStore.getState().patchMessages((prev) =>
        prev.map((m) =>
          m.id === msgId && m.a2ui
            ? { ...m, a2ui: { ...m.a2ui, ended: true } }
            : m,
        ),
      );
      break;
    }

    case 'a2ui_interaction': {
      const msgId = `a2ui-${event.surfaceId}`;
      useMessageStore.getState().patchMessages((prev) =>
        prev.map((m) =>
          m.id === msgId && m.a2ui
            ? {
                ...m,
                a2ui: {
                  ...m.a2ui,
                  pendingInteraction: {
                    interactionId: event.interactionId,
                    kind: event.kind,
                    inputSchema: event.inputSchema,
                  },
                },
              }
            : m,
        ),
      );
      break;
    }

    case 'agui_activity': {
      const msgId = `agui-a2ui-${event.surfaceId}`;
      useMessageStore.getState().patchMessages((prev) => {
        const activity = { surfaceId: event.surfaceId, messages: event.messages };
        let attached = false;
        const withAttachedActivity = prev.map((message) => {
          if (message.id !== event.messageId) return message;
          attached = true;
          const prior = message.aguiActivities || [];
          const next = [
            ...prior.filter((item) => item.surfaceId !== event.surfaceId),
            activity,
          ];
          return { ...message, aguiActivities: next };
        });
        if (attached) return withAttachedActivity;

        // An activity can legally arrive before the assistant message. Keep
        // the existing standalone fallback for that edge case and for replay.
        const current = prev.find((message) => message.id === msgId);
        const nextMessage: Message = {
          id: msgId,
          role: 'a2ui',
          content: '',
          timestamp: current?.timestamp || Date.now(),
          aguiActivity: activity,
        };
        return current
          ? prev.map((message) => message.id === msgId ? nextMessage : message)
          : [...prev, nextMessage];
      });
      break;
    }
  }
}

export function resetDispatcherState() {
  // Kept for test and session lifecycle callers. Message existence is now the
  // source of truth, so switching sessions cannot drop a live AG-UI event.
}
