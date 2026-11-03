%{
#include <stdio.h>
%}
%option noyywrap yylineno
BODY ([^"\\\n]|\\.)*
%%
\"{BODY}\"   { printf("STRING %s\n", yytext); }
\"{BODY}     { printf("ERROR line %d: unterminated string\n", yylineno); }
.|\n         { }
%%
int main(void) {
  yylex();
  return 0;
}
