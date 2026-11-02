import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

const controlClass =
  'h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink transition-colors duration-(--duration-fast) placeholder:text-ink-muted disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(controlClass, className)} {...props} />;
  },
);

export const NativeSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function NativeSelect({ className, ...props }, ref) {
    return <select ref={ref} className={cn(controlClass, className)} {...props} />;
  },
);
