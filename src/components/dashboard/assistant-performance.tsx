'use client';

/**
 * Assistant Performance Component
 * Tracks metrics per assistant: success rate, response time, call volume
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Bot, TrendingUp, Zap, Target } from 'lucide-react';

interface AssistantMetrics {
  assistantId: string;
  assistantName: string;
  totalCalls: number;
  completedCalls: number;
  goalSuccessRate: number;
  avgResponseTime: number;
  avgCallDuration: number;
  totalCost: number;
}

interface AssistantPerformanceProps {
  metrics: AssistantMetrics[];
}

export function AssistantPerformance({ metrics }: AssistantPerformanceProps) {
  const topAssistants = [...metrics].sort((a, b) => b.goalSuccessRate - a.goalSuccessRate).slice(0, 3);

  const chartData = metrics.map((m) => ({
    name: m.assistantName,
    successRate: m.goalSuccessRate,
    responseTime: m.avgResponseTime / 1000, // Convert to seconds
    calls: m.totalCalls,
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Bot className="h-6 w-6" />
        <h2 className="text-2xl font-bold">AI Assistant Performance</h2>
      </div>

      {/* Top Assistants */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {topAssistants.map((assistant, idx) => (
          <Card key={assistant.assistantId}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center justify-between">
                <span className="truncate">{assistant.assistantName}</span>
                <Badge variant={idx === 0 ? 'success' : 'default'}>
                  #{idx + 1}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Target className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Success Rate</span>
                </div>
                <span className="text-lg font-bold text-green-600">
                  {assistant.goalSuccessRate.toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Response Time</span>
                </div>
                <span className="text-sm font-medium">
                  {(assistant.avgResponseTime / 1000).toFixed(2)}s
                </span>
              </div>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Total Calls</span>
                </div>
                <span className="text-sm font-medium">{assistant.totalCalls}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Performance Chart */}
      <Card>
        <CardHeader>
          <CardTitle>Performance Comparison</CardTitle>
          <CardDescription>Success rate and response time across assistants</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="name" />
              <YAxis yAxisId="left" orientation="left" stroke="#10b981" />
              <YAxis yAxisId="right" orientation="right" stroke="#3b82f6" />
              <Tooltip />
              <Legend />
              <Bar yAxisId="left" dataKey="successRate" fill="#10b981" name="Success Rate (%)" />
              <Bar yAxisId="right" dataKey="responseTime" fill="#3b82f6" name="Response Time (s)" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Detailed Metrics Table */}
      <Card>
        <CardHeader>
          <CardTitle>Detailed Metrics</CardTitle>
          <CardDescription>Complete performance breakdown by assistant</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Assistant</TableHead>
                <TableHead className="text-right">Total Calls</TableHead>
                <TableHead className="text-right">Completed</TableHead>
                <TableHead className="text-right">Success Rate</TableHead>
                <TableHead className="text-right">Avg Response</TableHead>
                <TableHead className="text-right">Avg Duration</TableHead>
                <TableHead className="text-right">Total Cost</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metrics.map((assistant) => (
                <TableRow key={assistant.assistantId}>
                  <TableCell className="font-medium">{assistant.assistantName}</TableCell>
                  <TableCell className="text-right">{assistant.totalCalls}</TableCell>
                  <TableCell className="text-right">{assistant.completedCalls}</TableCell>
                  <TableCell className="text-right">
                    <Badge variant={assistant.goalSuccessRate > 70 ? 'success' : 'default'}>
                      {assistant.goalSuccessRate.toFixed(1)}%
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {(assistant.avgResponseTime / 1000).toFixed(2)}s
                  </TableCell>
                  <TableCell className="text-right">
                    {Math.floor(assistant.avgCallDuration / 60)}m {assistant.avgCallDuration % 60}s
                  </TableCell>
                  <TableCell className="text-right">
                    ${assistant.totalCost.toFixed(4)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
