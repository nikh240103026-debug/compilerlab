%{
#include <stdio.h>
int lines = 0, words = 0, chars = 0;
%}
%option noyywrap
%%
  /* TODO: add a rule that counts a whole word. */
\n    { lines++; chars++; }
.     { chars++; }
%%
int main(void) {
  yylex();
  printf("%d %d %d\n", lines, words, chars);
  return 0;
}
