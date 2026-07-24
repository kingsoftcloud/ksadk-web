export type RuntimeApiFormat = 'responses' | 'chat_completions';

export type HostedChatTransportProtocol = 'ag-ui' | 'responses';

export type HostedChatTransport = {
  Protocol: HostedChatTransportProtocol;
  Runtime: string;
  Endpoint: string;
  Version: string;
  Capabilities: {
    A2UI: boolean;
    Interrupt: boolean;
    Cancel: boolean;
  };
};
