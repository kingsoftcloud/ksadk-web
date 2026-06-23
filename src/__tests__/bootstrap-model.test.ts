import { afterEach, describe, expect, it } from 'vitest';
import { fetchModels } from '../hooks/useBootstrap.js';
import { useModelStore } from '../stores/model.js';

describe('fetchModels', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    useModelStore.setState({
      availableModels: [],
      selectedModel: '',
      modelSource: '',
      modelCatalogLoaded: false,
      thinkingMode: 'auto',
    });
  });

  it('does not overwrite a user-selected model when refreshing the catalog', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        Code: 0,
        Data: {
          Current: 'glm-5.2',
          Source: 'runtime',
          Models: [
            { id: 'glm-5.2', display_name: 'GLM 5.2' },
            { id: 'minimax-m3', display_name: 'MiniMax M3' },
          ],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    useModelStore.getState().setSelectedModel('minimax-m3');

    await fetchModels('agent-1');

    expect(useModelStore.getState().selectedModel).toBe('minimax-m3');
    expect(useModelStore.getState().modelCatalogLoaded).toBe(true);
  });

  it('uses the server current model as the initial default', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({
        Code: 0,
        Data: {
          Current: 'glm-5.2',
          Source: 'runtime',
          Models: [{ id: 'glm-5.2', display_name: 'GLM 5.2' }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;

    await fetchModels('agent-1');

    expect(useModelStore.getState().selectedModel).toBe('glm-5.2');
  });
});
