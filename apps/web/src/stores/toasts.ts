import { create } from 'zustand';

export type ToastTone = 'info' | 'success' | 'danger';

export interface Toast {
  id: number;
  title: string;
  description?: string;
  tone: ToastTone;
}

interface ToastState {
  toasts: Toast[];
  dismiss: (id: number) => void;
}

const AUTO_DISMISS_MS = 5000;
let nextId = 1;

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}));

export function toast(input: { title: string; description?: string; tone?: ToastTone }): number {
  const id = nextId++;
  const entry: Toast = { tone: 'info', ...input, id };
  useToasts.setState((state) => ({ toasts: [...state.toasts, entry] }));
  // Errors stay until dismissed, so there is time to read them and press Ask AI.
  if (entry.tone !== 'danger') {
    setTimeout(() => useToasts.getState().dismiss(id), AUTO_DISMISS_MS);
  }
  return id;
}
