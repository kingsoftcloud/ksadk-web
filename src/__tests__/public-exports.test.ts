import { describe, expect, it } from 'vitest';
import * as capabilities from '../public/capabilities.js';
import * as components from '../public/components.js';
import * as runtime from '../public/runtime.js';
import * as types from '../public/types.js';

describe('public package entrypoints', () => {
  it('exports the stable runtime shell and core runtime contracts', () => {
    expect(typeof runtime.AgentWorkbench).toBe('function');
    expect(typeof runtime.ApiFacadeImpl).toBe('function');
    expect(typeof runtime.RunEngineImpl).toBe('function');
    expect(runtime.App).toBeUndefined();
  });

  it('exports stable component and capability APIs without exposing app internals', () => {
    expect(typeof components.ChatComposer).toBe('function');
    expect(typeof components.ChatMessageList).toBe('function');
    expect(typeof components.WorkspacePanelContainer).toBe('function');
    expect(typeof capabilities.normalizeCapabilities).toBe('function');
    expect(typeof capabilities.PluginRegistry).toBe('function');
    expect(types).toBeDefined();
  });
});
