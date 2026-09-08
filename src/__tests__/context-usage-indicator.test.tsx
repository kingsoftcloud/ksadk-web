import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ContextUsageIndicator } from '../components/chat/ContextUsageIndicator';

describe('context usage presentation', () => {
  it('hides percentages but keeps the known model window when usage is unavailable', () => {
    const html = renderToStaticMarkup(createElement(ContextUsageIndicator, {
      indicator: { label: '上下文占用', percent: 87, contextWindowTokens: 128000, contextWindowSource: 'runtime' },
    }));
    expect(html).toContain('上下文用量暂不可用');
    expect(html).not.toContain('%');
    expect(html).not.toContain('stroke-dasharray');
    expect(html).toContain('模型窗口：128,000 tokens');
    expect(html).not.toContain('等待运行时');
    expect(html).not.toContain('运行时报告');
    expect(html).not.toContain('模型配置');
  });

  it('keeps known usage and percentage but never displays provenance', () => {
    for (const contextWindowSource of ['runtime', 'model'] as const) {
      const html = renderToStaticMarkup(createElement(ContextUsageIndicator, {
        indicator: { label: '上下文占用', usedTokens: 32000, percent: 25, contextWindowTokens: 128000, contextWindowSource },
      }));
      expect(html).toContain('32,000 tokens');
      expect(html).toContain('25% 已使用');
      expect(html).not.toContain('运行时报告');
      expect(html).not.toContain('模型配置');
    }
  });
});
