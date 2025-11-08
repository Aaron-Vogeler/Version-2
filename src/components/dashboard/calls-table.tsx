'use client';

/**
 * Calls table with drill-down
 */

import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatPhoneNumber, formatDuration, formatCurrency, formatDateTime } from '@/lib/utils';
import { Call } from '@/lib/types/database';
import { Phone, Eye } from 'lucide-react';

interface CallsTableProps {
  calls: Call[];
  onViewDetails?: (call: Call) => void;
}

export function CallsTable({ calls, onViewDetails }: CallsTableProps) {
  const getStatusBadge = (status: string) => {
    const variants: Record<string, 'success' | 'warning' | 'destructive' | 'default'> = {
      completed: 'success',
      answered: 'success',
      ringing: 'warning',
      initiated: 'warning',
      failed: 'destructive',
      'no-answer': 'destructive',
      busy: 'destructive',
    };

    return (
      <Badge variant={variants[status] || 'default'}>
        {status.replace('-', ' ').toUpperCase()}
      </Badge>
    );
  };

  const getDirectionIcon = (direction: string) => {
    return direction === 'inbound' ? (
      <Phone className="h-4 w-4 rotate-180 text-green-600" />
    ) : (
      <Phone className="h-4 w-4 text-blue-600" />
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Calls</CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12"></TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Cost</TableHead>
              <TableHead>Goal</TableHead>
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground">
                  No calls found
                </TableCell>
              </TableRow>
            ) : (
              calls.map((call) => (
                <TableRow key={call.id} data-call-id={call.id}>
                  <TableCell>{getDirectionIcon(call.direction)}</TableCell>
                  <TableCell className="font-mono text-sm">
                    {formatPhoneNumber(call.from_e164)}
                  </TableCell>
                  <TableCell className="font-mono text-sm">
                    {formatPhoneNumber(call.to_e164)}
                  </TableCell>
                  <TableCell>{getStatusBadge(call.status)}</TableCell>
                  <TableCell className="text-sm">
                    {call.started_at ? formatDateTime(call.started_at) : '-'}
                  </TableCell>
                  <TableCell className="text-sm">
                    {formatDuration(call.duration_sec || 0)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {formatCurrency(Number(call.cost_usd) || 0)}
                  </TableCell>
                  <TableCell>
                    {call.goal ? (
                      <Badge variant={call.goal_status === 'achieved' ? 'success' : 'outline'}>
                        {call.goal}
                      </Badge>
                    ) : (
                      '-'
                    )}
                  </TableCell>
                  <TableCell>
                    {onViewDetails && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onViewDetails(call)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
