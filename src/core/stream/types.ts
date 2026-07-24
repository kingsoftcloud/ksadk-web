export interface A2UIComponent {
  component_id: string;
  type: string;
  props: Record<string, unknown>;
  children: A2UIComponent[];
}

export interface A2UISurface {
  surface_id: string;
  catalog_id: string;
  components: A2UIComponent[];
  data_model: Record<string, unknown>;
}

export type StreamAction =
  | { type: 'text_delta'; text: string }
  | { type: 'text_final'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_upsert'; name: string; args: string; status: 'running' | 'completed' | 'error' | 'paused'; extra?: Record<string, unknown> }
  | { type: 'tool_result'; name: string; output: string }
  | { type: 'approval_request'; approvalRequestId: string; previousResponseId?: string }
  | { type: 'a2ui_surface_begin'; surfaceId: string; surface: A2UISurface }
  | { type: 'a2ui_surface_update'; surfaceId: string; surface: A2UISurface }
  | { type: 'a2ui_surface_end'; surfaceId: string }
  | { type: 'a2ui_interaction'; surfaceId: string; interactionId: string; kind: string; inputSchema: Record<string, unknown> }
  | { type: 'compaction'; phase: 'start' | 'done' | 'failed'; trigger?: string; compactedUntilSeqId?: number }
  | { type: 'incomplete' }
  | { type: 'failed'; message: string }
  | { type: 'terminal'; status: string };

export interface StreamProtocol {
  createState(): Record<string, unknown>;
  parse(event: import('../transport/types.js').TransportEvent, state: Record<string, unknown>): StreamAction[];
  readonly id: string;
}
