import type { Settings, ToolId } from '@compilerlab/shared';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { probe, TOOLS, type Probe } from '../../../../scripts/lib/checks.mjs';

export interface ToolCommand {
  command: string;
  /** Arguments that come first. Tests use this to run stand-in tools through node. */
  prefixArgs: string[];
}

export type LabToolId = Extract<ToolId, 'flex' | 'gcc' | 'gpp'>;

export interface LabToolchain {
  /** How to run a tool, or null if it is not installed. */
  find(id: LabToolId): Promise<ToolCommand | null>;
  /** How to run the program a compiler just built in this folder. */
  program(runDirectory: string): ToolCommand;
  /** The environment for every process in a job, before the run folder is added. */
  environment(): NodeJS.ProcessEnv;
}

/** Only these reach student programs, so the Gemini key and anything else secret cannot. */
const PASSED_THROUGH = ['SystemRoot', 'windir', 'PATHEXT', 'HOME', 'USERPROFILE', 'MSYSTEM'];

export function realToolchain(
  toolPaths: Settings['toolPaths'],
  run: Probe = probe,
  platform: NodeJS.Platform = process.platform,
): LabToolchain {
  return {
    async find(id) {
      const tool = TOOLS.find((candidate) => candidate.id === id);
      const command = toolPaths[id].trim() || (tool?.command as string);
      const version = await run(command, ['--version']);
      return version === null ? null : { command, prefixArgs: [] };
    },
    program(runDirectory) {
      return {
        command: join(runDirectory, platform === 'win32' ? 'program.exe' : 'program'),
        prefixArgs: [],
      };
    },
    environment() {
      const env: NodeJS.ProcessEnv = {};
      for (const name of PASSED_THROUGH) {
        if (process.env[name] !== undefined) env[name] = process.env[name];
      }
      // A tool's folder has what it needs next to it: m4 for flex, and on Windows, the DLLs
      // for gcc and for the programs it builds.
      const toolFolders = Object.values(toolPaths)
        .map((path) => path.trim())
        .filter((path) => isAbsolute(path))
        .map((path) => dirname(path));
      env.PATH = [...new Set(toolFolders), process.env.PATH ?? ''].join(delimiter);
      // Tool messages stay in English, which is what the diagnostics parser reads.
      env.LANG = 'C';
      env.LC_ALL = 'C';
      return env;
    },
  };
}
