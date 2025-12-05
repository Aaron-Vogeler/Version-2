import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium uppercase tracking-wider transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
  {
    variants: {
      variant: {
        default: 'bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20',
        secondary: 'bg-secondary text-secondary-foreground border border-border hover:bg-secondary/80',
        destructive: 'bg-destructive/10 text-destructive border border-destructive/20 hover:bg-destructive/20',
        success: 'bg-success/10 text-success border border-success/20 hover:bg-success/20',
        warning: 'bg-warning/10 text-warning border border-warning/20 hover:bg-warning/20',
        outline: 'bg-transparent text-foreground border border-border hover:bg-secondary/50',
        accent: 'bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
