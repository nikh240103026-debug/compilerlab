import type { CSSProperties } from 'react';

export function moduleColor(number: number): CSSProperties {
  return { '--mod': `var(--module-${number})` } as CSSProperties;
}

export function ModuleChip({ number }: { number: number }) {
  return (
    <span aria-hidden="true" className="module-chip" style={moduleColor(number)}>
      {number}
    </span>
  );
}
