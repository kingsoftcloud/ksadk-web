import { describe, expect, it } from 'vitest';
import * as capabilities from '../public/capabilities.js';
import * as chatComposer from '../public/chat-composer.js';
import * as chatTimeline from '../public/chat-timeline.js';
import * as components from '../public/components.js';
import * as conversation from '../public/conversation.js';
import * as hooks from '../public/hooks.js';
import * as runtime from '../public/runtime.js';
import * as types from '../public/types.js';

describe('public package entrypoints', () => {
  it('exports the stable runtime shell and core runtime contracts', () => {
    expect(typeof runtime.AgentWorkbench).toBe('function');
    expect(typeof runtime.ApiFacadeImpl).toBe('function');
    expect(typeof runtime.AgentEngineClient).toBe('function');
    expect(typeof runtime.RunEngineImpl).toBe('function');
    expect(typeof runtime.decodeConversationSurface).toBe('function');
    expect(typeof runtime.decodeConversationItem).toBe('function');
    expect(typeof runtime.ConversationItemReducer).toBe('function');
    expect(typeof runtime.projectConversationItems).toBe('function');
    expect(runtime.App).toBeUndefined();
  });

  it('exports stable component and capability APIs without exposing app internals', () => {
    expect(typeof components.ChatComposer).toBe('function');
    expect(typeof components.ChatMessageList).toBe('function');
    expect(typeof components.AgentConversationTimeline).toBe('function');
    expect(typeof components.AgentConversationComposer).toBe('function');
    expect(typeof components.WorkspacePanelContainer).toBe('function');
    expect(typeof capabilities.normalizeCapabilities).toBe('function');
    expect(typeof capabilities.PluginRegistry).toBe('function');
    expect(types).toBeDefined();
  });

  it('exports the shared headless chat controller', () => {
    expect(typeof hooks.useAgentChat).toBe('function');
  });

  it('exports independently loadable timeline and composer surfaces', () => {
    expect(typeof chatTimeline.AgentConversationTimeline).toBe('function');
    expect(typeof chatTimeline.ProcessingBlocksView).toBe('function');
    expect(typeof chatComposer.AgentConversationComposer).toBe('function');
    expect(typeof chatComposer.InteractionTray).toBe('function');
  });

  it('exports the headless conversation contract as a dedicated entrypoint', () => {
    expect(typeof conversation.buildConversationInput).toBe('function');
    expect(typeof conversation.decodeConversationInput).toBe('function');
    expect(typeof conversation.decodeConversationSurface).toBe('function');
    expect(typeof conversation.decodeConversationItem).toBe('function');
    expect(typeof conversation.ConversationItemReducer).toBe('function');
    expect(typeof conversation.HttpConversationClient).toBe('function');
    expect(typeof conversation.ConversationClientError).toBe('function');
    expect(typeof conversation.projectConversationItems).toBe('function');
  });
});
