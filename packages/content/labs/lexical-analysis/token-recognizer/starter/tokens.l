%{
#include <stdio.h>
%}
%option noyywrap
%%
[a-zA-Z_][a-zA-Z0-9_]*   { printf("ID %s\n", yytext); }
[0-9]+                   { printf("NUM %s\n", yytext); }
[ \t\n]+                 { }
  /* TODO: add keywords, operators, punctuation and an error rule. */
%%
int main(void) {
  yylex();
  return 0;
}
