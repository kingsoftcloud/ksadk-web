import { useEffect, useRef } from 'react';

/**
 * Tracks IME composition state so a keydown handler can tell an IME
 * confirmation Enter apart from a send Enter.
 *
 * `event.nativeEvent.isComposing` is unreliable across browsers: some
 * engines fire `compositionend` before the matching `keydown(Enter)`,
 * leaving `isComposing` already false when the confirmation Enter
 * arrives. The `keyCode === 229` fallback helps on engines that report
 * it, but not all do. This hook tracks `compositionstart`/`compositionend`
 * explicitly with a ref, so the handler reads a stable value that does
 * not depend on per-engine timing.
 *
 * Returns a function `isComposing(event)` to call inside `onKeyDown`.
 */
export function useImeComposition() {
  const composingRef = useRef(false);

  useEffect(() => {
    const start = () => { composingRef.current = true; };
    const end = () => { composingRef.current = false; };
    document.addEventListener('compositionstart', start);
    document.addEventListener('compositionend', end);
    return () => {
      document.removeEventListener('compositionstart', start);
      document.removeEventListener('compositionend', end);
    };
  }, []);

  return function isComposing(event: { nativeEvent: { isComposing?: boolean; keyCode?: number } }): boolean {
    return composingRef.current
      || event.nativeEvent.isComposing === true
      || event.nativeEvent.keyCode === 229;
  };
}
