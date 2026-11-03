import { describe, expect, it } from 'vitest';
import { EngineError } from '../core/result';
import { Utf8Decoder, utf8Bytes } from './bytes';
import { flexToPlayground } from './playground';
import { compileScanner, runScanner } from './simulate';
import { locateOffset, parseFlexFile } from './spec';

function run(source: string, stdin = '') {
  const decoders = { stdout: new Utf8Decoder(), stderr: new Utf8Decoder() };
  const output = { stdout: '', stderr: '' };
  const matches: { ruleLine: number | null; text: string }[] = [];
  const steps = runScanner(compileScanner(source), stdin, {
    write: (stream, bytes) => {
      output[stream] += decoders[stream].write(bytes);
    },
    onMatch: (match) => matches.push(match),
  });
  let state = steps.next();
  while (!state.done) state = steps.next();
  return { ...output, exit: state.value, matches };
}

/** Runs a scanner with no rules worth mentioning, to test the C subset by itself. */
function runC(body: string, stdin = '') {
  return run(`%%\n.|\\n ;\n%%\n${body}\n`, stdin);
}

function errorOf(action: () => unknown): EngineError['info'] {
  try {
    action();
  } catch (error) {
    if (error instanceof EngineError) return error.info;
    throw error;
  }
  throw new Error('Expected this to fail.');
}

describe('scanning', () => {
  it('counts lines, words and characters like the classic word counter', () => {
    const source = String.raw`%{
int lines = 0, words = 0, chars = 0;
%}
%option noyywrap
%%
[a-zA-Z]+  { words++; chars += yyleng; }
\n         { lines++; chars++; }
.          { chars++; }
%%
int main(void) {
  yylex();
  printf("%d %d %d\n", lines, words, chars);
  return 0;
}
`;
    expect(run(source, 'hello big world\nsecond line\n').stdout).toBe('2 5 28\n');
    expect(run(source, '').stdout).toBe('0 0 0\n');
  });

  it('takes the longest match, then the earliest rule', () => {
    const source = String.raw`%%
if        printf("IF ");
[a-z]+    printf("ID(%s) ", yytext);
"<="      printf("LE ");
"<"       printf("LT ");
[ ]       ;
`;
    expect(run(source, 'if iffy < <= x').stdout).toBe('IF ID(iffy) LT LE ID(x) ');
  });

  it('echoes what no rule matches, as the default rule does', () => {
    const { stdout, matches } = run('%%\n[0-9]+ printf("N");\n', 'a1b\n22');
    expect(stdout).toBe('aNb\nN');
    expect(matches[0]).toEqual({ ruleLine: null, text: 'a' });
    expect(matches[1]).toEqual({ ruleLine: 2, text: '1' });
  });

  it('runs the same action for a rule ending in |', () => {
    const source = String.raw`%%
a |
b |
c      printf("[%s]", yytext);
.      ;
`;
    expect(run(source, 'abcd').stdout).toBe('[a][b][c]');
  });

  it('expands definitions and repeat counts', () => {
    const source = String.raw`DIGIT [0-9]
HEX   ({DIGIT}|[a-f])
%%
0x{HEX}{2}     printf("byte ");
{DIGIT}{2,3}   printf("short ");
{DIGIT}{4,}    printf("long ");
x{1}y?         printf("xy ");
[ ]            ;
`;
    expect(run(source, '0xa9 12 123 1234 12345 xy x').stdout).toBe(
      'byte short short long long xy xy ',
    );
  });

  it('understands flex character classes and escapes', () => {
    const source = String.raw`%%
[[:digit:]]+     printf("D");
[[:alpha:]_]+    printf("A");
[[:^space:]]     printf("?");
\x20             printf("S");
\011             printf("T");
"a b"            printf("Q");
\n               printf("N");
`;
    expect(run(source, '12 ab_ \t#\n').stdout).toBe('DSAST?N');
    const members = String.raw`%%
[]x]       printf("B");
[a\-z]     printf("C");
[^a\n]     printf("N");
a          printf("A");
\n         printf("L");
`;
    // [a\-z] holds a, - and z, and comes before the rule for a alone.
    expect(run(members, ']x-z\nqa').stdout).toBe('BBCCLNC');
  });

  it('keeps . away from newlines but lets [^a] match them', () => {
    const source = String.raw`%%
.   printf("D");
[^a]   printf("X");
`;
    // . and [^a] both match x, and the earlier rule wins. Only [^a] can match the newline.
    expect(run(source, 'x\n').stdout).toBe('DX');
  });

  it('ignores case with %option case-insensitive', () => {
    const source = '%option case-insensitive\n%%\nselect printf("KW");\n[a-c]+ printf("L");\n. ;\n';
    expect(run(source, 'SeLeCt ABC').stdout).toBe('KWL');
  });

  it('treats ^ and $ and / as flex does', () => {
    const source = String.raw`%%
^#.*      printf("[directive]");
end$      printf("[eol]");
foo/bar   printf("[%s]", yytext);
.|\n      ECHO;
`;
    expect(run(source, '#x\na#b end\nend foobar foo').stdout).toBe(
      '[directive]\na#b [eol]\nend [foo]bar foo',
    );
  });
});

describe('start conditions', () => {
  const stripper = String.raw`%x COMMENT
%%
"/*"              BEGIN(COMMENT);
<COMMENT>"*/"     BEGIN(INITIAL);
<COMMENT>.|\n     ;
`;

  it('strips comments with an exclusive condition', () => {
    expect(run(stripper, 'a/* x\ny */b/**/c').stdout).toBe('abc');
  });

  it('keeps inclusive rules active with %s', () => {
    const source = String.raw`%s LOUD
%%
<LOUD>a   printf("A");
a         printf("a");
b         printf("b");
!         BEGIN LOUD;
`;
    expect(run(source, 'ab!ab').stdout).toBe('abAb');
  });

  it('reads <*>, lists and block scopes', () => {
    const source = String.raw`%x ONE TWO
%%
<*>#        printf("#");
<ONE,TWO>x  printf("x%d", YY_START);
<ONE>{
  y         printf("y");
  z         BEGIN(TWO);
}
a           BEGIN(ONE);
`;
    expect(run(source, '#axyzx#').stdout).toBe('#x1yx2#');
  });

  it('fails clearly on a condition that was never declared', () => {
    const info = errorOf(() => compileScanner('%%\n<NOPE>a ;\n'));
    expect(info.code).toBe('flex_undeclared_condition');
    expect(info.hint).toContain('%x NOPE');
  });
});

describe('flex functions', () => {
  it('counts lines only with %option yylineno, as real flex does', () => {
    const action = String.raw`%%
x     printf("%d ", yylineno);
.|\n  ;
`;
    expect(run(`%option yylineno\n${action}`, 'x\n\nx').stdout).toBe('1 3 ');
    expect(run(action, 'x\n\nx').stdout).toBe('1 1 ');
  });

  it('returns tokens from yylex to a main loop', () => {
    const source = String.raw`%{
enum { NUM = 258, ID };
#define PLUS 300
%}
%%
[0-9]+    return NUM;
[a-z]+    return ID;
"+"       return PLUS;
[ ]       ;
%%
int main() {
  int token;
  while ((token = yylex()) != 0) printf("%d:%s ", token, yytext);
  return 7;
}
`;
    const { stdout, exit } = run(source, 'ab + 12');
    expect(stdout).toBe('259:ab 300:+ 258:12 ');
    expect(exit).toBe(7);
  });

  it('runs a local block on each entry to yylex', () => {
    const source = String.raw`%%
%{
  int seen = 0;
%}
x   { seen++; printf("%d", seen); return 1; }
%%
int main() { while (yylex()); return 0; }
`;
    expect(run(source, 'xx').stdout).toBe('11');
  });

  it('supports REJECT by moving to the next best rule', () => {
    const source = String.raw`%%
abc   { printf("first "); REJECT; }
ab    printf("second ");
.     printf("%s ", yytext);
`;
    expect(run(source, 'abc').stdout).toBe('first second c ');
  });

  it('falls back to the default rule when every rule rejects', () => {
    expect(run('%%\na REJECT;\n', 'a').stdout).toBe('a');
  });

  it('supports yymore and yyless', () => {
    const more = String.raw`%%
a     { printf("[%s]", yytext); yymore(); }
b     printf("[%s %d]", yytext, yyleng);
`;
    expect(run(more, 'ab').stdout).toBe('[a][ab 2]');
    const less = String.raw`%%
abc   { yyless(1); printf("[%s %d]", yytext, yyleng); }
.     printf("<%s>", yytext);
`;
    expect(run(less, 'abc').stdout).toBe('[a 1]<b><c>');
  });

  it('supports input and unput', () => {
    const source = String.raw`%%
"/*"   {
  int c, last = 0;
  while ((c = input()) != 0) {
    if (last == '*' && c == '/') break;
    last = c;
  }
}
!      { unput('?'); unput('x'); }
x      printf("X");
\?     printf("Q");
.|\n   ECHO;
`;
    expect(run(source, 'a/* b */c!').stdout).toBe('acXQ');
  });

  it('stops at yyterminate and runs <<EOF>> rules', () => {
    const stop =
      '%%\nq yyterminate();\n. ECHO;\n%%\nint main() { yylex(); printf("|%d", 1); return 0; }\n';
    expect(run(stop, 'abqcd').stdout).toBe('ab|1');
    const eof = String.raw`%x STR
%%
\"            BEGIN(STR);
<STR>[^"]+    ;
<STR>\"       BEGIN(INITIAL);
<STR><<EOF>>  { printf("unterminated"); yyterminate(); }
<<EOF>>       { printf("done"); return 0; }
.             ECHO;
`;
    expect(run(eof, 'a"b"c').stdout).toBe('acdone');
    expect(run(eof, 'a"b').stdout).toBe('aunterminated');
  });

  it('calls a yywrap the student wrote', () => {
    const source = '%%\n. ;\n%%\nint yywrap(void) { printf("wrapped"); return 1; }\n';
    expect(run(source, 'x').stdout).toBe('wrapped');
  });

  it('reports a jam under %option nodefault', () => {
    const info = errorOf(() => run('%option nodefault\n%%\na ;\n', 'b'));
    expect(info.code).toBe('c_runtime');
    expect(info.message).toContain('nodefault');
  });

  it('refuses scanner functions outside an action', () => {
    expect(errorOf(() => runC('int main() { REJECT; return 0; }')).message).toContain('REJECT');
    expect(errorOf(() => runC('int main() { yyterminate(); return 0; }')).code).toBe('c_runtime');
    expect(errorOf(() => runC('int main() { yyless(0); return 0; }')).code).toBe('c_runtime');
  });

  it('counts bytes, as C does, and passes text through unchanged', () => {
    const source = '%%\n[^ ]+ { printf("%d:", yyleng); ECHO; }\n';
    expect(run(source, 'é€').stdout).toBe('5:é€');
  });

  it('keeps one yytext buffer, so saving the pointer has its classic bug', () => {
    const source = String.raw`%{
char *saved;
%}
%%
a   saved = yytext;
b   printf("%s", saved);
`;
    expect(run(source, 'ab').stdout).toBe('b');
  });
});

describe('the C subset', () => {
  it('does integer and floating arithmetic the way C does', () => {
    const { stdout } = runC(String.raw`
int main() {
  int a = 7, b = 2;
  double d = 7;
  float f = 1.5;
  long big = 2147483647L;
  unsigned u = 0;
  char c = 300;
  short s = 70000;
  u = u - 1;
  printf("%d %d %d %.2f %.1f ", a / b, a % b, -a / b, d / b, f + 1);
  printf("%ld %u %d %d %d ", big + 1, u, c, s, (int)3.9);
  printf("%d %d %d %d %d %d ", a & b, a | b, a ^ b, ~a, a << 1, a >> 1);
  printf("%d %d %d %d ", a == 7, a != 7, 1 < 2 && 2 < 1, 1 > 2 || 2 > 1);
  printf("%d %d %d ", !a, a > b ? 1 : 2, (a = 3, a + 1));
  return 0;
}`);
    expect(stdout).toBe(
      '3 1 -3 3.50 2.5 2147483648 4294967295 44 4464 3 2 7 5 -8 14 3 1 0 0 1 0 1 4 ',
    );
  });

  it('runs loops, switch and functions', () => {
    const { stdout } = runC(String.raw`
int fact(int n) { return n <= 1 ? 1 : n * fact(n - 1); }
void show(char *label, int value) { printf("%s=%d ", label, value); return; }
int classify(int n) {
  switch (n) {
    case 1:
    case 2: return 10;
    case 3: n = 30;
    case 4: n++; break;
    default: return -1;
  }
  return n;
}
int main(void) {
  int i, total = 0;
  for (i = 0; i < 5; i++) { if (i == 1) continue; if (i == 4) break; total += i; }
  show("for", total);
  i = 0; while (1) { i++; if (i > 2) break; }
  show("while", i);
  do { i--; } while (i > 0);
  show("do", i);
  show("fact", fact(5));
  for (int j = 0; j < 2; j++) ;
  printf("%d %d %d %d %d", classify(1), classify(2), classify(3), classify(4), classify(9));
  return 0;
}`);
    expect(stdout).toBe('for=5 while=3 do=0 fact=120 10 10 31 5 -1');
  });

  it('handles arrays, strings and pointers', () => {
    const { stdout } = runC(String.raw`
char table[3][8];
int counts[] = {4, 5, 6};
char *names[] = {"ab", "cde"};
int grid[2][2] = {{1, 2}, {3, 4}};
char greeting[] = "hi";
int main() {
  int local[3] = {1, 2};
  int *p = counts;
  char *s = "hello";
  char buf[16];
  int x = 5;
  int *q = &x;
  strcpy(table[1], "row");
  strcpy(buf, "ab");
  strcat(buf, "cd");
  *q = 6;
  p++;
  printf("%s %d %d %d %s ", table[1], counts[2], *p, *(p + 1), names[1]);
  printf("%d %d %d %s %d ", grid[1][0], local[2], x, greeting, (int)strlen(s));
  printf("%s %c %d %d ", buf, s[1], strcmp("a", "b"), strcmp("b", "a"));
  printf("%d %d %d ", strcmp("a", "a"), strncmp("abc", "abd", 2), (int)(q == &x));
  printf("%d %d %d ", (int)sizeof(int), (int)sizeof(counts), (int)(sizeof(counts) / sizeof(counts[0])));
  printf("%s %d ", strchr(s, 'l'), strchr(s, 'z') == NULL);
  printf("%s %d %d ", strstr(s, "ll"), atoi("42x"), abs(-3));
  printf("%.1f", atof("2.5"));
  return 0;
}`);
    expect(stdout).toBe('row 6 5 6 cde 3 0 6 hi 5 abcd e -1 1 0 0 1 4 12 3 llo 1 llo 42 3 2.5');
  });

  it('copes with more of the library', () => {
    const { stdout, stderr } = runC(String.raw`
int main() {
  char buf[32];
  char *copy = strdup("dup");
  char *mem = (char *)malloc(8);
  int *nums = (int *)calloc(2, sizeof(int));
  sprintf(buf, "%d-%s", 7, copy);
  puts(buf);
  fputs("x", stdout);
  putchar('y');
  putc('z', stdout);
  fputc('!', stderr);
  fprintf(stderr, "%s", "err");
  strncpy(mem, "abc", 2);
  mem[2] = '\0';
  nums[1] = 9;
  printf(" %s %d", mem, nums[1]);
  free(mem);
  printf(" %d%d%d%d%d%d%d%d", isdigit('5'), isalpha('5'), isalnum('a'), isspace(' '),
    isupper('a'), islower('a'), ispunct('!'), isxdigit('f'));
  printf(" %c%c", toupper('a'), tolower('Q'));
  exit(3);
  return 0;
}`);
    expect(stdout).toBe('7-dup\nxyz ab 9 10110111 Aq');
    expect(stderr).toBe('!err');
  });

  it('reads stdin through getchar', () => {
    const { stdout } = runC(
      String.raw`
int main() {
  int c, n = 0;
  while ((c = getchar()) != EOF) n++;
  printf("%d", n);
  return 0;
}`,
      'abc',
    );
    expect(stdout).toBe('3');
  });

  it('formats printf like C', () => {
    const { stdout } = runC(String.raw`
int main() {
  printf("[%5d][%-5d][%05d][%+d][% d]", 42, 42, 42, 42, 42);
  printf("[%x][%X][%o][%#x][%u]", 255, 255, 8, 255, 5);
  printf("[%c][%3c][%-3c]", 'a', 'b', 'c');
  printf("[%s][%5s][%-5s][%.2s]", "hi", "hi", "hi", "hello");
  printf("[%f][%.2f][%8.3f][%e][%E]", 1.5, 1.5, 1.5, 1500.0, 0.015);
  printf("[%g][%g][%g][%g]", 100000.0, 1000000.0, 0.0001, 0.00001);
  printf("[%*d][%%][%.3d]", 4, 7, 5);
  return 0;
}`);
    expect(stdout).toBe(
      '[   42][42   ][00042][+42][ 42]' +
        '[ff][FF][10][0xff][5]' +
        '[a][  b][c  ]' +
        '[hi][   hi][hi   ][he]' +
        '[1.500000][1.50][   1.500][1.500000e+03][1.500000E-02]' +
        '[100000][1e+06][0.0001][1e-05]' +
        '[   7][%][005]',
    );
  });

  it('accepts old-style main and comments', () => {
    const source = '%%\n. ;\n%%\n/* c */ main() { // old C\n printf("ok"); }\n';
    expect(run(source).stdout).toBe('ok');
  });

  it('passes argc and argv to a two-argument main', () => {
    const { stdout } = runC(
      'int main(int argc, char **argv) { printf("%d %s", argc, argv[0]); return 0; }',
    );
    expect(stdout).toBe('1 program');
  });
});

describe('runtime mistakes are explained, not crashes', () => {
  it.each([
    ['division by zero', 'int main() { int z = 0; return 1 / z; }', 'divides by zero'],
    ['modulo by zero', 'int main() { int z = 0; return 1 % z; }', 'divides by zero'],
    ['a null pointer', 'int main() { int *p = 0; return *p; }', 'null pointer'],
    ['a null pointer write', 'int main() { int *p = 0; *p = 1; return 0; }', 'null pointer'],
    ['a null index', 'int main() { char *p = 0; return p[1]; }', 'null pointer'],
    ['an index past the end', 'int main() { int a[2]; return a[2]; }', 'position 2'],
    ['a write past the end', 'int main() { int a[2]; a[5] = 1; return 0; }', 'position 5'],
    ['an undeclared variable', 'int main() { return nope; }', 'not declared'],
    ['an assignment to undeclared', 'int main() { nope = 1; return 0; }', 'not declared'],
    ['an unknown function', 'int main() { fopen("a", "r"); return 0; }', 'no function named'],
    [
      'endless recursion',
      'int f(int n) { return f(n + 1); } int main() { return f(0); }',
      'levels deep',
    ],
    [
      'a wrong argument count',
      'int f(int a) { return a; } int main() { return f(); }',
      'takes 1 argument',
    ],
    ['too many conversions', 'int main() { printf("%d %d", 1); return 0; }', 'more % conversions'],
    [
      'an unterminated string',
      'int main() { char s[2]; s[0] = 1; s[1] = 1; printf("%s", s); return 0; }',
      'terminating zero',
    ],
    ['an overflowing strcpy', 'int main() { char s[2]; strcpy(s, "long"); return 0; }', 'overrun'],
    ['an array assignment', 'int a[2]; int main() { a = 0; return 0; }', 'cannot be assigned'],
    ['a void variable', 'int main() { void v; return 0; }', 'type void'],
    ['too much memory', 'int main() { int a[100000000]; return 0; }', 'more memory'],
    ['writing to a file', 'int main() { fprintf(5, "x"); return 0; }', 'stdout and stderr'],
    [
      'a pointer as a number',
      'int main() { char *s = "a"; return s * 2; }',
      'does not work on a pointer',
    ],
    ['a decimal in a pointer', 'int main() { int *p; p = 1.5; return 0; }', 'decimal'],
    [
      'a bad percent operand',
      'int main() { double d = 1.5; d = d % 2; return 0; }',
      'whole numbers',
    ],
    ['a list on a scalar', 'int main() { int x = {1}; return x; }', 'not an array'],
    [
      'an oversized initializer',
      'int a[1] = {1, 2}; int main() { return 0; }',
      'more initial values',
    ],
    ['text too long for an array', 'char a[1] = "long"; int main() { return 0; }', 'does not fit'],
    ['an array with no size', 'int a[]; int main() { return 0; }', 'needs a size'],
    ['an array of size zero', 'int a[0]; int main() { return 0; }', 'at least 1'],
    [
      'comparing a pointer with a number',
      'int main() { char *s = "a"; return s == 5; }',
      'compared with',
    ],
    ['unrelated pointers', 'int a[1]; int b[1]; int main() { return a < b; }', 'different arrays'],
    ['a bad cast use', 'int main() { return &5 == 0; }', 'no address'],
    ['assigning to a value', 'int main() { 1 = 2; return 0; }', 'cannot be assigned'],
    ['a bad start condition', '%%BEGIN', 'BEGIN set start condition'],
  ])('%s', (_name, body, expected) => {
    const source = body === '%%BEGIN' ? '%%\na BEGIN(9);\nb ;\n' : `%%\n. ;\n%%\n${body}\n`;
    const info = errorOf(() => run(source, body === '%%BEGIN' ? 'ab' : ''));
    expect(info.code).toBe('c_runtime');
    expect(info.message).toContain(expected);
  });

  it('points at the line with the mistake', () => {
    const source = '%%\n. ;\n%%\nint main() {\n  int z = 0;\n  return 1 / z;\n}\n';
    const info = errorOf(() => run(source));
    expect(locateOffset(source, info.position as number)).toEqual({ line: 6, column: 12 });
  });
});

describe('mistakes in the file are explained with a location', () => {
  it.each([
    ['no rules section', 'DIGIT [0-9]\n', 'flex_missing_rules'],
    ['no rules', '%%\n', 'flex_no_rules'],
    ['an unclosed code block', '%{\nint x;\n%%\na ;\n', 'flex_unclosed_code'],
    ['an unclosed comment', '/* never\n%%\na ;\n', 'flex_unclosed_comment'],
    ['an unknown directive', '%frob\n%%\na ;\n', 'flex_unknown_directive'],
    ['a line that is not a definition', 'lonely\n%%\na ;\n', 'flex_bad_definition'],
    ['a bad condition name', '%x 9bad\n%%\na ;\n', 'flex_bad_condition'],
    ['an unclosed condition list', '%%\n<A a ;\n', 'flex_bad_condition_list'],
    ['an unclosed scope', '%x A\n%%\n<A>{\na ;\n', 'flex_unclosed_scope'],
    ['an unclosed action', '%%\na { b;\n', 'flex_unclosed_action'],
    ['an unclosed action string', '%%\na printf("x);\n', 'flex_unclosed_literal'],
    ['an unclosed action comment', '%%\na /* x\n', 'flex_unclosed_comment'],
    ['a final | action', '%%\na |\n', 'flex_bad_fallthrough'],
    ['an undefined name', '%%\n{NOPE} ;\n', 'flex_undefined_name'],
    ['a bad brace', '%%\n{ ;\n', 'flex_bad_name'],
    ['a stray close paren', '%%\na) ;\n', 'flex_unmatched_paren'],
    ['an unclosed paren', '%%\n(a ;\n', 'flex_unclosed_paren'],
    ['an empty alternative', '%%\na| ;\n', 'flex_empty_pattern'],
    ['nothing to repeat', '%%\n* ;\n', 'flex_nothing_to_repeat'],
    ['a bad repeat', '%%\na{2 ;\n', 'flex_bad_repeat'],
    ['a backwards repeat', '%%\na{3,2} ;\n', 'flex_bad_repeat'],
    ['a zero repeat', '%%\na{0} ;\n', 'flex_bad_repeat'],
    ['a huge repeat', '%%\na{999} ;\n', 'flex_repeat_too_big'],
    ['an unclosed quote', '%%\n"a ;\n', 'flex_unclosed_quote'],
    ['an empty quote', '%%\n"" ;\n', 'flex_empty_quote'],
    ['an unclosed class', '%%\n[a ;\n', 'flex_unclosed_class'],
    ['a backwards range', '%%\n[z-a] ;\n', 'flex_reversed_range'],
    ['an unknown class name', '%%\n[[:nope:]] ;\n', 'flex_bad_class_name'],
    ['non-ASCII in a class', '%%\n[é] ;\n', 'flex_non_ascii_class'],
    ['a pattern option', '%%\n(?i:a) ;\n', 'flex_unsupported'],
    ['a trailing backslash', '%%\na\\', 'flex_trailing_backslash'],
    ['a struct', '%{\nstruct p { int x; };\n%}\n%%\na ;\n', 'c_unsupported'],
    ['a typedef', '%{\ntypedef int t;\n%}\n%%\na ;\n', 'c_unsupported'],
    ['a function pointer', '%{\nint (*f)(void);\n%}\n%%\na ;\n', 'c_unsupported'],
    ['struct fields', '%%\na x.y = 1;\n', 'c_unsupported'],
    ['goto', '%%\na goto end;\n', 'c_unsupported'],
    ['a macro with arguments', '%{\n#define F(x) x\n%}\n%%\na ;\n', 'c_unsupported'],
    ['an #if', '%{\n#if 1\n#endif\n%}\n%%\na ;\n', 'c_unsupported'],
    ['variable arguments', '%%\na ;\n%%\nint f(int a, ...) { return 0; }\n', 'c_unsupported'],
    ['a #define with no name', '%{\n#define\n%}\n%%\na ;\n', 'c_bad_define'],
    ['a bad octal number', '%%\na x = 09;\n', 'c_bad_number'],
    ['an empty char', "%%\na x = '';\n", 'c_empty_char'],
    ['a missing semicolon', '%%\na { x = 1 }\n', 'c_syntax'],
    ['a stray brace in an action', '%%\na x = 1; }\n', 'c_syntax'],
    ['a stray symbol', '%%\na x = @;\n', 'c_bad_character'],
    ['code outside a function', '%%\na ;\n%%\nx = 1;\n', 'c_syntax'],
    [
      'a function defined twice',
      '%%\na ;\n%%\nint f() { return 0; }\nint f() { return 1; }\n',
      'c_syntax',
    ],
  ])('%s', (_name, source, code) => {
    const info = errorOf(() => compileScanner(source));
    expect(info.code).toBe(code);
    expect(info.message.length).toBeGreaterThan(5);
  });

  it('points a missing semicolon at the end of the statement', () => {
    const source = '%%\na {\n  x = 1\n  y = 2;\n}\n';
    const info = errorOf(() => compileScanner(source));
    expect(locateOffset(source, info.position as number).line).toBe(3);
    expect(info.hint).toContain('semicolon');
  });

  it('survives absurdly deep nesting', () => {
    const deep = `${'('.repeat(200_000)}1${')'.repeat(200_000)}`;
    expect(errorOf(() => compileScanner(`%%\na x = ${deep};\n`)).code).toBe('c_too_deep');
  });
});

describe('reading a flex file', () => {
  it('finds its sections and handles comments, indented code and options', () => {
    const source = String.raw`/* a comment */
%option noyywrap yylineno
%array
  int indented = 1;
D   [0-9]
%%
  /* an indented comment */
  // another
  int local = 2;
{D}+   printf("n");
%%
int helper(void) { return 1; }
`;
    const file = parseFlexFile(source);
    expect([...file.options]).toEqual(['noyywrap', 'yylineno']);
    expect(file.definitions.get('D')).toBe('[0-9]');
    expect(file.declarations).toHaveLength(1);
    expect(file.localCode).toHaveLength(1);
    expect(file.rules[0]?.line).toBe(10);
    expect(file.rules[0]?.text).toBe('{D}+');
    expect(file.userCode).not.toBeNull();
  });

  it('copes with CRLF line endings', () => {
    const source = '%option noyywrap\r\nD [0-9]\r\n%%\r\n{D}+ printf("n");\r\n. ;\r\n';
    expect(run(source, '1a').stdout).toBe('n');
  });

  it('reads braces, strings and comments in actions without being fooled', () => {
    const source = String.raw`%%
a   { if (1) { printf("}"); } /* } */ // }
      printf("'"); }
b   printf("{");
`;
    expect(run(source, 'ab').stdout).toBe("}'{");
  });

  it('finds an action with no terminating newline', () => {
    expect(run('%%\na printf("x");', 'a').stdout).toBe('x');
  });
});

describe('text as bytes', () => {
  it('round-trips every kind of character', () => {
    const text = 'aé€😀';
    const decoder = new Utf8Decoder();
    expect(decoder.write(utf8Bytes(text)) + decoder.flush()).toBe(text);
  });

  it('holds back a character split across writes', () => {
    const decoder = new Utf8Decoder();
    const bytes = utf8Bytes('€');
    expect(decoder.write(bytes.slice(0, 1))).toBe('');
    expect(decoder.write(bytes.slice(1))).toBe('€');
  });

  it('replaces invalid bytes instead of failing', () => {
    const decoder = new Utf8Decoder();
    expect(decoder.write([0xff, 0x61])).toBe('�a');
    expect(decoder.write([0xe2, 0x61, 0x62])).toBe('�ab');
    expect(decoder.write([0xe2])).toBe('');
    expect(decoder.flush()).toBe('�');
    expect(decoder.flush()).toBe('');
  });
});

describe('flexToPlayground', () => {
  it('turns rules into the visualizer format', () => {
    const file = parseFlexFile(String.raw`D [0-9]
%%
{D}+      return NUM;
[a-z]+    return ID;
[ \t\n]+  ;
"//".*    { /* nothing */ }
if        return ID;
`);
    const { rules, omitted } = flexToPlayground(file);
    expect(omitted).toEqual([]);
    expect(rules).toBe(
      [
        'NUM  ([0-9])+',
        'ID  [a-z]+',
        'RULE_5  [ \\t\\n]+  %skip',
        'RULE_6  "//".*  %skip',
        'ID_2  if',
      ].join('\n'),
    );
  });

  it('says which rules it left out and why', () => {
    const file = parseFlexFile(String.raw`%x C
%%
<C>a       ;
^b         ;
c/d        ;
e{2}       ;
[[:alpha:]] ;
\x41       ;
ε          ;
f*         ;
<<EOF>>    ;
g          ;
`);
    const { rules, omitted } = flexToPlayground(file);
    expect(rules).toBe('RULE_12  g  %skip');
    expect(omitted.join(' ')).toMatch(/line 3 uses a start condition/);
    expect(omitted.join(' ')).toMatch(/line 4 only matches at the start/);
    expect(omitted.join(' ')).toMatch(/line 5 uses trailing context/);
    expect(omitted.join(' ')).toMatch(/line 6 uses a repeat count/);
    expect(omitted.join(' ')).toMatch(/line 7 uses a named/);
    expect(omitted.join(' ')).toMatch(/line 8 uses a numeric/);
    expect(omitted.join(' ')).toMatch(/line 9 uses non-ASCII/);
    expect(omitted.join(' ')).toMatch(/line 10 is too complex/);
    expect(omitted.join(' ')).toMatch(/line 11 is an end-of-file/);
  });

  it('gives null rules when nothing can be shown', () => {
    expect(flexToPlayground(parseFlexFile('%%\n^a ;\n')).rules).toBeNull();
  });
});
