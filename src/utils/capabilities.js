const DEFAULT_API_FORMATS = ['responses', 'chat_completions'];
const NATIVE_DASHBOARD_FRAMEWORKS = new Map([
  ['openclaw', 'OpenClaw'],
  ['hermes', 'Hermes'],
]);

function normalizeFramework(value) {
  return String(value || '').trim().toLowerCase();
}

function firstFramework(...values) {
  for (const value of values) {
    const framework = normalizeFramework(value);
    if (framework) {
      return framework;
    }
  }
  return '';
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function normalizeApiFormats(value) {
  if (!Array.isArray(value)) {
    return DEFAULT_API_FORMATS;
  }
  const formats = value.filter((item) => item === 'responses' || item === 'chat_completions');
  return formats.length > 0 ? formats : DEFAULT_API_FORMATS;
}

function normalizeEnabled(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeBuiltinTools(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(item => asObject(item))
    .filter(item => typeof item.name === 'string' && item.name.trim())
    .map(item => {
      const normalized = {
        ...item,
        name: item.name.trim(),
        group: typeof item.group === 'string' ? item.group : '',
        risk_level: typeof item.risk_level === 'string' ? item.risk_level : 'low',
        requires_approval: Boolean(item.requires_approval),
        side_effects: Array.isArray(item.side_effects)
          ? item.side_effects.filter(sideEffect => typeof sideEffect === 'string')
          : [],
        enabled: normalizeEnabled(item.enabled, true),
      };
      if (typeof item.description === 'string') {
        normalized.description = item.description;
      }
      return normalized;
    });
}

function normalizeHostedChatTransports(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    const transport = asObject(item);
    const protocol = String(transport.Protocol || '').trim().toLowerCase();
    const endpoint = String(transport.Endpoint || '').trim();
    if (!['ag-ui', 'responses'].includes(protocol) || !endpoint.startsWith('/')) {
      return [];
    }
    const capabilities = asObject(transport.Capabilities);
    return [{
      Protocol: protocol,
      Runtime: String(transport.Runtime || '').trim(),
      Endpoint: endpoint,
      Version: String(transport.Version || '').trim(),
      Capabilities: {
        A2UI: Boolean(capabilities.A2UI),
        Interrupt: Boolean(capabilities.Interrupt),
        Cancel: Boolean(capabilities.Cancel),
      },
    }];
  });
}

export function normalizeCapabilities(bootstrap) {
  const data = bootstrap?.Data || bootstrap || {};
  const rawCapabilities = asObject(data.Capabilities);
  const hostedRuntime = asObject(data.HostedRuntime);
  const framework = firstFramework(
    data.Agent?.Framework,
    hostedRuntime.Framework,
    hostedRuntime.Type,
  );
  const productName = NATIVE_DASHBOARD_FRAMEWORKS.get(framework) || '';
  const apiFormats = normalizeApiFormats(data.ApiFormats || rawCapabilities.HostedChat?.ApiFormats);
  const defaultHostedChat = framework !== 'openclaw';
  const defaultNativeDashboard = Boolean(productName);
  const defaultNativeTerminal = Boolean(productName);

  const hostedChat = asObject(rawCapabilities.HostedChat);
  const nativeDashboard = asObject(rawCapabilities.NativeDashboard);
  const nativeTerminal = asObject(rawCapabilities.NativeTerminal);
  const runLifecycle = asObject(rawCapabilities.RunLifecycle);
  const topLevelHostedChat = asObject(data.HostedChat);
  const transports = normalizeHostedChatTransports(
    hostedChat.Transports || topLevelHostedChat.Transports,
  );
  const preferredCandidate = String(
    hostedChat.PreferredTransport || topLevelHostedChat.PreferredTransport || 'responses',
  ).trim().toLowerCase();
  const preferredTransport = transports.some(
    (transport) => transport.Protocol === preferredCandidate,
  ) ? preferredCandidate : 'responses';

  const hostedChatEnabled = normalizeEnabled(hostedChat.Enabled, defaultHostedChat);
  const nativeDashboardEnabled = normalizeEnabled(
    nativeDashboard.Enabled,
    defaultNativeDashboard,
  );
  const nativeTerminalEnabled = normalizeEnabled(nativeTerminal.Enabled, defaultNativeTerminal);
  const runLifecycleEnabled = normalizeEnabled(runLifecycle.Enabled, hostedChatEnabled);

  return {
    ...rawCapabilities,
    HostedChat: {
      Enabled: hostedChatEnabled,
      ApiFormats: normalizeApiFormats(hostedChat.ApiFormats || apiFormats),
      PreferredTransport: preferredTransport,
      Transports: transports,
    },
    NativeDashboard: {
      Enabled: nativeDashboardEnabled,
      Href:
        typeof nativeDashboard.Href === 'string'
          ? nativeDashboard.Href
          : nativeDashboardEnabled
            ? '/'
            : null,
      Label:
        typeof nativeDashboard.Label === 'string'
          ? nativeDashboard.Label
          : nativeDashboardEnabled
            ? '管理平台'
            : null,
    },
    NativeTerminal: {
      Enabled: nativeTerminalEnabled,
      Mode:
        typeof nativeTerminal.Mode === 'string'
          ? nativeTerminal.Mode
          : nativeTerminalEnabled
            ? 'tui'
            : null,
      Protocol:
        typeof nativeTerminal.Protocol === 'string'
          ? nativeTerminal.Protocol
          : 'ks-terminal.v1',
      Path:
        typeof nativeTerminal.Path === 'string'
          ? nativeTerminal.Path
          : '/_ksadk/terminal/ws',
    },
    RunLifecycle: {
      Enabled: runLifecycleEnabled,
      Resume: normalizeEnabled(runLifecycle.Resume, runLifecycleEnabled),
      Abort: normalizeEnabled(runLifecycle.Abort, runLifecycleEnabled),
      Checkpoints: normalizeEnabled(runLifecycle.Checkpoints, false),
      CheckpointResume: normalizeEnabled(runLifecycle.CheckpointResume, false),
      CheckpointResumePreview: normalizeEnabled(runLifecycle.CheckpointResumePreview, false),
    },
    BuiltinTools: normalizeBuiltinTools(rawCapabilities.BuiltinTools),
  };
}

export function isHostedChatEnabled(capabilities) {
  return normalizeCapabilities({ Data: { Capabilities: capabilities } }).HostedChat.Enabled;
}

export function isNativeDashboardEnabled(capabilities) {
  return normalizeCapabilities({ Data: { Capabilities: capabilities } }).NativeDashboard.Enabled;
}

export function isNativeTerminalEnabled(capabilities) {
  return normalizeCapabilities({ Data: { Capabilities: capabilities } }).NativeTerminal.Enabled;
}

export function resolveHostedChatTransport(capabilities) {
  const hostedChat = normalizeCapabilities({ Data: { Capabilities: capabilities } }).HostedChat;
  const preferred = hostedChat.Transports.find(
    (transport) => transport.Protocol === hostedChat.PreferredTransport,
  );
  const responses = hostedChat.Transports.find(
    (transport) => transport.Protocol === 'responses',
  );
  return preferred || responses || {
    Protocol: 'responses',
    Runtime: 'ksadk',
    Endpoint: '/v1/responses',
    Version: 'v1',
    Capabilities: { A2UI: false, Interrupt: false, Cancel: false },
  };
}
