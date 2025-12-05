/**
 * Stat card component for displaying KPIs
 * Redesigned with minimalist beige aesthetic
 */

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LucideIcon, TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  description?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
}

export function StatCard({ title, value, icon: Icon, description, trend }: StatCardProps) {
  return (
    <Card className="group transition-all duration-300 hover:shadow-large border-border/30">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-foreground-muted">
          {title}
        </CardTitle>
        <div className="rounded-lg bg-primary/10 p-3 transition-colors duration-200 group-hover:bg-primary/20">
          <Icon className="h-5 w-5 text-primary" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-4xl font-bold tracking-tight text-foreground">{value}</div>
        {description && (
          <p className="text-sm text-foreground-secondary leading-relaxed">{description}</p>
        )}
        {trend && (
          <div className="flex items-center gap-2 pt-2">
            {trend.isPositive ? (
              <TrendingUp className="h-4 w-4 text-success" />
            ) : (
              <TrendingDown className="h-4 w-4 text-destructive" />
            )}
            <p
              className={cn(
                'text-sm font-medium',
                trend.isPositive ? 'text-success' : 'text-destructive'
              )}
            >
              {trend.isPositive ? '+' : ''}
              {trend.value}%
              <span className="text-foreground-muted ml-1">from last period</span>
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
