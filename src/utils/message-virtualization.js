function clampIndex(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Index row positions once per transcript or measurement change.
 *
 * @template T
 * @param {{ items?: T[]; defaultItemHeight?: number; measuredHeights?: Map<string, number>; getItemKey?: (item: T, index: number) => string }} [options]
 */
export function createVirtualMessageLayout({
  items = [],
  defaultItemHeight = 120,
  measuredHeights = new Map(),
  getItemKey = (item, index) => item?.id || String(index),
} = {}) {
  const estimatedHeight = Math.max(1, Number(defaultItemHeight) || 120);
  const offsets = [0];
  const keyIndex = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const key = getItemKey(items[index], index);
    const height = Number(measuredHeights.get(key));
    keyIndex.set(key, index);
    offsets.push(offsets[index] + (Number.isFinite(height) && height >= 0 ? height : estimatedHeight));
  }

  return { items, offsets, keyIndex };
}

function findOffset(offsets, start, end, test) {
  while (start < end) {
    const middle = Math.floor((start + end) / 2);
    if (test(offsets[middle])) end = middle;
    else start = middle + 1;
  }
  return start;
}

/** Find the first row which extends below the given scroll position. */
export function findVirtualMessageIndex(offsets, scrollTop) {
  return findOffset(offsets, 1, offsets.length, offset => offset > scrollTop) - 1;
}

/**
 * Compute the visible slice of a message transcript for virtualized rendering.
 *
 * @template T
 * @param {{ items?: T[]; scrollTop?: number; viewportHeight?: number; overscan?: number; defaultItemHeight?: number; measuredHeights?: Map<string, number>; getItemKey?: (item: T, index: number) => string; layout?: { items: T[]; offsets: number[] } }} [options]
 * @returns {{ startIndex: number; endIndex: number; offsetTop: number; totalHeight: number; visibleItems: Array<{ index: number; item: T; top: number; height: number }> }}
 */
export function calculateVirtualMessageWindow({
  items,
  scrollTop = 0,
  viewportHeight = 0,
  overscan = 4,
  defaultItemHeight,
  measuredHeights,
  getItemKey,
  layout = createVirtualMessageLayout({ items, defaultItemHeight, measuredHeights, getItemKey }),
} = {}) {
  const { items: rows, offsets } = layout;
  const safeScrollTop = Math.max(0, Number(scrollTop) || 0);
  const viewportEnd = safeScrollTop + Math.max(0, Number(viewportHeight) || 0);
  const safeOverscan = Math.max(0, Number(overscan) || 0);

  const first = findVirtualMessageIndex(offsets, safeScrollTop);
  const end = findOffset(offsets, first, rows.length, offset => offset >= viewportEnd);
  const startIndex = clampIndex(first - safeOverscan, 0, rows.length);
  const endIndex = clampIndex(Math.max(startIndex + 1, end + safeOverscan), 0, rows.length);

  return {
    startIndex,
    endIndex,
    offsetTop: offsets[startIndex],
    totalHeight: offsets[rows.length],
    visibleItems: rows.slice(startIndex, endIndex).map((item, index) => {
      const absoluteIndex = startIndex + index;
      return {
        index: absoluteIndex,
        item,
        top: offsets[absoluteIndex],
        height: offsets[absoluteIndex + 1] - offsets[absoluteIndex],
      };
    }),
  };
}
