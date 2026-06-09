export {
  isHostedChatEnabled,
  isNativeDashboardEnabled,
  isNativeTerminalEnabled,
  normalizeCapabilities,
} from '../utils/capabilities.js';
export { PluginRegistry } from '../core/capability/registry.js';
export type {
  CapabilityContext,
  CapabilityPlugin,
  CapabilitySlot,
} from '../core/capability/types.js';
export type { BuiltinToolCapability, UiCapabilities } from '../types/capabilities.js';
