export type McpAuthorizationAction = 'GetMcpAuthorizationWait' | 'OpenMcpAuthorization' | 'RetryMcpAuthorization' | 'RetryMcpConnection' | 'CancelMcpAuthorizationWait';
export type McpAuthorizationSnapshot = {
  schema: 'mcp.authorization/v1'; capability_digest: string;
  wait_id: string; run_id: string; config_id: string; revision: number;
  status: string; deadline: number; error?: string | null;
  scopes: string[]; allowed_actions: string[]; requires_resume: boolean;
};
export type McpAuthorizationRequest = (action: McpAuthorizationAction, waitId: string, revision?: number) => Promise<McpAuthorizationSnapshot & { authorization_url?: string }>;
