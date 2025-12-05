import * as React from 'react';
import { cn } from '@/lib/utils';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          'flex h-12 w-full rounded-lg border-2 border-input bg-background px-4 py-3 text-base text-foreground transition-all duration-200',
          'placeholder:text-foreground-muted',
          'file:border-0 file:bg-transparent file:text-base file:font-medium file:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0 focus-visible:border-ring',
          'hover:border-foreground/20',
          'disabled:cursor-not-allowed disabled:opacity-50 disabled:bg-muted/30',
          className
        )}
        ref={ref}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';

export { Input };
