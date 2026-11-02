import ReactDOM from 'react-dom/client';
import { AgentWorkbench } from '../../src/App.js';
import { customCatalogRegistry } from '../../examples/custom-catalog/registry.js';
import { ErrorBoundary } from '../../src/components/ErrorBoundary.js';
import '../../src/index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary><AgentWorkbench a2uiCatalogRegistry={customCatalogRegistry} /></ErrorBoundary>,
);
