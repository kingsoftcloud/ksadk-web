import { TeamsOperationDrainer, TeamsOperationOutbox, TeamsOperationOutboxError, type EnqueueTeamsOperation, type TeamsOperation, type TeamsOperationOutboxOptions, type TeamsOperationTransport } from './operationOutbox.js';

export interface CloudOperationsState { operations: TeamsOperation[]; recovering: boolean; errorCode: string | null }

/** Owns one authenticated scope. A view change never generates another command identity. */
export class CloudOperations {
  readonly outbox: TeamsOperationOutbox;
  private readonly drainer: TeamsOperationDrainer;
  private state: CloudOperationsState = { operations: [], recovering: false, errorCode: null };
  private listeners = new Set<() => void>();
  private work?: Promise<void>;
  private disposed = false;
  private writable = true;
  private recoveryController?: AbortController;
  private readonly controller = new AbortController();
  constructor(options: TeamsOperationOutboxOptions, transport: TeamsOperationTransport) {
    this.outbox = new TeamsOperationOutbox(options);
    this.drainer = new TeamsOperationDrainer(this.outbox, transport);
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<CloudOperationsState>) { if (!this.disposed) { this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener()); } }
  async refresh() { if (!this.disposed) this.update({ operations: await this.outbox.list({ limit: 10_000 }) }); }
  /** Read-only degradation may inspect the queue, but must not silently resume delivery. */
  setWritable(value: boolean) { this.writable = value; if (!value) this.recoveryController?.abort(); }
  async enqueue(input: EnqueueTeamsOperation): Promise<TeamsOperation> {
    if (this.disposed || !this.writable) throw new TeamsOperationOutboxError('cloud_read_only');
    const operation = await this.outbox.enqueue(input, { reuseUnresolved: true });
    await this.refresh();
    return operation;
  }
  async recover(): Promise<void> {
    if (this.disposed) return;
    if (this.work) return this.work;
    if (!this.writable) { await this.refresh(); return; }
    this.update({ recovering: true, errorCode: null });
    const recovery = new AbortController(); this.recoveryController = recovery;
    const abort = () => recovery.abort(); this.controller.signal.addEventListener('abort', abort, { once: true });
    this.work = (async () => {
      try {
        await this.drainer.drain({ signal: recovery.signal, maxOperations: 50, maxDurationMs: 30_000 });
        await this.refresh();
      } catch (cause) {
        this.update({ errorCode: cause instanceof TeamsOperationOutboxError ? cause.code : 'outbox_unavailable' });
      } finally { this.controller.signal.removeEventListener('abort', abort); this.recoveryController = undefined; this.update({ recovering: false }); this.work = undefined; }
    })();
    return this.work;
  }
  async submit(input: EnqueueTeamsOperation): Promise<TeamsOperation> {
    const row = await this.enqueue(input);
    await this.recover();
    return await this.outbox.get(row.operationId) ?? row;
  }
  dispose() { this.disposed = true; this.controller.abort(); this.drainer.deactivate(); this.listeners.clear(); void this.outbox.close().catch(() => undefined); }
}
