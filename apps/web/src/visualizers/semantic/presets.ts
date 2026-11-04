import type { SymtabFormat } from './jobs';
import type { SourcePreset } from './playground';

// Examples for the Module 3 playgrounds. Most come from the book, so a student can start from a
// known answer, and a few exist to show what goes wrong.

export const DESK_CALCULATOR: SourcePreset = {
  label: 'Desk calculator',
  text: `L -> E n     { L.val = E.val }
E -> E1 + T  { E.val = E1.val + T.val }
E -> T       { E.val = T.val }
T -> T1 * F  { T.val = T1.val * F.val }
T -> F       { T.val = F.val }
F -> ( E )   { F.val = E.val }
F -> digit   { F.val = digit.lexval }`,
  input: '3 * 5 + 4 n',
};

const INHERITED: SourcePreset = {
  label: 'Inherited attributes',
  text: `T -> F T'      { T'.inh = F.val; T.val = T'.syn }
T' -> * F T1'  { T1'.inh = T'.inh * F.val; T'.syn = T1'.syn }
T' -> ε        { T'.syn = T'.inh }
F -> digit     { F.val = digit.lexval }`,
  input: '3 * 5',
};

const DECLARATIONS: SourcePreset = {
  label: 'Declarations',
  text: `D -> T L      { L.inh = T.type }
T -> int      { T.type = integer }
T -> float    { T.type = float }
L -> L1 , id  { L1.inh = L.inh; addType(id.entry, L.inh) }
L -> id       { addType(id.entry, L.inh) }`,
  input: 'float x, y, z',
};

const TO_POSTFIX: SourcePreset = {
  label: 'Postfix text',
  text: `E -> E1 + T  { E.code = E1.code || ' ' || T.code || ' +' }
E -> T       { E.code = T.code }
T -> id      { T.code = id.lexeme }`,
  input: 'a + b + c',
};

const READS_RIGHT: SourcePreset = {
  label: 'Reads from the right',
  text: `S -> A B  { A.i = B.v; S.v = A.v }
A -> a    { A.v = A.i + 1 }
B -> b    { B.v = 2 }`,
  input: 'a b',
};

export const CIRCULAR: SourcePreset = {
  label: 'A cycle',
  text: `A -> B  { A.s = B.i; B.i = A.s + 1 }
B -> x`,
  input: 'x',
};

export const SDD_PRESETS: readonly SourcePreset[] = [
  DESK_CALCULATOR,
  INHERITED,
  DECLARATIONS,
  TO_POSTFIX,
  READS_RIGHT,
  CIRCULAR,
];

export const SDT_INFIX_TO_POSTFIX: SourcePreset = {
  label: 'Infix to postfix',
  text: `E -> T R
R -> + T { print('+') } R1
   | - T { print('-') } R1
   | ε
T -> num { print(num.val) }`,
  input: '9 - 5 + 2',
};

const SDT_CALCULATOR: SourcePreset = {
  label: 'Postfix desk calculator',
  text: `L -> E n     { print(E.val) }
E -> E1 + T  { E.val = E1.val + T.val }
E -> T       { E.val = T.val }
T -> T1 * F  { T.val = T1.val * F.val }
T -> F       { T.val = F.val }
F -> ( E )   { F.val = E.val }
F -> digit   { F.val = digit.lexval }`,
  input: '3 * 5 + 4 n',
};

const SDT_PREFIX: SourcePreset = {
  label: 'Infix to prefix',
  text: `L -> E n
E -> { print('+') } E1 + T
E -> T
T -> { print('*') } T1 * F
T -> F
F -> ( E )
F -> digit { print(digit.lexval) }`,
  input: '3 * 5 + 4 n',
};

const SDT_INHERITED: SourcePreset = {
  label: 'Inherited attributes',
  text: `T -> F { T'.inh = F.val } T' { T.val = T'.syn; print(T.val) }
T' -> * F { T1'.inh = T'.inh * F.val } T1' { T'.syn = T1'.syn }
T' -> ε { T'.syn = T'.inh }
F -> digit { F.val = digit.lexval }`,
  input: '3 * 5',
};

export const SDT_PRESETS: readonly SourcePreset[] = [
  SDT_INFIX_TO_POSTFIX,
  SDT_CALCULATOR,
  SDT_PREFIX,
  SDT_INHERITED,
];

export interface SymtabPreset extends SourcePreset {
  format: SymtabFormat;
}

export const SYMTAB_BLOCKS: SymtabPreset = {
  label: 'Nested blocks',
  format: 'blocks',
  text: '{ int x; char y; { bool y; x; y; } x; y; }',
};

export const SYMTAB_PRESETS: readonly SymtabPreset[] = [
  SYMTAB_BLOCKS,
  {
    label: 'Hiding names',
    format: 'blocks',
    text: `{
  int a; int b;
  {
    float a;
    a; b;
    { char b; a; b; }
    b;
  }
  a; b;
}`,
  },
  {
    label: 'Names that collide',
    format: 'blocks',
    text: `{
  int ab; int ba; int cd;
  ab; ba;
  { float ba; ba; ab; }
  ba;
}`,
  },
  {
    label: 'Errors',
    format: 'blocks',
    text: '{ int x; int x; y; { z; } }',
  },
  {
    label: 'A list of operations',
    format: 'script',
    text: `enter
insert x int
insert y char
enter
insert y bool
lookup x
lookup y
exit
lookup y
exit`,
  },
];

export const TC_COERCIONS: SourcePreset = {
  label: 'Conversions',
  text: `int x;
float y;
y = x + 2.5;
x = y;`,
};

export const TC_PRESETS: readonly SourcePreset[] = [
  TC_COERCIONS,
  {
    label: 'Functions and scopes',
    text: `int total;

float average(int a, int b) {
  float sum;
  sum = a + b;
  return sum / 2;
}

total = 3;
bool big;
big = average(total, 4) > 2.5;`,
  },
  {
    label: 'Structs and arrays',
    text: `struct point { int x; int y; };
struct point p;
int a[10];
char c;
p.x = a[c];
if (p.x > 0) {
  float p;
  p = 1;
}`,
  },
  {
    label: 'Several errors',
    text: `int n;
float f;
bool done;
n = undeclared + 1;
f = done * 2;
if (n) f = 1.5;
n[0] = 1;`,
  },
];

export const INFER_LENGTH: SourcePreset = {
  label: 'length',
  text: 'fun length(x) = if null(x) then 0 else length(tl(x)) + 1',
};

export const INFER_PRESETS: readonly SourcePreset[] = [
  INFER_LENGTH,
  {
    label: 'Polymorphism',
    text: `fun id(x) = x
id(3);
id(true)`,
  },
  {
    label: 'A function argument',
    text: 'fun twice(f, x) = f(f(x))',
  },
  {
    label: 'map',
    text: 'fun map(f, xs) = if null(xs) then [] else cons(f(hd(xs)), map(f, tl(xs)))',
  },
  {
    label: 'Occurs check',
    text: 'fun self(x) = x(x)',
  },
  {
    label: 'Type error',
    text: 'fun bad(x) = if x then 1 else true',
  },
];
