import { Component, type ReactNode, type RefObject } from 'react';
import type { Message } from './types.js';
import { captureReadingAnchors, readingAnchorDelta } from './history-reading-anchor.js';
import type { calculateVirtualMessageWindow, createVirtualMessageLayout } from '../../utils/message-virtualization.js';

type Layout = ReturnType<typeof createVirtualMessageLayout<Message>>;
type Window = ReturnType<typeof calculateVirtualMessageWindow<Message>>;
type Row = Window['visibleItems'][number];

type Props = {
  layout: Layout;
  window: Window;
  scrollRef: RefObject<HTMLDivElement | null>;
  historyScrollPending?: RefObject<boolean>;
  sessionId?: string | null;
  onAnchor: (scroller: HTMLDivElement, delta: number, historyChanged: boolean) => void;
  onReset: () => void;
  renderRow: (entry: Row) => ReactNode;
};

type Snapshot = {
  anchors: ReturnType<typeof captureReadingAnchors>;
  historyChanged: boolean;
  reset?: boolean;
};

function precedes(previous: Layout, next: Layout): boolean {
  const first = previous.items[0];
  const nextFirst = next.items[0];
  if (!first || !nextFirst) return false;
  if ((next.keyIndex.get(first.id || '0') ?? 0) > 0) return true;
  const before = first.historyOrder?.seq;
  const after = nextFirst.historyOrder?.seq;
  if (before != null && after != null && after < before) return true;
  return first.id === nextFirst.id && first.role === 'model' && first.content.length > 0
    && nextFirst.content.length > first.content.length && nextFirst.content.endsWith(first.content);
}

// React captures the live DOM before the renderer inserts or replaces rows.
// The virtual window keeps those rows mounted for the corresponding commit.
export class HistoryAnchoredRows extends Component<Props> {
  private committed: Props | undefined;
  private retained: { snapshot: Snapshot; scrollTop: number; range: number } | undefined;

  componentDidMount() {
    this.committed = this.props;
  }

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { layout, scrollRef } = this.props;
    const scroller = scrollRef.current;
    if (!scroller) return null;
    if (previous.sessionId !== this.props.sessionId) return { anchors: [], historyChanged: false, reset: true };
    if (previous.layout === layout || !previous.layout.items.length) return null;
    const historyChanged = previous.layout.items !== layout.items;
    if (historyChanged && !this.props.historyScrollPending?.current && !precedes(previous.layout, layout)) {
      return { anchors: [], historyChanged, reset: true };
    }
    if (!historyChanged && this.retained) {
      const range = scroller.scrollHeight - scroller.clientHeight;
      // A shrinking scroll range can clamp scrollTop while the reader has
      // stayed still. Retain the original reading anchor across that clamp.
      const clamped = range < this.retained.range && range < this.retained.scrollTop
        && Math.abs(scroller.scrollTop - range) < 1;
      if (clamped || Math.abs(scroller.scrollTop - this.retained.scrollTop) < 1) {
        return this.retained.snapshot;
      }
    }
    const anchors = captureReadingAnchors(scroller, historyChanged);
    return { anchors, historyChanged };
  }

  componentDidUpdate(_previous: Props, _state: unknown, snapshot: Snapshot | null) {
    this.committed = this.props;
    if (!snapshot) return;
    this.retained = undefined;
    if (snapshot.reset) {
      this.props.onReset();
      return;
    }
    const scroller = this.props.scrollRef.current;
    if (!scroller) return;
    const delta = readingAnchorDelta(scroller, snapshot.anchors);
    if (delta === undefined) return;
    if (Math.abs(delta) >= 0.5) this.props.onAnchor(scroller, delta, snapshot.historyChanged);
    if (snapshot.historyChanged) this.retained = {
      snapshot, scrollTop: scroller.scrollTop, range: scroller.scrollHeight - scroller.clientHeight,
    };
  }

  render() {
    const { layout, window, renderRow } = this.props;
    const previous = this.committed;
    let rows = window.visibleItems;
    if (previous && previous.sessionId === this.props.sessionId && previous.layout !== layout
      && (previous.layout.items === layout.items
      || this.props.historyScrollPending?.current || precedes(previous.layout, layout))) {
      const indices = new Set(rows.map(row => row.index));
      for (const row of previous.window.visibleItems) {
        const index = layout.keyIndex.get(row.item.id || String(row.index));
        if (index !== undefined) {
          indices.add(index);
          continue;
        }
        const run = row.item.runId || row.item.invocationId;
        if (run) {
          // A partial model row can acquire a new key when the invocation is
          // reassembled. Keep the corresponding row available for text matching.
          const replacement = layout.items.findIndex(item =>
            item.role === row.item.role && (item.runId || item.invocationId) === run
            && ((item.itemId && item.itemId === row.item.itemId)
              || (row.item.content.length > 0 && item.content.endsWith(row.item.content))));
          if (replacement >= 0) indices.add(replacement);
        }
      }
      rows = [...indices].sort((a, b) => a - b).map(index => ({
        index, item: layout.items[index], top: layout.offsets[index],
        height: layout.offsets[index + 1] - layout.offsets[index],
      }));
    }
    return <div style={{ height: window.totalHeight }} className="relative">{rows.map(renderRow)}</div>;
  }
}
