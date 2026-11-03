%{
#include <stdio.h>
%}
%option noyywrap
%%
"+"     { printf("PLUS\n"); }
"="     { printf("ASSIGN\n"); }
  /* TODO: add ++, += and == */
.|\n    { }
%%
int main(void) {
  yylex();
  return 0;
}
