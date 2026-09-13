const SENSITIVE_COMPOUNDS = [
  'authorization',
  'credential',
  'password',
  'secret',
  'token',
  'cookie',
  'apikey',
  'accesskey',
  'secretaccesskey',
  'clientsecret',
  'refreshtoken',
  'accesstoken',
  'setcookie',
  'traceback',
  'stack',
  'exception',
];

function normalizedKey(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sensitiveKey(value: string): boolean {
  const key = normalizedKey(value);
  return SENSITIVE_COMPOUNDS.some((candidate) => key.includes(candidate));
}

function ipv4Number(host: string): number | null {
  const pieces = host.split('.');
  if (pieces.length > 4 || pieces.some((piece) => piece.length === 0)) return null;
  const values = pieces.map((piece) => {
    const radix = /^0x/i.test(piece) ? 16 : piece.length > 1 && piece.startsWith('0') ? 8 : 10;
    const source = radix === 16 ? piece.slice(2) : piece;
    if (!source || !new RegExp(`^[0-9a-f]+$`, 'i').test(source)) return null;
    const parsed = Number.parseInt(source, radix);
    return Number.isSafeInteger(parsed) ? parsed : null;
  });
  if (values.some((value) => value === null)) return null;
  const numeric = values as number[];
  const lastLimit = 2 ** (8 * (5 - numeric.length));
  if (numeric.slice(0, -1).some((value) => value > 255) || numeric.at(-1)! >= lastLimit)
    return null;
  return numeric.slice(0, -1).reduce((sum, value, index) => (
    sum + value * 2 ** (8 * (3 - index))
  ), numeric.at(-1)!);
}

function privateIpv4(value: number): boolean {
  return value >>> 24 === 0
    || value >>> 24 === 10
    || value >>> 24 === 127
    || value >>> 16 === 0xa9fe
    || value >>> 16 === 0xc0a8
    || value >>> 20 === 0xac1;
}

function privateHost(rawHost: string): boolean {
  let host: string;
  try {
    host = decodeURIComponent(rawHost).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  } catch {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    return true;
  const mapped = host.match(/^::ffff:(\d+(?:\.\d+){0,3})$/)?.[1];
  const hexadecimalMapped = host.match(
    /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i,
  );
  const ipv4 = hexadecimalMapped
    ? Number.parseInt(hexadecimalMapped[1], 16) * 65536 + Number.parseInt(hexadecimalMapped[2], 16)
    : ipv4Number(mapped || host);
  if (ipv4 !== null) return privateIpv4(ipv4);
  const firstHextet = Number.parseInt(host.split(':', 1)[0], 16);
  return host === '::'
    || host === '::1'
    || (Number.isInteger(firstHextet) && (firstHextet & 0xfe00) === 0xfc00)
    || (Number.isInteger(firstHextet) && (firstHextet & 0xffc0) === 0xfe80);
}

function containsInternalUrl(value: string): boolean {
  const candidates = value.match(
    /https?:\/\/\[[^\]]+\](?::\d+)?[^\s<>{}"']*|https?:\/\/[^\s<>{}"'[\]()]+/gi,
  ) || [];
  return candidates.some((candidate) => {
    const token = candidate.replace(/[.,;:!?]+$/, '').replace(/\\/g, '/');
    try {
      const url = new URL(token);
      return Boolean(url.username || url.password) || privateHost(url.hostname);
    } catch {
      return true;
    }
  });
}

/** Defense in depth for public tool observations; never render credential/transport diagnostics. */
export function safeToolValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') {
    if (
      /bearer\s+\S+|traceback|(?:token|authorization|api[_ .-]?key|access[_ .-]?token|refresh[_ .-]?token|secretaccesskey|accesstoken|refreshtoken|cookie|password|secret)\s*["']?\s*[=:]/i.test(value)
      || containsInternalUrl(value)
    )
      return '[redacted]';
    return value.length > 8192 ? `${value.slice(0, 8192)}[truncated]` : value;
  }
  if (Array.isArray(value))
    return value.slice(0, 128).map((v) => safeToolValue(v, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 128)
        .filter(
          ([key]) =>
            !sensitiveKey(key),
        )
        .map(([key, v]) => [key, safeToolValue(v, depth + 1)]),
    );
  return value;
}
