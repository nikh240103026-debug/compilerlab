# Content review

Points a human should check against the textbook, _Compilers: Principles, Techniques, and Tools_, 2nd edition.

**Read this first.** The lessons were written without a copy of the book at hand, so every statement about what the book says comes from memory. Every state count, table, token count and trace in them was checked by running the engine, and the engine is tested against the book's figures as remembered. Facts the engine can compute are reliable. Attributions to the book, and the points below, need a human.

Nothing here has been run with real tools: flex, bison and gcc were not installed when these lessons were written. Run the samples once in Milestone 3.

## Open decisions

| Where                                                     | Question                                                                                                                                                                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard pipeline, `modules.json`, `compiler-phases.mdx` | The spec says "seven compiler phases", and the lesson teaches the book's seven by splitting optimization into machine-independent and machine-dependent. The dashboard draws six states, one per module. Decide whether to draw seven. |
| Dashboard pipeline labels                                 | Characters, tokens, parse tree, typed tree, IR, better IR and code are informal shorthand. Check that they do not conflict with the lessons' terms.                                                                                    |
| `regex-to-dfa.mdx`, `finite-automata.mdx`                 | The site's DFAs leave out the dead state, so `a*b` draws 2 states where the complete DFA has 3. The lessons say exams usually mean the complete DFA. Confirm that against GATE's convention.                                           |

## Run these samples

The lab can now run Lex samples, but the machine these were written on has no flex or gcc, so **no exercise or lesson sample has been run with the real tools yet.** The word counter's answer has been checked in Simulated mode only. Before release, run `npx vitest run real-tools` on a machine with the tools, which runs every exercise solution through real flex and gcc.

| Where                            | Sample                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `construction-tools.mdx`         | The `calc.l` and `calc.y` calculator                                                             |
| `lex-and-flex.mdx`               | The word counter. The quiz keys its output on input `a bb\n\n` as 2 lines, 2 words, 6 characters |
| `language-processing-system.mdx` | The C example, with `gcc -E`, `-S` and `-c`                                                      |
| `compiler-vs-interpreter.mdx`    | The `javac` and `java` commands                                                                  |

## Check against the book

| File                             | Point                                                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compiler-vs-interpreter.mdx`    | The book draws one Linker/Loader box, and older books use "loader" to include linking.                                                                                                          |
| `compiler-phases.mdx`            | The book puts intermediate code generation in the front end, and optimization between front and back. Other sources say "middle end".                                                           |
| `compiler-phases.mdx`            | The lexer creates symbol-table entries in the book's opening example, and the parser creates them later in the book.                                                                            |
| `compiler-phases.mdx`            | The 2nd edition's diagram shows only the symbol table, and many course diagrams add an error-handler box.                                                                                       |
| `compiler-phases.mdx`            | The book's `⟨60⟩` is a simplification of `⟨number, 4⟩`.                                                                                                                                         |
| `compiler-phases.mdx`            | The running example's details as a whole.                                                                                                                                                       |
| `bootstrapping.mdx`              | T-diagrams are not in the 2nd edition's Chapter 1, and the notation varies. Recalled from the 1st edition, so this topic cannot fully follow the 2nd.                                           |
| `bootstrapping.mdx`              | Sources disagree on the first self-implemented language: NELIAC or Lisp.                                                                                                                        |
| `language-processing-system.mdx` | The book has one Linker/Loader box and says a compiler may produce assembly. GCC and Clang arrange these stages differently.                                                                    |
| `construction-tools.mdx`         | The six categories follow the book's list. LLVM, TableGen and GCC machine descriptions are added examples.                                                                                      |
| `tokens-lexemes-patterns.mdx`    | The book's `number` attribute is an integer in its example, though it says a typical compiler would store a pointer to a string.                                                                |
| `tokens-lexemes-patterns.mdx`    | Counting conventions for preprocessor lines such as `#include` vary.                                                                                                                            |
| `input-buffering.mdx`            | The book counts two tests per character, down to one with sentinels. The visualizer's counter adds one for each `eof`.                                                                          |
| `regular-expressions.mdx`        | The book's basis has no ∅, unlike many theory texts.                                                                                                                                            |
| `finite-automata.mdx`            | The book's NFA includes ε-moves, while Hopcroft, Motwani and Ullman treat the ε-NFA as a separate model.                                                                                        |
| `finite-automata.mdx`            | The table of build and per-string costs for NFAs and DFAs.                                                                                                                                      |
| `regex-to-dfa.mdx`               | The book's Thompson property says two ε-edges, but states 3 and 5 of its own figure have one. The lesson says "at most two".                                                                    |
| `regex-to-dfa.mdx`               | The book treats `r+` and `r?` as shorthand, and the engine has direct rules. `a+` is 4 states against 5 for `aa*`, and `a?` is 4 against 6 for `a\|ε`.                                          |
| `regex-to-dfa.mdx`               | The minimization tab uses Hopcroft's worklist, not the book's rounds. The splits can come in a different order, and the final groups are always the same.                                       |
| `lexer-design.mdx`               | The book's DFA for `a`, `abb`, `a*b+` has six states named by NFA states, and the site's labels are A to F. The book's look-back gives the same match as remembering the last accepting state.  |
| `lexical-errors.mdx`             | Grouping adjacent bad characters is this tool's choice, not the book's. The `:=` repair examples were written for this lesson.                                                                  |
| `lex-and-flex.mdx`               | Start conditions, `%option` and `BEGIN(name)` are as in Flex. AT&T Lex has only inclusive conditions and writes `BEGIN name;`. `yytext` is a pointer in Flex and an array in some Lex versions. |

## Facts from outside the book

These have no callout in the lessons, and are stated from general knowledge.

| File                                         | Claim                                                                                                                                                                 |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bootstrapping.mdx`                          | The first Rust compiler was in OCaml. Go's compiler was in C until 1.5. Cfront generated C. Hart and Levin bootstrapped Lisp in 1962. GCC bootstraps in three stages. |
| `construction-tools.mdx`, `lexer-design.mdx` | GCC and Clang use hand-written parsers and lexers.                                                                                                                    |
| `lex-and-flex.mdx`                           | In Flex, `\d` means the letter d, unlike this site's visualizer, where it means a digit.                                                                              |
