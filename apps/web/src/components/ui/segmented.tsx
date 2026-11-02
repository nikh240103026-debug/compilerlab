import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: ReactNode;
}

interface SegmentedProps<T extends string> {
  name: string;
  legend: string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onChange: (value: T) => void;
}

/** Native radio buttons, so arrow keys and screen readers work without extra code. */
export function Segmented<T extends string>({
  name,
  legend,
  value,
  options,
  onChange,
}: SegmentedProps<T>) {
  return (
    <fieldset className="inline-flex rounded-md border border-line-strong p-0.5">
      <legend className="sr-only">{legend}</legend>
      {options.map((option) => (
        <label
          key={option.value}
          className={cn(
            'flex h-8 cursor-pointer items-center gap-2 rounded-sm px-3 text-[0.8125rem] font-medium transition-colors duration-(--duration-fast) has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-accent [&_svg]:size-4',
            option.value === value
              ? 'bg-accent text-on-accent'
              : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
          )}
        >
          <input
            type="radio"
            className="sr-only"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onChange(option.value)}
          />
          {option.icon}
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
