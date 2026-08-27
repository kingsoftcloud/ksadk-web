import type {
  ConversationClientErrorCode,
  ConversationClientErrorDetails,
} from './types.js';

/** Stable, non-secret-bearing failures for headless conversation clients. */
export class ConversationClientError extends Error {
  readonly code: ConversationClientErrorCode;

  readonly status?: number;

  readonly capability?: string;

  readonly runId?: string;

  readonly cursor?: number;

  override readonly cause?: unknown;

  constructor(
    code: ConversationClientErrorCode,
    message: string,
    details: ConversationClientErrorDetails = {},
  ) {
    super(message);
    this.name = 'ConversationClientError';
    this.code = code;
    this.status = details.status;
    this.capability = details.capability;
    this.runId = details.runId;
    this.cursor = details.cursor;
    this.cause = details.cause;
  }
}
