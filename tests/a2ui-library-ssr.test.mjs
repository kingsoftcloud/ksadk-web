import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

const entry = new URL('../dist-lib/runtime.js', import.meta.url);

test('built public A2UI registration API remains importable in Node SSR', {
  skip: !existsSync(entry) && 'Run npm run build:lib to verify the built consumer.',
}, async () => {
  assert.equal(typeof document, 'undefined');
  assert.equal(typeof HTMLElement, 'undefined');
  const { AgentWorkbench, createA2uiCatalogRegistry, A2uiCatalogProvider } = await import(entry.href);
  assert.equal(typeof AgentWorkbench, 'function');
  const registry = createA2uiCatalogRegistry();
  assert.equal(registry.catalogIds.length, 2);
  assert.equal(renderToString(createElement(A2uiCatalogProvider, { registry },
    createElement('span', null, 'SSR works'))), '<span>SSR works</span>');
});
