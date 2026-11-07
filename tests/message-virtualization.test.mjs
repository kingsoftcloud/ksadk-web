import test from 'node:test';
import assert from 'node:assert/strict';

async function loadMessageVirtualizationUtils() {
  return import('../src/utils/message-virtualization.js').catch(() => null);
}

test('message virtualization keeps a bounded render window with overscan', async () => {
  const virtualization = await loadMessageVirtualizationUtils();

  assert.ok(virtualization, 'expected message virtualization helpers to exist');

  const items = Array.from({ length: 100 }, (_, index) => ({ id: `msg-${index}` }));
  const windowed = virtualization.calculateVirtualMessageWindow({
    items,
    scrollTop: 2400,
    viewportHeight: 600,
    overscan: 3,
    defaultItemHeight: 120,
  });

  assert.equal(windowed.totalHeight, 12000);
  assert.ok(windowed.startIndex > 0);
  assert.ok(windowed.endIndex < items.length);
  assert.ok(windowed.visibleItems.length < items.length);
  assert.equal(windowed.visibleItems[0].item.id, items[windowed.startIndex].id);
  assert.equal(windowed.visibleItems.at(-1)?.item.id, items[windowed.endIndex - 1].id);
});

test('message virtualization honors measured heights when available', async () => {
  const virtualization = await loadMessageVirtualizationUtils();

  assert.ok(virtualization, 'expected message virtualization helpers to exist');

  const items = Array.from({ length: 8 }, (_, index) => ({ id: `msg-${index}` }));
  const measuredHeights = new Map([
    ['msg-0', 80],
    ['msg-1', 160],
    ['msg-2', 240],
  ]);

  const windowed = virtualization.calculateVirtualMessageWindow({
    items,
    scrollTop: 150,
    viewportHeight: 260,
    overscan: 1,
    defaultItemHeight: 100,
    measuredHeights,
    getItemKey: (item) => item.id,
  });

  assert.equal(windowed.offsetTop, 0);
  assert.ok(windowed.totalHeight > items.length * 100);
  assert.ok(windowed.visibleItems.some((entry) => entry.item.id === 'msg-2'));
});

test('message virtualization moves later rows after an expanded row is remeasured', async () => {
  const virtualization = await loadMessageVirtualizationUtils();
  const items = [{ id: 'reasoning' }, { id: 'approval' }, { id: 'result' }];

  const collapsed = virtualization.calculateVirtualMessageWindow({
    items,
    viewportHeight: 1000,
    overscan: 0,
    defaultItemHeight: 100,
  });
  const expanded = virtualization.calculateVirtualMessageWindow({
    items,
    viewportHeight: 1000,
    overscan: 0,
    defaultItemHeight: 100,
    measuredHeights: new Map([['reasoning', 320]]),
  });

  assert.equal(collapsed.visibleItems[1].top, 100);
  assert.equal(expanded.visibleItems[1].top, 320);
  assert.equal(expanded.visibleItems[2].top, 420);
  assert.equal(expanded.totalHeight, 520);
});

test('a measured hidden row releases its previous space without becoming an estimate', async () => {
  const { calculateVirtualMessageWindow } = await loadMessageVirtualizationUtils();
  const items = [{ id: 'form' }, { id: 'approval' }, { id: 'result' }];
  const measuredHeights = new Map([['form', 32], ['approval', 478], ['result', 80]]);
  const expanded = calculateVirtualMessageWindow({ items, viewportHeight: 1000, measuredHeights });
  measuredHeights.set('approval', 0);
  const hidden = calculateVirtualMessageWindow({ items, viewportHeight: 1000, measuredHeights });
  assert.equal(expanded.visibleItems[2].top, 510);
  assert.equal(hidden.visibleItems[1].height, 0);
  assert.equal(hidden.visibleItems[2].top, 32);
  assert.equal(hidden.totalHeight, 112);
});

test('zero is a known height while missing, negative and nonfinite heights remain estimates', async () => {
  const { calculateVirtualMessageWindow } = await loadMessageVirtualizationUtils();
  const items = ['hidden', 'missing', 'negative', 'not-a-number', 'infinite'].map(id => ({ id }));
  const measuredHeights = new Map([['hidden', 0], ['negative', -1], ['not-a-number', NaN], ['infinite', Infinity]]);
  const result = calculateVirtualMessageWindow({ items, viewportHeight: 1000, defaultItemHeight: 140, measuredHeights });
  assert.deepEqual(result.visibleItems.map(entry => entry.height), [0, 140, 140, 140, 140]);
  assert.equal(result.totalHeight, 560);
});
