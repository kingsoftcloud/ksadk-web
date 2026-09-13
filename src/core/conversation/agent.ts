import type { ConversationItem, ConversationSurface } from './types.js';
import type { TrustedRendererCatalog } from './renderer-registry.js';

export type AgentExecutionStatus =
  | 'submitted'
  | 'working'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type ExecutionScopeDescriptor = {
  schema: 'execution.scope/v1';
  scope_id: string;
  parent_scope_id: string;
  trigger_ref: { scope_id: string; item_id: string; call_id: string };
  binding_id: string;
  agent: { id: string; name: string; version_id: string; protocol: string };
  status: AgentExecutionStatus;
  started_at: number;
  ended_at: number | null;
  output_refs: Array<{
    scope_id: string;
    item_id: string;
    part_id?: string | null;
  }>;
  cancel: {
    capability: 'supported' | 'unsupported' | 'unknown';
    request_state:
      | 'none'
      | 'cancel_requested'
      | 'unsupported'
      | 'unknown'
      | 'confirmed'
      | 'local_confirmed';
  };
};
export type AgentScopeAction = {
  sessionId: string;
  runId: string;
  scopeId: string;
  parentItemId: string;
};
/** Host-owned surface action. Interaction responses use the existing Interaction/v1 revision-CAS client. */
export type AgentBlockActions = {
  cancel?: (action: AgentScopeAction) => void | Promise<void>;
};

export function agentBlockProfile(
  surface: ConversationSurface,
  catalog?: TrustedRendererCatalog,
): 'agent-block-v1' | 'flat-v1' {
  const enabled = (name: string, values: ConversationSurface['inputs']) =>
    values.some(
      (capability) =>
        capability.name === name &&
        ['native', 'translated'].includes(capability.mode),
    );
  return enabled('ksadk.presentation', surface.inputs) &&
    enabled('agent.block', surface.outputs) &&
    catalog
      ?.entries()
      .some(
        (renderer) =>
          renderer.schemaRef === 'conversation.item.agent/v1' &&
          renderer.kinds.includes('agent'),
      )
    ? 'agent-block-v1'
    : 'flat-v1';
}

const terminal = (status: unknown) =>
  ['completed', 'failed', 'cancelled'].includes(String(status));
const nonempty = (value: unknown) =>
  typeof value === 'string' && value.trim().length > 0;

export function validateAgentItem(
  item: ConversationItem,
  previous?: ConversationItem,
): void {
  if (
    item.kind !== 'agent' ||
    item.payloadSchemaRef !== 'conversation.item.agent/v1'
  )
    return;
  const descriptor = item.payload;
  const trigger = descriptor.trigger_ref as Record<string, unknown> | undefined;
  const cancel = descriptor.cancel as Record<string, unknown> | undefined;
  const agent = descriptor.agent as Record<string, unknown> | undefined;
  const statuses = [
    'submitted',
    'working',
    'input_required',
    'completed',
    'failed',
    'cancelled',
  ];
  if (
    descriptor.schema !== 'execution.scope/v1' ||
    !nonempty(descriptor.scope_id) ||
    !nonempty(descriptor.parent_scope_id) ||
    !nonempty(descriptor.binding_id) ||
    !nonempty(trigger?.item_id) ||
    !nonempty(trigger?.call_id) ||
    trigger?.scope_id !== descriptor.parent_scope_id ||
    !agent ||
    ['id', 'name', 'version_id', 'protocol'].some(
      (key) => !nonempty(agent[key]),
    ) ||
    !statuses.includes(String(descriptor.status)) ||
    !Number.isFinite(descriptor.started_at) ||
    (terminal(descriptor.status)
      ? !Number.isFinite(descriptor.ended_at)
      : descriptor.ended_at !== null) ||
    !Array.isArray(descriptor.output_refs)
  ) {
    throw new Error('Invalid agent scope descriptor');
  }
  if (
    !cancel ||
    !['supported', 'unsupported', 'unknown'].includes(
      String(cancel.capability),
    ) ||
    ![
      'none',
      'cancel_requested',
      'unsupported',
      'unknown',
      'confirmed',
      'local_confirmed',
    ].includes(String(cancel.request_state))
  ) {
    throw new Error('Invalid agent cancel state');
  }
  if (
    cancel.request_state === 'confirmed' &&
    cancel.capability !== 'supported'
  ) {
    throw new Error('Unsupported remote cancel confirmation');
  }
  if (
    cancel.request_state === 'local_confirmed' &&
    descriptor.status !== 'cancelled'
  ) {
    throw new Error('Local cancellation must be terminal');
  }
  if (previous) {
    for (const key of [
      'scope_id',
      'parent_scope_id',
      'trigger_ref',
      'binding_id',
      'agent',
    ]) {
      if (
        JSON.stringify(previous.payload[key]) !==
        JSON.stringify(descriptor[key])
      ) {
        throw new Error('Agent descriptor identity changed');
      }
    }
    const before = String(previous.payload.status);
    if (
      terminal(before) &&
      JSON.stringify(previous.payload) !== JSON.stringify(descriptor)
    ) {
      throw new Error('Agent terminal conflict');
    }
    if (
      ['working', 'input_required'].includes(before) &&
      descriptor.status === 'submitted'
    ) {
      throw new Error('Agent status regression');
    }
    if (
      cancel.request_state === 'local_confirmed' &&
      before !== 'submitted' &&
      before !== 'cancelled'
    ) {
      throw new Error('Local cancellation after send');
    }
  }
}
