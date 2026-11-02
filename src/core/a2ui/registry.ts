import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { Catalog, MessageProcessor, createFunctionImplementation, type ComponentApi } from '@a2ui/web_core/v0_9';
import type { ReactCatalogComponent } from '@a2ui/react';
import { a2uiCatalog, a2uiManifest, catalogDigest, legacyA2uiCatalog } from './catalog.js';
import common from './assets/common-types-v0_9.json';
import type { A2uiHistoryAnswer } from '../../components/chat/a2ui-response-snapshot.js';
import { linkA2uiCatalog } from './linking.js';

type Document = Record<string, unknown>;
type Operation = Record<string, unknown>;
export type A2uiHistoryAdapter = (input: {
  surfaceId: string; messages: Operation[]; answer: A2uiHistoryAnswer;
}) => { messages: Operation[]; mapped: boolean };
export type A2uiCatalogRegistration = {
  schema: Document;
  resources?: readonly Document[];
  /** Application code imports a trusted, bundled implementation in the browser. */
  loadRenderer: () => Promise<Catalog<ReactCatalogComponent>>;
  /** Extra components using the standard label/value input bindings. */
  inputComponents?: readonly string[];
  historyAdapter?: A2uiHistoryAdapter;
};
type Entry = Readonly<A2uiCatalogRegistration & { digest: string }>;

const builtinEntries: A2uiCatalogRegistration[] = [
  { schema: a2uiCatalog, loadRenderer: async () =>
    (await import('@a2ui/web_core/v0_9/basic_catalog')).basicCatalog },
  { schema: legacyA2uiCatalog, loadRenderer: async () => new Catalog(
    legacyA2uiCatalog.catalogId, '0.9',
    [...Catalog.fromSchema(legacyA2uiCatalog, '0.9').components.values()] as ReactCatalogComponent[], [],
  ) },
];

export class A2uiCatalogRegistry {
  readonly defaultCatalogId: string;
  private readonly entries = new Map<string, Entry>();
  private readonly validators = new Map<string, Map<string, ValidateFunction>>();
  private readonly loaders = new Map<string, Promise<Catalog<ReactCatalogComponent>>>();
  private readonly processorSchemas = new Map<string, Document>();

  constructor(additional: readonly A2uiCatalogRegistration[] = [], defaultCatalogId = a2uiManifest.catalog_id) {
    for (const raw of [...builtinEntries, ...additional]) {
      const schema = structuredClone(raw.schema);
      const id = schema.catalogId;
      if (typeof id !== 'string' || !id.trim() || !schema.components || typeof schema.components !== 'object') {
        throw new Error('A2UI 目录缺少身份或组件 Schema。');
      }
      const digest = catalogDigest(schema);
      const existing = this.entries.get(id);
      if (existing) {
        if (existing.digest !== digest || existing.loadRenderer !== raw.loadRenderer
          || existing.historyAdapter !== raw.historyAdapter
          || catalogDigest(existing.resources) !== catalogDigest(raw.resources || [])
          || catalogDigest(existing.inputComponents) !== catalogDigest(raw.inputComponents || [])) {
          throw new Error('A2UI 目录身份存在冲突。');
        }
        continue;
      }
      const resources = structuredClone(raw.resources || []);
      this.entries.set(id, Object.freeze({ ...raw, schema, resources, digest,
        inputComponents: Object.freeze([...(raw.inputComponents || [])]) }));
    }
    const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
    addFormats(ajv);
    const assets = new Map<string, Document>();
    const add = (schema: Document) => {
      const id = schema.$id ?? schema.catalogId;
      if (typeof id !== 'string' || !id) throw new Error('离线 A2UI Schema 缺少 $id。');
      if (assets.has(id) && catalogDigest(assets.get(id)) !== catalogDigest(schema)) {
        throw new Error('离线 A2UI Schema 身份存在冲突。');
      }
      assets.set(id, schema);
    };
    add(common);
    for (const entry of this.entries.values()) {
      add(entry.schema);
      for (const resource of entry.resources || []) add(resource);
    }
    for (const alias of Object.keys(a2uiManifest.schema_resolution_aliases)) add({ ...a2uiCatalog, $id: alias });
    for (const [id, schema] of assets) ajv.addSchema(schema, id);
    for (const [id, entry] of this.entries) {
      const base = String(entry.schema.$id || id);
      this.validators.set(id, new Map(Object.keys(entry.schema.components as object).map(name => [
        name, ajv.getSchema(`${base}#/components/${name}`)!,
      ])));
      this.processorSchemas.set(id, linkA2uiCatalog(entry.schema, address => ajv.getSchema(address)?.schema));
    }
    if (!this.entries.has(defaultCatalogId)) throw new Error('默认 A2UI 目录未注册。');
    this.defaultCatalogId = defaultCatalogId;
  }

  get catalogIds(): readonly string[] { return [...this.entries.keys()]; }

  get(id: string): Entry | undefined {
    const entry = this.entries.get(id);
    return entry && { ...entry, schema: structuredClone(entry.schema),
      resources: structuredClone(entry.resources) };
  }

  validateComponents(id: string, components: unknown): void {
    if (!Array.isArray(components) || components.length === 0 || components.length > 2048) {
      throw new Error('A2UI 组件列表无效或过大。');
    }
    const validators = this.validators.get(id);
    if (!validators) throw new Error('当前卡片使用了页面未注册的组件目录。');
    const ids = new Set<string>();
    for (const raw of components) {
      const component = raw as Record<string, unknown> | null;
      const validate = component && typeof component.component === 'string' && validators.get(component.component);
      if (!validate || !validate(component)) throw new Error('A2UI 组件或属性不符合已注册的目录。');
      if (typeof component?.id !== 'string' || !component.id.trim() || ids.has(component.id)) {
        throw new Error('A2UI 组件身份无效或重复。');
      }
      ids.add(component.id);
    }
  }

  /** Schema-only processor; it never loads or executes React implementations. */
  validateMessages(messages: Operation[]): MessageProcessor<ComponentApi> {
    if (!messages.length || messages.length > 4096 || new TextEncoder().encode(JSON.stringify(messages)).length > 1_048_576) {
      throw new Error('A2UI 消息无效或超过展示预算。');
    }
    const processor = new MessageProcessor<ComponentApi>([...this.processorSchemas.values()].map(schema => {
      const api = Catalog.fromSchema(schema, '0.9');
      return new Catalog(api.id, api.protocolVersion, [...api.components.values()],
        [...api.functions.values()].map(fn => createFunctionImplementation(fn, () => {
          throw new Error('校验过程不能执行 A2UI 函数。');
        })), api.themeSchema, api.instructions);
    }), undefined, {
      version: 'v0.9.1', validationConfig: { allowOrphanComponents: true,
        allowDanglingReferences: true, allowMissingRoot: true, allowUnknownElements: false },
    });
    try {
      for (const message of messages) {
        if (!['v0.9', 'v0.9.1'].includes(String(message.version))) throw new Error('当前页面不支持此 A2UI 协议版本。');
        const keys = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface'].filter(key => key in message);
        if (keys.length !== 1) throw new Error('A2UI 消息操作无效。');
        const kind = keys[0], detail = message[kind] as Operation;
        if (!detail || typeof detail.surfaceId !== 'string' || !detail.surfaceId.trim()) throw new Error('A2UI surface 身份无效。');
        const surface = processor.getSurface(detail.surfaceId);
        if (kind === 'createSurface') {
          if (!this.entries.has(String(detail.catalogId))) throw new Error('当前卡片使用了页面未注册的组件目录。');
          if (surface) throw new Error('重建卡片前必须先删除原 surface。');
        } else if (!surface) throw new Error('卡片缺少已接受的 createSurface。');
        if (kind === 'updateComponents') this.validateComponents(surface!.defaultCatalog.id, detail.components);
        processor.processMessages(structuredClone(message));
      }
      return processor;
    } catch (error) { processor.dispose(); throw error; }
  }

  async loadRenderers(ids: readonly string[] = this.catalogIds): Promise<Catalog<ReactCatalogComponent>[]> {
    return Promise.all([...new Set(ids)].map(id => {
      const entry = this.entries.get(id);
      if (!entry) throw new Error('当前卡片使用了页面未注册的组件目录。');
      let load = this.loaders.get(id);
      if (!load) {
        load = Promise.resolve().then(() => entry.loadRenderer()).then(renderer => {
          if (renderer.id !== id || !['0.9', 'v0.9', '0.9.1', 'v0.9.1'].includes(String(renderer.protocolVersion))) {
            throw new Error('A2UI 组件实现与注册目录身份不一致。');
          }
          for (const name of Object.keys(entry.schema.components as object)) {
            if (!renderer.components.has(name)) throw new Error('A2UI 目录缺少组件实现。');
          }
          for (const name of Object.keys(entry.schema.functions as object || {})) {
            if (!renderer.functions.has(name)) throw new Error('A2UI 目录缺少函数实现。');
          }
          return renderer;
        }).catch(error => { this.loaders.delete(id); throw error; });
        this.loaders.set(id, load);
      }
      return load;
    }));
  }
}

export function createA2uiCatalogRegistry(entries: readonly A2uiCatalogRegistration[] = [],
  options: { defaultCatalogId?: string } = {}): A2uiCatalogRegistry {
  return new A2uiCatalogRegistry(entries, options.defaultCatalogId);
}

export const defaultA2uiCatalogRegistry = createA2uiCatalogRegistry();
