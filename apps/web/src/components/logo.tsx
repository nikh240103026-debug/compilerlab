import { cn } from '@/lib/cn';

/** A start arrow into an accepting state, the app's automaton motif. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      aria-hidden="true"
      className={cn('size-6 shrink-0 text-accent', className)}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.2"
    >
      <path d="M2.5 16h7" />
      <path d="M7.5 12.8 11 16l-3.5 3.2" />
      <circle cx="20.5" cy="16" r="9" />
      <circle cx="20.5" cy="16" r="5" />
    </svg>
  );
}
