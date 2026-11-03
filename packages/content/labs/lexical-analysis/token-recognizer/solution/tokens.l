%{
#include <stdio.h>
%}
%option noyywrap
%%
if|else|while|int|return   { printf("KEYWORD %s\n", yytext); }
[a-zA-Z_][a-zA-Z0-9_]*     { printf("ID %s\n", yytext); }
[0-9]+                     { printf("NUM %s\n", yytext); }
"=="|"!="|"<="|">="        { printf("OP %s\n", yytext); }
[-=<>+*/]                  { printf("OP %s\n", yytext); }
[(){};]                    { printf("PUNCT %s\n", yytext); }
[ \t\n]+                   { }
.                          { printf("ERROR %s\n", yytext); }
%%
int main(void) {
  yylex();
  return 0;
}
