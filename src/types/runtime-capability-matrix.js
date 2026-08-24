const REQUIRED_CAPABILITY_KEYS = [
  'cancel',
  'pause',
  'resume',
  'submit_interaction',
  'attach',
  'steer',
  'inject',
  'checkpoint',
  'durable_restore',
];

const EXECUTION_MODE_KEYS = ['goal', 'loop', 'plan'];
const CAPABILITY_MODES = new Set(['native', 'emulated', 'unavailable']);
const CAPABILITY_VALUE_KEYS = new Set(['supported', 'mode', 'reason']);
const MATRIX_KEYS = new Set([
  'schema_version',
  ...REQUIRED_CAPABILITY_KEYS,
  ...EXECUTION_MODE_KEYS,
]);

function asRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value;
}

function decodeCapabilityValue(raw, field) {
  const value = asRecord(raw, field);
  if (typeof value.supported !== 'boolean') {
    throw new Error(`${field}.supported must be a boolean`);
  }
  if (!CAPABILITY_MODES.has(value.mode)) {
    throw new Error(`${field}.mode must be native, emulated, or unavailable`);
  }
  if (
    value.reason !== undefined
    && value.reason !== null
    && (typeof value.reason !== 'string' || value.reason.length === 0)
  ) {
    throw new Error(`${field}.reason must be a non-empty string or null`);
  }
  if (!value.supported && (value.mode !== 'unavailable' || !value.reason)) {
    throw new Error(
      `${field}: unsupported capability requires mode=unavailable and reason`,
    );
  }

  return {
    supported: value.supported,
    mode: value.mode,
    reason: value.reason ?? null,
    extensions: Object.fromEntries(
      Object.entries(value).filter(([key]) => !CAPABILITY_VALUE_KEYS.has(key)),
    ),
  };
}

/**
 * Decode the runtime-only portion of AgentKernel RuntimeCapabilityMatrix/v1.
 *
 * This module intentionally stays plain JavaScript so both the browser bundle
 * and the repository's pre-build Node compatibility tests execute the same
 * fail-closed decoder. The public TypeScript wrapper supplies the contract
 * type and canonical ContractMismatchError.
 */
export function decodeCapabilityMatrixValue(raw) {
  const value = asRecord(raw, 'RuntimeCapabilityMatrix/v1');
  if (value.schema_version !== 1) {
    throw new Error('schema_version must equal 1');
  }
  for (const key of REQUIRED_CAPABILITY_KEYS) {
    if (!(key in value)) {
      throw new Error(`${key} is required`);
    }
  }

  const matrix = {
    schema_version: 1,
    extensions: Object.fromEntries(
      Object.entries(value).filter(([key]) => !MATRIX_KEYS.has(key)),
    ),
  };
  for (const key of REQUIRED_CAPABILITY_KEYS) {
    matrix[key] = decodeCapabilityValue(value[key], key);
  }
  for (const key of EXECUTION_MODE_KEYS) {
    if (value[key] !== undefined && value[key] !== null) {
      matrix[key] = decodeCapabilityValue(value[key], key);
    }
  }
  return matrix;
}
