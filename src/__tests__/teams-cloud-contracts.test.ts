import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import manifest from '../../schemas/teams-cloud/v1/manifest.json';
import fixtures from './fixtures/teams-cloud-v1.json';
import {
  canonicalTeamsJson, compareTeamsMaterialPaths, decodeTeamsCanonicalEventBatch, decodeTeamsExecutionRef,
  decodeTeamsHostReceipt, decodeTeamsHostOperationResult, decodeTeamsMaterialManifest, decodeTeamsNodeReport, digestTeamsJson,
  parseTeamsNodeMessage, teamsNodeProbeDigest, decodeTeamsNodeProbeReport, decodeTeamsExecutionResult,
  parseTeamsNodeCommand, teamsMaterialCreateSchema, teamsMaterialManifestDigest,
  teamsNodeCommandDigest, teamsNodeCommandSchema,
  decodeTeamsExtendedContract, TEAMS_EFFECTS_PORT_VERSION, TEAMS_BUILD_VERSION, TEAMS_LOADED_BUILD_VERSION,
} from '../public/teams.js';

const execution = fixtures.valid.find(item => item.model === 'execution-reference')!.value;
const prepare = fixtures.valid.find(item => item.model === 'node-command')!.value;
const material = fixtures.valid.find(item => item.model === 'material-manifest')!.value;
const ref = decodeTeamsExecutionRef(execution);
const original = teamsNodeCommandSchema.parse(prepare);
const hash = `sha256:${'a'.repeat(64)}`;
const controlId = '33333333-3333-4333-8333-333333333333';

it('matches every generated schema byte digest and the complete contract manifest', async () => {
  for (const [name, expected] of Object.entries(manifest.schemas)) {
    const bytes = readFileSync(new URL(`../../schemas/teams-cloud/v1/${name}`, import.meta.url));
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    expect(`sha256:${Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('')}`).toBe(expected);
  }
  const { contractDigest, ...body } = manifest;
  expect(await digestTeamsJson(body)).toBe(contractDigest);
  expect(manifest.effectsPortVersion).toBe(TEAMS_EFFECTS_PORT_VERSION);
  expect(manifest.buildVersion).toBe(TEAMS_BUILD_VERSION);
  expect(manifest.loadedBuildVersion).toBe(TEAMS_LOADED_BUILD_VERSION);
});

async function decode(model: string, value: unknown) {
  switch (model) {
    case 'execution-reference': return decodeTeamsExecutionRef(value);
    case 'node-command': return parseTeamsNodeCommand(value);
    case 'node-probe-command': return parseTeamsNodeMessage(value);
    case 'node-probe-report': return decodeTeamsNodeProbeReport(value);
    case 'execution-result': return decodeTeamsExecutionResult(value);
    case 'material-manifest': return decodeTeamsMaterialManifest(value);
    case 'host-receipt': return decodeTeamsHostReceipt(value);
    case 'canonical-event-batch': return decodeTeamsCanonicalEventBatch(value);
    case 'node-report': return decodeTeamsNodeReport(value);
    case 'host-operation-result': return decodeTeamsHostOperationResult(value);
    default: return decodeTeamsExtendedContract(model, value);
  }
}

function nativeEnqueue() {
  return { command_id: ref.commandId, idempotency_key: ref.idempotencyKey, tenant_id: 'account-a',
    agent_instance_id: 'instance-a', session_id: ref.sessionId, command_type: 'enqueue',
    payload: { content: 'Do the assigned task', execution_grant_id: 'grant-a', execution_policy_ref: 'policy-a', teams_context_ref: 'context-a', futureField: { decimal: 0.125 } },
    source: { kind: 'workflow', ref: `teams:${ref.authorityId}:${ref.deliveryId}`, futureField: true },
    authorization_ref: 'native-auth-ref', submitted_at: '2026-09-18T08:00:00.000Z', futureOptionalField: 'preserved' };
}
async function signedNode(operation: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  const value = teamsNodeCommandSchema.parse({ ...structuredClone(original), operation, payload,
    lane: operation === 'prepare' || operation === 'submit' ? 'execution' : 'control', ...overrides });
  value.commandDigest = await teamsNodeCommandDigest(value);
  return value;
}
function receipt() {
  return { status: 'accepted', commandId: ref.commandId, idempotencyKey: ref.idempotencyKey, payloadDigest: hash,
    storeIncarnation: 'original-store', runId: 'native-run', acceptedSeq: 2, nativeStatus: 'succeeded',
    terminalEvidence: { sessionId: ref.sessionId, runId: 'native-run', commandId: ref.commandId, terminalSeq: 9, terminalEventDigest: hash } };
}
function eventBatch() {
  return { sessionId: ref.sessionId, storeIncarnation: 'original-store', afterSeq: 5, nextSeq: 10, snapshotUpperSeq: 20, hasMore: true,
    items: [7, 9].map(seq => ({ eventId: `event-${seq}`, sessionId: ref.sessionId, runId: 'native-run', seq,
      family: 'runtime', type: 'run.progress', payload: { text: 'progress', fraction: 0.25 }, sourceRef: {} })) };
}

describe('Shared Python / Server / Web cloud fixtures', () => {
  for (const fixture of fixtures.valid) {
    it(`accepts ${fixture.name}`, async () => {
      await expect(decode(fixture.model, fixture.value)).resolves.toBeDefined();
      if (fixture.model === 'material-manifest' && 'manifestDigest' in fixture) {
        expect(await teamsMaterialManifestDigest(fixture.value)).toBe(fixture.manifestDigest);
      }
    });
  }
  for (const fixture of fixtures.invalid) {
    it(`rejects ${fixture.name}`, async () => { await expect(decode(fixture.model, fixture.value)).rejects.toThrow(); });
  }
});

describe('Strict cloud execution and operation contracts', () => {
  it('fills exactly the Python nullable defaults and preserves safe integer maxima', () => {
    const value = { ...ref, attemptEpoch: Number.MAX_SAFE_INTEGER } as Record<string, unknown>;
    delete value.taskId; delete value.nativeRunId;
    expect(decodeTeamsExecutionRef(value)).toMatchObject({ taskId: null, nativeRunId: null, attemptEpoch: Number.MAX_SAFE_INTEGER });
  });

  it.each([Number.MAX_SAFE_INTEGER + 1, 1.5, Infinity, NaN, true, '1', 0])('rejects invalid revision %s', epoch => {
    expect(() => decodeTeamsExecutionRef({ ...ref, attemptEpoch: epoch })).toThrow();
  });

  it('forbids unknown cloud envelope, target, payload and authorization fields', async () => {
    expect(() => decodeTeamsExecutionRef({ ...ref, future: true })).toThrow();
    expect(() => decodeTeamsExecutionRef({ ...ref, target: { ...ref.target, future: true } })).toThrow();
    for (const value of [
      { ...original, future: true }, { ...original, payload: { ...original.payload, future: true } },
      { ...original, authorization: { ...original.authorization, future: true } },
    ]) await expect(parseTeamsNodeCommand(value)).rejects.toThrow();
  });

  it('requires valid UTC millisecond timestamps and an increasing claim interval', async () => {
    for (const issuedAt of ['2026-02-30T08:00:00.000Z', '0000-01-01T00:00:00.000Z', '2026-09-18T08:00:00Z', '2026-09-18T08:00:00.000+00:00']) {
      await expect(parseTeamsNodeCommand({ ...original, issuedAt })).rejects.toThrow();
    }
    await expect(parseTeamsNodeCommand({ ...original, claimLeaseUntil: original.issuedAt })).rejects.toThrow();
  });

  it('accepts cloud execution references but excludes them from node transport', async () => {
    const cloudRef = { ...ref, target: { kind: 'cloud_agent', agentId: 'agent-a', versionId: 'version-a', runtimeId: 'runtime-a', agentInstanceId: 'instance-a' } };
    expect(decodeTeamsExecutionRef(cloudRef).target.kind).toBe('cloud_agent');
    await expect(parseTeamsNodeCommand({ ...original, ref: cloudRef })).rejects.toThrow();
  });

  it('excludes refreshed permit, claim lease and scheduler epoch from the operation digest', async () => {
    const refreshed = { ...original, issuedAt: '2026-09-18T08:01:00.000Z', claimLeaseUntil: '2026-09-18T08:01:25.000Z',
      authorization: { ...original.authorization, permit: 'different-temporary-permit', grantRevision: 9 }, ref: { ...ref, schedulerEpoch: 9 } };
    expect((await parseTeamsNodeCommand(refreshed)).commandDigest).toBe(original.commandDigest);
    for (const change of [{ attemptEpoch: 2 }, { leaderEpoch: 2 }, { dispatchEpoch: 2 }, { bindingRef: 'other-binding' }]) {
      await expect(parseTeamsNodeCommand({ ...original, ref: { ...ref, ...change } })).rejects.toThrow('node_command_digest_mismatch');
    }
  });

  it('validates all operation payloads and preserves the exact native enqueue dictionary', async () => {
    const native = nativeEnqueue();
    const cases = [
      await signedNode('submit', { command: native, payloadDigest: hash }),
      await signedNode('lookup', { commandId: ref.commandId, idempotencyKey: ref.idempotencyKey, payloadDigest: hash, storeIncarnation: 'original-store' }),
      await signedNode('set_grant', { grantId: 'grant-a', expectedRevision: 1, state: 'active', attemptEpoch: 1, expiresAt: '2026-09-18T08:00:30.000Z', renewalId: 'renew-1' }),
      await signedNode('get_grant', { grantId: 'grant-a' }),
      await signedNode('set_admission', { grantId: 'grant-a', expectedAdmissionRevision: 1, admissionAllowed: false, attemptEpoch: ref.attemptEpoch, controlId: 'pause-1' }),
      await signedNode('cancel', { controlCommandId: controlId, controlIdempotencyKey: 'cancel-1', targetRunId: 'native-run', reason: 'owner request' }, { ref: { ...ref, nativeRunId: 'native-run' } }),
      await signedNode('respond_interaction', { controlCommandId: controlId, controlIdempotencyKey: 'reply-1', interactionId: 'interaction-a', expectedRevision: 1, action: 'submit', response: { score: 4.5 } }, { ref: { ...ref, nativeRunId: 'native-run' } }),
      await signedNode('observe', { sessionId: ref.sessionId, afterSeq: 0 }),
    ];
    for (const value of cases) expect(await parseTeamsNodeCommand(value)).toEqual(value);
    expect(cases[0].payload).toEqual({ command: native, payloadDigest: hash });
    expect(cases.at(-1)?.payload).toMatchObject({ limit: 200 });
  });

  it('rejects native enqueue without its governed context and mismatched frozen identity', async () => {
    const valid = await signedNode('submit', { command: nativeEnqueue(), payloadDigest: hash });
    if (valid.operation !== 'submit') throw new Error('unexpected discriminant');
    for (const key of ['execution_grant_id', 'execution_policy_ref', 'teams_context_ref', 'content']) {
      const command = structuredClone(nativeEnqueue()) as Record<string, unknown>;
      delete (command.payload as Record<string, unknown>)[key];
      await expect(parseTeamsNodeCommand({ ...valid, payload: { command, payloadDigest: hash } })).rejects.toThrow();
    }
    await expect(parseTeamsNodeCommand({ ...valid, payload: { ...valid.payload, command: { ...nativeEnqueue(), command_id: controlId } } })).rejects.toThrow();
  });

  it('checks original lookup/control/session identities and enforces recovery permissions', async () => {
    const lookup = await signedNode('lookup', { commandId: ref.commandId, idempotencyKey: ref.idempotencyKey, payloadDigest: hash, storeIncarnation: 'store' });
    await expect(parseTeamsNodeCommand({ ...lookup, payload: { ...lookup.payload, idempotencyKey: 'wrong-key' } })).rejects.toThrow();
    const cancel = await signedNode('cancel', { controlCommandId: controlId, controlIdempotencyKey: 'cancel-key', targetRunId: 'native-run', reason: '' }, { ref: { ...ref, nativeRunId: 'native-run' }, authorization: { permitKind: 'recovery', permit: 'recovery-only' } });
    expect((await parseTeamsNodeCommand(cancel)).operation).toBe('cancel');
    await expect(parseTeamsNodeCommand({ ...cancel, payload: { ...cancel.payload, controlCommandId: ref.commandId } })).rejects.toThrow();
    await expect(parseTeamsNodeCommand({ ...cancel, payload: { ...cancel.payload, targetRunId: 'another-run' } })).rejects.toThrow();
    const observe = await signedNode('observe', { sessionId: ref.sessionId, afterSeq: 0 });
    await expect(parseTeamsNodeCommand({ ...observe, payload: { sessionId: 'wrong-session', afterSeq: 0 } })).rejects.toThrow();
    const grant = await signedNode('set_grant', { grantId: 'grant', expectedRevision: 1, state: 'active', attemptEpoch: 1, expiresAt: '2026-09-18T08:00:30.000Z', renewalId: 'renew' });
    await expect(parseTeamsNodeCommand({ ...grant, authorization: { permitKind: 'recovery', permit: 'recovery-only' } })).rejects.toThrow();
    await expect(parseTeamsNodeCommand({ ...grant, payload: { ...grant.payload, controlId: 'also-control' } })).rejects.toThrow();
    await expect(parseTeamsNodeCommand({ ...grant, payload: { ...grant.payload, state: 'revoked' } })).rejects.toThrow();
    const admission = await signedNode('set_admission', { grantId: 'grant-a', expectedAdmissionRevision: 1, admissionAllowed: false, attemptEpoch: ref.attemptEpoch, controlId: 'pause-1' });
    await expect(parseTeamsNodeCommand({ ...admission, authorization: { permitKind: 'recovery', permit: 'recovery-only' } })).rejects.toThrow();
    await expect(parseTeamsNodeCommand({ ...admission, payload: { ...admission.payload, controlId: ref.idempotencyKey } })).rejects.toThrow();
  });
});

describe('Host evidence and canonical event page validation', () => {
  it('allows matching terminal evidence and never infers missing from an observed run', () => {
    expect(decodeTeamsHostReceipt(receipt()).terminalEvidence?.terminalSeq).toBe(9);
    for (const change of [{ status: 'missing' }, { nativeStatus: 'running' }, { commandId: controlId }, { runId: 'other-run' }]) {
      expect(() => decodeTeamsHostReceipt({ ...receipt(), ...change })).toThrow();
    }
    const missing = decodeTeamsHostReceipt({ status: 'missing', commandId: ref.commandId, idempotencyKey: ref.idempotencyKey, payloadDigest: hash, storeIncarnation: 'original-store' });
    expect(missing.runId).toBeNull();
  });

  it('allows filtered session gaps while validating frozen cursors, ordering and uniqueness', () => {
    expect(decodeTeamsCanonicalEventBatch(eventBatch()).items.map(item => item.seq)).toEqual([7, 9]);
    for (const value of [
      { ...eventBatch(), nextSeq: 4 }, { ...eventBatch(), nextSeq: 21 }, { ...eventBatch(), hasMore: false },
      { ...eventBatch(), nextSeq: 5, items: [] },
      { ...eventBatch(), items: eventBatch().items.reverse() },
      { ...eventBatch(), items: [eventBatch().items[0], { ...eventBatch().items[1], eventId: eventBatch().items[0].eventId }] },
      { ...eventBatch(), items: [{ ...eventBatch().items[0], sessionId: 'other' }] },
      { ...eventBatch(), items: [{ ...eventBatch().items[0], seq: Number.MAX_SAFE_INTEGER + 1 }] },
      { ...eventBatch(), items: [{ ...eventBatch().items[0], payload: { text: '中'.repeat(350_000) } }] },
    ]) expect(() => decodeTeamsCanonicalEventBatch(value)).toThrow();
    expect(decodeTeamsCanonicalEventBatch({ ...eventBatch(), afterSeq: 20, nextSeq: 20, hasMore: false, items: [] }).hasMore).toBe(false);
  });

  it('requires complete canonical evidence and accounting for terminal node reports', async () => {
    const report = fixtures.valid.find(item => item.name === 'canonical-completion-terminal')!.value;
    expect((await decodeTeamsNodeReport(report)).receipt?.nativeStatus).toBe('succeeded');
    await expect(decodeTeamsNodeReport({ ...report, receipt: null })).rejects.toThrow();
    await expect(decodeTeamsNodeReport({ ...report, error: { code: 'offline', retryable: 'true' } })).rejects.toThrow();
  });

  it('requires typed preparation/control results and verifies the exact original grant lookup receipt', async () => {
    const grantSnapshot = { storeIncarnation: 'store-a', grant: { grantId: 'grant-a', state: 'active', revision: 2, attemptEpoch: 1,
      expiresAt: '2026-09-18T08:00:30.000Z', admissionAllowed: false, admissionRevision: 2 }, barrier: {} };
    const mutation = { operationId: 'pause-a', snapshot: grantSnapshot };
    const lookup = { operation: 'get_grant', storeIncarnation: 'store-a', current: grantSnapshot, lookupOperationId: 'pause-a', mutationReceipt: mutation };
    expect(decodeTeamsHostOperationResult(lookup)).toMatchObject({ mutationReceipt: { status: 'applied' } });
    for (const value of [{ ...lookup, storeIncarnation: 'other-store' }, { ...lookup, lookupOperationId: 'other-mutation' },
      { ...lookup, current: { ...grantSnapshot, extraField: true } },
    ]) expect(() => decodeTeamsHostOperationResult(value)).toThrow();
    const report = { nodeCommandId: original.nodeCommandId, nodeGeneration: 1, commandDigest: original.commandDigest, resultRevision: 1 };
    await expect(decodeTeamsNodeReport({ ...report, phase: 'prepared' })).rejects.toThrow();
    await expect(decodeTeamsNodeReport({ ...report, phase: 'control_applied' })).rejects.toThrow();
    const prepared = { operation: 'prepare', contextRef: 'context-a', contextDigest: hash, snapshot: grantSnapshot };
    expect((await decodeTeamsNodeReport({ ...report, phase: 'prepared', operationResult: prepared })).phase).toBe('prepared');
    await expect(decodeTeamsNodeReport({ ...report, phase: 'control_applied', operationResult: prepared })).rejects.toThrow();
    await expect(decodeTeamsNodeReport({ ...report, phase: 'running', operationResult: lookup })).rejects.toThrow();
    expect((await decodeTeamsNodeReport({ ...report, phase: 'control_applied', operationResult: { operation: 'set_admission', mutationReceipt: mutation } })).phase).toBe('control_applied');
  });
});

describe('Material content contracts', () => {
  it('sorts entry lists by path and excludes absent source commit from the content digest', async () => {
    const parsed = decodeTeamsMaterialManifest(material);
    expect(parsed.sourceCommit).toBeNull();
    expect(await teamsMaterialManifestDigest(parsed)).toBe(await teamsMaterialManifestDigest({ ...parsed, entries: [...parsed.entries].reverse() }));
    expect(teamsMaterialCreateSchema.parse({ ...parsed, idempotencyKey: 'create-1' }).entries).toEqual(parsed.entries);
    const paths = ['\u{1f600}', '\uffff', 'a'];
    expect(paths.sort(compareTeamsMaterialPaths)).toEqual(['a', '\uffff', '\u{1f600}']);
  });

  it('rejects traversal, non-normalized paths, collisions and byte limits', () => {
    const parsed = decodeTeamsMaterialManifest(material);
    for (const path of ['/etc/secret', '../secret', 'a/../b', 'a//b', 'a/./b', 'C:/secret', 'a\\b', 'a\u0000b', 'a/']) {
      expect(() => decodeTeamsMaterialManifest({ ...parsed, entries: [{ ...parsed.entries[0], path }] })).toThrow();
    }
    expect(() => decodeTeamsMaterialManifest({ ...parsed, entries: [
      { ...parsed.entries[0], path: 'file' }, { ...parsed.entries[0], path: 'file/child' },
    ] })).toThrow();
    expect(() => decodeTeamsMaterialManifest({ ...parsed, entries: [{ ...parsed.entries[0], sizeBytes: 20 * 1024 * 1024 + 1 }] })).toThrow();
    expect(() => decodeTeamsMaterialManifest({ ...parsed, entries: [0, 1, 2, 3].map(index => ({ ...parsed.entries[0], path: `file-${index}`, sizeBytes: 20 * 1024 * 1024 })) })).toThrow();
    expect(() => decodeTeamsMaterialManifest({ ...parsed, kind: 'git_snapshot' })).toThrow();
    expect(() => decodeTeamsMaterialManifest({ ...parsed, sourceCommit: 'a'.repeat(40) })).toThrow();
    expect(() => decodeTeamsMaterialManifest({ ...parsed, entries: [{ ...parsed.entries[0], extra: true }] })).toThrow();
  });
});

describe('Teams JCS input boundary', () => {
  for (const vector of fixtures.canonicalVectors) {
    it(`matches Python canonical bytes and digest for ${vector.name}`, async () => {
      expect(canonicalTeamsJson(vector.value)).toBe(vector.canonical);
      expect(await digestTeamsJson(vector.value)).toBe(vector.digest);
    });
  }
  for (const vector of fixtures.canonicalInvalidVectors) {
    it(`rejects shared unsafe canonical input ${vector.name}`, () => {
      expect(() => canonicalTeamsJson(JSON.parse(vector.json))).toThrow();
    });
  }
  it('normalizes finite numbers and orders object keys by UTF-16, independently of material ordering', async () => {
    expect(canonicalTeamsJson({ z: -0, a: 1.0, tiny: 1e-7, decimal: 4.5 })).toBe('{"a":1,"decimal":4.5,"tiny":1e-7,"z":0}');
    expect(canonicalTeamsJson({ '\uffff': 2, '\u{1f600}': 1 })).toBe('{"😀":1,"￿":2}');
    expect(await digestTeamsJson({ a: 1, b: 2 })).toBe(await digestTeamsJson({ b: 2, a: 1 }));
  });

  it('rejects unsafe integer-valued numbers, non-finite numbers, lone surrogates and lossy non-JSON values', () => {
    const cyclic: Record<string, unknown> = {}; cyclic.value = cyclic;
    const getter = Object.defineProperty({}, 'value', { enumerable: true, get: () => 'invisible side effect' });
    for (const value of [Number.MAX_SAFE_INTEGER + 1, 1e20, NaN, Infinity, '\ud800', '\udc00', { '\ud800': 1 },
      undefined, { missing: undefined }, [undefined], Array(1), new Date(), 1n, cyclic, getter,
    ]) expect(() => canonicalTeamsJson(value)).toThrow('invalid_teams_canonical_json');
  });
});


it('uses separate pre-execution probe identity and excludes temporary permit/claim from its digest', async () => {
  const value = { protocolVersion: 'teams-node/v1', nodeCommandId: controlId, operation: 'describe', lane: 'control',
    operationKey: 'probe-one', authorityId: ref.authorityId, nodeId: 'node-a', nodeGeneration: 1,
    bindingRef: 'registered-binding', localBindingRef: 'local-build:one',
    expectedDigests: { bundle: hash, contract: hash, capabilities: hash }, claimLeaseUntil: '2026-09-18T08:00:30.000Z',
    authorization: { permitKind: 'probe', permit: 'temporary-test-permit' }, commandDigest: hash };
  value.commandDigest = await teamsNodeProbeDigest(value);
  expect((await parseTeamsNodeMessage(value)).operation).toBe('describe');
  expect((await parseTeamsNodeMessage({ ...value, claimLeaseUntil: '2026-09-18T08:01:30.000Z', authorization: { ...value.authorization, permit: 'renewed' } })).commandDigest).toBe(value.commandDigest);
  for (const change of [{ nodeGeneration: 2 }, { bindingRef: 'other' }, { ref }, { lane: 'execution' }]) {
    await expect(parseTeamsNodeMessage({ ...value, ...change })).rejects.toThrow();
  }
  const report = { nodeCommandId: controlId, nodeGeneration: 1, commandDigest: value.commandDigest, resultRevision: 1, phase: 'described',
    probeResult: { bindingRef: 'registered-binding', localBindingRef: 'local-build:one', agentInstanceId: 'instance-a', storeIncarnation: 'store-a',
      capabilities: { enqueue: true }, capabilitiesDigest: hash, bundleDigest: hash, contractDigest: hash } };
  expect(decodeTeamsNodeProbeReport(report).reportKind).toBe('probe');
  expect(() => decodeTeamsNodeProbeReport({ ...report, probeResult: null })).toThrow();
  expect(() => decodeTeamsNodeProbeReport({ ...report, phase: 'uncertain' })).toThrow();
});
