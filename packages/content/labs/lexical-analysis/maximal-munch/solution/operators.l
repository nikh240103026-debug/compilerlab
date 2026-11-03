%{
#include <stdio.h>
%}
%option noyywrap
%%
"++"    { printf("INCR\n"); }
"+="    { printf("ADD_ASSIGN\n"); }
"+"     { printf("PLUS\n"); }
"=="    { printf("EQ\n"); }
"="     { printf("ASSIGN\n"); }
.|\n    { }
%%
int main(void) {
  yylex();
  return 0;
}
