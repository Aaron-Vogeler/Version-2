'use client';

/**
 * Billing & Usage Component
 * Shows detailed cost breakdown and usage summary
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, LineChart, Line } from 'recharts';
import { DollarSign, TrendingUp, Clock, Phone } from 'lucide-react';
import { formatCurrency } from '@/lib/utils';

interface BillingData {
  currentPeriod: {
    totalCalls: number;
    totalMinutes: number;
    totalCost: number;
    breakdown: {
      assistant?: Record<string, number>;
      goal?: Record<string, number>;
      direction?: Record<string, number>;
    };
  };
  historicalCosts: {
    date: string;
    cost: number;
    calls: number;
  }[];
  costByAssistant: {
    assistantName: string;
    calls: number;
    minutes: number;
    cost: number;
  }[];
}

interface BillingUsageProps {
  data: BillingData;
}

export function BillingUsage({ data }: BillingUsageProps) {
  const avgCostPerCall = data.currentPeriod.totalCalls > 0
    ? data.currentPeriod.totalCost / data.currentPeriod.totalCalls
    : 0;

  const avgCostPerMinute = data.currentPeriod.totalMinutes > 0
    ? data.currentPeriod.totalCost / data.currentPeriod.totalMinutes
    : 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <DollarSign className="h-6 w-6" />
        <h2 className="text-2xl font-bold">Billing & Usage</h2>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <DollarSign className="h-4 w-4" />
              Total Cost
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-green-600">
              {formatCurrency(data.currentPeriod.totalCost)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">Current billing period</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Phone className="h-4 w-4" />
              Total Calls
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{data.currentPeriod.totalCalls}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Avg: {formatCurrency(avgCostPerCall)}/call
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Clock className="h-4 w-4" />
              Total Minutes
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {data.currentPeriod.totalMinutes.toFixed(1)}
            </div>
            <p className="text-xs text-muted-foreground mt-1">
              Avg: {formatCurrency(avgCostPerMinute)}/min
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Avg Duration
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {data.currentPeriod.totalCalls > 0
                ? (data.currentPeriod.totalMinutes / data.currentPeriod.totalCalls).toFixed(1)
                : 0}
              m
            </div>
            <p className="text-xs text-muted-foreground mt-1">Per call</p>
          </CardContent>
        </Card>
      </div>

      {/* Cost Trends */}
      <Card>
        <CardHeader>
          <CardTitle>Cost Trends</CardTitle>
          <CardDescription>Daily costs over the last 30 days</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={data.historicalCosts}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickFormatter={(value) => {
                  const date = new Date(value);
                  return `${date.getMonth() + 1}/${date.getDate()}`;
                }}
              />
              <YAxis yAxisId="left" orientation="left" stroke="#10b981" />
              <YAxis yAxisId="right" orientation="right" stroke="#3b82f6" />
              <Tooltip
                formatter={(value: number, name: string) => {
                  if (name === 'cost') return formatCurrency(value);
                  return value;
                }}
              />
              <Legend />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="cost"
                stroke="#10b981"
                strokeWidth={2}
                name="Cost (USD)"
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="calls"
                stroke="#3b82f6"
                strokeWidth={2}
                name="Calls"
              />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Cost by Assistant */}
        <Card>
          <CardHeader>
            <CardTitle>Cost by Assistant</CardTitle>
            <CardDescription>Breakdown of costs per AI assistant</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Assistant</TableHead>
                  <TableHead className="text-right">Calls</TableHead>
                  <TableHead className="text-right">Minutes</TableHead>
                  <TableHead className="text-right">Cost</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.costByAssistant.map((item) => (
                  <TableRow key={item.assistantName}>
                    <TableCell className="font-medium">{item.assistantName}</TableCell>
                    <TableCell className="text-right">{item.calls}</TableCell>
                    <TableCell className="text-right">{item.minutes.toFixed(1)}</TableCell>
                    <TableCell className="text-right font-medium">
                      {formatCurrency(item.cost)}
                    </TableCell>
                  </TableRow>
                ))}
                {data.costByAssistant.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground">
                      No data available
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Cost Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle>Cost Breakdown</CardTitle>
            <CardDescription>Distribution by category</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* By Goal */}
            {data.currentPeriod.breakdown.goal && (
              <div>
                <h4 className="text-sm font-medium mb-2">By Goal Type</h4>
                <div className="space-y-2">
                  {Object.entries(data.currentPeriod.breakdown.goal).map(([goal, cost]) => (
                    <div key={goal} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{goal}</Badge>
                      </div>
                      <span className="font-medium">{formatCurrency(cost)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* By Direction */}
            {data.currentPeriod.breakdown.direction && (
              <div>
                <h4 className="text-sm font-medium mb-2">By Direction</h4>
                <div className="space-y-2">
                  {Object.entries(data.currentPeriod.breakdown.direction).map(([direction, cost]) => (
                    <div key={direction} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="capitalize">{direction}</Badge>
                      </div>
                      <span className="font-medium">{formatCurrency(cost)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
