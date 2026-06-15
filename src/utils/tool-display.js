function decodeEscapedUnicode(text) {
  return String(text || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function parseJsonLikeString(value) {
  let text = String(value || '').trim();
  for (let index = 0; index < 3; index += 1) {
    if (!text) return text;
    const first = text[0];
    const last = text[text.length - 1];
    const looksJson =
      (first === '{' && last === '}') ||
      (first === '[' && last === ']') ||
      (first === '"' && last === '"');
    if (!looksJson) return text.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'string') {
        return parseNestedJsonStrings(parsed);
      }
      text = parsed.trim();
    } catch {
      const decoded = decodeEscapedUnicode(text);
      return decoded.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    }
  }
  return text;
}

function parseNestedJsonStrings(value) {
  if (typeof value === 'string') {
    return parseJsonLikeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => parseNestedJsonStrings(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [key, parseNestedJsonStrings(nestedValue)]),
  );
}

function parseToolPayloadValue(value) {
  return typeof value === 'string' ? parseJsonLikeString(value) : parseNestedJsonStrings(value);
}

function isExplicitFalse(value) {
  if (value === false) return true;
  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'false';
  }
  return false;
}

function isExplicitTrue(value) {
  if (value === true) return true;
  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'true';
  }
  return false;
}

function hasNonEmptyErrorValue(value) {
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }
  if (typeof value === 'object') {
    return Object.keys(value).length > 0;
  }
  return true;
}

function hasFailureMarker(value, depth = 0) {
  if (!value || depth > 4) {
    return false;
  }
  if (typeof value === 'string') {
    const parsed = parseJsonLikeString(value);
    return parsed !== value && hasFailureMarker(parsed, depth + 1);
  }
  if (Array.isArray(value)) {
    return value.some((item) => hasFailureMarker(item, depth + 1));
  }
  if (typeof value !== 'object') {
    return false;
  }

  if (isExplicitFalse(value.ok) || isExplicitFalse(value.success)) {
    return true;
  }

  const explicitlySucceeded = isExplicitTrue(value.ok) || isExplicitTrue(value.success);
  const status = String(value.status || '').trim().toLowerCase();
  if (!explicitlySucceeded && ['error', 'failed', 'failure'].includes(status)) {
    return true;
  }

  if (
    !explicitlySucceeded
    && (
      hasNonEmptyErrorValue(value.error_type)
      || hasNonEmptyErrorValue(value.error_message)
      || hasNonEmptyErrorValue(value.error)
    )
  ) {
    return true;
  }

  return Object.values(value).some((nestedValue) => hasFailureMarker(nestedValue, depth + 1));
}

export function isFailedToolOutput(value) {
  if (value === undefined || value === null || value === '') {
    return false;
  }
  return hasFailureMarker(parseToolPayloadValue(value));
}

export function formatToolPayload(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }
  const parsed = parseToolPayloadValue(value);
  if (typeof parsed === 'string') {
    return parsed;
  }
  return JSON.stringify(parsed, null, 2);
}
