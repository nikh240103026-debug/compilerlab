%{
#include <stdio.h>
int line = 0;
%}
%option noyywrap
%%
.*\n   { line++; printf("%d: %s", line, yytext); }
.+     { line++; printf("%d: %s\n", line, yytext); }
%%
int main(void) {
  yylex();
  return 0;
}
