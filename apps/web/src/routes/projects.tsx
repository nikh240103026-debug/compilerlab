import { PlannedFeature } from '@/components/planned-feature';
import { Card } from '@/components/ui/card';

const MINI_PROJECTS = [
  'Calculator',
  'JSON parser',
  'Config-file language',
  'SQL subset parser',
  'Regex engine',
];

export function Component() {
  return (
    <PlannedFeature
      title="Projects"
      lead="Put it all together by building a working compiler for a small language."
      milestone="Arrives in Milestone 10"
      points={[
        'A guided TinyC compiler in eight stages: lexer, parser, AST, semantic checks, IR, optimizer, code generation and VM',
        'Automated tests at each stage and a final demo runner',
        'An optional track that builds the compiler in C with Lex and Yacc',
      ]}
    >
      <Card className="p-5">
        <h2 className="mb-3 text-base font-semibold">Mini-projects</h2>
        <ul className="space-y-1.5 text-sm text-ink-muted">
          {MINI_PROJECTS.map((project) => (
            <li key={project}>{project}</li>
          ))}
        </ul>
      </Card>
    </PlannedFeature>
  );
}
