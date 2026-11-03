%{
#include <stdio.h>
%}
%option noyywrap
DIGIT [0-9]
%%
{DIGIT}+   { printf("INT %s\n", yytext); }
  /* TODO: add rules for FLOAT and HEX. */
.|\n       { }
%%
int main(void) {
  yylex();
  return 0;
}
