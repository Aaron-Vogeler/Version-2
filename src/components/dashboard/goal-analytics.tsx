'use client';

/**
 * Goal Analytics Component
 * Shows goal performance trends, success rates, and time-to-goal metrics
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, Legend } from 'recharts';
import { Target, TrendingUp, Clock } from 'lucide-react';

interface GoalAnalytics {
  goalTrends: {
    date: string;
    achieved: number;
    failed: number;
    pending: number;
  }[];
  goalsByType: {
    goal: string;
    total: number;
    achieved: number;
    successRate: number;
    avgTimeToGoal: number;
  }[];
  topPerformingGoals: {
    goal: string;
    successRate: number;
    avgDuration: number;
  }[];
}

interface GoalAnalyticsProps {
  data: GoalAnalytics;
}

const COLORS = ['#10b981', '#ef4444', '#f59e0b', '#3b82f6', '#8b5cf6'];

export function GoalAnalytics({ data }: GoalAnalyticsProps) {
  const pieData = data.goalsByType.map((item) => ({
    name: item.goal,
    value: item.achieved,
  }));

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Target className="h-6 w-6" />
        <h2 className="text-2xl font-bold">Goal Analytics</h2>
      </div>

      {/* Top Performing Goals */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {data.topPerformingGoals.slice(0, 3).map((goal, idx) => (
          <Card key={goal.goal}>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium flex items-center justify-between">
                <span>{goal.goal}</span>
                <Badge variant={idx === 0 ? 'success' : 'default'}>
                  #{idx + 1}
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Success Rate</span>
                  <span className="text-lg font-bold">{goal.successRate.toFixed(1)}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Avg Duration</span>
                  <span className="text-sm font-medium">{Math.floor(goal.avgDuration / 60)}m</span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Goal Trends Over Time */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Goal Trends
            </CardTitle>
            <CardDescription>Achievement trends over the last 30 days</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <LineChart data={data.goalTrends}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value) => {
                    const date = new Date(value);
                    return `${date.getMonth() + 1}/${date.getDate()}`;
                  }}
                />
                <YAxis />
                <Tooltip />
                <Legend />
                <Line type="monotone" dataKey="achieved" stroke="#10b981" strokeWidth={2} name="Achieved" />
                <Line type="monotone" dataKey="failed" stroke="#ef4444" strokeWidth={2} name="Failed" />
                <Line type="monotone" dataKey="pending" stroke="#f59e0b" strokeWidth={2} name="Pending" />
              </LineChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        {/* Success by Goal Type */}
        <Card>
          <CardHeader>
            <CardTitle>Success by Goal Type</CardTitle>
            <CardDescription>Distribution of achieved goals</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  labelLine={false}
                  label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                  outerRadius={80}
                  fill="#8884d8"
                  dataKey="value"
                >
                  {pieData.map((entry, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Goal Breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Goal Performance Details
          </CardTitle>
          <CardDescription>Success rates and average time to achieve each goal</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={data.goalsByType}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="goal" />
              <YAxis yAxisId="left" orientation="left" stroke="#10b981" />
              <YAxis yAxisId="right" orientation="right" stroke="#3b82f6" />
              <Tooltip />
              <Legend />
              <Bar yAxisId="left" dataKey="successRate" fill="#10b981" name="Success Rate (%)" />
              <Bar yAxisId="right" dataKey="avgTimeToGoal" fill="#3b82f6" name="Avg Time (sec)" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
