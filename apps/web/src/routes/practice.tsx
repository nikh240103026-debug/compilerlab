import { PlannedFeature } from '@/components/planned-feature';

export function Component() {
  return (
    <PlannedFeature
      title="Practice"
      lead="Build real skill with questions the engine can grade, without an internet connection."
      milestone="Arrives in Milestone 6"
      points={[
        'MCQ, fill-in-the-blank, matching, and ordering of parsing steps',
        'Completing FIRST and FOLLOW sets and parsing tables',
        'Drawing automata, writing grammars and tracing parsers',
        'Instant feedback, a hint, a solution and an explanation for every question',
        'Spaced repetition for flashcards',
      ]}
    />
  );
}
