import { describe, expect, it } from 'vitest';
import {
  appendTextBlock,
  appendThinkingBlock,
  finalizeTextBlock,
} from './blocks.js';

describe('finalizeTextBlock', () => {
  it('preserves interleaved text blocks when done repeats the streamed aggregate', () => {
    let blocks = appendThinkingBlock(undefined, '阶段一思考');
    blocks = appendTextBlock(blocks, '【阶段 1/2】进度');
    blocks = appendThinkingBlock(blocks, '阶段二思考');
    blocks = appendTextBlock(blocks, '【阶段 2/2】答案');

    const finalized = finalizeTextBlock(
      blocks,
      '【阶段 1/2】进度【阶段 2/2】答案',
    );

    expect(finalized.map((block) => [block.type, block.content, block.status])).toEqual([
      ['thinking', '阶段一思考', 'done'],
      ['text', '【阶段 1/2】进度', 'done'],
      ['thinking', '阶段二思考', 'done'],
      ['text', '【阶段 2/2】答案', 'done'],
    ]);
  });
});
