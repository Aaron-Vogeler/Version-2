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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Phone, Send, CheckCircle2, AlertCircle } from 'lucide-react';

export function DelegateCall() {
  const [goal, setGoal] = useState('');
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
      // Trigger the webhook
      const response = await fetch('https://telnyx-webhook.aaronmvogeler.workers.dev', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          goal,
          to_number: toNumber,
        }),
      });

      if (!response.ok) {
        throw new Error(`Webhook failed: ${response.status} ${response.statusText}`);
      }

      setStatus('success');
      setMessage('Call delegated successfully!');

      // Clear form
      setGoal('');
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
        <h2 className="text-2xl font-bold">Delegate A Call</h2>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create Outbound Call</CardTitle>
          <CardDescription>
            Delegate a call to an AI assistant by specifying the goal and phone number
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Goal Field */}
            <div className="space-y-2">
              <Label htmlFor="goal">
                Goal <span className="text-destructive">*</span>
              </Label>
              <Select value={goal} onValueChange={setGoal} required>
                <SelectTrigger id="goal">
                  <SelectValue placeholder="Select a goal" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sales">Sales</SelectItem>
                  <SelectItem value="support">Support</SelectItem>
                  <SelectItem value="survey">Survey</SelectItem>
                  <SelectItem value="appointment">Appointment</SelectItem>
                  <SelectItem value="followup">Follow-up</SelectItem>
                  <SelectItem value="reminder">Reminder</SelectItem>
                  <SelectItem value="verification">Verification</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The purpose of this call
              </p>
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

      {/* Instructions Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">How It Works</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-2">
          <ol className="list-decimal list-inside space-y-1">
            <li>Select the goal for this call (e.g., Sales, Support)</li>
            <li>Enter the phone number to call in E.164 format</li>
            <li>Click &quot;Delegate Call&quot; to initiate the outbound call</li>
            <li>The AI assistant will handle the call based on the goal</li>
            <li>View call results in the &quot;Billing&quot; or &quot;All Calls&quot; tab</li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
