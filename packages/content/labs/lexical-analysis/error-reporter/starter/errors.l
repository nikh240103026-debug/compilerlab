%{
#include <stdio.h>
int line = 1, column = 1, errors = 0;
%}
%option noyywrap
%%
[a-zA-Z_][a-zA-Z0-9_]*   { column += yyleng; }
[0-9]+                   { column += yyleng; }
[-+*/=;]                 { column += yyleng; }
[ \t]+                   { column += yyleng; }
  /* TODO: handle newlines, and report anything else as an error. */
%%
int main(void) {
  yylex();
  printf("%d errors\n", errors);
  return 0;
}
