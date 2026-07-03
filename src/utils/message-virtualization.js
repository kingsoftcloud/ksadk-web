function clampIndex(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Compute the visible slice of a message transcript for virtualized rendering.
 *
 * @template T
 * @param {{ items?: T[]; scrollTop?: number; viewportHeight?: number; overscan?: number; defaultItemHeight?: number; measuredHeights?: Map<string, number>; getItemKey?: (item: T, index: number) => string }} [options]
 * @returns {{ startIndex: number; endIndex: number; offsetTop: number; totalHeight: number; visibleItems: Array<{ index: number; item: T; top: number; height: number }> }}
 */
export function calculateVirtualMessageWindow({
  items = [],
  scrollTop = 0,
  viewportHeight = 0,
  overscan = 4,
  defaultItemHeight = 120,
  measuredHeights = new Map(),
  getItemKey = (item, index) => item?.id || String(index),
} = {}) {
  const safeViewportHeight = Math.max(0, Number(viewportHeight) || 0);
  const safeScrollTop = Math.max(0, Number(scrollTop) || 0);
  const safeOverscan = Math.max(0, Number(overscan) || 0);
  const safeDefaultItemHeight = Math.max(1, Number(defaultItemHeight) || 120);

  if (!items.length) {
    return {
      startIndex: 0,
      endIndex: 0,
      offsetTop: 0,
      totalHeight: 0,
      visibleItems: [],
    };
  }

  const heights = items.map((item, index) => {
    const key = getItemKey(item, index);
    const measured = Number(measuredHeights.get(key));
    return Number.isFinite(measured) && measured > 0 ? measured : safeDefaultItemHeight;
  });

  const offsets = new Array(items.length);
  let runningTop = 0;
  for (let index = 0; index < items.length; index += 1) {
    offsets[index] = runningTop;
    runningTop += heights[index];
  }

  const totalHeight = runningTop;
  const viewportEnd = safeScrollTop + safeViewportHeight;
  let startIndex = 0;
  while (
    startIndex < items.length &&
    offsets[startIndex] + heights[startIndex] <= safeScrollTop
  ) {
    startIndex += 1;
  }

  let endIndex = startIndex;
  while (endIndex < items.length && offsets[endIndex] < viewportEnd) {
    endIndex += 1;
  }

  startIndex = clampIndex(startIndex - safeOverscan, 0, items.length);
  endIndex = clampIndex(Math.max(startIndex + 1, endIndex + safeOverscan), 0, items.length);

  return {
    startIndex,
    endIndex,
    offsetTop: offsets[startIndex] || 0,
    totalHeight,
    visibleItems: items.slice(startIndex, endIndex).map((item, index) => {
      const absoluteIndex = startIndex + index;
      return {
        index: absoluteIndex,
        item,
        top: offsets[absoluteIndex] || 0,
        height: heights[absoluteIndex] || safeDefaultItemHeight,
      };
    }),
  };
}
