%{
#include <stdio.h>
int lines = 0, words = 0, chars = 0;
%}
%option noyywrap
%%
[^ \t\n]+   { words++; chars += yyleng; }
\n          { lines++; chars++; }
.           { chars++; }
%%
int main(void) {
  yylex();
  printf("%d %d %d\n", lines, words, chars);
  return 0;
}
