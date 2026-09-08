import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { generateEmbedPreflight } from '../scripts/generate-embed-preflight.mjs';

const from = new URL('../src/embed.css', import.meta.url).pathname;
const compiled = await postcss([tailwind()]).process(readFileSync(from, 'utf8'), { from });
const rules = [];
compiled.root.walkRules(rule => rules.push(rule));

test('scoped reset stays synchronized with pinned Tailwind and cannot reset the host', () => {
  const source = readFileSync(new URL('../src/embed-preflight.css', import.meta.url), 'utf8');
  assert.equal(source, generateEmbedPreflight());
  postcss.parse(source).walkRules(rule => {
    for (const selector of postcss.list.comma(rule.selector)) {
      assert.ok(selector.startsWith(':where(.ksadk-web)'), selector);
    }
  });
});

test('embedded artifact resets native controls only inside the component boundary', () => {
  const reset = rules.find(rule => rule.selector.includes('.ksadk-web')
    && rule.selector.includes('button')
    && rule.nodes.some(node => node.prop === 'font' && node.value === 'inherit'));
  assert.ok(reset, 'embedded CSS must reset native button/input fonts and backgrounds');
  for (const selector of postcss.list.comma(reset.selector)) {
    assert.ok(selector.includes('.ksadk-web'), `reset leaks into host: ${selector}`);
  }
  assert.ok(rules.some(rule => rule.selector.includes('.ksadk-web')
    && rule.nodes.some(node => node.prop === 'border' && node.value === '0 solid')),
  'embedded CSS must remove native inset/outset borders');
});

test('semantic utilities resolve theme variables at the component, not document root', () => {
  const sidebar = rules.find(rule => rule.selector === '.ksadk-web .bg-sidebar');
  assert.ok(sidebar);
  assert.ok(sidebar.nodes.some(node => node.prop === 'background-color'
    && node.value === 'hsl(var(--sidebar))'), 'sidebar must use its local theme variable');
});

test('standalone workbench also emits local sidebar and text semantics', async () => {
  const standalone = new URL('../src/index.css', import.meta.url).pathname;
  const output = await postcss([tailwind()]).process(readFileSync(standalone, 'utf8'), { from: standalone });
  for (const [selector, property, value] of [
    ['.bg-sidebar', 'background-color', 'hsl(var(--sidebar))'],
    ['.text-text-secondary', 'color', 'hsl(var(--text-secondary))'],
  ]) {
    let found = false;
    output.root.walkRules(selector, rule => {
      found ||= rule.nodes.some(node => node.prop === property && node.value === value);
    });
    assert.ok(found, `standalone CSS is missing ${selector}`);
  }
});
