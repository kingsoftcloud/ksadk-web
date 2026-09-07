import test from 'node:test';
import assert from 'node:assert/strict';

async function loadSessionUtils() {
  return import('../src/utils/session.js').catch(() => null);
}

function createStorageStub(seed = {}) {
  const store = new Map(Object.entries(seed));
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
  };
}

test('session persistence utils use agent-scoped storage keys', async () => {
  const sessionUtils = await loadSessionUtils();

  assert.ok(sessionUtils, 'expected Web UI session persistence helpers to exist');
  assert.equal(
    sessionUtils.buildSessionStorageKey('demo-agent'),
    'ksadk:webui:selected-session:demo-agent',
  );
});

test('resolveSessionToRestore prefers the persisted session when it still exists', async () => {
  const sessionUtils = await loadSessionUtils();

  assert.ok(sessionUtils, 'expected Web UI session persistence helpers to exist');
  assert.equal(
    sessionUtils.resolveSessionToRestore(
      [
        { SessionId: 'sess-new' },
        { SessionId: 'sess-keep' },
      ],
      'sess-keep',
    ),
    'sess-keep',
  );
});

test('resolveSessionToRestore falls back to the newest session when persisted selection is stale', async () => {
  const sessionUtils = await loadSessionUtils();

  assert.ok(sessionUtils, 'expected Web UI session persistence helpers to exist');
  assert.equal(
    sessionUtils.resolveSessionToRestore(
      [
        { SessionId: 'sess-new' },
        { SessionId: 'sess-old' },
      ],
      'sess-missing',
    ),
    'sess-new',
  );
});

test('mergePendingSessions keeps a just-created session through a lagging list refresh', async () => {
  const sessionUtils = await import('../src/utils/session.js');
  const listed = [{ SessionId: 'older-session' }];
  const current = [
    { SessionId: 'new-session', UpdatedAt: '2026-09-04T10:00:00Z' },
    { SessionId: 'older-session' },
  ];

  assert.deepEqual(
    sessionUtils.mergePendingSessions(listed, current, new Set(['new-session'])),
    [listed[0], current[0]],
  );
  assert.equal(
    sessionUtils.mergePendingSessions(
      [{ SessionId: 'new-session', Name: 'durable' }],
      current,
      new Set(['new-session']),
    ).length,
    1,
  );
});

test('persisted session helpers can read and clear local storage safely', async () => {
  const sessionUtils = await loadSessionUtils();

  assert.ok(sessionUtils, 'expected Web UI session persistence helpers to exist');

  const storage = createStorageStub();
  sessionUtils.writePersistedSessionId('demo-agent', 'sess-42', storage);
  assert.equal(sessionUtils.readPersistedSessionId('demo-agent', storage), 'sess-42');

  sessionUtils.writePersistedSessionId('demo-agent', null, storage);
  assert.equal(sessionUtils.readPersistedSessionId('demo-agent', storage), null);
});
