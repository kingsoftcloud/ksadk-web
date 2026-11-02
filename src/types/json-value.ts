/** JSON wire values. Absence is represented by an omitted field, never null. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function jsonValue(value: unknown): JsonValue {
  const ancestors = new Set<object>();
  const stack: Array<{ value: unknown; leave?: boolean }> = [{ value }];
  while (stack.length) {
    const frame = stack.pop()!;
    const entry = frame.value;
    if (frame.leave) { ancestors.delete(entry as object); continue; }
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') continue;
    if (typeof entry === 'number' && Number.isFinite(entry)) continue;
    if (typeof entry !== 'object' || ancestors.has(entry)) {
      throw new TypeError('答案必须是合法 JSON 值。');
    }
    if (!Array.isArray(entry) && ![Object.prototype, null].includes(Object.getPrototypeOf(entry))) {
      throw new TypeError('答案必须是合法 JSON 值。');
    }
    if (Object.getOwnPropertySymbols(entry).length) throw new TypeError('答案必须是合法 JSON 值。');
    ancestors.add(entry);
    stack.push({ value: entry, leave: true });
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) stack.push({ value: entry[index] });
    } else {
      for (const child of Object.values(entry)) stack.push({ value: child });
    }
  }
  return value as JsonValue;
}
