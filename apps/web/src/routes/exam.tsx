import { PlannedFeature } from '@/components/planned-feature';

export function Component() {
  return (
    <PlannedFeature
      title="Exam prep"
      lead="Prepare for GATE, university end-semester papers, or your own syllabus."
      milestone="Milestones 6 and 11"
      points={[
        'Timed tests, phase tests and full mock exams with negative marking',
        'Topic-wise results, weak-area detection and retry-only-mistakes mode',
        'A syllabus mapper that shows your coverage',
        'Cheat sheets and worked solutions for classic problems',
        'A printable PDF export',
      ]}
    />
  );
}
