%{
#include <stdio.h>
%}
%option noyywrap
DIGIT [0-9]
EXP   [eE][-+]?{DIGIT}+
%%
0[xX][0-9a-fA-F]+                 { printf("HEX %s\n", yytext); }
{DIGIT}+"."{DIGIT}+{EXP}?         { printf("FLOAT %s\n", yytext); }
{DIGIT}+{EXP}                     { printf("FLOAT %s\n", yytext); }
{DIGIT}+                          { printf("INT %s\n", yytext); }
.|\n                              { }
%%
int main(void) {
  yylex();
  return 0;
}
