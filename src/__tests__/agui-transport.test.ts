import { describe, expect, it } from 'vitest';
import {
  normalizeCapabilities,
  resolveHostedChatTransport,
} from '../utils/capabilities.js';

const responses = {
  Protocol: 'responses',
  Runtime: 'ksadk',
  Endpoint: '/v1/responses',
  Version: 'v1',
  Capabilities: { A2UI: false, Interrupt: true, Cancel: true },
};

const agui = {
  Protocol: 'ag-ui',
  Runtime: 'copilotkit',
  Endpoint: '/agentengine/agui',
  Version: '0.1.19',
  Capabilities: { A2UI: true, Interrupt: true, Cancel: true },
};

describe('HostedChat transport selection', () => {
  it('selects advertised AG-UI without guessing from framework', () => {
    const capabilities = normalizeCapabilities({
      Data: {
        Agent: { Framework: 'custom-framework' },
        HostedChat: { PreferredTransport: 'ag-ui', Transports: [agui, responses] },
        Capabilities: { HostedChat: { Enabled: true } },
      },
    });

    expect(resolveHostedChatTransport(capabilities)).toMatchObject(agui);
  });

  it('falls back to Responses when AG-UI is absent or malformed', () => {
    const capabilities = normalizeCapabilities({
      Data: {
        HostedChat: {
          PreferredTransport: 'ag-ui',
          Transports: [{ ...agui, Endpoint: 'not-an-app-path' }, responses],
        },
        Capabilities: { HostedChat: { Enabled: true } },
      },
    });

    expect(resolveHostedChatTransport(capabilities)).toMatchObject(responses);
  });

  it('keeps legacy bootstrap responses-compatible', () => {
    const capabilities = normalizeCapabilities({
      Data: { Agent: { Framework: 'langgraph' }, Capabilities: {} },
    });

    expect(resolveHostedChatTransport(capabilities)).toMatchObject({
      Protocol: 'responses',
      Endpoint: '/v1/responses',
    });
  });
});
