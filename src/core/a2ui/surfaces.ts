import { Catalog, MessageProcessor, type ProcessableMessage, type SurfaceModel } from '@a2ui/web_core/v0_9';
import { basicCatalog } from '@a2ui/web_core/v0_9/basic_catalog';
import type { ReactCatalogComponent } from '@a2ui/react';
import { legacyA2uiCatalog, type A2UIClientEventMessage } from './catalog.js';
import { defaultA2uiCatalogRegistry, type A2uiCatalogRegistry } from './registry.js';

type Operation = Record<string, unknown>;

/** One processor per mounted operation history; an append never recreates the provider. */
export class A2uiSurfaces {
  private processor;
  private processed: string[] = [];
  private active = new Map<string, SurfaceModel<ReactCatalogComponent>>();
  private disposed = false;
  private action: (message: A2UIClientEventMessage) => void;
  private readonly registry: A2uiCatalogRegistry;
  private readonly renderers: Catalog<ReactCatalogComponent>[];
  enabled = true;

  constructor(action: (message: A2UIClientEventMessage) => void,
    registry: A2uiCatalogRegistry = defaultA2uiCatalogRegistry,
    renderers: Catalog<ReactCatalogComponent>[] = []) {
    this.action = action;
    this.registry = registry;
    this.renderers = renderers;
    this.processor = this.makeProcessor();
  }

  private makeProcessor() {
    return new MessageProcessor<ReactCatalogComponent>([
      basicCatalog, new Catalog(legacyA2uiCatalog.catalogId, '0.9', [
        ...Catalog.fromSchema(legacyA2uiCatalog, '0.9').components.values(),
      ], []), ...this.renderers.filter(renderer => ![basicCatalog.id, legacyA2uiCatalog.catalogId].includes(renderer.id)),
    ], undefined, {
      version: 'v0.9.1',
      validationConfig: {
        allowOrphanComponents: true, allowDanglingReferences: true,
        allowMissingRoot: true, allowUnknownElements: false,
      },
    });
  }

  apply(messages: Operation[]): void {
    if (this.disposed) throw new Error('A2UI surface is closed');
    if (messages.length > 4096 || JSON.stringify(messages).length > 1_048_576) {
      throw new Error('A2UI 消息超过展示预算。');
    }
    const serialized = messages.map(message => JSON.stringify(message));
    if (serialized.length === this.processed.length && serialized.every((message, index) => this.processed[index] === message)) return;
    // Validate a trial model before touching the live surface or its draft.
    const trial = this.registry.validateMessages(messages);
    trial.dispose();
    if (!this.processed.every((message, index) => serialized[index] === message)) {
      this.active.clear();
      this.processor.dispose();
      this.processor = this.makeProcessor();
      this.processed = [];
    }
    for (let index = this.processed.length; index < messages.length; index += 1) {
      const message = messages[index];
      if (!['v0.9', 'v0.9.1'].includes(String(message.version))) {
        throw new Error('当前页面不支持此 A2UI 协议版本。');
      }
      const operationKeys = ['createSurface', 'updateComponents', 'updateDataModel', 'deleteSurface']
        .filter(key => key in message);
      if (operationKeys.length !== 1) throw new Error('A2UI 消息操作无效。');
      const kind = operationKeys[0];
      const detail = message[kind] as Operation;
      if (!detail || typeof detail.surfaceId !== 'string') throw new Error('A2UI surface 身份无效。');
      if (kind === 'createSurface' && !this.registry.get(String(detail.catalogId))) {
        throw new Error('当前卡片使用了页面未注册的组件目录。');
      }
      const surface = this.processor.getSurface(detail.surfaceId);
      if (kind === 'createSurface' && surface) throw new Error('重建卡片前必须先删除原 surface。');
      if (kind !== 'createSurface' && !surface) throw new Error('卡片缺少已接受的 createSurface。');
      if (kind === 'updateComponents') this.registry.validateComponents(surface!.defaultCatalog.id, detail.components);
      // The official DataModel owns values passed to it and edits them in
      // place. Keep accepted operations immutable so drafts cannot rewrite
      // the request snapshot later compared with persisted card history.
      this.processor.processMessages(structuredClone(message) as ProcessableMessage);
      this.processed.push(serialized[index]);
      if (kind === 'deleteSurface') this.active.delete(detail.surfaceId);
      if (kind === 'createSurface') {
        const surface = this.processor.getSurface(detail.surfaceId)!;
        this.active.set(surface.id, surface);
        surface.onAction.subscribe(action => {
          if (!this.disposed && this.enabled && this.active.get(surface.id) === surface) {
            this.action({ userAction: action });
          }
        });
      }
    }
  }

  get(surfaceId: string) { return this.processor.getSurface(surfaceId); }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.active.clear();
    this.processor.dispose();
  }
}
