import { projectConversationItems } from '../core/conversation/presentation.js';
import { describe, expect, it } from 'vitest';
import { projectConversationStreamForHostedUi } from '../core/conversation/hosted.js';
import type { ConversationItem, ConversationStreamResult } from '../core/conversation/types.js';

function toolSnapshot(executionStatus: string, terminal?: 'completed' | 'failed', runId = 'run-1') {
  const tool: ConversationItem = {
    apiVersion: 'conversation.ksadk.io/v1', kindVersion: 1,
    itemId: 'lookup', sourceEventIds: ['call'], sessionId: 'session', runId,
    kind: 'tool_call', operation: 'completed', lifecycle: 'completed', visibility: 'public',
    payloadSchemaRef: 'conversation.item.tool-call/v1',
    payload: { tool: 'lookup', callId: 'lookup', executionStatus }, nativeRef: {},
  };
  const result: ConversationStreamResult = {
    cursor: 1, runId: 'run-1', state: { items: [tool], appliedSources: [] },
    presentation: {
      runId: 'run-1', terminalStatus: terminal,
      timeline: [{ key: 'lookup', item: tool, sourceItemIds: ['lookup'] }],
      output: '', reasoning: '', textItems: [], toolItems: [tool], approvalItems: [],
      structuredInputItems: [], a2uiItems: [], artifacts: [], fallbacks: [],
    },
  };
  return projectConversationStreamForHostedUi(result).messages[0];
}

describe('terminal run tool presentation', () => {
  it.each(['completed', 'failed'] as const)('keeps an unreceipted call unknown when run %s', terminal => {
    const message = toolSnapshot('running', terminal);
    expect(message.tools?.lookup.status).toBe('unknown');
    expect(message.blocks?.[0].status).toBe('unknown');
    expect(message.tools?.lookup.output).toBeUndefined();
  });

  it.each(['completed', 'failed', 'unknown'])('preserves authoritative %s tool outcome', status => {
    expect(toolSnapshot(status, 'completed').tools?.lookup.status)
      .toBe(status === 'failed' ? 'error' : status);
  });

  it('does not settle an active call or a different native run', () => {
    expect(toolSnapshot('running').tools?.lookup.status).toBe('running');
    expect(toolSnapshot('running', 'completed', 'other-run').tools?.lookup.status).toBe('running');
  });
});

describe('LangGraph ToolNode results', () => {
  function item(id: string, kind: 'tool_call' | 'tool_result', scopeId: string, parentScopeId?: string): ConversationItem {
    return { apiVersion: 'conversation.ksadk.io/v1', kindVersion: 1, kind: 'tool_call',
      operation: 'completed', lifecycle: 'completed', visibility: 'public', itemId: id,
      sourceEventIds: [id], runId: 'run', sessionId: 'session', payloadSchemaRef: 'conversation.item.tool-call/v1',
      nativeRef: { framework: 'langgraph', scopeId, parentScopeId },
      payload: { callId: 'native-1', sourceKind: kind, ...(kind === 'tool_call'
        ? {tool: 'lookup', executionStatus: 'running'} : {output: 'answer', executionStatus: 'completed'}) } };
  }
  it('joins only an unambiguous result in the direct child scope of its call', () => {
    const project = (items: ConversationItem[]) => projectConversationItems({items, appliedSources: []}).timeline;
    const call = item('call', 'tool_call', 'research');
    const result = item('result', 'tool_result', 'execute', 'research');
    for (const items of [[call, result], [result, call]]) {
      const entries = project(items);
      expect(entries).toHaveLength(1);
      expect(entries[0].item.payload).toMatchObject({tool:'lookup', output:'answer', executionStatus:'completed'});
    }
    expect(project([call, item('result', 'tool_result', 'execute', 'sibling')])).toHaveLength(2);
    expect(project([call, result, item('local', 'tool_result', 'research')])).toHaveLength(2);
    expect(project([call, result, item('other', 'tool_result', 'parallel', 'research')])).toHaveLength(3);
  });
});
