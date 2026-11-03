%{
#include <stdio.h>
%}
%option noyywrap
%x COMMENT
%%
"/*"            { BEGIN(COMMENT); }
<COMMENT>"*/"   { BEGIN(INITIAL); }
<COMMENT>.|\n   { }
  /* TODO: remove // comments, and leave strings alone. */
.|\n            { ECHO; }
%%
int main(void) {
  yylex();
  return 0;
}
