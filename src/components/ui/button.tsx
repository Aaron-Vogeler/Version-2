import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 tracking-wide',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-soft hover:shadow-medium hover:-translate-y-0.5 active:translate-y-0',
        secondary: 'bg-secondary text-secondary-foreground shadow-soft hover:shadow-medium hover:-translate-y-0.5 active:translate-y-0',
        outline: 'border-2 border-border bg-transparent hover:bg-secondary/50 hover:border-foreground/20',
        ghost: 'hover:bg-secondary/60 hover:text-foreground',
        destructive: 'bg-destructive text-destructive-foreground shadow-soft hover:shadow-medium hover:-translate-y-0.5 active:translate-y-0',
        success: 'bg-success text-success-foreground shadow-soft hover:shadow-medium hover:-translate-y-0.5 active:translate-y-0',
        link: 'text-primary underline-offset-4 hover:underline hover:text-primary/80',
      },
      size: {
        default: 'h-12 px-6 py-3 text-base rounded-lg',
        sm: 'h-10 px-4 py-2 text-sm rounded-md',
        lg: 'h-14 px-8 py-4 text-lg rounded-xl',
        xl: 'h-16 px-10 py-5 text-xl rounded-xl',
        icon: 'h-12 w-12 rounded-lg',
        'icon-sm': 'h-10 w-10 rounded-md',
        'icon-lg': 'h-14 w-14 rounded-xl',
      },
      pill: {
        true: 'rounded-full',
        false: '',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      pill: false,
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, pill, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, pill, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = 'Button';

export { Button, buttonVariants };
