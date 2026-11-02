import { createContext, useContext, type ReactNode } from 'react';
import { defaultA2uiCatalogRegistry, type A2uiCatalogRegistry } from './registry.js';

const Context = createContext(defaultA2uiCatalogRegistry);

export function A2uiCatalogProvider({ registry, children }: { registry: A2uiCatalogRegistry; children: ReactNode }) {
  return <Context.Provider value={registry}>{children}</Context.Provider>;
}

// Context consumers are exported with their Provider so applications cannot
// accidentally bind their cards to a separate context instance.
// eslint-disable-next-line react-refresh/only-export-components
export function useA2uiCatalogRegistry(): A2uiCatalogRegistry { return useContext(Context); }
