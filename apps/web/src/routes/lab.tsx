import { PlannedFeature } from '@/components/planned-feature';
import { ToolchainStatus } from '@/components/system-status';
import { Card } from '@/components/ui/card';

export function Component() {
  return (
    <PlannedFeature
      title="Lab"
      lead="Write Lex, Yacc, C and C++ programs and run them with the real tools."
      milestone="Arrives in Milestone 3"
      points={[
        'A multi-file editor with a terminal, input pane and build log',
        'One-click flex, bison, gcc and g++ pipelines',
        'Compiler errors marked in your code and explained in plain English',
        'A built-in engine, clearly labeled Simulated, when the tools are missing',
      ]}
    >
      <Card className="p-5">
        <h2 className="mb-3 text-base font-semibold">Your toolchain</h2>
        <ToolchainStatus />
      </Card>
    </PlannedFeature>
  );
}
