%{
#include <stdio.h>
int line = 0;
%}
%option noyywrap
%%
  /* TODO: match a whole line and print it with its number. */
\n    { ECHO; }
.     { ECHO; }
%%
int main(void) {
  yylex();
  return 0;
}
