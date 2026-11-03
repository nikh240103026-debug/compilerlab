%{
#include <stdio.h>
%}
%option noyywrap yylineno
%%
  /* TODO: recognize complete and unterminated strings. */
.|\n   { }
%%
int main(void) {
  yylex();
  return 0;
}
