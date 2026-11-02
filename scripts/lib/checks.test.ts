import { describe, expect, it } from 'vitest';
import { checkGemini, checkNode, checkTool, checkTools, probe, toolFix, TOOLS } from './checks.mjs';

describe('checkNode', () => {
  it('accepts the pinned major', () => {
    expect(checkNode('v22.22.2').state).toBe('ok');
  });

  it('warns on newer versions and explains how to switch', () => {
    const result = checkNode('v24.1.0', 'linux');
    expect(result.state).toBe('warn');
    expect(result.fix.join('\n')).toContain('nvm install');
  });

  it('fails on older versions', () => {
    expect(checkNode('v20.11.0').state).toBe('fail');
  });

  it('gives Windows its own instructions', () => {
    expect(checkNode('v18.0.0', 'win32').fix[0]).toContain('winget');
  });
});

describe('toolFix', () => {
  it('returns nothing when no tool is missing', () => {
    expect(toolFix([], 'linux')).toEqual([]);
  });

  it('uses apt on Ubuntu with only the missing tools', () => {
    expect(toolFix(['flex', 'g++'], 'linux')).toEqual([
      'sudo apt update && sudo apt install -y flex g++',
    ]);
  });

  it('offers both MSYS2 and WSL2 on Windows', () => {
    const text = toolFix(['gcc', 'flex'], 'win32').join('\n');
    expect(text).toContain('pacman -S --needed flex mingw-w64-ucrt-x86_64-gcc');
    expect(text).toContain('wsl --install');
  });

  it('uses Homebrew and the Xcode tools on macOS', () => {
    const text = toolFix(['bison', 'g++'], 'darwin').join('\n');
    expect(text).toContain('brew install bison');
    expect(text).toContain('xcode-select --install');
    expect(text).toContain('opt/bison/bin');
  });
});

describe('checkTool', () => {
  const flex = TOOLS[0]!;

  it('reports the version when the tool runs', async () => {
    const result = await checkTool(flex, { run: async () => 'flex 2.6.4' });
    expect(result).toMatchObject({ state: 'ok', version: 'flex 2.6.4', command: 'flex' });
  });

  it('warns when the tool is missing', async () => {
    const result = await checkTool(flex, { run: async () => null });
    expect(result).toMatchObject({ state: 'warn', version: null });
  });

  it('prefers the path from Settings', async () => {
    const seen: string[] = [];
    await checkTool(flex, {
      override: ' /opt/flex ',
      run: async (command) => {
        seen.push(command);
        return 'flex';
      },
    });
    expect(seen).toEqual(['/opt/flex']);
  });

  it('checks every tool', async () => {
    const results = await checkTools({ run: async () => 'v1' });
    expect(results.map((tool) => tool.label)).toEqual(['flex', 'bison', 'gcc', 'g++', 'make']);
  });
});

describe('probe', () => {
  it('returns the first output line of a real command', async () => {
    expect(await probe(process.execPath, ['--version'])).toBe(process.version);
  });

  it('returns null for a command that does not exist', async () => {
    expect(await probe('compilerlab-no-such-tool', ['--version'])).toBeNull();
  });

  it('returns null for a command that fails', async () => {
    expect(await probe(process.execPath, ['--no-such-flag-here'])).toBeNull();
  });
});

describe('checkGemini', () => {
  it('reports a key without exposing it', () => {
    const result = checkGemini({ GEMINI_API_KEY: 'super-secret-value' });
    expect(result.configured).toBe(true);
    expect(JSON.stringify(result)).not.toContain('super-secret-value');
  });

  it.each([[{}], [{ GEMINI_API_KEY: '' }], [{ GEMINI_API_KEY: '   ' }]])(
    'warns when the key is missing: %j',
    (env) => {
      const result = checkGemini(env);
      expect(result).toMatchObject({ state: 'warn', configured: false });
      expect(result.fix.join(' ')).toContain('aistudio.google.com');
    },
  );
});
