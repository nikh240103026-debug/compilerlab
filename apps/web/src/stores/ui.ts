import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UiState {
  sidebarCollapsed: boolean;
  modulesOpen: boolean;
  toggleSidebar: () => void;
  toggleModules: () => void;
}

/** Per-browser layout preferences. Anything that must last goes through the server. */
export const useUi = create<UiState>()(
  persist(
    (set) => ({
      sidebarCollapsed: false,
      modulesOpen: true,
      toggleSidebar: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
      toggleModules: () => set((state) => ({ modulesOpen: !state.modulesOpen })),
    }),
    { name: 'compilerlab.ui' },
  ),
);
