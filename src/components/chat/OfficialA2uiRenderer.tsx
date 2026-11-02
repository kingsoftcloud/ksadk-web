import { A2uiSurface } from '@a2ui/react';
import { setMarkdownRenderer } from '@a2ui/web_core/v0_9/basic_catalog';
import { renderMarkdown } from '@a2ui/markdown-it';

// This module is loaded only in the browser: the renderer and DOMPurify need
// the real DOM. The shared library remains importable by SSR consumers.
setMarkdownRenderer(renderMarkdown);
export default A2uiSurface;
