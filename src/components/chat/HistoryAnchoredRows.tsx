import { Component, Fragment, createRef, type ReactNode, type RefObject } from 'react';
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
  followLatest?: RefObject<boolean>;
  historyScrollPending?: RefObject<boolean>;
  historyRevealPending?: RefObject<boolean>;
  sessionId?: string | null;
  onAnchor: (scroller: HTMLDivElement, delta: number, historyChanged: boolean) => void;
  onReset: () => void;
  renderRow: (entry: Row) => ReactNode;
};

type Snapshot = {
  anchors: ReturnType<typeof captureReadingAnchors>;
  historyChanged: boolean;
  reveal?: number;
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
  private content = createRef<HTMLDivElement>();
  private resizeObserver: ResizeObserver | undefined;
  private scrollNode: HTMLDivElement | null = null;
  private resizeBaseline: {
    anchors: Snapshot['anchors'];
    height: number;
    scrollTop: number;
    range: number;
  } | undefined;

  componentDidMount() {
    this.committed = this.props;
    this.scrollNode = this.props.scrollRef.current
      ?? this.content.current?.closest<HTMLDivElement>('[data-slot="message-list"]') ?? null;
    if (this.content.current && this.scrollNode && typeof ResizeObserver !== 'undefined') {
      this.captureResizeBaseline();
      this.scrollNode.addEventListener('scroll', this.onScroll, { passive: true });
      this.resizeObserver = new ResizeObserver(this.restoreResizeBaseline);
      this.resizeObserver.observe(this.content.current);
    }
  }

  componentWillUnmount() {
    this.resizeObserver?.disconnect();
    this.scrollNode?.removeEventListener('scroll', this.onScroll);
  }

  private captureResizeBaseline() {
    const scroller = this.scrollNode;
    const content = this.content.current;
    this.resizeBaseline = scroller && content && !this.props.followLatest?.current
      ? { anchors: captureReadingAnchors(scroller, false, true), height: content.offsetHeight,
        scrollTop: scroller.scrollTop, range: scroller.scrollHeight - scroller.clientHeight }
      : undefined;
  }

  private onScroll = () => {
    // Keep the positions sampled before a resize even when a wheel event
    // arrives in the same frame. The resize callback will refresh them.
    if (!this.resizeBaseline || this.content.current?.offsetHeight === this.resizeBaseline.height) {
      this.captureResizeBaseline();
    }
  };

  private restoreResizeBaseline = () => {
    const baseline = this.resizeBaseline;
    const scroller = this.scrollNode;
    if (baseline && scroller && !this.props.followLatest?.current
      && baseline.height !== this.content.current?.offsetHeight) {
      const range = scroller.scrollHeight - scroller.clientHeight;
      const clamped = range < baseline.range && baseline.scrollTop > range
        && Math.abs(scroller.scrollTop - range) < 1;
      const movement = clamped ? 0 : scroller.scrollTop - baseline.scrollTop;
      const delta = readingAnchorDelta(scroller, baseline.anchors);
      if (delta !== undefined && Math.abs(delta + movement) >= 0.5) {
        this.props.onAnchor(scroller, delta + movement, false);
      }
    }
    this.captureResizeBaseline();
  };

  getSnapshotBeforeUpdate(previous: Props): Snapshot | null {
    const { layout, scrollRef } = this.props;
    const scroller = scrollRef.current;
    if (!scroller) return null;
    if (previous.sessionId !== this.props.sessionId) return { anchors: [], historyChanged: false, reset: true };
    const rangeChanged = previous.window.startIndex !== this.props.window.startIndex
      || previous.window.endIndex !== this.props.window.endIndex;
    if ((previous.layout === layout && !rangeChanged) || !previous.layout.items.length) return null;
    const historyChanged = previous.layout.items !== layout.items;
    const prepended = historyChanged && precedes(previous.layout, layout);
    if (historyChanged && !this.props.historyScrollPending?.current && !prepended) {
      return { anchors: [], historyChanged, reset: true };
    }
    if (!prepended && !this.props.historyScrollPending?.current && this.props.followLatest?.current) {
      return null;
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
    const reveal = this.props.historyRevealPending?.current && scroller.scrollTop <= 1
      && prepended
      ? Math.min(48, scroller.clientHeight * 0.08) : 0;
    return { anchors, historyChanged, reveal };
  }

  componentDidUpdate(_previous: Props, _state: unknown, snapshot: Snapshot | null) {
    this.committed = this.props;
    if (!snapshot) {
      this.restoreResizeBaseline();
      return;
    }
    this.retained = undefined;
    if (snapshot.reset) {
      this.props.onReset();
      this.captureResizeBaseline();
      return;
    }
    const scroller = this.props.scrollRef.current;
    if (!scroller) return;
    const anchorDelta = readingAnchorDelta(scroller, snapshot.anchors);
    if (anchorDelta === undefined) {
      this.captureResizeBaseline();
      return;
    }
    const delta = anchorDelta - Math.min(snapshot.reveal ?? 0, Math.max(0, scroller.scrollTop + anchorDelta));
    if (snapshot.reveal && this.props.historyRevealPending) this.props.historyRevealPending.current = false;
    if (Math.abs(delta) >= 0.5) this.props.onAnchor(scroller, delta, snapshot.historyChanged);
    if (snapshot.historyChanged) this.retained = {
      snapshot, scrollTop: scroller.scrollTop, range: scroller.scrollHeight - scroller.clientHeight,
    };
    this.captureResizeBaseline();
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
    // Let consecutive mounted rows stack at their DOM heights on the first
    // layout. A measured height enters the virtual layout only when that row
    // is represented by a spacer, so remeasurement cannot displace its siblings.
    let end = 0;
    const content: ReactNode[] = [];
    for (const row of rows) {
      const gap = layout.offsets[row.index] - layout.offsets[end];
      if (gap > 0) content.push(<div key={`gap-${row.index}`} aria-hidden="true" style={{ height: gap, overflowAnchor: 'none' }} />);
      content.push(<Fragment key={`row-${row.item.id || row.index}`}>{renderRow(row)}</Fragment>);
      end = row.index + 1;
    }
    const tail = window.totalHeight - layout.offsets[end];
    if (tail > 0) content.push(<div key="tail" aria-hidden="true" style={{ height: tail, overflowAnchor: 'none' }} />);
    return <div ref={this.content}>{content}</div>;
  }
}
