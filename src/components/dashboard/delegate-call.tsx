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
import { Phone, Send, CheckCircle2, AlertCircle, ChevronDown, ChevronUp, Settings2 } from 'lucide-react';

/**
 * AI Configuration for per-call customization
 */
interface AIConfig {
  systemPrompt?: string;
  summaryPrompt?: string;
  maxTurnsInWindow?: number;
  summaryUpdateInterval?: number;
  silenceTimeoutMs?: number;
}

interface DelegateCallProps {
  customAssistantName?: string;
}

// Default values for AI configuration
const DEFAULT_AI_CONFIG = {
  silenceTimeoutMs: 500,
  maxTurnsInWindow: 12,
  summaryUpdateInterval: 6,
};

export function DelegateCall({ customAssistantName = 'your AI assistant' }: DelegateCallProps) {
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [toNumber, setToNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  // Advanced Settings state
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');
  const [silenceTimeoutMs, setSilenceTimeoutMs] = useState(DEFAULT_AI_CONFIG.silenceTimeoutMs);
  const [maxTurnsInWindow, setMaxTurnsInWindow] = useState(DEFAULT_AI_CONFIG.maxTurnsInWindow);
  const [summaryUpdateInterval, setSummaryUpdateInterval] = useState(DEFAULT_AI_CONFIG.summaryUpdateInterval);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStatus('idle');
    setMessage('');

    try {
      // Build AI config object (only include non-default values to minimize payload)
      const aiConfig: AIConfig = {};
      if (systemPrompt.trim()) {
        aiConfig.systemPrompt = systemPrompt.trim();
      }
      if (silenceTimeoutMs !== DEFAULT_AI_CONFIG.silenceTimeoutMs) {
        aiConfig.silenceTimeoutMs = silenceTimeoutMs;
      }
      if (maxTurnsInWindow !== DEFAULT_AI_CONFIG.maxTurnsInWindow) {
        aiConfig.maxTurnsInWindow = maxTurnsInWindow;
      }
      if (summaryUpdateInterval !== DEFAULT_AI_CONFIG.summaryUpdateInterval) {
        aiConfig.summaryUpdateInterval = summaryUpdateInterval;
      }

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
          // Only include aiConfig if it has any values
          ...(Object.keys(aiConfig).length > 0 && { aiConfig }),
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

      // Reset advanced settings to defaults
      setSystemPrompt('');
      setSilenceTimeoutMs(DEFAULT_AI_CONFIG.silenceTimeoutMs);
      setMaxTurnsInWindow(DEFAULT_AI_CONFIG.maxTurnsInWindow);
      setSummaryUpdateInterval(DEFAULT_AI_CONFIG.summaryUpdateInterval);
      setShowAdvanced(false);
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

            {/* Advanced Settings Accordion */}
            <div className="border rounded-lg">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center justify-between w-full p-4 text-left hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2">
                  <Settings2 className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">Advanced Settings</span>
                </div>
                {showAdvanced ? (
                  <ChevronUp className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                )}
              </button>

              {showAdvanced && (
                <div className="p-4 pt-0 space-y-4 border-t">
                  {/* System Prompt */}
                  <div className="space-y-2">
                    <Label htmlFor="system_prompt">
                      Custom System Prompt
                    </Label>
                    <Textarea
                      id="system_prompt"
                      placeholder="Leave empty to use the default system prompt. Enter a custom prompt to override the AI's behavior for this call..."
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      className="resize-none min-h-[100px]"
                      style={{
                        height: 'auto',
                        minHeight: '100px',
                        maxHeight: '200px'
                      }}
                      onInput={(e) => {
                        const target = e.target as HTMLTextAreaElement;
                        target.style.height = 'auto';
                        target.style.height = Math.min(target.scrollHeight, 200) + 'px';
                      }}
                    />
                    <p className="text-xs text-muted-foreground">
                      Optional: Override the default AI system prompt for this call
                    </p>
                  </div>

                  {/* Silence Wait Time */}
                  <div className="space-y-2">
                    <Label htmlFor="silence_timeout">
                      Silence Wait Time: {silenceTimeoutMs}ms
                    </Label>
                    <div className="flex items-center gap-4">
                      <input
                        id="silence_timeout"
                        type="range"
                        min="200"
                        max="2000"
                        step="100"
                        value={silenceTimeoutMs}
                        onChange={(e) => setSilenceTimeoutMs(Number(e.target.value))}
                        className="flex-1 h-2 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                      />
                      <Input
                        type="number"
                        min={200}
                        max={2000}
                        step={100}
                        value={silenceTimeoutMs}
                        onChange={(e) => setSilenceTimeoutMs(Math.min(2000, Math.max(200, Number(e.target.value))))}
                        className="w-24"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      How long to wait for silence before responding (200-2000ms, default: 500ms)
                    </p>
                  </div>

                  {/* Context Window */}
                  <div className="space-y-2">
                    <Label htmlFor="max_turns">
                      Context Window (Turns)
                    </Label>
                    <Input
                      id="max_turns"
                      type="number"
                      min={4}
                      max={24}
                      value={maxTurnsInWindow}
                      onChange={(e) => setMaxTurnsInWindow(Math.min(24, Math.max(4, Number(e.target.value))))}
                      className="w-32"
                    />
                    <p className="text-xs text-muted-foreground">
                      Number of recent conversation turns to keep in memory (4-24, default: 12)
                    </p>
                  </div>

                  {/* Summary Cadence */}
                  <div className="space-y-2">
                    <Label htmlFor="summary_interval">
                      Summary Update Cadence (Turns)
                    </Label>
                    <Input
                      id="summary_interval"
                      type="number"
                      min={2}
                      max={12}
                      value={summaryUpdateInterval}
                      onChange={(e) => setSummaryUpdateInterval(Math.min(12, Math.max(2, Number(e.target.value))))}
                      className="w-32"
                    />
                    <p className="text-xs text-muted-foreground">
                      How often to update the rolling call summary (2-12 turns, default: 6)
                    </p>
                  </div>

                  {/* Reset to Defaults Button */}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSystemPrompt('');
                      setSilenceTimeoutMs(DEFAULT_AI_CONFIG.silenceTimeoutMs);
                      setMaxTurnsInWindow(DEFAULT_AI_CONFIG.maxTurnsInWindow);
                      setSummaryUpdateInterval(DEFAULT_AI_CONFIG.summaryUpdateInterval);
                    }}
                  >
                    Reset to Defaults
                  </Button>
                </div>
              )}
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
