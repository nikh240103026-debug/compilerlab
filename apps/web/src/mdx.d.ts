declare module '*.mdx' {
  import type { ComponentType } from 'react';

  const Lesson: ComponentType<{ components?: Record<string, unknown> }>;
  export default Lesson;
}
