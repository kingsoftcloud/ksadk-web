import { canonicalTeamsJson, digestTeamsJson } from './cloudCanonical.js';

/** Durable user intent only. Authentication belongs to the injected transport, never this store. */
export type TeamsOperationStatus = 'queued' | 'sending' | 'confirmed' | 'rejected' | 'uncertain';
export type TeamsOperationJson = null | boolean | number | string | TeamsOperationJson[] | { [key: string]: TeamsOperationJson };
export type TeamsOperationPayload = { [key: string]: TeamsOperationJson };

export interface TeamsOperationScope {
  origin: string;
  ownerScopeRef: string;
  authorityId: string;
  /** Empty only for authority-level operations, such as creating a group. */
  groupId: string;
}

export interface TeamsOperation {
  scope: TeamsOperationScope;
  operationId: string;
  /** Stable business operation, including its resource target, not a URL carrying credentials. */
  operation: string;
  idempotencyKey: string;
  payload: TeamsOperationPayload;
  payloadDigest: string;
  createdAt: number;
  updatedAt: number;
  status: TeamsOperationStatus;
  revision: number;
  attempts: number;
  serverOperationId?: string;
  receipt?: TeamsOperationPayload;
  errorCode?: string;
  leaseOwner?: string;
  leaseToken?: string;
  leaseExpiresAt?: number;
}

export interface EnqueueTeamsOperation {
  operationId?: string;
  operation: string;
  idempotencyKey?: string;
  /** Business JSON only; transport headers, request IDs and credentials are rejected. */
  payload: TeamsOperationPayload;
}

export type TeamsOperationOutcome =
  | { status: 'confirmed'; serverOperationId?: string; receipt?: TeamsOperationPayload }
  | { status: 'rejected'; serverOperationId?: string; code: string; receipt?: TeamsOperationPayload }
  | { status: 'uncertain' | 'pending'; serverOperationId?: string };

export interface TeamsOperationTransport {
  /** A definitive missing reply permits resending the SAME operation/key/payload only. */
  lookup(operation: Readonly<TeamsOperation>, signal: AbortSignal): Promise<TeamsOperationOutcome | { status: 'missing' }>;
  send(operation: Readonly<TeamsOperation>, signal: AbortSignal): Promise<TeamsOperationOutcome>;
}

export class TeamsOperationOutboxError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'TeamsOperationOutboxError'; this.code = code; }
}

const STORE = 'teams_operations';
const SCOPE_PATH = ['scope.origin', 'scope.ownerScopeRef', 'scope.authorityId', 'scope.groupId'];
const TERMINAL = new Set<TeamsOperationStatus>(['confirmed', 'rejected']);
// Reject transport envelopes rather than silently stripping data and changing business intent.
const SECRET_FIELDS = new Set(['authorization', 'proxyauthorization', 'cookie', 'setcookie', 'credentials',
  'headers', 'password', 'secret', 'secretkey', 'accesskey', 'accesskeyid', 'accesskeysecret', 'apikey',
  'token', 'tokenref', 'accesstoken', 'refreshtoken', 'refreshsecret', 'privatekey', 'clientsecret',
  'nodecredential', 'runtimetoken', 'signedurl', 'presignedurl']);
const TRANSPORT_FIELDS = new Set(['requestId', 'idempotencyKey', 'transportTimestamp', 'transportTime']);

function fail(code: string): never { throw new TeamsOperationOutboxError(code); }
function boundedText(value: string, max = 200, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || Array.from(value).some(char => char.charCodeAt(0) < 32)) fail('invalid_operation_identity');
  return value;
}
function businessJson(value: TeamsOperationPayload, maxBytes: number, rejectMetadata = true): { payload: TeamsOperationPayload; json: string } {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('invalid_business_payload');
  if (rejectMetadata && Object.keys(value).some(key => TRANSPORT_FIELDS.has(key))) fail('transport_metadata_not_allowed');
  let json: string;
  try { json = canonicalTeamsJson(value); } catch { fail('invalid_business_payload'); }
  if (new TextEncoder().encode(json).byteLength > maxBytes) fail('payload_too_large');
  const checkCredentials = (item: TeamsOperationJson): void => {
    if (Array.isArray(item)) item.forEach(checkCredentials);
    else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (SECRET_FIELDS.has(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) fail('credentials_not_allowed');
        checkCredentials(child);
      }
    }
  };
  checkCredentials(value);
  return { payload: JSON.parse(json) as TeamsOperationPayload, json };
}
function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { value.onsuccess = () => resolve(value.result); value.onerror = () => reject(value.error); });
}
function scopeKey(scope: TeamsOperationScope): string[] { return [scope.origin, scope.ownerScopeRef, scope.authorityId, scope.groupId]; }
function integer(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid_outbox_limit');
  return value;
}

export interface TeamsOperationOutboxOptions {
  scope: TeamsOperationScope;
  databaseName?: string;
  indexedDB?: IDBFactory;
  crypto?: Pick<Crypto, 'subtle' | 'randomUUID'>;
  now?: () => number;
  /** Per scope. Terminal rows may be evicted, unresolved intent is never evicted. */
  maxEntries?: number;
  maxPayloadBytes?: number;
}

/** One immutable authenticated owner scope per instance; never a process-wide current-user store. */
export class TeamsOperationOutbox {
  readonly scope: Readonly<TeamsOperationScope>;
  private readonly factory: IDBFactory;
  private readonly cryptography: Pick<Crypto, 'subtle' | 'randomUUID'>;
  private readonly now: () => number;
  private readonly databaseName: string;
  private readonly maxEntries: number;
  private readonly maxPayloadBytes: number;
  private database?: Promise<IDBDatabase>;
  private closed = false;

  constructor(options: TeamsOperationOutboxOptions) {
    const { origin, ownerScopeRef, authorityId, groupId } = options.scope;
    let parsed: URL;
    try { parsed = new URL(origin); } catch { fail('invalid_operation_origin'); }
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) fail('invalid_operation_origin');
    this.scope = Object.freeze({ origin, ownerScopeRef: boundedText(ownerScopeRef, 512), authorityId: boundedText(authorityId), groupId: boundedText(groupId, 200, true) });
    this.factory = options.indexedDB ?? globalThis.indexedDB;
    this.cryptography = options.crypto ?? globalThis.crypto;
    if (!this.factory || !this.cryptography?.subtle || !this.cryptography.randomUUID) fail('outbox_unavailable');
    this.now = options.now ?? Date.now;
    this.databaseName = options.databaseName ?? 'ksadk-teams-operations';
    this.maxEntries = integer(options.maxEntries ?? 1_000, 1, 10_000);
    this.maxPayloadBytes = integer(options.maxPayloadBytes ?? 1_048_576, 1, 2_097_152);
  }

  private async open(): Promise<IDBDatabase> {
    if (this.closed) fail('outbox_closed');
    if (!this.database) {
      this.database = new Promise((resolve, reject) => {
        const opening = this.factory.open(this.databaseName, 1);
        opening.onupgradeneeded = () => {
          const store = opening.result.createObjectStore(STORE, { keyPath: [...SCOPE_PATH, 'operationId'] });
          store.createIndex('scope', SCOPE_PATH);
          store.createIndex('scope_key', [...SCOPE_PATH, 'operation', 'idempotencyKey'], { unique: true });
        };
        opening.onsuccess = () => {
          opening.result.onversionchange = () => { opening.result.close(); this.closed = true; };
          resolve(opening.result);
        };
        opening.onerror = () => reject(new TeamsOperationOutboxError('outbox_unavailable'));
        opening.onblocked = () => reject(new TeamsOperationOutboxError('outbox_upgrade_blocked'));
      });
    }
    return this.database;
  }

  private key(operationId: string): string[] { return [...scopeKey(this.scope), boundedText(operationId)]; }
  private async transaction<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const database = await this.open();
    const transaction = database.transaction(STORE, mode, { durability: mode === 'readwrite' ? 'strict' : 'default' });
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new TeamsOperationOutboxError('outbox_transaction_aborted'));
      transaction.onerror = () => { /* onabort is the final transaction outcome. */ };
    });
    // Prevent an early request rejection from becoming an unhandled transaction rejection.
    void done.catch(() => undefined);
    try {
      const result = await action(transaction.objectStore(STORE));
      await done;
      return result;
    } catch (error) {
      try { transaction.abort(); } catch { /* It may have already aborted. */ }
      await done.catch(() => undefined);
      throw error;
    }
  }

  private async digest(operation: string, json: string): Promise<string> {
    return digestTeamsJson({ operation, payload: JSON.parse(json) }, this.cryptography.subtle);
  }

  async enqueue(input: EnqueueTeamsOperation, options: { reuseUnresolved?: boolean } = {}): Promise<TeamsOperation> {
    const operationId = boundedText(input.operationId ?? this.cryptography.randomUUID());
    const operation = boundedText(input.operation, 512);
    // Business operation names cannot smuggle a signed URL into persistent storage.
    if (!/^[a-zA-Z0-9_.:/-]+$/.test(operation) || operation.includes('://')) fail('invalid_business_operation');
    const idempotencyKey = boundedText(input.idempotencyKey ?? this.cryptography.randomUUID());
    const { payload, json } = businessJson(input.payload, this.maxPayloadBytes);
    const payloadDigest = await this.digest(operation, json);
    return this.transaction('readwrite', async store => {
      const existing = await request(store.get(this.key(operationId))) as TeamsOperation | undefined;
      if (existing) {
        if (existing.payloadDigest !== payloadDigest || existing.operation !== operation || (input.idempotencyKey !== undefined && existing.idempotencyKey !== idempotencyKey)) fail('operation_payload_conflict');
        return existing;
      }
      const rows = await request(store.index('scope').getAll(scopeKey(this.scope))) as TeamsOperation[];
      // The lookup and insertion share one transaction across tabs. A separate
      // pre-read allows two identical user intents to race into different keys.
      const unresolved = options.reuseUnresolved && rows.find(row => row.operation === operation && row.payloadDigest === payloadDigest && !TERMINAL.has(row.status));
      if (unresolved) return unresolved;
      const keyOwner = await request(store.index('scope_key').get([...scopeKey(this.scope), operation, idempotencyKey]));
      if (keyOwner) fail('idempotency_key_conflict');
      const evict = rows.filter(row => TERMINAL.has(row.status)).sort((a, b) => a.updatedAt - b.updatedAt);
      let count = rows.length;
      while (count >= this.maxEntries && evict.length) { await request(store.delete(this.key(evict.shift()!.operationId))); count--; }
      if (count >= this.maxEntries) fail('outbox_capacity');
      const now = this.now();
      const row: TeamsOperation = { scope: { ...this.scope }, operationId, operation, idempotencyKey, payload, payloadDigest, createdAt: now, updatedAt: now, status: 'queued', revision: 1, attempts: 0 };
      await request(store.add(row));
      return row;
    });
  }

  async get(operationId: string): Promise<TeamsOperation | undefined> {
    return this.transaction('readonly', async store => await request(store.get(this.key(operationId))) as TeamsOperation | undefined);
  }

  async list(options: { statuses?: TeamsOperationStatus[]; limit?: number } = {}): Promise<TeamsOperation[]> {
    const limit = integer(options.limit ?? 100, 1, 10_000);
    return this.transaction('readonly', async store => {
      const rows = await request(store.index('scope').getAll(scopeKey(this.scope))) as TeamsOperation[];
      return rows.filter(row => !options.statuses || options.statuses.includes(row.status))
        .sort((a, b) => a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId)).slice(0, limit);
    });
  }

  /** A payload may change only before the first claim, with explicit revision CAS. */
  async updateDraft(operationId: string, expectedRevision: number, value: TeamsOperationPayload): Promise<TeamsOperation> {
    const before = await this.get(operationId);
    if (!before) fail('operation_not_found');
    const { payload, json } = businessJson(value, this.maxPayloadBytes);
    const payloadDigest = await this.digest(before.operation, json);
    return this.transaction('readwrite', async store => {
      const row = await request(store.get(this.key(operationId))) as TeamsOperation | undefined;
      if (!row) fail('operation_not_found');
      if (row.revision !== expectedRevision) fail('operation_revision_conflict');
      if (row.status !== 'queued' || row.attempts !== 0) fail('operation_already_sent');
      const updated = { ...row, payload, payloadDigest, revision: row.revision + 1, updatedAt: this.now() };
      await request(store.put(updated));
      return updated;
    });
  }

  /** IndexedDB serializes overlapping read/write transactions across tabs. */
  async claimNext(leaseOwner: string, leaseMs: number, excludedIds: ReadonlySet<string> = new Set()): Promise<TeamsOperation | undefined> {
    boundedText(leaseOwner);
    integer(leaseMs, 100, 120_000);
    const leaseToken = this.cryptography.randomUUID();
    return this.transaction('readwrite', async store => {
      const now = this.now();
      const rows = await request(store.index('scope').getAll(scopeKey(this.scope))) as TeamsOperation[];
      const row = rows.filter(item => !TERMINAL.has(item.status) && !excludedIds.has(item.operationId) && (!item.leaseExpiresAt || item.leaseExpiresAt <= now))
        // Least attempted first prevents the first page of uncertain rows starving later intent.
        .sort((a, b) => a.attempts - b.attempts || a.createdAt - b.createdAt || a.operationId.localeCompare(b.operationId))[0];
      if (!row) return undefined;
      const claimed: TeamsOperation = { ...row, status: 'sending', leaseOwner, leaseToken, leaseExpiresAt: now + leaseMs, attempts: row.attempts + 1, revision: row.revision + 1, updatedAt: now };
      await request(store.put(claimed));
      return claimed;
    });
  }

  private owns(row: TeamsOperation | undefined, claim: TeamsOperation): row is TeamsOperation {
    return Boolean(row && scopeKey(claim.scope).every((part, index) => part === scopeKey(this.scope)[index]) && row.status === 'sending' && row.leaseOwner === claim.leaseOwner && row.leaseToken === claim.leaseToken && row.leaseExpiresAt! > this.now());
  }

  async renew(claim: TeamsOperation, leaseMs: number): Promise<boolean> {
    integer(leaseMs, 100, 120_000);
    return this.transaction('readwrite', async store => {
      const row = await request(store.get(this.key(claim.operationId))) as TeamsOperation | undefined;
      if (!this.owns(row, claim)) return false;
      await request(store.put({ ...row, leaseExpiresAt: this.now() + leaseMs, updatedAt: this.now() }));
      return true;
    });
  }

  /** Late responses from an expired owner can never overwrite a newer tab's receipt. */
  async settle(claim: TeamsOperation, outcome: TeamsOperationOutcome, failureCode?: string): Promise<boolean> {
    if (!['confirmed', 'rejected', 'uncertain', 'pending'].includes(outcome.status)) fail('invalid_operation_receipt');
    const serverOperationId = outcome.serverOperationId === undefined ? undefined : boundedText(outcome.serverOperationId);
    const receipt = 'receipt' in outcome && outcome.receipt !== undefined ? businessJson(outcome.receipt, this.maxPayloadBytes, false).payload : undefined;
    const errorCode = outcome.status === 'rejected' ? outcome.code : failureCode ?? (outcome.status === 'pending' ? 'pending' : undefined);
    if (errorCode !== undefined && !/^[a-z][a-z0-9_]{0,99}$/.test(errorCode)) fail('invalid_operation_error_code');
    return this.transaction('readwrite', async store => {
      const row = await request(store.get(this.key(claim.operationId))) as TeamsOperation | undefined;
      if (!this.owns(row, claim)) return false;
      const updated: TeamsOperation = { ...row, status: outcome.status === 'pending' ? 'uncertain' : outcome.status,
        updatedAt: this.now(), revision: row.revision + 1 };
      delete updated.leaseOwner; delete updated.leaseToken; delete updated.leaseExpiresAt;
      delete updated.errorCode; delete updated.receipt;
      if (serverOperationId !== undefined) updated.serverOperationId = serverOperationId;
      if (receipt !== undefined) updated.receipt = receipt;
      if (errorCode !== undefined) updated.errorCode = errorCode;
      await request(store.put(updated));
      return true;
    });
  }

  async close(): Promise<void> { this.closed = true; if (this.database) (await this.database).close(); }
}

export interface TeamsOperationDrainOptions {
  signal?: AbortSignal;
  maxOperations?: number;
  maxDurationMs?: number;
  requestTimeoutMs?: number;
  leaseMs?: number;
}
export interface TeamsOperationDrainResult { processed: number; confirmed: number; rejected: number; uncertain: number; aborted: boolean }

/** Bounded, cancellable recovery. Call deactivate on logout/identity change before creating another drainer. */
export class TeamsOperationDrainer {
  private readonly outbox: TeamsOperationOutbox;
  private readonly transport: TeamsOperationTransport;
  private readonly tabId: string;
  private active?: AbortController;
  private deactivated = false;

  constructor(outbox: TeamsOperationOutbox, transport: TeamsOperationTransport, tabId: string = globalThis.crypto.randomUUID()) {
    this.outbox = outbox; this.transport = transport; this.tabId = boundedText(tabId);
  }

  deactivate(): void { this.deactivated = true; this.active?.abort(); }

  async drain(options: TeamsOperationDrainOptions = {}): Promise<TeamsOperationDrainResult> {
    if (this.deactivated) fail('outbox_identity_inactive');
    if (this.active) fail('outbox_drain_in_progress');
    const maxOperations = integer(options.maxOperations ?? 50, 1, 1_000);
    const maxDurationMs = integer(options.maxDurationMs ?? 30_000, 1, 120_000);
    const timeoutMs = integer(options.requestTimeoutMs ?? 10_000, 1, 120_000);
    const leaseMs = integer(options.leaseMs ?? 15_000, 100, 120_000);
    const controller = new AbortController(); this.active = controller;
    const cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const deadline = setTimeout(cancel, maxDurationMs);
    const result: TeamsOperationDrainResult = { processed: 0, confirmed: 0, rejected: 0, uncertain: 0, aborted: false };
    const attempted = new Set<string>();
    try {
      while (!controller.signal.aborted && result.processed < maxOperations) {
        const claim = await this.outbox.claimNext(this.tabId, leaseMs, attempted);
        if (!claim) break;
        attempted.add(claim.operationId);
        result.processed++;
        const outcome = await this.recover(claim, controller.signal, leaseMs, timeoutMs);
        if (outcome !== undefined) result[outcome]++;
      }
      result.aborted = controller.signal.aborted;
      return result;
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener('abort', cancel);
      this.active = undefined;
    }
  }

  private async recover(claim: TeamsOperation, signal: AbortSignal, leaseMs: number, timeoutMs: number): Promise<'confirmed' | 'rejected' | 'uncertain' | undefined> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing || controller.signal.aborted) return;
      renewing = true;
      void this.outbox.renew(claim, leaseMs).then(owned => { if (!owned) cancel(); }, cancel).finally(() => { renewing = false; });
    }, Math.floor(leaseMs / 3));
    try {
      // Always lookup, including after refresh and after an ambiguous submission response.
      let outcome = await this.call(abort => this.transport.lookup(structuredClone(claim), abort), controller.signal, timeoutMs);
      if (outcome.status === 'missing') {
        if (controller.signal.aborted || !await this.outbox.renew(claim, leaseMs)) fail('operation_aborted');
        outcome = await this.call(abort => this.transport.send(structuredClone(claim), abort), controller.signal, timeoutMs);
      }
      if (controller.signal.aborted) fail('operation_aborted');
      if (!await this.outbox.settle(claim, outcome)) return undefined;
      return outcome.status === 'pending' ? 'uncertain' : outcome.status;
    } catch (error) {
      // Never persist transport Error.message: servers can include private URLs or tokens in it.
      const code = signal.aborted ? 'aborted' : error instanceof TeamsOperationOutboxError && error.code === 'operation_timeout' ? 'timeout' : 'transport_uncertain';
      if (await this.outbox.settle(claim, { status: 'uncertain' }, code)) return 'uncertain';
      return undefined;
    } finally {
      clearInterval(heartbeat);
      signal.removeEventListener('abort', cancel);
      controller.abort();
    }
  }

  private async call<T>(invoke: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
    if (signal.aborted) fail('operation_aborted');
    const controller = new AbortController();
    let cancel: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      cancel = () => { controller.abort(); reject(new TeamsOperationOutboxError('operation_aborted')); };
      signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => { controller.abort(); reject(new TeamsOperationOutboxError('operation_timeout')); }, timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => {
        if (controller.signal.aborted) fail('operation_aborted');
        return invoke(controller.signal);
      }), interrupted]);
    }
    finally { clearTimeout(timer); signal.removeEventListener('abort', cancel); controller.abort(); }
  }
}
