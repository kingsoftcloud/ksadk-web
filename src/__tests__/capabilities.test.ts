import { describe, expect, it } from 'vitest';
import { normalizeCapabilities } from '../utils/capabilities.js';

describe('normalizeCapabilities', () => {
  it('does not enable checkpoint resume from generic run resume defaults', () => {
    const capabilities = normalizeCapabilities({
      Data: {
        Capabilities: {
          HostedChat: { Enabled: true },
          RunLifecycle: { Enabled: true, Resume: true },
        },
      },
    });

    expect(capabilities.RunLifecycle.Resume).toBe(true);
    expect(capabilities.RunLifecycle.Checkpoints).toBe(false);
    expect(capabilities.RunLifecycle.CheckpointResume).toBe(false);
    expect(capabilities.RunLifecycle.CheckpointResumePreview).toBe(false);
  });

  it('honors explicit checkpoint lifecycle capability fields', () => {
    const capabilities = normalizeCapabilities({
      Data: {
        Capabilities: {
          HostedChat: { Enabled: true },
          RunLifecycle: {
            Enabled: true,
            Checkpoints: true,
            CheckpointResume: true,
            CheckpointResumePreview: true,
          },
        },
      },
    });

    expect(capabilities.RunLifecycle.Checkpoints).toBe(true);
    expect(capabilities.RunLifecycle.CheckpointResume).toBe(true);
    expect(capabilities.RunLifecycle.CheckpointResumePreview).toBe(true);
  });
});

import { decodeCapabilityMatrix } from '../types/agent-control.js';

describe('agent-kernel/v1 capability matrix', () => {
  it('decodes the canonical matrix and keeps unsupported reasons addressable', () => {
    const matrix = decodeCapabilityMatrix({
      schema_version: 1,
      cancel: { supported: true, mode: 'native' },
      pause: { supported: false, mode: 'unavailable', reason: 'runtime_pause_not_supported' },
      resume: { supported: true, mode: 'native' },
      submit_interaction: { supported: true, mode: 'native' },
      attach: { supported: true, mode: 'native' },
      steer: { supported: true, mode: 'native' },
      inject: { supported: true, mode: 'native' },
      checkpoint: { supported: false, mode: 'unavailable', reason: 'runtime_checkpoint_not_supported' },
      durable_restore: { supported: true, mode: 'native' },
    });
    expect(matrix.pause.supported).toBe(false);
    expect(matrix.pause.reason).toBe('runtime_pause_not_supported');
    expect(matrix.checkpoint.mode).toBe('unavailable');
  });

  it('rejects matrices that violate the contract', () => {
    expect(() => decodeCapabilityMatrix({ schema_version: 1 })).toThrow();
  });
});
