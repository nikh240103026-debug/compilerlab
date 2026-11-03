import { describe, expect, it } from 'vitest';
import { EngineError } from '../core/result';
import { Utf8Decoder } from '../flex/bytes';
import { compileScanner, runScanner } from '../flex/simulate';

function run(source: string, stdin = '') {
  const decoder = new Utf8Decoder();
  let stdout = '';
  const steps = runScanner(compileScanner(source), stdin, {
    write: (stream, bytes) => {
      if (stream === 'stdout') stdout += decoder.write(bytes);
    },
  });
  // A bug here must fail the test, not hang the whole run.
  let state = steps.next();
  for (let count = 0; !state.done; count++) {
    if (count > 20_000_000) throw new Error('This program never finished.');
    state = steps.next();
  }
  return { stdout, exit: state.value };
}

const program = (body: string) => `%%\n.|\\n ;\n%%\n${body}\n`;
const inMain = (body: string) => program(`int main() {\n${body}\nreturn 0;\n}`);
const output = (body: string, stdin = '') => run(inMain(body), stdin).stdout;

function failure(source: string, stdin = ''): EngineError['info'] {
  try {
    run(source, stdin);
  } catch (error) {
    if (error instanceof EngineError) return error.info;
    throw error;
  }
  throw new Error('Expected this to fail.');
}

/** Each of these is the answer real C gives. */
describe('C expressions', () => {
  it.each([
    [
      'comparing doubles',
      'double a = 1.5, b = 2.5; printf("%d%d%d%d%d%d", a == 1.5, a != b, a < b, a > b, a <= b, a >= b);',
      '111010',
    ],
    [
      'double arithmetic',
      'double a = 1.5, b = 2.5; printf("%.1f %.1f %.2f %.2f", a + b, b - a, a * b, b / a);',
      '4.0 1.0 3.75 1.67',
    ],
    [
      'unary on doubles',
      'double a = 1.5; printf("%.1f %.1f %d %d", -a, +a, !a, !0.0);',
      '-1.5 1.5 0 1',
    ],
    [
      'doubles as conditions',
      'double z = 0.0; if (z) printf("t"); else printf("f"); if (0.5) printf("t");',
      'ft',
    ],
    [
      'mixing int and double',
      'int i = 3; double d = 2; printf("%.1f %.1f", i / d, d + i);',
      '1.5 5.0',
    ],
    [
      'comparing ints',
      'printf("%d%d%d%d%d%d", 1 == 1, 1 != 1, 2 < 1, 2 > 1, 1 <= 1, 1 >= 2);',
      '100110',
    ],
    ['negative remainder', 'printf("%d %d %d", -7 % 3, 7 % -3, -7 / 2);', '-1 1 -3'],
    [
      'compound assignment',
      'int x = 5; x += 2; x -= 1; x *= 4; x /= 3; x %= 5; printf("%d ", x); x = 6; x &= 3; x |= 8; x ^= 1; x <<= 2; x >>= 1; printf("%d", x);',
      '3 22',
    ],
    [
      'compound assignment on doubles',
      'double d = 1; d += 0.5; d *= 2; d -= 1; d /= 4; printf("%.2f", d);',
      '0.50',
    ],
    [
      'prefix and postfix',
      'int i = 5; printf("%d ", i++); printf("%d ", i); printf("%d ", ++i); printf("%d ", i--); printf("%d", --i);',
      '5 6 7 7 5',
    ],
    [
      'stepping a double and a char',
      'double d = 1; char c = 97; d++; c++; printf("%.1f %c", d, c);',
      '2.0 b',
    ],
    [
      'short-circuit evaluation',
      'printf("%d%d%d%d", 1 || nope, 0 && nope, 0 || 0, 1 && 1);',
      '1001',
    ],
    [
      'the ternary operator',
      'int a = 2; printf("%d %d", a > 1 ? 10 : 20, a > 5 ? 10 : 20);',
      '10 20',
    ],
    [
      'casting',
      'printf("%d %d %d %.1f %ld %d", (char)321, (unsigned char)300, (short)70000, (float)1 / 2, (long)1.9, (int)-1.9);',
      '65 44 4464 0.5 1 -1',
    ],
    ['casting to void', 'int x = 1; (void)x; printf("%d", (x));', '1'],
    ['unsigned wrap', 'unsigned u = 0; u--; printf("%u", u);', '4294967295'],
    ['bit negation', 'printf("%d", ~5);', '-6'],
    [
      'hex, octal, suffixes and floats',
      'printf("%d %d %ld %u %.2f %.1f %.1f", 0x1F, 010, 10L, 7u, .5, 1e3, 1.5e1f);',
      '31 8 10 7 0.50 1000.0 15.0',
    ],
    [
      'character escapes',
      `printf("%d %d %d %d %d %d", '\\n', '\\t', '\\\\', '\\'', '\\x41', '\\101');`,
      '10 9 92 39 65 65',
    ],
    ['string escapes and joining', `printf("%s", "A\\x42\\103" "D\\t" "\\"q\\"");`, 'ABCD\t"q"'],
    [
      'sizeof',
      'char s[5]; int a[3]; printf("%d %d %d %d %d %d %d %d", (int)sizeof(char), (int)sizeof(long), (int)sizeof(double), (int)sizeof(char *), (int)sizeof "abc", (int)sizeof s, (int)sizeof(a), (int)sizeof(a[0]));',
      '1 8 8 8 4 5 12 4',
    ],
    ['sizeof of an unusual expression', 'int x = 1; printf("%d", (int)sizeof(x + 1));', '4'],
  ])('%s', (_name, body, expected) => {
    expect(output(body)).toBe(expected);
  });
});

describe('C pointers', () => {
  it.each([
    [
      'comparing',
      'int a[4]; int *p = a, *q = a + 2; printf("%d%d%d%d%d%d %d", p < q, p > q, p <= q, p >= q, p == q, p != q, (int)(q - p));',
      '101001 2',
    ],
    [
      'pointer math in both orders',
      'int a[3] = {10, 20, 30}; int *p = a; int *q = a + 2; printf("%d %d", *(1 + p), *(q - 1));',
      '20 20',
    ],
    [
      'null checks',
      'int a[1]; int *p = a; int *n = NULL; printf("%d%d%d%d %d", p != 0, 0 == p, p == NULL, 0 != p, n == 0);',
      '1001 1',
    ],
    [
      'stepping',
      'int a[3] = {1, 2, 3}; int *p = a; p++; ++p; p--; printf("%d %d", *p, *p++);',
      '2 2',
    ],
    [
      'writing through',
      'int a[2]; int *q = &a[1]; *q = 7; *(a) = 8; printf("%d %d", a[1], a[0]);',
      '7 8',
    ],
    ['pointer to pointer', 'int x = 3; int *p = &x; int **pp = &p; printf("%d", **pp);', '3'],
    ['address of an array', 'int a[2] = {4, 5}; int *p = &a; printf("%d", p[1]);', '5'],
    ['address of a deref', 'int a[2] = {4, 5}; int *p = &*a; printf("%d", *p);', '4'],
    [
      'walking a string',
      'char *s = "abc"; int n = 0; while (*s) { n++; s++; } printf("%d", n);',
      '3',
    ],
    [
      'arrays of strings',
      'char w[2][4] = {"ab", "cd"}; printf("%s%s%c", w[0], w[1], w[1][1]);',
      'abcdd',
    ],
    [
      'a string that exactly fills its array',
      'char t[2] = "ab"; printf("%c%c", t[0], t[1]);',
      'ab',
    ],
    [
      '%d and %f given other kinds',
      'int a[2]; printf("%d %.1f %d", 2.9, 2, (int)(&a[1] - a));',
      '2 2.0 1',
    ],
    ['%d given a pointer shows something, not a crash', 'int a[2]; printf("%d", a);', '0'],
    ['%p', 'int a[1]; printf("%p %p", a, 0);', '0x1000 (nil)'],
    [
      'a cast tags the pointer',
      'int *n = (int *)malloc(8); n[1] = 300; printf("%d", n[1]);',
      '300',
    ],
    ['a void pointer keeps its element type', 'char *s = "x"; void *v = s; printf("%s", v);', 'x'],
  ])('%s', (_name, body, expected) => {
    expect(output(body)).toBe(expected);
  });
});

describe('C statements', () => {
  it.each([
    ['if with no else', 'if (0) printf("no"); printf("yes");', 'yes'],
    ['return from inside each loop', 'printf("%d%d%d%d%d", w(), d(), f(), s(), n());', '12345'],
    [
      'break and continue in a do loop',
      'int i = 0; do { i++; if (i == 1) continue; if (i == 3) break; } while (i < 9); printf("%d", i);',
      '3',
    ],
    [
      'a for loop with nothing in its header',
      'int i = 0; for (;;) { if (++i > 2) break; } printf("%d", i);',
      '3',
    ],
    ['a for loop with no update', 'int i = 0; for (i = 0; i < 2; ) i++; printf("%d", i);', '2'],
    [
      'continue in a switch inside a loop',
      'int i, n = 0; for (i = 0; i < 3; i++) { switch (i) { case 1: continue; default: n += 10; } n++; } printf("%d", n);',
      '22',
    ],
    [
      'a switch with no match and no default',
      'switch (9) { case 1: printf("no"); } printf("end");',
      'end',
    ],
    [
      'default in the middle of a switch',
      'switch (2) { default: printf("d"); case 1: printf("1"); break; case 3: printf("3"); } ',
      'd1',
    ],
    [
      'a case that declares a variable',
      'switch (1) { case 1: { int y = 4; printf("%d", y); } }',
      '4',
    ],
    ['blocks and shadowing', 'int x = 1; { int x = 2; printf("%d", x); } printf("%d", x);', '21'],
    ['a for scope that declares its variable', 'for (int k = 1; k < 2; k++) printf("%d", k);', '1'],
    ['empty statements', ';;; printf("ok");', 'ok'],
    [
      'local enums, named and not',
      'enum { A = 5, B }; enum color { RED, GREEN } c = GREEN; enum color d; printf("%d %d %d %d", A, B, c, d);',
      '5 6 1 0',
    ],
    ['a lone enum declaration', 'enum { X = 3 }; printf("%d", X);', '3'],
    [
      'all the qualifiers',
      'const char *const s = "a"; static int n = 1; register int r = 2; signed int v = 3; long long l = 4; short h = 5; float f = 6; volatile int w = 7; printf("%s%d%d%d%ld%d%.0f%d", s, n, r, v, l, h, f, w);',
      'a1234567',
    ],
    ['bool and size_t', 'bool b = true; size_t n = 3; printf("%d%d%d", b, false, (int)n);', '103'],
  ])('%s', (_name, body, expected) => {
    const helpers = `
int w() { while (1) return 1; return 0; }
int d() { do return 2; while (1); return 0; }
int f() { for (;;) return 3; return 0; }
int s() { switch (1) { case 1: return 4; } return 0; }
int n() { if (1) { return 5; } return 0; }
`;
    expect(run(program(`${helpers}int main() {\n${body}\nreturn 0;\n}`)).stdout).toBe(expected);
  });
});

describe('C at the top level', () => {
  it('handles prototypes, globals, unnamed parameters and array parameters', () => {
    const source = program(String.raw`
int helper(int, char *);
double half(int n);
char *name(void);
void nothing(void) { return; }
int silent(void) { }
;
int total = 2;
enum { LIMIT = 3 };
enum shade { DARK };
int sum(int a[], int n) { int i, s = 0; for (i = 0; i < n; i++) s += a[i]; return s; }
int helper(int n, char *s) { return n + (int)strlen(s); }
double half(int n) { return n / 2.0; }
char *name(void) { return "cl"; }
int main() {
  int a[3] = {1, 2, 3};
  nothing();
  printf("%d %d %.1f %s %d %d %d", sum(a, 3), helper(1, "ab"), half(3), name(), silent(), total, LIMIT);
  return DARK;
}`);
    expect(run(source)).toEqual({ stdout: '6 3 1.5 cl 0 2 3', exit: 0 });
  });

  it('handles the preprocessor lines it knows', () => {
    const source = String.raw`%{
#include <stdio.h>
#pragma once
#define SIZE 3
#define LONG_ONE \
  (SIZE + 1)
#define GONE 1
#undef GONE
int GONE = 8;
%}
%%
. ;
%%
int main(void) { printf("%d %d %d", SIZE, LONG_ONE, GONE); return 0; }
`;
    expect(run(source).stdout).toBe('3 4 8');
  });

  it('returns the exit code from main', () => {
    expect(run(program('int main() { return 4; }')).exit).toBe(4);
    expect(run(program('int main() { exit(5); }')).exit).toBe(5);
  });
});

describe('the C library', () => {
  it.each([
    ['strcmp on prefixes', 'printf("%d %d", strcmp("ab", "abc"), strcmp("abc", "ab"));', '-1 1'],
    [
      'strchr finding the terminator',
      'char *s = "ab"; printf("%d", (int)strlen(strchr(s, 0)));',
      '0',
    ],
    ['strstr finding nothing', 'printf("%d", strstr("abc", "z") == NULL);', '1'],
    [
      'strncpy padding with zeros',
      'char b[4]; b[3] = 65; strncpy(b, "x", 3); printf("%s %d %d", b, b[1], b[3]);',
      'x 0 65',
    ],
    [
      'malloc and calloc of nothing',
      'printf("%d %d", malloc(0) == NULL, calloc(0, 4) == NULL);',
      '1 1',
    ],
    ['free of nothing', 'free(NULL); printf("ok");', 'ok'],
    [
      'atoi and atof on bad text',
      'printf("%d %.1f %d", atoi("x"), atof("x"), atoi("-12"));',
      '0 0.0 -12',
    ],
    [
      'character classes',
      `printf("%d%d%d%d", isalnum('_'), isalnum('9'), isspace('\\t'), isspace('x'));`,
      '0110',
    ],
    ['case changes that do nothing', `printf("%c%c", toupper('A'), tolower('a'));`, 'Aa'],
    [
      'sprintf overrun protection works on enough room',
      'char b[8]; int n = sprintf(b, "%d", 123); printf("%s %d", b, n);',
      '123 3',
    ],
    ['printf returns the count', 'int n = printf("abc"); printf("%d", n);', 'abc3'],
    ['getchar at the end of input', 'printf("%d", getchar());', '-1'],
  ])('%s', (_name, body, expected) => {
    expect(output(body)).toBe(expected);
  });
});

describe('printf', () => {
  it.each([
    ['negative numbers with zero padding', '[%05d]', '-42', '[-0042]'],
    ['hex of a negative int', '[%x]', '-1', '[ffffffff]'],
    ['octal, with and without a prefix', '[%o %#o]', '8, 8', '[10 010]'],
    ['upper-case hex prefix', '[%#X]', '255', '[0XFF]'],
    ['precision on hex and zero', '[%.3x %#x]', '10, 0', '[00a 0]'],
    ['zero padding on hex', '[%04x]', '10', '[000a]'],
    ['a negative star width', '[%*d]', '-4, 7', '[7   ]'],
    ['precision from a star', '[%.*f]', '1, 2.55', '[2.5]'],
    [
      'an exact tie rounds to even',
      '[%.f %.f %.1f %.2f]',
      '2.5, 3.5, 0.25, 1.125',
      '[2 4 0.2 1.12]',
    ],
    ['a value that is not a tie rounds normally', '[%.f %.1f]', '2.6, 0.26', '[3 0.3]'],
    ['ties in the other formats', '[%.0e %.1e %.1g]', '2.5, 1.25, 0.25', '[2e+00 1.2e+00 0.2]'],
    ['huge values', '[%.0f]', '1e22', '[10000000000000000000000]'],
    ['zero padded decimals', '[%06.2f]', '1.5', '[001.50]'],
    ['a plus sign on decimals', '[%+.1f]', '1.5', '[+1.5]'],
    ['%g of zero and small precision', '[%g %.1g %.0g]', '0.0, 123.0, 7.0', '[0 1e+02 7]'],
    ['upper-case %G and %F', '[%G %.1F]', '0.00001, 1.5', '[1E-05 1.5]'],
    ['infinity', '[%f %f %F %5f]', '1.0 / 0, -1.0 / 0, 1.0 / 0, 1.0 / 0', '[inf -inf INF   inf]'],
    ['negative zero', '[%.1f]', '-0.0', '[-0.0]'],
    ['an unknown conversion prints as written', '[%q]', '0', '[%q]'],
    ['long and short length modifiers', '[%ld %hd %lu %lld]', '1, 2, 3, 4', '[1 2 3 4]'],
    ['a left-justified string and char', '[%-3s%-2c]', '"a", 98', '[a  b ]'],
  ])('%s', (_name, format, args, expected) => {
    expect(output(`printf("${format}", ${args});`)).toBe(expected);
  });

  it('prints a lone percent at the end', () => {
    expect(output('printf("100%");')).toBe('100%');
    expect(output('printf("100%l");')).toBe('100%');
  });

  it('caps absurd widths instead of running out of memory', () => {
    expect(output('printf("%999999999d", 1);').length).toBe(4096);
  });

  it('tells nan apart', () => {
    expect(output('double z = 0.0; printf("%f", z / z);')).toBe('nan');
    expect(output('double z = 0.0; printf("%G", z / z);')).toBe('NAN');
  });
});

describe('mistakes the interpreter explains', () => {
  it.each([
    ['printf with no format', 'printf();', 'format string'],
    ['%s given a number', 'printf("%s", 5);', 'not a pointer'],
    ['%s given null', 'printf("%s", 0);', 'null pointer'],
    ['strlen of null', 'strlen(NULL);', 'null pointer'],
    ['strcpy into null', 'strcpy(NULL, "x");', 'null pointer'],
    ['strncpy into null', 'strncpy(NULL, "x", 1);', 'null pointer'],
    ['strncpy past the end', 'char b[2]; strncpy(b, "abc", 3);', 'past the end'],
    ['sizeof of something undeclared', 'printf("%d", (int)sizeof(nope));', 'not declared'],
    ['sizeof of an undeclared array', 'printf("%d", (int)sizeof(nope[0]));', 'not declared'],
    ['the address of something undeclared', 'int *p = &nope;', 'not declared'],
    ['the address of a number', 'int *p = &5;', 'no address'],
    ['indexing a number', 'int x = 3; x[0] = 1;', 'not a pointer'],
    ['reading through a number', 'int x = 3; printf("%d", *x);', 'not a pointer'],
    ['a pointer where a number is needed', 'int a[1]; int x = 1; x = a;', 'whole number'],
    ['two pointers multiplied', 'int a[1]; printf("%d", a * a);', 'does not work on two'],
    ['a list as a value', 'int x; x = 1; printf("%d", x, {1});', 'Expected a value'],
    ['a string array with a number', 'char s[2] = 5;', 'initializer'],
    ['a 2-D array with too many rows', 'int g[1][1] = {{1}, {2}};', 'more initial values'],
    ['an assignment to a call', 'abs(1) = 2;', 'cannot be assigned'],
    ['a pointer shift', 'int a[1]; a << 1;', 'does not work on a pointer'],
    [
      'subtracting a pointer from a number',
      'int a[1]; printf("%d", 1 - a);',
      'does not work on a pointer',
    ],
    ['too many arguments', 'printf("%d", two(1, 2, 3));', 'takes 2 arguments'],
  ])('%s', (_name, body, expected) => {
    const info = failure(
      program(`int two(int a, int b) { return a + b; }\nint main() {\n${body}\nreturn 0;\n}`),
    );
    expect(info.message).toContain(expected);
  });

  it('refuses to run past the memory limit with malloc too', () => {
    const body = 'int i; for (i = 0; i < 100; i++) malloc(1000000);';
    expect(failure(inMain(body)).message).toContain('more memory');
    expect(failure(inMain('calloc(100000000, 1);')).message).toContain('more memory');
    expect(
      failure(inMain('int i; for (i = 0; i < 100; i++) strdup("x"); int a[9000000];')).message,
    ).toContain('more memory');
  });

  it('gives memory back when a scope ends or free is called', () => {
    const local =
      'void f(void) { int a[1000000]; a[0] = 1; }\nint main() { int i; for (i = 0; i < 20; i++) f(); printf("ok"); return 0; }';
    expect(run(program(local)).stdout).toBe('ok');
    const block = 'int i; for (i = 0; i < 20; i++) { int a[1000000]; a[0] = i; } printf("ok");';
    expect(output(block)).toBe('ok');
    const freed =
      'int i; for (i = 0; i < 20; i++) { char *p = malloc(1000000); free(p); } printf("ok");';
    expect(output(freed)).toBe('ok');
    const switched =
      'int i; for (i = 0; i < 20; i++) switch (1) { case 1: { int a[1000000]; a[0] = 1; } } printf("ok");';
    expect(output(switched)).toBe('ok');
  });
});

describe('mistakes the parser explains', () => {
  it.each([
    ['a missing variable name', 'int 3;', 'variable name'],
    ['a bad parameter', 'int f(3) { return 0; }', 'parameter type'],
    ['no function body', 'int f() 3', 'function body'],
    ['a function body never closed', 'int f() {', 'never closed'],
    ['a struct parameter', 'int f(struct p x) { return 0; }', 'struct types'],
    ['a struct cast', 'int f() { return (struct p *)0; }', 'struct types'],
    ['a union', 'union u { int a; };', 'union types'],
    ['a typedef inside a function', 'int f() { typedef int t; return 0; }', 'typedef types'],
    ['goto as a statement in a function', 'int f() { goto x; }', 'goto'],
    ['a call through a value', 'int f() { (g)(); g()(); return 0; }', 'function pointer'],
    ['a missing while', 'int f() { do { } 3; }', 'Expected "while"'],
    ['a never-closed switch', 'int f() { switch (1) { case 1:', 'never closed'],
    ['a stray close paren', 'int f() { return 1); }', 'Expected ";"'],
    ['a missing close paren', 'int f() { return (1; }', 'Expected ")"'],
    ['a missing colon', 'int f() { return 1 ? 2; }', 'Expected ":"'],
    ['nothing after an operator', 'int f() { return 1 + ; }', 'Expected a value'],
    ['the end of the code', 'int x =', 'the end of the code'],
    ['a stray keyword after a type', 'int if', 'Expected ";"'],
  ])('%s', (_name, code, expected) => {
    expect(failure(`%%\na ;\n%%\n${code}\n`).message).toContain(expected);
  });

  it('suggests the missing character', () => {
    expect(failure('%%\na ;\n%%\nint f() { return (1; }\n').hint).toContain('Add the missing ")"');
  });
});

describe('mistakes the tokenizer explains', () => {
  it.each([
    ['an unclosed comment in user code', '%%\na ;\n%%\n/* never', 'c_unclosed_comment'],
    ['an unclosed string in user code', '%%\na ;\n%%\nchar *s = "never', 'c_unclosed_string'],
    ['a string broken across lines', '%%\na ;\n%%\nchar *s = "ab\ncd";', 'c_unclosed_string'],
    ['an unclosed character', "%%\na ;\n%%\nchar c = 'a", 'c_unclosed_char'],
    ['a character at the end', "%%\na ;\n%%\nchar c = '", 'c_unclosed_char'],
    ['two characters in single quotes', "%%\na ;\n%%\nchar c = 'ab';", 'c_unclosed_char'],
    ['a # with nothing after it', '%{\n#\n%}\n%%\na ;\n', 'c_unsupported'],
    ['a stray backtick', '%%\na ;\n%%\nint x = `;', 'c_bad_character'],
  ])('%s', (_name, source, code) => {
    expect(failure(source).code).toBe(code);
  });
});

describe('scanner corners', () => {
  it('treats a rule that matches nothing as no match', () => {
    expect(run('%%\nx* printf("[%s]", yytext);\n', 'axx').stdout).toBe('a[xx]');
  });

  it('handles trailing context with a pattern that may be empty', () => {
    expect(run('%%\na*/b printf("[%s]", yytext);\n. ECHO;\n', 'aab').stdout).toBe('[aa]b');
    expect(run('%%\na/b* printf("[%s]", yytext);\n', 'a').stdout).toBe('[a]');
    expect(run('%%\n(a|ab)/b printf("[%s]", yytext);\n. ECHO;\n', 'abb').stdout).toBe('[ab]b');
  });

  it('keeps line numbers right through input, unput, yyless and the default rule', () => {
    const source = String.raw`%option yylineno
%%
a   { input(); printf("%d ", yylineno); }
b   { unput('\n'); printf("%d ", yylineno); }
c\nc { yyless(1); printf("%d ", yylineno); }
d   { printf("%d ", yylineno); }
`;
    expect(run(source, 'a\nd').stdout).toBe('2 2 ');
    expect(run(source, 'bd').stdout).toContain('0 ');
    expect(run(source, 'c\nc').stdout).toContain('1 ');
    expect(run(source, '\nd').stdout).toBe('\n2 ');
  });

  it('returns 0 from input at the end of the text', () => {
    expect(run('%%\na { printf("%d", input()); }\n', 'a').stdout).toBe('0');
  });

  it('lets unput add text before anything has been read', () => {
    const source = String.raw`%%
x printf("X");
%%
int main(void) { unput('x'); yylex(); return 0; }
`;
    expect(run(source).stdout).toBe('X');
  });

  it('rejects a yyless that is out of range', () => {
    expect(failure('%%\na yyless(5);\n', 'a').code).toBe('c_runtime');
  });

  it('lets a local block return from yylex', () => {
    expect(run('%%\n%{\nreturn 0;\n%}\na printf("never");\n', 'a').stdout).toBe('');
  });

  it('runs an EOF rule that returns a value', () => {
    const source = String.raw`%%
<<EOF>> { printf("end"); return 3; }
. ;
%%
int main(void) { printf("%d", yylex()); return 0; }
`;
    expect(run(source, 'x').stdout).toBe('end3');
  });

  it('asks yywrap again when it returns 0', () => {
    const source = String.raw`%{
int calls = 0;
%}
%%
. ;
%%
int yywrap(void) { calls++; return calls > 2; }
int main(void) { yylex(); printf("%d", calls); return 0; }
`;
    expect(run(source).stdout).toBe('3');
  });

  it('stops yyterminate from inside a helper called by an action', () => {
    const source = String.raw`%%
a { stop(); printf("never"); }
%%
void stop(void) { yyterminate(); }
int main(void) { yylex(); printf("done"); return 0; }
`;
    expect(run(source, 'a').stdout).toBe('done');
  });

  it('reports a pattern too large for the automaton builder', () => {
    const info = failure('%%\n(a|b)*a(a|b){13} ;\n');
    expect(info.message).toContain('The rule on line 2');
  });

  it('reports a repeat too large to expand', () => {
    expect(failure('%%\n(a{255}){255} ;\n').code).toBe('flex_pattern_too_big');
  });

  it('expands nested optional repeats', () => {
    const source = '%%\na{1,4} printf("[%s]", yytext);\n';
    expect(run(source, 'aaaaa').stdout).toBe('[aaaa][a]');
  });

  it('reads flex patterns that are easy to get wrong', () => {
    const source = String.raw`%%
[[:alpha:]-]+   printf("A");
\"[^"]*\"       printf("S");
"{"             printf("B");
a\ b            printf("C");
.|\n            ;
`;
    expect(run(source, 'a-b "x y" { a b').stdout).toBe('ASBC');
  });

  it('refuses text left over in a definition', () => {
    expect(failure('X a/b\n%%\n{X} ;\n').code).toBe('flex_bad_pattern');
  });

  it('allows odd but legal file layouts', () => {
    expect(run('%option BAD_CASE noyywrap\n\n\n%%\n\n\na printf("x");\n\n', 'a').stdout).toBe('x');
    expect(run('%%\n<INITIAL>a printf("x");\n', 'a').stdout).toBe('x');
    expect(run('%%\na printf("x"); // end of file comment', 'a').stdout).toBe('x');
    expect(run("%%\na { char q = '\\''; printf(\"%c\", q); }\n", 'a').stdout).toBe("'");
    expect(failure('%%\n[[:alpha:] printf("x");\n').code).toBe('flex_unclosed_class');
    expect(failure('%{\n%}\n%%').code).toBe('flex_no_rules');
  });

  it('explains an unterminated character in an action', () => {
    expect(failure("%%\na { char c = 'x; }\n").message).toContain('character constant');
  });
});
