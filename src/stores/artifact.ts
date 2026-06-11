import { create } from 'zustand';

export type ArtifactState = {
  content: string | null;
  type: string;
  visible: boolean;
};

export type ArtifactActions = {
  show: (content: string, type?: string) => void;
  hide: () => void;
  setContent: (content: string | null, type?: string) => void;
};

export type ArtifactStore = ArtifactState & ArtifactActions;

export const useArtifactStore = create<ArtifactStore>()((set) => ({
  content: null,
  type: 'html',
  visible: false,
  show: (content, type = 'html') => set({ content, type, visible: true }),
  hide: () => set({ visible: false }),
  setContent: (content, type) =>
    set((s) => ({ content, type: type ?? s.type })),
}));
