const ROW = '[data-message-id]';
const BLOCK = 'p, li, pre, h1, h2, h3, h4, h5, h6, td, th';

type TextAnchor = {
  text: string;
  offset: number;
  occurrenceFromEnd: number;
  top: number;
};

type ReadingAnchor = {
  id: string;
  run?: string;
  top: number;
  text?: TextAnchor;
};

function blocks(row: HTMLElement): HTMLElement[] {
  return [...row.querySelectorAll<HTMLElement>(BLOCK)].filter(block =>
    !block.querySelector(BLOCK) && !block.closest('details:not([open])'));
}

function rectAt(block: HTMLElement, offset: number): DOMRect | undefined {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (offset >= length) {
      offset -= length;
      continue;
    }
    const range = block.ownerDocument.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const rect = range.getBoundingClientRect();
    return rect.height > 0 ? rect : undefined;
  }
}

function visibleText(row: HTMLElement, viewportTop: number, readingTop: number, bottom: number): TextAnchor | undefined {
  const candidates = blocks(row);
  for (let index = 0; index < candidates.length; index++) {
    const block = candidates[index];
    const rect = block.getBoundingClientRect();
    const text = block.textContent ?? '';
    if (!text.trim() || rect.height <= 0 || rect.bottom <= readingTop || rect.top >= bottom) continue;
    const x = rect.left + Math.min(8, rect.width / 2);
    const y = Math.min(rect.bottom - 1, Math.max(rect.top + 2, readingTop + 2));
    const caret = block.ownerDocument.caretPositionFromPoint?.(x, y);
    const legacy = caret ? undefined : block.ownerDocument.caretRangeFromPoint?.(x, y);
    const node = caret?.offsetNode ?? legacy?.startContainer;
    let offset = 0;
    if (node && block.contains(node)) {
      const before = block.ownerDocument.createRange();
      before.selectNodeContents(block);
      before.setEnd(node, caret?.offset ?? legacy!.startOffset);
      offset = Math.min(text.length - 1, before.toString().length);
    }
    const occurrenceFromEnd = candidates.slice(index + 1).filter(next => next.textContent === text).length;
    return { text, offset, occurrenceFromEnd, top: (rectAt(block, offset)?.top ?? rect.top) - viewportTop };
  }
}

export function captureReadingAnchors(scroller: HTMLDivElement, paragraphs: boolean): ReadingAnchor[] {
  const viewport = scroller.getBoundingClientRect();
  const readingTop = viewport.top + 1;
  const anchors: ReadingAnchor[] = [];
  for (const row of scroller.querySelectorAll<HTMLElement>(ROW)) {
    const id = row.dataset.messageId;
    const rect = row.getBoundingClientRect();
    if (!id || rect.height <= 0 || rect.bottom <= readingTop || rect.top >= viewport.bottom) continue;
    const text = paragraphs && row.dataset.historyRole === 'model'
      ? visibleText(row, viewport.top, readingTop, viewport.bottom) : undefined;
    anchors.push({ id, run: row.dataset.historyRun, top: rect.top - viewport.top, text });
    if (anchors.length === 3) break;
  }
  return anchors;
}

function matchingText(row: HTMLElement, anchor: TextAnchor): DOMRect | undefined {
  const candidates = blocks(row).filter(block => block.getClientRects().length > 0);
  const exact = candidates.filter(block => block.textContent === anchor.text);
  const original = exact.at(-(anchor.occurrenceFromEnd + 1));
  if (original) return rectAt(original, anchor.offset);

  const suffixes = candidates.filter(block => block.textContent?.endsWith(anchor.text));
  if (suffixes.length === 1) {
    return rectAt(suffixes[0], suffixes[0].textContent!.length - anchor.text.length + anchor.offset);
  }

  // Markdown can merge or split blocks when an earlier fragment arrives.
  // Use a local text match only when it identifies a unique reading position.
  const start = Math.max(0, anchor.offset - 24);
  const context = anchor.text.slice(start, anchor.offset + 40);
  if (context.trim().length < 12) return undefined;
  const matches = candidates.flatMap(block => {
    const text = block.textContent ?? '';
    const at = text.indexOf(context);
    return at >= 0 && at === text.lastIndexOf(context) ? [{ block, at }] : [];
  });
  if (matches.length === 1) return rectAt(matches[0].block, matches[0].at + anchor.offset - start);
}

export function readingAnchorDelta(scroller: HTMLDivElement, anchors: ReadingAnchor[]): number | undefined {
  const top = scroller.getBoundingClientRect().top;
  const rows = [...scroller.querySelectorAll<HTMLElement>(ROW)];
  for (const anchor of anchors) {
    const sameRow = rows.find(row => row.dataset.messageId === anchor.id);
    if (anchor.text) {
      const related = rows.filter(row => row !== sameRow && anchor.run && row.dataset.historyRun === anchor.run
        && row.dataset.historyRole === 'model');
      for (const row of sameRow ? [sameRow, ...related] : related) {
        const rect = matchingText(row, anchor.text);
        if (rect) return rect.top - top - anchor.text.top;
      }
    }
    const rect = sameRow?.getBoundingClientRect();
    if (rect && rect.height > 0) return rect.top - top - anchor.top;
  }
}
