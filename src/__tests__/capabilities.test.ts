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
