%{
#include <stdio.h>
int vowels = 0, consonants = 0, digits = 0, other = 0;
%}
%option noyywrap
%%
[aeiouAEIOU]   { vowels++; }
[a-zA-Z]       { consonants++; }
[0-9]          { digits++; }
.|\n           { other++; }
%%
int main(void) {
  yylex();
  printf("vowels=%d consonants=%d digits=%d other=%d\n", vowels, consonants, digits, other);
  return 0;
}
