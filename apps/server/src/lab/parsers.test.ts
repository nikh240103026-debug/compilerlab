import {
  LabClientMessageSchema,
  LabJobSchema,
  labFileNameProblem,
  normalizeOutput,
} from '@compilerlab/shared';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainMessage, parseDiagnostics } from './diagnostics';
import { FlexTraceFilter } from './flex-trace';
import { createRunDirectory, runsDirectory, sweepRuns, writeRunFiles } from './runs';
import { realToolchain } from './toolchain';

describe('parseDiagnostics for gcc and g++', () => {
  it('reads errors, warnings and notes, skipping source echoes', () => {
    const output = `scanner.l: In function 'yylex':
scanner.l:7:5: error: 'wrods' undeclared (first use in this function); did you mean 'words'?
    7 |     wrods++;
      |     ^~~~~
scanner.l:7:5: note: each undeclared identifier is reported only once for each function it appears in
main.c:3:1: warning: control reaches end of non-void function [-Wreturn-type]
`;
    const items = parseDiagnostics('gcc', output);
    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ file: 'scanner.l', line: 7, column: 5, severity: 'error' });
    expect(items[0]?.explanation).toContain('wrods');
    expect(items[1]).toMatchObject({ severity: 'note', explanation: null });
    expect(items[2]).toMatchObject({ severity: 'warning', file: 'main.c', line: 3 });
  });

  it('handles Unicode quotes, fatal errors, and Windows paths', () => {
    const items = parseDiagnostics(
      'gcc',
      [
        'C:\\work\\main.c:2:10: fatal error: nope.h: No such file or directory',
        './a.c:1:2: error: ‘x’ undeclared here',
      ].join('\r\n'),
    );
    expect(items[0]).toMatchObject({ file: 'main.c', line: 2, column: 10, severity: 'error' });
    expect(items[0]?.explanation).toContain('#include');
    expect(items[1]).toMatchObject({ file: 'a.c' });
    expect(items[1]?.explanation).toContain('declaration of x');
  });

  it('reads linker errors in the formats ld uses', () => {
    const items = parseDiagnostics(
      'gcc',
      [
        "/usr/bin/ld: /tmp/cc1.o: in function `main':",
        "main.c:(.text+0x1e): undefined reference to `foo'",
        "C:/msys64/ld.exe: C:\\x\\cc2.o:lex.yy.c:(.text+0x10): undefined reference to `yywrap'",
        '/usr/bin/ld: cannot find -lfoo: No such file or directory',
        'collect2: error: ld returned 1 exit status',
      ].join('\n'),
    );
    expect(items.map((item) => item.tool)).toEqual(['linker', 'linker', 'linker']);
    expect(items[0]).toMatchObject({ file: 'main.c', line: null, severity: 'error' });
    expect(items[0]?.explanation).toContain('foo');
    expect(items[1]?.explanation).toContain('%option noyywrap');
    expect(items[2]?.explanation).toContain('library foo');
  });

  it('drops warnings about generated code along with their notes', () => {
    const items = parseDiagnostics(
      'gcc',
      [
        "lex.yy.c:1000:1: warning: 'yyunput' defined but not used",
        'lex.yy.c:1000:1: note: declared here',
        'lex.yy.c:50:2: error: a real problem',
        'lex.yy.c:50:2: note: about it',
      ].join('\n'),
    );
    expect(items.map((item) => item.message)).toEqual(['a real problem', 'about it']);
  });

  it('gives nothing for clean output', () => {
    expect(parseDiagnostics('gcc', '')).toEqual([]);
    expect(parseDiagnostics('gcc', 'just some text\nno location here\n')).toEqual([]);
  });
});

describe('parseDiagnostics for flex', () => {
  it('reads both of the formats flex versions use', () => {
    const items = parseDiagnostics(
      'flex',
      [
        'scanner.l:5: unrecognized rule',
        '"scanner.l", line 9: bad character class',
        'scanner.l:12: warning, rule cannot be matched',
        'flex: could not create lex.yy.c',
        'nothing to see here',
      ].join('\n'),
    );
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ file: 'scanner.l', line: 5, severity: 'error', tool: 'flex' });
    expect(items[0]?.explanation).toContain('pattern');
    expect(items[1]).toMatchObject({ line: 9 });
    expect(items[2]).toMatchObject({ severity: 'warning', message: 'rule cannot be matched' });
    expect(items[2]?.explanation).toContain('earlier rule');
    expect(items[3]).toMatchObject({ file: null, line: null, severity: 'error' });
  });
});

describe('explainMessage', () => {
  it.each([
    ['gcc', "implicit declaration of function 'foo'", 'foo'],
    ['gcc', "expected ';' before 'return'", 'semicolon'],
    ['gcc', "expected ';' at end of declaration", 'semicolon'],
    ['gcc', "expected ')' before ';' token", 'parenthesis'],
    ['gcc', 'expected declaration or statement at end of input', 'closing }'],
    ['gcc', "expected '}' before end of line", 'closing }'],
    ['gcc', "expected expression before ')' token", 'value'],
    ['gcc', 'missing terminating " character', 'closed'],
    ['gcc', "stray '\\342' in program", 'quotes'],
    ['gcc', "conflicting types for 'f'", 'two different ways'],
    ['gcc', "redefinition of 'f'", 'defined twice'],
    ['gcc', "multiple definition of `f'", 'more than one file'],
    ['gcc', "too few arguments to function 'f'", 'fewer'],
    ['gcc', "too many arguments to function 'f'", 'more arguments'],
    ['gcc', 'incompatible types when assigning', 'different type'],
    ['gcc', 'assignment makes pointer from integer without a cast', 'pointer'],
    ['gcc', "format '%d' expects argument of type 'int'", '%d'],
    ['gcc', "unused variable 'q'", 'never used'],
    ['gcc', 'lvalue required as left operand', 'stored'],
    ['gcc', 'division by zero', 'zero'],
    ['g++', "no match for 'operator+'", 'operator'],
    ['g++', "invalid conversion from 'int' to 'char*'", 'convert'],
    ['g++', "'cout' was not declared in this scope", 'cout'],
    ['gcc', "undefined reference to `main'", 'no main'],
    ['flex', 'default rule can be matched', 'catch-all'],
    ['flex', 'EOF encountered inside an action', 'never closed'],
    ['flex', 'undefined definition {X}', 'NAME'],
    ['flex', 'undeclared start condition X', '%x'],
    ['flex', 'unrecognized %option: frob', 'option'],
    ['flex', 'iteration value must be positive', 'positive'],
    ['flex', 'negative range in character class', 'backwards'],
    ['flex', 'premature EOF', 'balanced'],
  ])('%s: %s', (tool, message, expected) => {
    expect(explainMessage(tool, message)).toContain(expected);
  });

  it('admits when it does not recognize a message', () => {
    expect(explainMessage('gcc', 'something entirely new')).toBeNull();
  });
});

describe('FlexTraceFilter', () => {
  it('collects reports and passes everything else through', () => {
    const filter = new FlexTraceFilter();
    const output = filter.write(
      [
        '--accepting rule at line 7 ("abc")',
        'hello from the program',
        '--accepting default rule ("!")',
        '--(end of buffer or a NUL)',
        '--scanner backing up',
        '--EOF (start condition 0)',
        "-- a line of the student's own",
        '',
      ].join('\n'),
    );
    expect(output).toBe("hello from the program\n-- a line of the student's own\n");
    expect(filter.matches).toEqual([
      { ruleLine: 7, text: 'abc' },
      { ruleLine: null, text: '!' },
    ]);
  });

  it('handles a lexeme with a newline in it, and CRLF', () => {
    const filter = new FlexTraceFilter();
    filter.write('--accepting rule at line 3 ("\n")\r\n--accepting rule at line 4 ("a\nb")\n');
    expect(filter.matches).toEqual([
      { ruleLine: 3, text: '\n' },
      { ruleLine: 4, text: 'a\nb' },
    ]);
  });

  it('copes with a report split across chunks at any point', () => {
    const text = 'x\n--accepting rule at line 12 ("hello")\ny\n--EOF (start condition 0)\n';
    for (let split = 1; split < text.length; split++) {
      const filter = new FlexTraceFilter();
      const output =
        filter.write(text.slice(0, split)) + filter.write(text.slice(split)) + filter.flush();
      expect(output, `split at ${split}`).toBe('x\ny\n');
      expect(filter.matches, `split at ${split}`).toEqual([{ ruleLine: 12, text: 'hello' }]);
    }
  });

  it('passes an unfinished line through at the end', () => {
    const filter = new FlexTraceFilter();
    expect(filter.write('--')).toBe('');
    expect(filter.flush()).toBe('--');
    const partial = new FlexTraceFilter();
    expect(partial.write('--accepting rule at line 1 ("never closed')).toBe('');
    expect(partial.flush()).toBe('--accepting rule at line 1 ("never closed');
    expect(partial.matches).toEqual([]);
  });

  it('does not hold huge output forever', () => {
    const filter = new FlexTraceFilter();
    const big = `--accepting rule at line 1 ("${'x'.repeat(70_000)}`;
    expect(filter.write(big)).toBe(big);
    const other = new FlexTraceFilter();
    expect(other.write(`--${'y'.repeat(70_000)}`).length).toBe(70_002);
  });

  it('stops collecting at the limit and says so', () => {
    const filter = new FlexTraceFilter();
    filter.write('--accepting default rule ("a")\n'.repeat(5001));
    expect(filter.matches).toHaveLength(5000);
    expect(filter.truncated).toBe(true);
  });
});

describe('file names', () => {
  it.each([
    ['../evil.c'],
    ['..\\evil.c'],
    ['/etc/passwd.c'],
    ['C:\\evil.c'],
    ['a/b.c'],
    ['a\\b.c'],
    ['..'],
    ['.hidden.c'],
    ['a..b.c'],
    ['name.c:stream'],
    ['bad name.c'],
    ['nul\u0000.c'],
    ['evil.exe'],
    ['evil.sh'],
    ['noextension'],
    ['CON.c'],
    ['nul.txt'],
    ['com1.c'],
    ['lpt9.h'],
    ['lex.yy.c'],
    ['LEX.YY.C'],
    ['y.tab.c'],
    ['lab_defaults.c'],
    [''],
    [`${'a'.repeat(70)}.c`],
  ])('refuses %j', (name) => {
    expect(labFileNameProblem(name)).not.toBeNull();
  });

  it.each([
    ['scanner.l'],
    ['grammar.y'],
    ['main.c'],
    ['a-b_c.cpp'],
    ['x.h'],
    ['x.hpp'],
    ['input.txt'],
    ['a.in'],
    ['Main.C'],
  ])('accepts %s', (name) => {
    expect(labFileNameProblem(name)).toBeNull();
  });
});

describe('the job message schema', () => {
  const file = { name: 'a.c', content: '' };
  const job = { pipeline: 'c', files: [file] };

  it('fills in defaults', () => {
    expect(LabJobSchema.parse(job)).toMatchObject({ engine: 'auto', stdin: '', flags: [] });
  });

  it.each([
    ['a traversal in a name', { ...job, files: [{ name: '../a.c', content: '' }] }],
    ['no files', { ...job, files: [] }],
    [
      'too many files',
      { ...job, files: Array.from({ length: 21 }, (_, i) => ({ name: `f${i}.c`, content: '' })) },
    ],
    ['two names that differ only by case', { ...job, files: [file, { name: 'A.C', content: '' }] }],
    ['a huge file', { ...job, files: [{ name: 'a.c', content: 'x'.repeat(300 * 1024) }] }],
    ['huge input', { ...job, stdin: 'x'.repeat(300 * 1024) }],
    ['a flag not on the list', { ...job, flags: ['-o/etc/passwd'] }],
    ['a plugin flag', { ...job, flags: ['-fplugin=evil.so'] }],
    ['a standard for the wrong language', { ...job, standard: 'c++17' }],
    ['a made-up standard', { ...job, standard: 'c; rm -rf /' }],
    ['an unknown pipeline', { ...job, pipeline: 'shell' }],
    ['an unknown engine', { ...job, engine: 'magic' }],
    ['an extra field', { ...job, command: 'rm' }],
  ])('refuses %s', (_name, value) => {
    expect(LabJobSchema.safeParse(value).success).toBe(false);
  });

  it('takes standards for the right language', () => {
    expect(LabJobSchema.safeParse({ ...job, standard: 'c17' }).success).toBe(true);
    expect(
      LabJobSchema.safeParse({
        pipeline: 'cpp',
        files: [{ name: 'a.cpp', content: '' }],
        standard: 'c++20',
      }).success,
    ).toBe(true);
  });

  it('knows the three kinds of message', () => {
    expect(LabClientMessageSchema.safeParse({ type: 'stop' }).success).toBe(true);
    expect(LabClientMessageSchema.safeParse({ type: 'run', job }).success).toBe(true);
    expect(
      LabClientMessageSchema.safeParse({ type: 'check', exerciseId: 'a-b', job }).success,
    ).toBe(true);
    expect(
      LabClientMessageSchema.safeParse({ type: 'check', exerciseId: '../x', job }).success,
    ).toBe(false);
    expect(LabClientMessageSchema.safeParse({ type: 'shell' }).success).toBe(false);
  });
});

describe('normalizeOutput', () => {
  it('ignores line endings and spaces at the ends of lines', () => {
    expect(normalizeOutput('a  \r\nb\r\n\r\n')).toBe('a\nb');
    expect(normalizeOutput('a\rb')).toBe('a\nb');
    expect(normalizeOutput('')).toBe('');
    expect(normalizeOutput(' a')).toBe(' a');
  });
});

describe('run folders', () => {
  const withFolder = async (use: (dir: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'compilerlab-runs-'));
    try {
      await use(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('creates a new folder each time', () =>
    withFolder(async (dir) => {
      const one = await createRunDirectory(dir);
      const two = await createRunDirectory(dir);
      expect(one).not.toBe(two);
      expect(readdirSync(runsDirectory(dir))).toHaveLength(2);
    }));

  it('refuses to write outside the folder even if validation were bypassed', () =>
    withFolder(async (dir) => {
      const run = await createRunDirectory(dir);
      for (const name of [
        '../escape.c',
        '../../escape.c',
        join(dir, 'escape.c'),
        'sub/escape.c',
        '.',
      ]) {
        await expect(writeRunFiles(run, [{ name, content: 'x' }])).rejects.toThrow(/outside/);
      }
      expect(existsSync(join(dir, 'escape.c'))).toBe(false);
      expect(existsSync(join(dir, 'runs', 'escape.c'))).toBe(false);
    }));

  it('will not overwrite a file that is already there', () =>
    withFolder(async (dir) => {
      const run = await createRunDirectory(dir);
      await writeRunFiles(run, [{ name: 'a.c', content: 'x' }]);
      await expect(writeRunFiles(run, [{ name: 'a.c', content: 'y' }])).rejects.toThrow();
    }));

  it('removes old runs and keeps recent ones', () =>
    withFolder(async (dir) => {
      const root = runsDirectory(dir);
      const old = join(root, 'old');
      const fresh = join(root, 'fresh');
      mkdirSync(old, { recursive: true });
      mkdirSync(fresh);
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      utimesSync(old, twoHoursAgo, twoHoursAgo);
      await sweepRuns(dir);
      expect(existsSync(old)).toBe(false);
      expect(existsSync(fresh)).toBe(true);
    }));

  it('keeps only so many runs', () =>
    withFolder(async (dir) => {
      for (let i = 0; i < 5; i++) await createRunDirectory(dir);
      await sweepRuns(dir, { keep: 2 });
      expect(readdirSync(runsDirectory(dir))).toHaveLength(2);
    }));

  it('does nothing when there are no runs yet', () =>
    withFolder(async (dir) => {
      await expect(sweepRuns(dir)).resolves.toBeUndefined();
    }));
});

describe('realToolchain', () => {
  const noPaths = { flex: '', bison: '', gcc: '', gpp: '', make: '' };

  it('uses the path from Settings, then the bare command', async () => {
    const seen: string[] = [];
    const toolchain = realToolchain({ ...noPaths, gcc: ' /opt/gcc ' }, async (command) => {
      seen.push(command);
      return 'version 1';
    });
    expect(await toolchain.find('gcc')).toEqual({ command: '/opt/gcc', prefixArgs: [] });
    expect(await toolchain.find('gpp')).toEqual({ command: 'g++', prefixArgs: [] });
    expect(seen).toEqual(['/opt/gcc', 'g++']);
  });

  it('reports a missing tool', async () => {
    const toolchain = realToolchain(noPaths, async () => null);
    expect(await toolchain.find('flex')).toBeNull();
  });

  it('runs program.exe on Windows and program elsewhere', () => {
    const windows = realToolchain(noPaths, async () => '', 'win32');
    const linux = realToolchain(noPaths, async () => '', 'linux');
    expect(windows.program('dir').command).toBe(join('dir', 'program.exe'));
    expect(linux.program('dir').command).toBe(join('dir', 'program'));
  });

  it('puts configured tool folders first on PATH, and asks for English messages', () => {
    const tool =
      process.platform === 'win32' ? 'C:\\msys64\\ucrt64\\bin\\gcc.exe' : '/opt/x/bin/gcc';
    const folder = process.platform === 'win32' ? 'C:\\msys64\\ucrt64\\bin' : '/opt/x/bin';
    const env = realToolchain({ ...noPaths, gcc: tool }).environment();
    expect(env.PATH?.startsWith(folder)).toBe(true);
    expect(env.LC_ALL).toBe('C');
    expect(env.LANG).toBe('C');
  });
});
