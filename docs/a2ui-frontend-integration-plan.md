# A2UI And AG-UI Integration

## Status

KSADK Web uses the official transports and renderer:

- `@ag-ui/client` owns streaming, interrupts, resume payloads, and aborts.
- `@copilotkit/a2ui-renderer` owns catalog validation, A2UI state, rendering,
  and user actions.
- KSADK's `RuntimeAdapter` and `RuntimeEvent` remain the backend's common
  execution and persistence model. Neither library is replaced by a custom
  browser SSE protocol.

The old proposal for a private `SubmitA2UIAction` endpoint and a hand-written
`A2UISurface` component is retired. New work must not revive either path.

## Transport Boundary

`GetAgentUiBootstrap` advertises the usable transports. The web client selects
AG-UI only when it is explicitly advertised as valid:

```json
{
  "HostedChat": {
    "PreferredTransport": "ag-ui",
    "Transports": [
      {
        "Protocol": "ag-ui",
        "Runtime": "copilotkit",
        "Endpoint": "/agentengine/agui",
        "Version": "0.1.19",
        "Capabilities": { "A2UI": true, "Interrupt": true, "Cancel": true }
      },
      {
        "Protocol": "responses",
        "Runtime": "ksadk",
        "Endpoint": "/v1/responses",
        "Version": "v1",
        "Capabilities": { "A2UI": false, "Interrupt": true, "Cancel": true }
      }
    ]
  }
}
```

`/v1/responses` preserves the OpenAI Responses contract. It is not relabelled
as AG-UI and it does not gain a second, incompatible A2UI protocol. If AG-UI
is absent or malformed, the client falls back to Responses.

## Live Run And Resume

`src/core/run/agui.ts` creates an official `HttpAgent` with the server's
advertised endpoint. Every run carries the official A2UI catalog context and
`injectA2UITool: true`. `AguiRunClient` projects AG-UI events to the existing
run dispatcher:

| AG-UI event | Web projection |
| --- | --- |
| `TEXT_MESSAGE_*` | assistant message and deltas |
| `REASONING_MESSAGE_CONTENT` | reasoning delta |
| `TOOL_CALL_*` | tool activity/result |
| `ACTIVITY_SNAPSHOT` | A2UI activity attached to the producing assistant turn |
| interrupted `RUN_FINISHED` | pending approval card |

Approval accepts or rejects through `RunEngine.resumeAguiInterrupt`. The
client builds the official AG-UI resume array through `buildResumeArray`; it
does not invent a KSADK-only action endpoint. A durable interrupt can be
resumed after a page reload because the session and interrupt id are sent back
to the runtime, which remains authoritative.

The existing Responses approval path remains independent and continues to use
the OpenAI-compatible approval resume input. Do not merge the two payload
formats in the browser.

## A2UI Rendering

`src/components/chat/A2UIActivityMessage.tsx` renders activity messages with
`A2UIProvider`, `A2UIRenderer`, and the official v0.9 `basicCatalog`. The only
compatibility repair is `normalizeA2uiOperations`: it renames one persisted
legacy `*-root` component id to `root`, which is the identifier expected by the
official renderer. Valid current A2UI messages are never rewritten.

Renderer callbacks pass `A2UIClientEventMessage` directly to the AG-UI run
hook. This supports more than approval: any catalog-supported form, selection,
or action can carry its own `userAction.context` and resume the matching
interrupt. Policy enforcement, actor validation, idempotency, and tool receipt
checks remain backend responsibilities.

## Replay And UI Rules

- A2UI activities are persisted as RuntimeEvents and replayed into the same
  assistant turn as live events.
- A pending approval is rendered immediately when its `RUN_FINISHED` interrupt
  arrives; it must not depend on a history refresh.
- A resolved approval stays terminal after replay. A duplicated pending event
  must not make a completed decision actionable again.
- The renderer is a message-row surface, not a floating overlay. On a narrow
  viewport it remains in normal document flow above the composer.

## Verification

Required automated checks:

```bash
npm run lint
npm test
node --test tests/*.mjs
npm run build:all
```

Backend protocol coverage lives in `ksadk-python/tests/agui/` and validates
AG-UI wire format, RuntimeAdapter ownership, LangGraph interrupts, A2UI
projection, and application factory wiring. A browser smoke must additionally
verify an advertised AG-UI endpoint, live activity rendering, approval resume,
history replay, and desktop/mobile layout before release.
