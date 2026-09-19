import { cpus, platform, release, arch } from 'node:os';
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConversationController } from '../dist-lib/conversation.js';

// This is a deterministic local-state baseline. It intentionally does not
// claim runtime, model, network, IPC, or React paint latency.
class MemoryStorage {
  #values = new Map();
  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
  clear() { this.#values.clear(); }
}

globalThis.localStorage = new MemoryStorage();

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] ?? 0;
}

function measure(label, iterations, operation) {
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const start = performance.now();
    operation(i);
    samples.push(performance.now() - start);
  }
  return {
    label,
    iterations,
    p50Ms: +percentile(samples, 0.50).toFixed(3),
    p95Ms: +percentile(samples, 0.95).toFixed(3),
    maxMs: +Math.max(...samples).toFixed(3),
  };
}

const controller = new ConversationController('perf:studio');
const conversations = Array.from({ length: 256 }, (_, i) => (
  controller.createDraft(`agent-${i}`, `target-${i % 2}`)
));

const newDraft = measure('create editable draft', 256, i => {
  const id = controller.createDraft(`new-agent-${i}`, 'local');
  controller.drafts.set(id, `draft ${i}`);
});

const cachedSwitch = measure('switch to cached conversation', 512, i => {
  controller.getOrCreate(`agent-${i % 256}`, null, `target-${i % 2}`);
});

const outboxSubmit = measure('persist outbox intent', 256, i => {
  const conversationId = conversations[i];
  controller.outbox.enqueue({
    conversationId,
    agentId: `agent-${i}`,
    text: `message ${i}`,
    attachments: [],
  });
});

const report = {
  measuredAt: new Date().toISOString(),
  environment: { platform: platform(), release: release(), arch: arch(), cpu: cpus()[0]?.model, node: process.version },
  scope: 'Synthetic local state baseline; no runtime, model, network, IPC, or React paint is measured.',
  budgets: {
    newEditableP95Ms: 100,
    cachedSwitchP95Ms: 200,
    localFeedbackP95Ms: 100,
  },
  measurements: [newDraft, cachedSwitch, outboxSubmit],
  invariants: {
    draftCacheEntries: controller.drafts.size(),
    draftCacheBound: controller.drafts.size() <= 128,
    unresolvedOutboxEntries: controller.outbox.listUnresolved().length,
    conversationIdentityStable: controller.getOrCreate('agent-1', null, 'target-1') === controller.getOrCreate('agent-1', null, 'target-1'),
  },
};

if (!report.invariants.draftCacheBound || !report.invariants.conversationIdentityStable) {
  throw new Error(`Studio performance invariants failed: ${JSON.stringify(report.invariants)}`);
}

const outputDir = resolve(new URL('.', import.meta.url).pathname, '..', 'output');
mkdirSync(outputDir, { recursive: true });
writeFileSync(resolve(outputDir, 'studio-performance.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
