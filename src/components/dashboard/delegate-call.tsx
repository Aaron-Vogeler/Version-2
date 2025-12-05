'use client';

/**
 * Delegate A Call Component
 * Form to trigger outbound calls via webhook
 */

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Phone, Send, CheckCircle2, AlertCircle } from 'lucide-react';

interface DelegateCallProps {
  customAssistantName?: string;
}

export function DelegateCall({ customAssistantName = 'your AI assistant' }: DelegateCallProps) {
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [toNumber, setToNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStatus('idle');
    setMessage('');

    try {
      // Call secure API proxy (authenticated)
      const response = await fetch('/api/delegate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          goal,
          context,
          to_number: toNumber,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        // Handle specific error messages from API
        if (response.status === 401) {
          throw new Error('Please sign in to delegate calls');
        }
        throw new Error(data.error || `Request failed: ${response.status}`);
      }

      setStatus('success');
      setMessage('Call delegated successfully!');

      // Clear form
      setGoal('');
      setContext('');
      setToNumber('');
    } catch (error: any) {
      console.error('Error delegating call:', error);
      setStatus('error');
      setMessage(error.message || 'Failed to delegate call. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Phone className="h-6 w-6" />
        <h2 className="text-2xl font-bold">Assign a call to {customAssistantName}</h2>
      </div>

      <Card>
        <CardContent className="pt-6">
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* End Goal Field */}
            <div className="space-y-2">
              <Label htmlFor="goal">
                End Goal <span className="text-destructive">*</span>
              </Label>
              <Textarea
                id="goal"
                placeholder="Describe the goal for this call..."
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                maxLength={250}
                required
                className="resize-none min-h-[100px]"
                style={{
                  height: 'auto',
                  minHeight: '100px',
                  maxHeight: '300px'
                }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = 'auto';
                  target.style.height = Math.min(target.scrollHeight, 300) + 'px';
                }}
              />
              <div className="flex justify-between">
                <p className="text-xs text-muted-foreground">
                  Describe the purpose and desired outcome of this call
                </p>
                <p className="text-xs text-muted-foreground">
                  {goal.length}/250
                </p>
              </div>
            </div>

            {/* Context Field */}
            <div className="space-y-2">
              <Label htmlFor="context">
                Context
              </Label>
              <Textarea
                id="context"
                placeholder="Provide additional context for this call..."
                value={context}
                onChange={(e) => setContext(e.target.value)}
                maxLength={500}
                className="resize-none min-h-[100px]"
                style={{
                  height: 'auto',
                  minHeight: '100px',
                  maxHeight: '300px'
                }}
                onInput={(e) => {
                  const target = e.target as HTMLTextAreaElement;
                  target.style.height = 'auto';
                  target.style.height = Math.min(target.scrollHeight, 300) + 'px';
                }}
              />
              <div className="flex justify-between">
                <p className="text-xs text-muted-foreground">
                  Optional: Provide background information or specific details
                </p>
                <p className="text-xs text-muted-foreground">
                  {context.length}/500
                </p>
              </div>
            </div>

            {/* Number To Call Field */}
            <div className="space-y-2">
              <Label htmlFor="to_number">
                Number To Call <span className="text-destructive">*</span>
              </Label>
              <Input
                id="to_number"
                type="tel"
                placeholder="+1234567890"
                value={toNumber}
                onChange={(e) => setToNumber(e.target.value)}
                required
                pattern="^\+?[1-9]\d{1,14}$"
              />
              <p className="text-xs text-muted-foreground">
                Enter phone number in E.164 format (e.g., +14155551234)
              </p>
            </div>

            {/* Status Message */}
            {status !== 'idle' && (
              <div
                className={`flex items-center gap-2 p-3 rounded-md ${
                  status === 'success'
                    ? 'bg-green-50 text-green-900 dark:bg-green-900/10 dark:text-green-400'
                    : 'bg-red-50 text-red-900 dark:bg-red-900/10 dark:text-red-400'
                }`}
              >
                {status === 'success' ? (
                  <CheckCircle2 className="h-5 w-5" />
                ) : (
                  <AlertCircle className="h-5 w-5" />
                )}
                <span className="text-sm font-medium">{message}</span>
              </div>
            )}

            {/* Submit Button */}
            <Button
              type="submit"
              className="w-full"
              disabled={loading || !goal || !toNumber}
            >
              {loading ? (
                <>
                  <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  Delegating Call...
                </>
              ) : (
                <>
                  <Send className="mr-2 h-4 w-4" />
                  Delegate Call
                </>
              )}
            </Button>
          </form>
        </CardContent>
      </Card>

    </div>
  );
}
