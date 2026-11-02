/** An application extension, not a change to KSADK's built-in catalogs. */
import { createA2uiCatalogRegistry } from '../../src/core/a2ui/registry.js';
import schema from './catalog.json';

export const customCatalogRegistry = createA2uiCatalogRegistry([{
  schema,
  inputComponents: ['FeedbackInput'],
  loadRenderer: async () => {
    // Importing the registration itself is SSR-safe. Browser implementations
    // only load when this application's custom card is actually mounted.
    const [{ Catalog, ResolvedBinding, isWritable }, { basicCatalog }, { createComponentImplementation }] = await Promise.all([
      import('@a2ui/web_core/v0_9'), import('@a2ui/web_core/v0_9/basic_catalog'), import('@a2ui/react'),
    ]);
    const api = Catalog.fromSchema(schema, '0.9').components.get('FeedbackInput')!;
    const feedback = createComponentImplementation(api, ({ props }) => {
      const fields = props as Record<string, unknown>;
      const value = fields.value;
      const label = fields.label;
      return <label className="flex flex-col gap-2" data-testid="custom-feedback-input">
        <span>{String(label instanceof ResolvedBinding ? label.value : label || '')}</span>
        <input className="rounded border p-2" type={fields.variant === 'obscured' ? 'password' : 'text'}
          value={String(value instanceof ResolvedBinding ? value.value ?? '' : value ?? '')}
          onChange={event => {
            // The node renderer exposes setValue; the binder fallback exposes
            // WritableBinding. Both are public renderer contracts.
            if (typeof fields.setValue === 'function') fields.setValue(event.target.value);
            else if (value instanceof ResolvedBinding && isWritable(value)) value.set(event.target.value);
          }} />
      </label>;
    });
    return new Catalog(schema.catalogId, '0.9', [
      ...[...basicCatalog.components.values()].filter(component => component.name in schema.components), feedback,
    ], [...basicCatalog.functions.values()]);
  },
}], { defaultCatalogId: schema.catalogId });
