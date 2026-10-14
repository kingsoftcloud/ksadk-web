import { useCallback } from 'react';
import { useMessageStore } from '../stores/message.js';
import { useSessionStore } from '../stores/session.js';
import {
  applyOptimisticFeedback,
  buildGetFeedbackPayload,
  buildUpsertFeedbackPayload,
  clearFeedback,
  markFeedbackSaved,
  normalizeFeedback,
  rollbackFeedback,
} from '../utils/feedback.js';
import type { Message } from '../components/chat/types.js';
import type { ApiFacade } from '../core/api/types.js';

type UseFeedbackContext = {
  agentId: string;
  currentSessionId: string | null;
  isStreaming: boolean;
  api: ApiFacade;
  submitDraft: (
    text: string,
    attachments: File[],
    responsesInput?: unknown,
    previousResponseId?: string,
  ) => Promise<boolean>;
};

export function useFeedback(ctx: UseFeedbackContext) {
  const {
    agentId,
    currentSessionId,
    isStreaming,
    api,
    submitDraft,
  } = ctx;

  const submitResponseFeedback = useCallback(
    async (options: {
      message: Message;
      rating: 'up' | 'down';
      comment?: string;
    }) => {
      if (!currentSessionId) {
        return;
      }

      let previousFeedback: NonNullable<Message['feedback']> | null = null;
      useMessageStore.getState().patchMessages((prev) => {
        const result = applyOptimisticFeedback(prev, {
          messageId: options.message.id,
          rating: options.rating,
          comment: options.comment || '',
        });
        previousFeedback = result.previousFeedback;
        return result.nextMessages;
      });

      try {
        const data = await api.upsertResponseFeedback(
          buildUpsertFeedbackPayload({
            agentId,
            sessionId: currentSessionId,
            message: options.message,
            rating: options.rating,
            comment: options.comment || '',
          }),
        );
        const feedback = normalizeFeedback((data as Record<string, unknown>)?.Feedback);
        if (feedback) {
          useMessageStore.getState().patchMessages((prev) =>
            markFeedbackSaved(prev, {
              messageId: options.message.id,
              feedback,
            }),
          );
        }
      } catch (error) {
        console.error('Failed to submit response feedback:', error);
        useMessageStore.getState().patchMessages((prev) =>
          rollbackFeedback(prev, {
            messageId: options.message.id,
            previousFeedback,
          }),
        );
      }
    },
    [agentId, currentSessionId, api],
  );

  const deleteResponseFeedback = useCallback(
    async (message: Message) => {
      if (!currentSessionId) {
        return;
      }

      const previousFeedback: NonNullable<Message['feedback']> | null = message.feedback
        ? { ...message.feedback }
        : null;
      useMessageStore.getState().patchMessages((prev) => clearFeedback(prev, { messageId: message.id }));

      try {
        await api.deleteResponseFeedback(
          buildGetFeedbackPayload({
            agentId,
            sessionId: currentSessionId,
            message,
          }),
        );
      } catch (error) {
        console.error('Failed to delete response feedback:', error);
        useMessageStore.getState().patchMessages((prev) =>
          rollbackFeedback(prev, {
            messageId: message.id,
            previousFeedback,
          }),
        );
      }
    },
    [agentId, currentSessionId, api],
  );

  const respondToApproval = useCallback(
    async (options: {
      approvalRequestId: string;
      approve: boolean;
      previousResponseId?: string;
    }): Promise<boolean> => {
      if (!options.approvalRequestId || isStreaming) return false;
      const accepted = await submitDraft(
        '',
        [],
        [
          {
            type: 'mcp_approval_response',
            approval_request_id: options.approvalRequestId,
            approve: options.approve,
          },
        ],
        options.previousResponseId,
      );
      if (!accepted) return false;
      // Dispatch belongs to the originating session even if the user navigated
      // while the HTTP request was pending. Its Interaction record is settled
      // by the client; only patch the transcript while that session is visible.
      if (useSessionStore.getState().currentSessionId !== currentSessionId) return true;

      // A terminal approval may arrive while submitDraft is awaiting dispatch.
      // Only update pending approvals (or legacy entries without a status).
      useMessageStore.getState().patchMessages((prev) =>
        prev.map((message) => {
          const approvalStatus = options.approve ? 'approved' : 'rejected';
          const nextStatus = (status: 'running' | 'completed' | 'error' | 'paused' | 'unknown') =>
            options.approve && status === 'paused'
              ? 'running' as const
              : !options.approve
                ? 'completed' as const
                : status;
          return {
            ...message,
            tools: message.tools
              ? Object.fromEntries(
                  Object.entries(message.tools).map(([name, tool]) => [
                    name,
                    tool.approvalRequestId === options.approvalRequestId
                      && (tool.approvalStatus === undefined || tool.approvalStatus === 'pending')
                      ? {
                          ...tool,
                          status: nextStatus(tool.status),
                          approvalStatus,
                        }
                      : tool,
                  ]),
                )
              : message.tools,
            blocks: message.blocks?.map((block) =>
              block.type === 'tool' && block.extra?.approvalRequestId === options.approvalRequestId
                && (block.extra.approvalStatus === undefined || block.extra.approvalStatus === 'pending')
                ? {
                    ...block,
                    status: nextStatus(block.status),
                    extra: { ...block.extra, approvalStatus },
                  }
                : block,
            ),
          };
        }),
      );
      return true;
    },
    [currentSessionId, isStreaming, submitDraft],
  );

  return { submitResponseFeedback, deleteResponseFeedback, respondToApproval };
}
