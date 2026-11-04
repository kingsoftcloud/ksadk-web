import type { Interaction } from './types.js';
import { MCP_AUTHORIZATION_CAPABILITY } from '../mcp-authorization/contract.js';
import type { McpAuthorizationSnapshot } from '../mcp-authorization/types.js';

/** Internal credential reuse is still tracked/followed, but is not a user task. */
export function isUserPendingInteraction(interaction: Interaction): boolean {
  if (!['pending', 'resolving', 'failed'].includes(interaction.status)) return false;
  const auth = interaction.extensions.mcpAuthorization as McpAuthorizationSnapshot | undefined;
  return !(auth?.schema === MCP_AUTHORIZATION_CAPABILITY.schema
    && auth.capability_digest === MCP_AUTHORIZATION_CAPABILITY.digest
    && !auth.error
    && ['credential_ready', 'connecting'].includes(auth.status));
}
