import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const FIXTURE = new URL('./fixtures/a2a_remote_agent/v1/', import.meta.url);
const SDK_COMMIT = 'a5bfd0a0c6373c9a5c7305aed58876eaffa6809d';
const SDK_MANIFEST_SHA256 = 'c1dc39058e2f75576aaebf3b74ccef106107d1bf1853082cd850f959b8ac2ee5';

const bytes = (filename: string): Buffer => readFileSync(new URL(filename, FIXTURE));
const parseJson = <T>(filename: string): T => JSON.parse(bytes(filename).toString('utf8')) as T;
const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

describe('SDK-owned A2A protocol fixture', () => {
  it('pins the SDK source commit, manifest, and every vendored byte', () => {
    const upstream = parseJson<{
      repository: string;
      commit: string;
      manifest_sha256: string;
    }>('upstream.json');
    const manifest = parseJson<{
      sha256: Record<string, string>;
      scenarios: string[];
    }>('manifest.json');

    expect(upstream).toEqual({
      repository: 'ksadk-python',
      commit: SDK_COMMIT,
      manifest_sha256: SDK_MANIFEST_SHA256,
    });
    expect(sha256(bytes('manifest.json'))).toBe(SDK_MANIFEST_SHA256);
    for (const [filename, expected] of Object.entries(manifest.sha256)) {
      expect(sha256(bytes(filename)), filename).toBe(expected);
    }
    expect(manifest.scenarios).toHaveLength(15);
  });

  it('freezes capability negotiation and the authoritative projection lane', () => {
    const manifest = parseJson<{
      profiles: string[];
      authoritative_lane: string;
      capabilities: Record<string, string>;
      auth_modes: { legacy_runtime_mapping: Record<string, string> };
    }>('manifest.json');
    const conversation = parseJson<{
      profile: string;
      authoritative_lane: string;
      items: Array<{ kind: string }>;
    }>('expected_conversation_projection.json');
    const legacy = parseJson<{ profile: string; items: Array<{ kind: string }> }>(
      'expected_v1_projection.json',
    );

    expect(manifest.profiles).toEqual(['flat-v1', 'agent-block-v1']);
    expect(manifest.authoritative_lane).toBe('runtime-event-v2');
    expect(manifest.capabilities).toEqual({
      input: 'ksadk.presentation',
      output: 'agent.block',
      tool_activity_extension: 'urn:ksadk:a2a:tool-activity:v1',
    });
    expect(manifest.auth_modes.legacy_runtime_mapping).toEqual({ api_key: 'platform_api_key' });
    expect(conversation.profile).toBe('agent-block-v1');
    expect(conversation.authoritative_lane).toBe('runtime-event-v2');
    expect(conversation.items.map((item) => item.kind)).toEqual(['agent', 'assistant_text']);
    expect(legacy).toEqual({
      profile: 'flat-v1',
      items: [{ kind: 'assistant_text', item_id: 'root-message-2', text: 'Root final answer' }],
    });
  });

  it('keeps the normative stream ordered across disconnect and root continuation', () => {
    const records = bytes('a2a_stream_tool_terminal.jsonl')
      .toString('utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as {
        scenario: string;
        kind: string;
        payload: Record<string, unknown>;
      });
    const events = records
      .filter(
        (record) =>
          record.scenario === 'a2a_stream_tool_terminal' && record.kind === 'runtime_event',
      )
      .map((record) => record.payload);

    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1));
    expect(events[12]).toMatchObject({
      seq: 13,
      scope_id: 'child-scope-1',
      event_type: 'item.completed',
      item_kind: 'tool_result',
    });
    expect(events[18]).toMatchObject({
      seq: 19,
      scope_id: 'child-scope-1',
      event_type: 'item.completed',
    });
    expect(events[19]).toMatchObject({ seq: 20, scope_id: 'root-scope' });
    expect(events[21]).toMatchObject({
      seq: 22,
      scope_id: 'root-scope',
      event_type: 'run.completed',
    });
  });
});
