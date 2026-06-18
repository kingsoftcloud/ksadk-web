import test from 'node:test';
import assert from 'node:assert/strict';

async function loadSessionPaginationUtils() {
  return import('../src/utils/session-pagination.js').catch(() => null);
}

test('session pagination resolves the next unloaded page and preserves loaded page cache', async () => {
  const sessionPagination = await loadSessionPaginationUtils();

  assert.ok(sessionPagination, 'expected session pagination helpers to exist');

  assert.equal(
    sessionPagination.resolveNextSessionsPage({
      total: 65,
      pageSize: 20,
      loadedPages: new Set([1]),
    }),
    2,
  );

  assert.equal(
    sessionPagination.resolveNextSessionsPage({
      total: 65,
      pageSize: 20,
      loadedPages: new Set([1, 2, 4]),
    }),
    3,
  );

  assert.equal(
    sessionPagination.resolveNextSessionsPage({
      total: 60,
      pageSize: 20,
      loadedPages: new Set([1, 2, 3]),
    }),
    null,
  );
});

test('session pagination metadata tracks hasMore and reset semantics', async () => {
  const sessionPagination = await loadSessionPaginationUtils();

  assert.ok(sessionPagination, 'expected session pagination helpers to exist');

  const state = sessionPagination.buildSessionPaginationState({
    sessionsLength: 20,
    total: 48,
    page: 1,
    pageSize: 20,
    loadedPages: new Set([1]),
  });

  assert.deepEqual(Array.from(state.loadedPages), [1]);
  assert.equal(state.hasMore, true);

  const merged = sessionPagination.mergeLoadedPages(new Set([1, 3]), [2, 4, 3]);
  assert.deepEqual(Array.from(merged), [1, 2, 3, 4]);

  const reset = sessionPagination.buildSessionPaginationState({
    sessionsLength: 0,
    total: 0,
    page: 0,
    pageSize: 20,
    loadedPages: new Set(),
  });

  assert.deepEqual(Array.from(reset.loadedPages), []);
  assert.equal(reset.hasMore, false);
});
