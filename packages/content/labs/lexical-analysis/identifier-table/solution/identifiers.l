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
[a-zA-Z_][a-zA-Z0-9_]*     { remember(yytext); }
.|\n                       { }
%%
void remember(const char *name) {
  int i;
  for (i = 0; i < total; i++) {
    if (strcmp(names[i], name) == 0) {
      counts[i]++;
      return;
    }
  }
  strcpy(names[total], name);
  counts[total] = 1;
  total++;
}
int main(void) {
  int i;
  yylex();
  for (i = 0; i < total; i++) {
    printf("%s %d\n", names[i], counts[i]);
  }
  return 0;
}
