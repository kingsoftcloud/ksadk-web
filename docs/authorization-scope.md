# Identity changes and browser caches (0.3.7 candidate)

`authorizationScopeKey` is an opaque **browser cache namespace**, not a token,
credential or authorization decision. Never put API keys or session cookies in
it. The server still authorizes every session/history/run/attachment request.

## Hosted workbench

`AgentWorkbench` reads the additive `AuthorizationScopeKey` from its existing
bootstrap response **before mounting the conversation**. The bootstrap result
is reused by the chat controller (no duplicate successful bootstrap request).
New servers derive this key from verified cloud actor, business identity,
agent and access mode. Default IAM main/subaccounts need no custom identity.
Servers without this field continue to use the original cache keys.

## Custom hosts and useAgentChat

An SPA that changes identity must persist its new authenticated context first,
then change the prop. Include tenant and subject, not merely tenant, in the
host's stable opaque key. Do not change it on ordinary access-token renewal
when the principal and authorization context stay the same.

```tsx
<AgentWorkbench apiAdapter={api} authorizationScopeKey={auth.cacheScopeKey} />
```

For a custom controller/layout, put the controller **inside** the boundary:

```tsx
import { AgentAuthorizationBoundary } from '@kingsoftcloud/ksadk-web';
import { useAgentChat } from '@kingsoftcloud/ksadk-web/hooks';

function MyChat() {
  const chat = useAgentChat({ api, agentId });
  return <MyLayout chat={chat} />;
}

<AgentAuthorizationBoundary authorizationScopeKey={auth.cacheScopeKey}>
  <MyChat />
</AgentAuthorizationBoundary>
```

0.3.x has page-wide stores. On a key change, the boundary hides/unmounts the old
tree before paint, freezes persistent-cache writes, and reloads the document.
This destroys the old page's requests/stream readers, drafts, attachment objects,
workspace previews, interaction state and singleton caches. It does **not** send
`CancelRun`: a server-side run may continue and can be replayed after login.
The host must restore the new authentication context after reload; a context
kept only in React state is insufficient. One controller per page remains the
supported integration. Do not mount another controller outside this boundary.

The library cannot infer an identity switch from arbitrary cookies or a mutable
custom API adapter. A custom login/logout/impersonation flow must update the key
(or navigate/reload the document itself). Hosted login navigation obtains a new
scope on the next bootstrap; this is not a background cross-tab login detector.

## Persistence and compatibility

- Selected session, pinned sessions and permission preference use separate scope
  keys. Returning to A can restore A's preferences; B never imports A's keys.
- A scoped identity never imports unowned legacy preferences. In particular,
  `full` permission from a legacy page does not become a new identity's default.
- No cache or database history is deleted or migrated. Historical sessions are
  still returned and authorized by the backend; this is not an owner migration.
- Omission retains legacy behavior. A transition from a scope back to omission
  also reloads; an empty string is rejected instead of silently downgrading.
- Unavailable localStorage degrades to in-memory use, not a shared fallback key.
- RunAgent/ADK/LangGraph request and event protocols are unchanged.

## Candidate verification

`src/__tests__/authorization-cache.test.ts` covers legacy keys, namespace
separation, downgrade, stale-write fencing and preference defaults.
`e2e/fixtures/authorization-scope.html` is a local browser-only A/B fixture with
drafts, persisted preferences and a deliberately uncleaned delayed callback.
It uses synthetic principals, no production credentials.
