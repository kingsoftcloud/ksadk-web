import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { a2uiManifest } from '../../src/core/a2ui/catalog.js';

const library = new URLSearchParams(location.search).get('library') === '1';
if (library) await import('../../dist-lib/styles.css');
else await import('../../src/index.css');
const { A2UIActivityMessage } = library
  ? await import('../../dist-lib/chat-timeline.js')
  : await import('../../src/components/chat/A2UIActivityMessage.js');
const messages = [
  { version: 'v0.9.1', createSurface: { surfaceId: 'icons', catalogId: a2uiManifest.catalog_id } },
  { version: 'v0.9.1', updateComponents: { surfaceId: 'icons', components: [
    { id: 'root', component: 'Row', children: ['check', 'home', 'search'] },
    ...['check', 'home', 'search'].map(name => ({ id: name, component: 'Icon', name })),
  ] } },
];
createRoot(document.getElementById('root')!).render(createElement(A2UIActivityMessage, { surfaceId: 'icons', messages }));
