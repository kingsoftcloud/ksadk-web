import { describe, expect, it } from 'vitest';
import { a2uiCatalog, a2uiManifest, catalogDigest } from '../core/a2ui/catalog.js';
import { A2uiSurfaces } from '../core/a2ui/surfaces.js';

const create = (id = 'card') => ({ version: 'v0.9.1', createSurface: {
  surfaceId: id, catalogId: a2uiManifest.catalog_id,
} });
const components = (entries: Record<string, unknown>[], surfaceId = 'card') => ({
  version: 'v0.9.1', updateComponents: { surfaceId, components: entries },
});
const text = { id: 'root', component: 'Text', text: 'Ready' };

describe('official A2UI processor and pinned full catalog', () => {
  it('hashes properties and functions, rather than component names alone', () => {
    expect(catalogDigest(a2uiCatalog)).toBe(a2uiManifest.catalog_digest);
    const altered = structuredClone(a2uiCatalog) as typeof a2uiCatalog & { components: unknown };
    altered.components = { ...altered.components as object, Text: { type: 'null' } };
    expect(catalogDigest(altered)).not.toBe(a2uiManifest.catalog_digest);
  });

  it('preserves the live surface and draft on identical replay or incremental append', () => {
    const controller = new A2uiSurfaces(() => {});
    const messages = [create(), components([text])];
    try {
      controller.apply(messages);
      const surface = controller.get('card')!;
      surface.dataModel.set('/draft', 'kept');
      controller.apply(structuredClone(messages));
      controller.apply([...messages, components([{ ...text, text: 'Updated' }])]);
      expect(controller.get('card')).toBe(surface);
      expect(surface.dataModel.get('/draft')).toBe('kept');
    } finally { controller.dispose(); }
  });

  it('does not mutate accepted operation snapshots while users edit an initialized data model', () => {
    const controller = new A2uiSurfaces(() => {});
    const messages = [create(), components([
      { id: 'root', component: 'TextField', label: 'Name', value: { path: '/answer/name' } },
    ]), { version: 'v0.9.1', updateDataModel: { surfaceId: 'card', path: '/',
      value: { answer: { name: '', count: 1 } } } }];
    const accepted = structuredClone(messages);
    try {
      controller.apply(messages);
      const surface = controller.get('card')!;
      surface.dataModel.set('/answer/name', 'accepted-name');
      surface.dataModel.set('/answer/count', 0);
      expect(messages).toEqual(accepted);
      controller.apply(structuredClone(messages));
      expect(controller.get('card')).toBe(surface);
      expect(surface.dataModel.get('/answer')).toEqual({ name: 'accepted-name', count: 0 });
    } finally { controller.dispose(); }
  });

  it('allows children before root but rejects an unknown component in a later batch', () => {
    const controller = new A2uiSurfaces(() => {});
    const messages = [create(), components([{ id: 'child', component: 'Text', text: 'Child' }])];
    try {
      controller.apply(messages);
      controller.apply([...messages, components([{ id: 'root', component: 'Column', children: ['child'] }])]);
      expect(() => controller.apply([...messages, components([{ id: 'bad', component: 'Script' }])])).toThrow();
      expect(() => controller.apply([{ ...create(), createSurface: { surfaceId: 'x', catalogId: 'unknown' } }])).toThrow();
    } finally { controller.dispose(); }
  });

  it('isolates surfaces and ignores actions from a deleted generation or a disabled card', async () => {
    const actions: unknown[] = [];
    const controller = new A2uiSurfaces(action => { actions.push(action); });
    const messages = [create(), components([text]), create('other'), components([text], 'other')];
    try {
      controller.apply(messages);
      const old = controller.get('card')!;
      const other = controller.get('other');
      const deleted = { version: 'v0.9.1', deleteSurface: { surfaceId: 'card' } };
      controller.apply([...messages, deleted, create(), components([text])]);
      expect(controller.get('other')).toBe(other);
      const next = controller.get('card')!;
      expect(next).not.toBe(old);
      const action = { event: { name: 'submit', context: { payload: false } } };
      await old.dispatchAction(action, 'root');
      expect(actions).toHaveLength(0);
      await next.dispatchAction(action, 'root');
      expect(actions).toHaveLength(1);
      controller.enabled = false;
      await next.dispatchAction(action, 'root');
      expect(actions).toHaveLength(1);
    } finally { controller.dispose(); }
  });
});
