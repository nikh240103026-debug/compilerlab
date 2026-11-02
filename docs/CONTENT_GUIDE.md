# Content guide

Course content is data, not code. Adding a topic should never need a code change.

## What exists today

`packages/content/data/modules.json` is the course outline. Each module has these fields, validated by `ModuleSchema` in `packages/shared/src/content.ts`:

| Field              | Meaning                                                     |
| ------------------ | ----------------------------------------------------------- |
| `id`               | The URL slug, in lowercase with hyphens                     |
| `number`           | Display order, starting at 0. Also picks the module's color |
| `title`, `summary` | Shown in navigation and on module pages                     |
| `pipelineStage`    | `true` if the module is drawn on the dashboard pipeline     |
| `optional`         | `true` for optional tracks                                  |
| `lessonsMilestone` | The Part 14 milestone that delivers this module's lessons   |
| `topics`           | Planned topics, in teaching order                           |
| `visualizers`      | Planned visualizers                                         |

The file is parsed when the server starts, so a typo fails loudly and `npm test` catches it.

## Coming in Milestone 2

Lessons will be MDX files with frontmatter for the phase, topic id, prerequisites, estimated time and learning outcomes. This guide will gain the exact format then. Each topic page follows the template in [Part 5 of the build rules](../CLAUDE.md): Hook, Concept, Interactive visualizer, Worked example, Common mistakes, Practice, Lab link, Quiz, Summary and flashcards, and Ask AI.

## Accuracy

Write content against the textbook (Aho, Lam, Sethi and Ullman). Where a point is subtle or contested, add a "Check against the textbook" note and list it in [CONTENT_REVIEW.md](CONTENT_REVIEW.md) for a human to review.
