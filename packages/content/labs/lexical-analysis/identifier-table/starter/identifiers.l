%{
#include <stdio.h>
#include <string.h>
char names[100][32];
int counts[100];
int total = 0;
void remember(const char *name);
%}
%option noyywrap
%%
if|else|while|int|return   { }
[0-9]+                     { }
  /* TODO: call remember(yytext) for each identifier. */
.|\n                       { }
%%
void remember(const char *name) {
  /* TODO: find name in the table and count it, or add it. */
}
int main(void) {
  int i;
  yylex();
  for (i = 0; i < total; i++) {
    printf("%s %d\n", names[i], counts[i]);
  }
  return 0;
}
