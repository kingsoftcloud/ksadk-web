export type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

/**
 * Keep the jump control quiet during small layout shifts near the end of the
 * transcript. This mirrors the shared chat rule that auto-follow remains
 * attached until the reader has deliberately moved away from the latest turn.
 */
export const SCROLL_TO_BOTTOM_REVEAL_DISTANCE = 96;

export function distanceFromBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
}: ScrollMetrics): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function shouldShowScrollToBottom(metrics: ScrollMetrics): boolean {
  const overflow = metrics.scrollHeight > metrics.clientHeight + 1;
  return overflow && distanceFromBottom(metrics) > SCROLL_TO_BOTTOM_REVEAL_DISTANCE;
}
