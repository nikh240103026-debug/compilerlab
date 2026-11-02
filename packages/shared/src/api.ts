import type { ToolId } from './settings';

/** Every API failure has this shape, so the UI can always show a human-readable message. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: { path: string; message: string }[];
  };
}

export type DbDriver = 'better-sqlite3' | 'node:sqlite';

export interface HealthResponse {
  status: 'ok';
  version: string;
  uptimeSeconds: number;
  dbDriver: DbDriver;
}

export type CheckState = 'ok' | 'warn' | 'fail';

export interface ToolStatus {
  id: ToolId;
  label: string;
  state: CheckState;
  /** First line of the tool's version output, when it was found. */
  version: string | null;
  /** The path from Settings, or the bare command when using PATH. */
  command: string;
}

export interface SystemStatus {
  platform: string;
  node: { version: string; state: CheckState; detail: string };
  tools: ToolStatus[];
  /** Exact install commands for this OS. Empty when every tool was found. */
  toolFix: string[];
  /** "real" runs flex, bison and gcc; "simulated" uses the built-in teaching engine. */
  labMode: 'real' | 'simulated';
  /** Whether a key exists. The key itself never leaves the server. */
  gemini: { configured: boolean; defaultModel: string; model: string };
  data: { directory: string; dbDriver: DbDriver };
}
