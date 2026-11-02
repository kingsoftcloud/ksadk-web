import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { JsonSchemaInputForm } from '../../src/components/chat/JsonSchemaInputForm.js';
import type { JsonValue } from '../../src/types/json-value.js';

const schemas: Record<string, Record<string, unknown>> = {
  object: { type: 'object', properties: {
    count: { type: 'integer', minimum: 0 }, enabled: { type: 'boolean' },
    note: { type: ['string', 'null'] }, items: { type: 'array', items: { type: 'integer' } },
  }, required: ['count', 'enabled', 'note', 'items'], additionalProperties: false },
  arbitrary: {}, boolean: { type: 'boolean' }, integer: { type: 'integer' },
  string: { type: 'string' }, array: { type: 'array' },
};

function Harness() {
  const [scenario, setScenario] = useState('object');
  const [answers, setAnswers] = useState<JsonValue[]>([]);
  return <main>
    <label>Scenario <select aria-label="Scenario" value={scenario} onChange={event => setScenario(event.target.value)}>
      {Object.keys(schemas).map(key => <option key={key}>{key}</option>)}
    </select></label>
    <JsonSchemaInputForm key={scenario} schema={schemas[scenario]} disabled={false}
      onSubmit={value => setAnswers(previous => [...previous, value])} onCancel={() => {}} />
    <pre data-testid="answers">{JSON.stringify(answers)}</pre>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Harness />);
