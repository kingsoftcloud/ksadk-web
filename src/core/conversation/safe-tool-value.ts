/** Defense in depth for public tool observations; never render credential/transport diagnostics. */
export function safeToolValue(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (typeof value === 'string') {
    if (
      /bearer\s+\S+|traceback|https?:\/\/(?:[^/\s]*@|localhost|127\.|10\.|192\.168\.|169\.254\.)/i.test(
        value,
      )
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
            !/(?:authorization|credential|password|secret|api.?key|access.?token|traceback|stack)/i.test(
              key,
            ),
        )
        .map(([key, v]) => [key, safeToolValue(v, depth + 1)]),
    );
  return value;
}
