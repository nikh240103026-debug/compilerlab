import type { AiAnswerMeta, AiLevel } from '@compilerlab/shared';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface AiTurnError {
  code: string;
  message: string;
  retryAfterSeconds: number | null;
}

export interface AiTurn {
  id: number;
  role: 'user' | 'model';
  text: string;
  /** The question this answers, for the Report wrong answer button. */
  question?: string;
  meta?: AiAnswerMeta | null;
  error?: AiTurnError | null;
  cancelled?: boolean;
}

interface AiStoreState {
  level: AiLevel;
  setLevel: (level: AiLevel) => void;
  /** Kept per panel while the app is open, so closing a panel does not lose the conversation. */
  conversations: Record<string, AiTurn[]>;
  append: (conversationId: string, turn: Omit<AiTurn, 'id'>) => void;
  clear: (conversationId: string) => void;
}

let nextTurnId = 1;

export const useAiStore = create<AiStoreState>()(
  persist(
    (set) => ({
      level: 'intermediate',
      setLevel: (level) => set({ level }),
      conversations: {},
      append: (conversationId, turn) =>
        set((state) => ({
          conversations: {
            ...state.conversations,
            [conversationId]: [
              ...(state.conversations[conversationId] ?? []),
              { ...turn, id: nextTurnId++ },
            ],
          },
        })),
      clear: (conversationId) =>
        set((state) => ({
          conversations: { ...state.conversations, [conversationId]: [] },
        })),
    }),
    // Only the level lasts between visits. Conversations stay in memory.
    { name: 'compilerlab.ai', partialize: (state) => ({ level: state.level }) },
  ),
);
