/**
 * Single Interaction store.
 *
 * Holds the normalized Interaction records for all sessions and enforces
 * first-wins terminal semantics locally: a terminal record never
 * regresses to pending, so a replayed history or a racing second tab
 * cannot resurrect an already-resolved decision.
 */
import {
  isTerminalInteraction,
  type Interaction,
  type InteractionEvent,
} from './types.js';

export type InteractionStoreListener = (event: InteractionEvent) => void;

export class InteractionStore {
  /** key: `${sessionId}\u0000${interactionId}` */
  private records = new Map<string, Interaction>();
  /** Run terminal facts can arrive before replay reaches its interaction. */
  private terminalRuns = new Set<string>();
  private rejectedCommands = new Map<string, string>();
  private listeners = new Set<InteractionStoreListener>();

  private key(sessionId: string, interactionId: string): string {
    return `${sessionId}\u0000${interactionId}`;
  }

  private runKey(sessionId: string, runId: string): string {
    return `${sessionId}\u0000${runId}`;
  }

  subscribe(listener: InteractionStoreListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  private emit(event: InteractionEvent) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  get(sessionId: string, interactionId: string): Interaction | null {
    return this.records.get(this.key(sessionId, interactionId)) || null;
  }

  listPending(sessionId: string): readonly Interaction[] {
    return this.listAll(sessionId).filter(
      (interaction) => interaction.status === 'pending',
    );
  }

  listAll(sessionId: string): readonly Interaction[] {
    return this.all().filter(
      (interaction) => interaction.sessionId === sessionId,
    );
  }

  all(): readonly Interaction[] {
    return [...this.records.values()].sort((a, b) =>
      String(a.createdAt).localeCompare(String(b.createdAt)),
    );
  }

  /**
   * Insert or merge an Interaction. Returns the emitted event.
   *
   * - A terminal record never regresses to a non-terminal status
   *   (first-wins).
   * - A newer revision of the same status wins (revision CAS).
   * - Terminal facts (actor, outcome, resolvedAt, responseSummary) are
   *   preserved on merge.
   */
  upsert(interaction: Interaction): InteractionEvent {
    if (
      interaction.runId
      && !isTerminalInteraction(interaction.status)
      && this.terminalRuns.has(this.runKey(interaction.sessionId, interaction.runId))
    ) {
      interaction = {
        ...interaction,
        status: 'expired',
        outcome: 'expired',
        resolvedAt: interaction.resolvedAt ?? new Date().toISOString(),
        responseSummary: interaction.responseSummary ?? '运行已结束',
      };
    }
    const existing = this.get(interaction.sessionId, interaction.interactionId);
    let next: Interaction;
    let event: InteractionEvent;

    if (!existing) {
      next = interaction;
      event = { type: 'interaction_requested', interaction: next };
    } else if (isTerminalInteraction(existing.status) && !isTerminalInteraction(interaction.status)) {
      // First-wins: keep the terminal record, only fill missing facts.
      next = existing;
      event = { type: 'interaction_updated', interaction: next };
    } else if (
      interaction.revision < existing.revision
      || (interaction.revision === existing.revision
        && isTerminalInteraction(existing.status)
        && !isTerminalInteraction(interaction.status))
    ) {
      next = existing;
      event = { type: 'interaction_updated', interaction: next };
    } else if (
      existing.status === 'failed'
      && existing.extensions.rejected_command_id
      && interaction.revision === existing.revision
      && !isTerminalInteraction(interaction.status)
    ) {
      // Replaying the original request does not undo a later command rejection
      // or discard the command identity needed for a deliberate retry.
      next = existing;
      event = { type: 'interaction_updated', interaction: next };
    } else if (existing.status === 'resolving' && !isTerminalInteraction(interaction.status)) {
      // An in-flight submit is never demoted by a non-terminal fact (the
      // receipt path no longer resolves locally): keep resolving until the
      // authoritative terminal SessionEvent arrives.
      next = existing;
      event = { type: 'interaction_updated', interaction: next };
    } else if (isTerminalInteraction(interaction.status)) {
      next = {
        ...existing,
        ...interaction,
        // The terminal SessionEvent carries only the decision facts —
        // descriptive snapshot fields (title, kind, request_schema,
        // presentation) come from the original request and must survive
        // the merge so history anchors can render the read-only snapshot.
        title: existing.title || interaction.title,
        kind: existing.kind || interaction.kind,
        message: existing.message || interaction.message,
        runId: interaction.runId ?? existing.runId,
        requestSchema: existing.requestSchema ?? interaction.requestSchema,
        presentation: existing.presentation ?? interaction.presentation,
        actor: interaction.actor ?? existing.actor,
        outcome: interaction.outcome ?? existing.outcome,
        resolvedAt: interaction.resolvedAt ?? existing.resolvedAt,
        responseSummary: interaction.responseSummary ?? existing.responseSummary,
      };
      event = { type: 'interaction_resolved', interaction: next };
    } else {
      next = { ...existing, ...interaction };
      event = { type: 'interaction_updated', interaction: next };
    }

    this.records.set(this.key(next.sessionId, next.interactionId), next);
    this.emit(event);
    return event;
  }

  /** Locally mark a record as resolving while a submit is in flight. */
  markResolving(sessionId: string, interactionId: string): void {
    const existing = this.get(sessionId, interactionId);
    if (!existing || !['pending', 'failed'].includes(existing.status)) return;
    const extensions = { ...existing.extensions };
    delete extensions.submit_error;
    this.records.set(this.key(sessionId, interactionId), {
      ...existing,
      status: 'resolving',
      extensions,
    });
    this.emit({
      type: 'interaction_updated',
      interaction: this.get(sessionId, interactionId)!,
    });
  }

  /** Locally resolve a record (optimistic legacy paths). */
  resolveLocally(
    sessionId: string,
    interactionId: string,
    patch: Partial<Pick<Interaction, 'status' | 'outcome' | 'actor' | 'responseSummary' | 'resolvedAt' | 'revision'>>,
  ): void {
    const existing = this.get(sessionId, interactionId);
    if (!existing) return;
    const next: Interaction = {
      ...existing,
      ...patch,
      resolvedAt: patch.resolvedAt ?? existing.resolvedAt ?? new Date().toISOString(),
      revision: patch.revision ?? existing.revision,
    };
    this.records.set(this.key(sessionId, interactionId), next);
    this.emit({ type: 'interaction_resolved', interaction: next });
  }

  /** Correlate durable Inbox receipts with later execution rejections. */
  recordCommand(sessionId: string, interactionId: string, commandId: string): void {
    const existing = this.get(sessionId, interactionId);
    if (!existing || !commandId || isTerminalInteraction(existing.status)) return;
    this.records.set(this.key(sessionId, interactionId), {
      ...existing, extensions: { ...existing.extensions, submit_command_id: commandId },
    });
    const reason = this.rejectedCommands.get(this.key(sessionId, commandId));
    if (reason) this.rejectCommand(sessionId, commandId, reason);
  }

  rejectCommand(sessionId: string, commandId: string, reason: string): void {
    if (!sessionId || !commandId) return;
    this.rejectedCommands.set(this.key(sessionId, commandId), reason);
    for (const record of this.listAll(sessionId)) {
      if (record.extensions.submit_command_id !== commandId) continue;
      this.markFailed(sessionId, record.interactionId, {
        code: reason, message: `提交未执行（${reason}），请重试`, retryable: true,
      });
      const updated = this.get(sessionId, record.interactionId);
      if (updated?.status === 'failed') {
        this.records.set(this.key(sessionId, record.interactionId), {
          ...updated, extensions: { ...updated.extensions, rejected_command_id: commandId },
        });
      }
    }
  }

  /** Attach an idempotency key to a resolving record (replay correlation). */
  recordIdempotencyKey(sessionId: string, interactionId: string, key: string): void {
    const existing = this.get(sessionId, interactionId);
    if (!existing) return;
    const next: Interaction = {
      ...existing,
      extensions: { ...existing.extensions, idempotency_key: key },
    };
    this.records.set(this.key(sessionId, interactionId), next);
    this.emit({ type: 'interaction_updated', interaction: next });
  }

  /** Locally mark a submit as failed after a definitive receipt rejection. */
  markFailed(
    sessionId: string,
    interactionId: string,
    error: { code: string; message: string; retryable: boolean },
  ): void {
    const existing = this.get(sessionId, interactionId);
    if (!existing || existing.status !== 'resolving') return;
    const next: Interaction = {
      ...existing,
      status: 'failed',
      extensions: { ...existing.extensions, submit_error: error },
    };
    this.records.set(this.key(sessionId, interactionId), next);
    this.emit({ type: 'interaction_updated', interaction: next });
  }

  /** Revert a resolving record to pending (retryable receipt, legacy rejection). */
  revertToPending(sessionId: string, interactionId: string): void {
    const existing = this.get(sessionId, interactionId);
    if (!existing || existing.status !== 'resolving') return;
    const next: Interaction = { ...existing, status: 'pending' };
    this.records.set(this.key(sessionId, interactionId), next);
    this.emit({ type: 'interaction_updated', interaction: next });
  }

  /** Close every actionable interaction when its owning run reaches a terminal state. */
  markRunTerminal(sessionId: string, runId: string): void {
    if (!sessionId || !runId) return;
    this.terminalRuns.add(this.runKey(sessionId, runId));
    for (const interaction of this.listAll(sessionId)) {
      if (
        interaction.runId !== runId
        || isTerminalInteraction(interaction.status)
      ) continue;
      const next: Interaction = {
        ...interaction,
        status: 'expired',
        outcome: 'expired',
        resolvedAt: interaction.resolvedAt ?? new Date().toISOString(),
        responseSummary: interaction.responseSummary ?? '运行已结束',
      };
      this.records.set(this.key(sessionId, interaction.interactionId), next);
      this.emit({ type: 'interaction_resolved', interaction: next });
    }
  }

  /** Close the active session's open cards when a transport terminal is run-scoped only implicitly. */
  markSessionTerminal(sessionId: string): void {
    if (!sessionId) return;
    const runIds = new Set(
      this.listAll(sessionId)
        .filter((interaction) => !isTerminalInteraction(interaction.status))
        .map((interaction) => interaction.runId)
        .filter((runId): runId is string => Boolean(runId)),
    );
    for (const runId of runIds) this.markRunTerminal(sessionId, runId);
    for (const interaction of this.listAll(sessionId)) {
      if (interaction.runId || isTerminalInteraction(interaction.status)) continue;
      const next: Interaction = {
        ...interaction,
        status: 'expired',
        outcome: 'expired',
        resolvedAt: interaction.resolvedAt ?? new Date().toISOString(),
        responseSummary: interaction.responseSummary ?? '运行已结束',
      };
      this.records.set(this.key(sessionId, interaction.interactionId), next);
      this.emit({ type: 'interaction_resolved', interaction: next });
    }
  }

  remove(sessionId: string, interactionId: string): void {
    const key = this.key(sessionId, interactionId);
    if (!this.records.has(key)) return;
    this.records.delete(key);
    this.emit({ type: 'interaction_removed', interactionId });
  }

  clearSession(sessionId: string): void {
    for (const interaction of this.listAll(sessionId)) {
      this.remove(sessionId, interaction.interactionId);
    }
    const prefix = `${sessionId}\u0000`;
    for (const key of this.rejectedCommands.keys()) {
      if (key.startsWith(prefix)) this.rejectedCommands.delete(key);
    }
    for (const key of this.terminalRuns) {
      if (key.startsWith(prefix)) this.terminalRuns.delete(key);
    }
  }
}
