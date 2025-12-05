/**
 * Reusable layout container components
 * Minimalist beige futuristic design system
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

// Main page container
export const Container = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('max-w-7xl mx-auto px-6 lg:px-8', className)}
      {...props}
    />
  )
);
Container.displayName = 'Container';

// Section with consistent spacing
export const Section = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <section
      ref={ref}
      className={cn('py-16 lg:py-24 xl:py-32', className)}
      {...props}
    />
  )
);
Section.displayName = 'Section';

// Page header
export const PageHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn('space-y-4 mb-8 lg:mb-12', className)}
      {...props}
    />
  )
);
PageHeader.displayName = 'PageHeader';

// Page title
export const PageTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, ...props }, ref) => (
    <h1
      ref={ref}
      className={cn('text-4xl lg:text-5xl xl:text-6xl font-bold tracking-tight text-foreground', className)}
      {...props}
    />
  )
);
PageTitle.displayName = 'PageTitle';

// Page description
export const PageDescription = React.forwardRef<HTMLParagraphElement, React.HTMLAttributes<HTMLParagraphElement>>(
  ({ className, ...props }, ref) => (
    <p
      ref={ref}
      className={cn('text-lg lg:text-xl text-foreground-secondary max-w-3xl leading-relaxed', className)}
      {...props}
    />
  )
);
PageDescription.displayName = 'PageDescription';

// Grid layout
interface GridProps extends React.HTMLAttributes<HTMLDivElement> {
  cols?: 1 | 2 | 3 | 4;
  gap?: 'sm' | 'md' | 'lg' | 'xl';
}

export const Grid = React.forwardRef<HTMLDivElement, GridProps>(
  ({ className, cols = 3, gap = 'lg', ...props }, ref) => {
    const gapClass = {
      sm: 'gap-4',
      md: 'gap-6',
      lg: 'gap-8',
      xl: 'gap-12',
    }[gap];

    const colsClass = {
      1: 'grid-cols-1',
      2: 'grid-cols-1 md:grid-cols-2',
      3: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
      4: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
    }[cols];

    return (
      <div
        ref={ref}
        className={cn('grid', colsClass, gapClass, className)}
        {...props}
      />
    );
  }
);
Grid.displayName = 'Grid';

// Stack layout
interface StackProps extends React.HTMLAttributes<HTMLDivElement> {
  spacing?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  direction?: 'vertical' | 'horizontal';
}

export const Stack = React.forwardRef<HTMLDivElement, StackProps>(
  ({ className, spacing = 'md', direction = 'vertical', ...props }, ref) => {
    const spacingClass = {
      sm: direction === 'vertical' ? 'space-y-2' : 'space-x-2',
      md: direction === 'vertical' ? 'space-y-4' : 'space-x-4',
      lg: direction === 'vertical' ? 'space-y-6' : 'space-x-6',
      xl: direction === 'vertical' ? 'space-y-8' : 'space-x-8',
      '2xl': direction === 'vertical' ? 'space-y-12' : 'space-x-12',
    }[spacing];

    return (
      <div
        ref={ref}
        className={cn(
          'flex',
          direction === 'vertical' ? 'flex-col' : 'flex-row',
          spacingClass,
          className
        )}
        {...props}
      />
    );
  }
);
Stack.displayName = 'Stack';
