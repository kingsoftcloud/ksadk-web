import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import AjvDraft4 from 'ajv-draft-04';
import addFormats from 'ajv-formats';
import draft6 from 'ajv/dist/refs/json-schema-draft-06.json';
import type { ValidateFunction } from 'ajv';
import { jsonValue } from '../../types/json-value.js';

export type InputValidation = { valid: boolean; issues: string[] };
const validators = new Map<string, ValidateFunction>();

function validator(schema: Record<string, unknown>): ValidateFunction {
  jsonValue(schema);
  const key = JSON.stringify(schema);
  const cached = validators.get(key);
  if (cached) return cached;
  const dialect = String(schema.$schema || 'https://json-schema.org/draft/2020-12/schema');
  const options = {
    strict: false, allErrors: true, coerceTypes: false, useDefaults: false,
    removeAdditional: false, ownProperties: true, logger: false as const,
  };
  const engine = /draft-04/.test(dialect) ? new AjvDraft4(options)
    : /draft-0[67]/.test(dialect) ? new Ajv(options)
      : /2019-09/.test(dialect) ? new Ajv2019(options)
        : /2020-12/.test(dialect) ? new Ajv2020(options) : null;
  if (!engine) throw new TypeError('Unsupported JSON Schema dialect');
  if (/draft-06/.test(dialect)) engine.addMetaSchema(draft6);
  addFormats(engine);
  const compiled = engine.compile(schema);
  if ('$async' in compiled && compiled.$async) throw new TypeError('Async schemas are not supported');
  if (validators.size >= 128) validators.delete(validators.keys().next().value!);
  validators.set(key, compiled);
  return compiled;
}

/** Client feedback uses the saved request Schema. Runtime validates again. */
export function validateInput(schema: Record<string, unknown>, response: unknown): InputValidation {
  try {
    jsonValue(response);
    const validate = validator(schema);
    const valid = validate(response);
    return { valid: Boolean(valid), issues: valid ? [] : (validate.errors || []).slice(0, 10)
      .map(error => `${error.instancePath || '/'}：不符合 ${error.keyword} 约束`) };
  } catch {
    return { valid: false, issues: ['输入或表单约束不是受支持的 JSON。'] };
  }
}
