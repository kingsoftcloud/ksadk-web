import type {
  HostedChatTransport,
  HostedChatTransportProtocol,
  RuntimeApiFormat,
} from './api.js';

export type BuiltinToolCapability = {
  name: string;
  group: string;
  description?: string;
  risk_level: string;
  requires_approval: boolean;
  side_effects: string[];
  enabled: boolean;
  backend?: string;
  boundary?: string;
};

export type UiCapabilities = {
  Attachments?: boolean;
  Approval?: boolean;
  Thinking?: boolean;
  StopRun?: boolean;
  ResumeRun?: boolean;
  MCP?: boolean;
  HostedRuntime?: boolean;
  HostedChat: {
    Enabled: boolean;
    ApiFormats: RuntimeApiFormat[];
    PreferredTransport: HostedChatTransportProtocol;
    Transports: HostedChatTransport[];
  };
  NativeDashboard: {
    Enabled: boolean;
    Href?: string | null;
    Label?: string | null;
  };
  NativeTerminal: {
    Enabled: boolean;
    Mode?: string | null;
    Protocol?: string | null;
    Path?: string | null;
  };
  RunLifecycle: {
    Enabled: boolean;
    Resume: boolean;
    Abort: boolean;
    Checkpoints: boolean;
    CheckpointResume: boolean;
    CheckpointResumePreview: boolean;
  };
  WorkspaceFiles?: boolean;
  BuiltinTools: BuiltinToolCapability[];
};
