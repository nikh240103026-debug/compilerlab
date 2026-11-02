# Content guide

Course content is data, not code. To add a topic, add two files, with no code changes. Under `npm start` it appears right away. A production build includes the lessons that existed when it was built, so run `npm run build` again.

| File                                         | Holds                                  |
| -------------------------------------------- | -------------------------------------- |
| `packages/content/lessons/<module>/<id>.mdx` | The lesson text, with frontmatter      |
| `packages/content/banks/<id>.json`           | Practice, quiz, summary and flashcards |

`npm test` validates all of it: see [What the tests check](#what-the-tests-check). `packages/content/lessons/lexical-analysis/role-of-the-lexer.mdx` and its bank are a complete example to copy.

## Lesson frontmatter

```yaml
---
id: role-of-the-lexer # Lowercase with hyphens. Must match the bank's file name.
module: lexical-analysis # An id from packages/content/data/modules.json.
title: The role of the lexer
order: 1 # Position within the module.
estimatedMinutes: 15
prerequisites: # Topic ids to study first. May be empty: [].
  - compiler-phases
outcomes: # What the student will be able to do. Start each with a verb.
  - Explain what a lexer does and where it sits in a compiler
visualizers: # Tabs in the pane beside the lesson. May be empty: [].
  - id: token-stream
    label: Token stream # Optional tab name.
    props: # Optional starting input. All values are strings.
      source: 'x = 1'
---
```

Visualizer ids and the inputs they accept:

| Id                    | `props`                                              |
| --------------------- | ---------------------------------------------------- |
| `token-stream`        | `rules` (see below), `source`                        |
| `input-buffer`        | `text`, `size` (4, 8, 12 or 16)                      |
| `automata-builder`    | `preset` (`ends-in-abb`, `a-or-b`)                   |
| `automaton-run`       | `regex`, `text`, `machine` (`nfa`, `dfa`, `minimal`) |
| `regex-to-nfa`        | `regex`                                              |
| `subset-construction` | `regex`                                              |
| `dfa-minimization`    | `regex`                                              |
| `followpos`           | `regex`                                              |

Lexer rules are one per line: a name, a pattern, then optional tags. Earlier rules win ties.

```text
# comments are allowed
IF     if        %keyword
ID     [a-z]+    %identifier
WS     [ \t\n]+  %skip
```

Tags are `%skip` and the color categories `%keyword`, `%identifier`, `%literal`, `%operator`, `%punctuation` and `%comment`.

## Lesson body

Every topic follows one template. The page adds Practice, Lab, Quiz, Summary, Flashcards and Ask AI from the bank, so the MDX holds only the first parts:

```markdown
## Why this matters

A short hook: the problem this topic solves.

## How it works

The concept. Use any headings you need here, not necessarily this one.

## Worked example

One example, step by step.

## Common mistakes

What students get wrong, and why.
```

**Why this matters**, **Worked example** and **Common mistakes** are required headings. The topic's visualizer sits beside the text, so refer to it and use it.

### Components

Only these three are available, and they need no import.

```mdx
<Callout kind="note" title="Optional title">
  Text. kind is note, warning or textbook.
</Callout>

<TryIt visualizer="regex-to-nfa" regex="(a|b)*abb">
  Build this NFA
</TryIt>

<AutomatonFigure regex="(a|b)*abb" show="dfa" caption="The DFA" />
```

- `TryIt` loads an example into the visualizer pane. Every attribute besides `visualizer` is passed as that visualizer's input, and every value must be a plain string.
- `AutomatonFigure` draws a diagram that the engine computes, so it cannot be wrong. `show` is `nfa`, `dfa` or `minimal`. Prefer this to describing a diagram.

### Writing in MDX

MDX treats some characters specially. The tests catch all of these except the pipe.

- **Braces and angle brackets in text** start code and tags. Put them in backticks: `` `{a, b}` ``, `` `a < b` ``.
- **Pipes in a table cell** end the cell. Write `\|`, including inside backticks.
- **Math** goes in `$...$` or `$$...$$`, and is written in LaTeX: `$L(r)$`, `$\epsilon$`, `$\{a, b\}$`. Use it for mathematical statements, and backticks for regexes and code.

## Question bank

`packages/content/banks/<id>.json`:

```json
{
  "summary": ["At least two points, each a full sentence."],
  "practice": [],
  "quiz": [],
  "flashcards": [{ "front": "Question", "back": "Answer", "tags": ["topic"] }]
}
```

| Section      | Requirement                                        |
| ------------ | -------------------------------------------------- |
| `summary`    | At least 2 points                                  |
| `practice`   | 3 to 10 problems, of any type below                |
| `quiz`       | 5 to 10 `mcq` questions, plus at least one `short` |
| `flashcards` | At least 3                                         |

Every question has these fields, and all are required:

```json
{
  "id": "unique-within-this-bank",
  "type": "mcq",
  "prompt": "The question.",
  "hint": "A nudge that does not give the answer away.",
  "solution": "The answer.",
  "explanation": "Why that is the answer, and why the tempting wrong answers are wrong.",
  "difficulty": "easy",
  "tags": ["tokens"],
  "exams": ["GATE", "university"]
}
```

`difficulty` is `easy`, `medium` or `hard`. `exams` lists the styles the question suits: `GATE`, `university`, or both.

Each type adds its own fields:

| Type    | Extra fields                                 | How it is answered                                                                      |
| ------- | -------------------------------------------- | --------------------------------------------------------------------------------------- |
| `mcq`   | `options` (2 to 6), `answer` (index, from 0) | Checked instantly. Quiz and practice.                                                   |
| `short` | none. `solution` is the model answer         | The student reads the solution and marks themselves.                                    |
| `regex` | `reference`, `accepts`, `rejects`            | The engine proves the answer equivalent, or shows a string that differs. Practice only. |

For a `regex` problem, `accepts` and `rejects` are example strings the tests verify against `reference`.

## What the tests check

For every topic: frontmatter is valid, prerequisites exist, the template's headings are present, the MDX and its math compile, only the three components are used, every regex in a `TryIt` or `AutomatonFigure` parses, the bank is valid, MCQ options are distinct, `regex` problems agree with the engine, and there is no placeholder text.

The tests cannot check that the teaching is correct, so that part is on the author.

## Accuracy

Write content against the textbook: Aho, Lam, Sethi and Ullman, _Compilers: Principles, Techniques, and Tools_, 2nd edition. Where the engine can compute a claim, check it by running the visualizer rather than working it out by hand. Where a point is subtle or contested, add `<Callout kind="textbook">` and list it in [CONTENT_REVIEW.md](CONTENT_REVIEW.md) for a human to review.

Write for a student who is smart but new to this. Use plain sentences, define terms when they first appear, and prefer a concrete example to an abstract statement.
