import type { LabFile, LabPipeline } from '@compilerlab/shared/lab';

export interface LabTemplate {
  id: string;
  label: string;
  pipeline: LabPipeline;
  files: LabFile[];
  stdin: string;
}

export const LAB_TEMPLATES: readonly LabTemplate[] = [
  {
    id: 'lex-basic',
    label: 'Lex scanner',
    pipeline: 'lex',
    stdin: 'count 42 words\nand 7 numbers\n',
    files: [
      {
        name: 'scanner.l',
        content: String.raw`%{
#include <stdio.h>
%}
%option noyywrap

DIGIT  [0-9]
LETTER [a-zA-Z]

%%
{DIGIT}+    { printf("NUMBER %s\n", yytext); }
{LETTER}+   { printf("WORD   %s\n", yytext); }
[ \t\n]+    { /* skip whitespace */ }
.           { printf("OTHER  %s\n", yytext); }
%%

int main(void) {
  yylex();
  return 0;
}
`,
      },
    ],
  },
  {
    id: 'c-basic',
    label: 'C program',
    pipeline: 'c',
    stdin: 'Ada\n',
    files: [
      {
        name: 'main.c',
        content: String.raw`#include <stdio.h>

int main(void) {
  char name[64];
  if (fgets(name, sizeof name, stdin)) {
    printf("Hello, %s", name);
  }
  return 0;
}
`,
      },
    ],
  },
  {
    id: 'cpp-basic',
    label: 'C++ program',
    pipeline: 'cpp',
    stdin: 'Ada\n',
    files: [
      {
        name: 'main.cpp',
        content: String.raw`#include <iostream>
#include <string>

int main() {
  std::string name;
  std::getline(std::cin, name);
  std::cout << "Hello, " << name << "\n";
  return 0;
}
`,
      },
    ],
  },
];

export const DEFAULT_TEMPLATE = LAB_TEMPLATES[0] as LabTemplate;
