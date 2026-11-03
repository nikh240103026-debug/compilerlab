%{
#include <stdio.h>
%}
%option noyywrap
%x COMMENT STRING
%%
"/*"            { BEGIN(COMMENT); }
"//".*          { }
\"              { ECHO; BEGIN(STRING); }
<COMMENT>"*/"   { BEGIN(INITIAL); }
<COMMENT>.|\n   { }
<STRING>\\.     { ECHO; }
<STRING>\"      { ECHO; BEGIN(INITIAL); }
<STRING>.|\n    { ECHO; }
.|\n            { ECHO; }
%%
int main(void) {
  yylex();
  return 0;
}
