/** New Teams cloud wire hashing only. Native AgentControl hashing is unchanged. */
export class TeamsCanonicalJsonError extends Error {
  constructor() { super('invalid_teams_canonical_json'); this.name = 'TeamsCanonicalJsonError'; }
}

export function isTeamsUnicodeScalarString(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return false;
  }
  return true;
}

/** RFC 8785 object/string/number serialization, with Teams' safe integer input boundary. */
export function canonicalTeamsJson(value: unknown): string {
  const ancestors = new Set<object>();
  const invalid = (): never => { throw new TeamsCanonicalJsonError(); };
  const visit = (item: unknown, depth: number): string => {
    if (depth > 50) return invalid();
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'string') return isTeamsUnicodeScalarString(item) ? JSON.stringify(item) : invalid();
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item))) return invalid();
      return JSON.stringify(item);
    }
    if (!item || typeof item !== 'object' || ancestors.has(item) || Object.getOwnPropertySymbols(item).length) return invalid();
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return invalid();
    ancestors.add(item);
    let json: string;
    if (Array.isArray(item)) {
      if (Object.getOwnPropertyNames(item).length !== item.length + 1) return invalid();
      const parts: string[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor || !('value' in descriptor)) return invalid();
        parts.push(visit(descriptor.value, depth + 1));
      }
      json = `[${parts.join(',')}]`;
    } else {
      const keys = Object.keys(item).sort(); // JCS orders UTF-16 code units, not code points.
      if (Object.getOwnPropertyNames(item).length !== keys.length) return invalid();
      json = `{${keys.map(key => {
        if (!isTeamsUnicodeScalarString(key)) return invalid();
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor)) return invalid();
        return `${JSON.stringify(key)}:${visit(descriptor.value, depth + 1)}`;
      }).join(',')}}`;
    }
    ancestors.delete(item);
    return json;
  };
  return visit(value, 0);
}

export async function digestTeamsJson(value: unknown, subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<string> {
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(canonicalTeamsJson(value)));
  return `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Material list ordering follows Python path ordering; object key ordering remains JCS. */
export function compareTeamsMaterialPaths(a: string, b: string): number {
  const left = Array.from(a, char => char.codePointAt(0)!);
  const right = Array.from(b, char => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.length - right.length;
}
