'use client';

/**
 * Groq Call Component
 * Make actual phone calls with Groq LLM customization and visual logs:
 * - Goal injection (dynamic, editable template)
 * - LLM parameter customization
 * - Full settings and context visibility
 * - Expandable panels
 * - Phone number input for actual calls
 * - Live LLM input/output logs during calls
 */

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase/client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Phone,
  Send,
  Settings2,
  Copy,
  Check,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Target,
  FileText,
  User,
  Bot,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  Code,
  PhoneCall,
  Brain,
  PhoneOff,
  Zap,
  Clock,
  MessageSquare,
  RefreshCw,
} from 'lucide-react';

// Model type from API
interface GroqModel {
  id: string;
  name: string;
  description: string;
}

// Context config from API
interface ContextConfig {
  maxTurnsInWindow: number;
  summaryUpdateIntervalTurns: number;
  maxSummaryTokensHint: number;
}

// LLM log record type
interface LlmLog {
  id: string;
  call_id: string;
  request_type: 'chat' | 'summary';
  model: string;
  temperature?: number;
  max_tokens?: number;
  system_prompt?: string;
  messages: Array<{ role: string; content: string }>;
  user_input?: string;
  assistant_response?: string;
  rolling_summary?: string;
  recent_turns_count?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  latency_ms?: number;
  created_at: string;
}

// Call status type
interface ActiveCall {
  id: string;
  status: 'initiated' | 'ringing' | 'answered' | 'completed' | 'failed';
  goal?: string;
  started_at?: string;
}

// Default goal injection template
const DEFAULT_GOAL_TEMPLATE = `CALL GOAL (YOUR ONLY MISSION):
"{goal}"

EXECUTION RULES FOR THIS CALL:
- Ask ONLY questions necessary to achieve the goal above
- Preserve the EXACT specificity of the goal (dates, times, details)
- Do NOT reinterpret dates/times (e.g., if goal says "next Monday", ask about "next Monday", not "tomorrow")
- Do NOT ask for names, store info, account details, or anything else unless directly needed
- Example: If goal is "get store hours for next Monday", ask ONLY about next Monday's hours—not tomorrow, not "the next day", not today
- When you have what you need: confirm it back ("Just to confirm, [info]. Is that correct?")
- After confirmation: end with "Thank you. Goodbye."
- Do NOT deviate from this goal

Remember: You are an AI assistant. Strict scope control is mandatory.`;

// Default system prompt placeholder
const DEFAULT_SYSTEM_PROMPT_PLACEHOLDER = 'Loading default system prompt...';

interface GroqCallProps {
  customAssistantName?: string;
  firstName?: string;
}

export function GroqCall({ customAssistantName = 'Ferguson', firstName = 'Aaron' }: GroqCallProps) {
  // Call state
  const [toNumber, setToNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  // Active call tracking for live LLM logs
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [llmLogs, setLlmLogs] = useState<LlmLog[]>([]);
  const [selectedLlmLog, setSelectedLlmLog] = useState<LlmLog | null>(null);
  const [showLlmLogModal, setShowLlmLogModal] = useState(false);
  const [expandedLlmLogs, setExpandedLlmLogs] = useState<Set<string>>(new Set());
  const [showLlmLogs, setShowLlmLogs] = useState(true);

  // Call-like context state
  const [goal, setGoal] = useState('');
  const [goalTemplate, setGoalTemplate] = useState(DEFAULT_GOAL_TEMPLATE);
  const [additionalContext, setAdditionalContext] = useState('');
  const [assistantName, setAssistantName] = useState(customAssistantName);
  const [userName, setUserName] = useState(firstName);

  // Settings state
  const [showSettings, setShowSettings] = useState(true);
  const [showContextPanel, setShowContextPanel] = useState(true);
  const [models, setModels] = useState<GroqModel[]>([]);
  const [selectedModel, setSelectedModel] = useState('llama-3.1-8b-instant');
  const [customSystemPrompt, setCustomSystemPrompt] = useState('');
  const [defaultSystemPrompt, setDefaultSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT_PLACEHOLDER);
  const [useCustomPrompt, setUseCustomPrompt] = useState(false);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [topP, setTopP] = useState(1);
  const [contextConfig, setContextConfig] = useState<ContextConfig>({
    maxTurnsInWindow: 12,
    summaryUpdateIntervalTurns: 6,
    maxSummaryTokensHint: 300,
  });

  // UI state
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [expandedSystemPrompt, setExpandedSystemPrompt] = useState(false);
  const [showGoalTemplateEditor, setShowGoalTemplateEditor] = useState(false);

  // Expanded panel states
  const [expandedPanel, setExpandedPanel] = useState<'settings' | 'call' | 'context' | 'logs' | null>(null);

  // Update names when props change
  useEffect(() => {
    setAssistantName(customAssistantName);
  }, [customAssistantName]);

  useEffect(() => {
    setUserName(firstName);
  }, [firstName]);

  // Load available models and defaults on mount
  useEffect(() => {
    loadModels();
  }, []);

  // Subscribe to call status updates
  useEffect(() => {
    if (!activeCall?.id) return;

    const supabase = createClient();

    const channel = supabase
      .channel(`call-status-${activeCall.id}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'calls',
          filter: `id=eq.${activeCall.id}`,
        },
        (payload) => {
          const updatedCall = payload.new as any;
          setActiveCall((prev) =>
            prev ? { ...prev, status: updatedCall.status } : null
          );
          // Clear active call when completed or failed
          if (['completed', 'failed'].includes(updatedCall.status)) {
            // Keep the logs visible but mark as inactive
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeCall?.id]);

  // Subscribe to LLM logs for active call
  useEffect(() => {
    if (!activeCall?.id) return;

    const supabase = createClient();

    // Initial fetch of existing logs
    const fetchLogs = async () => {
      try {
        const res = await fetch(`/api/calls/${activeCall.id}/llm-logs`);
        if (res.ok) {
          const data = await res.json();
          setLlmLogs(data.logs || []);
        }
      } catch (err) {
        console.error('Failed to fetch LLM logs:', err);
      }
    };
    fetchLogs();

    // Subscribe to new logs
    const channel = supabase
      .channel(`llm-logs-${activeCall.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'call_llm_logs',
          filter: `call_id=eq.${activeCall.id}`,
        },
        (payload) => {
          const newLog = payload.new as LlmLog;
          setLlmLogs((prev) => [...prev, newLog]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [activeCall?.id]);

  const loadModels = async () => {
    try {
      const res = await fetch('/api/groq-chat');
      if (res.ok) {
        const data = await res.json();
        setModels(data.models || []);
        if (data.defaultModel) {
          setSelectedModel(data.defaultModel);
        }
        if (data.defaultSettings) {
          setTemperature(data.defaultSettings.temperature);
          setMaxTokens(data.defaultSettings.max_tokens);
          setTopP(data.defaultSettings.top_p);
        }
        if (data.defaultSystemPrompt) {
          setDefaultSystemPrompt(data.defaultSystemPrompt);
        }
        if (data.contextConfig) {
          setContextConfig(data.contextConfig);
        }
      }
    } catch (err) {
      console.error('Failed to load models:', err);
    }
  };

  // Build the full system prompt (for display)
  const buildFullSystemPrompt = () => {
    let prompt = useCustomPrompt ? customSystemPrompt : defaultSystemPrompt;

    // Replace names
    const finalAssistantName = assistantName || 'Ferguson';
    const finalUserName = userName || 'Aaron';
    prompt = prompt.replace(/Ferguson/g, finalAssistantName);
    prompt = prompt.replace(/ferguson/g, finalAssistantName.toLowerCase());
    prompt = prompt.replace(/Aaron/g, finalUserName);

    // Add goal with template
    if (goal) {
      const processedGoalTemplate = goalTemplate.replace('{goal}', goal);
      prompt += '\n\n' + processedGoalTemplate;
    }

    // Add context
    if (additionalContext) {
      prompt += `\n\nADDITIONAL CONTEXT:\n${additionalContext}`;
    }

    return prompt;
  };

  const handleDelegateCall = async () => {
    if (!goal || !toNumber) return;

    setLoading(true);
    setStatus('idle');
    setMessage('');
    setLlmLogs([]); // Clear previous logs

    try {
      const response = await fetch('/api/delegate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          goal,
          context: additionalContext,
          to_number: toNumber,
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Please sign in to delegate calls');
        }
        throw new Error(data.error || `Request failed: ${response.status}`);
      }

      setStatus('success');
      setMessage('Call delegated successfully! LLM logs will appear below as the call progresses.');

      // Extract call ID from response to track LLM logs
      const callControlId = data.flyResponse?.call_control_id;
      if (callControlId) {
        setActiveCall({
          id: callControlId,
          status: 'initiated',
          goal: goal,
          started_at: new Date().toISOString(),
        });
      }

      // Clear phone number only, keep settings for potential re-use
      setToNumber('');
    } catch (error: any) {
      console.error('Error delegating call:', error);
      setStatus('error');
      setMessage(error.message || 'Failed to delegate call. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleClearActiveCall = () => {
    setActiveCall(null);
    setLlmLogs([]);
  };

  const handleCopyPrompt = () => {
    navigator.clipboard.writeText(buildFullSystemPrompt());
    setCopiedPrompt(true);
    setTimeout(() => setCopiedPrompt(false), 2000);
  };

  const handleResetSettings = () => {
    setGoal('');
    setGoalTemplate(DEFAULT_GOAL_TEMPLATE);
    setAdditionalContext('');
    setAssistantName(customAssistantName);
    setUserName(firstName);
    setUseCustomPrompt(false);
    setCustomSystemPrompt('');
    setTemperature(0.7);
    setMaxTokens(1024);
    setTopP(1);
    if (models.length > 0) {
      setSelectedModel(models[0].id);
    }
  };

  // Helper functions for LLM logs
  const toggleLlmLogExpanded = (logId: string) => {
    setExpandedLlmLogs((prev) => {
      const next = new Set(prev);
      if (next.has(logId)) {
        next.delete(logId);
      } else {
        next.add(logId);
      }
      return next;
    });
  };

  const formatLogTime = (timestamp: string) => {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  // Calculate LLM log totals
  const totalLlmTokens = llmLogs.reduce((sum, log) => sum + (log.total_tokens || 0), 0);
  const avgLlmLatency = llmLogs.length > 0
    ? Math.round(llmLogs.reduce((sum, log) => sum + (log.latency_ms || 0), 0) / llmLogs.length)
    : 0;

  const isCallActive = activeCall && ['initiated', 'ringing', 'answered'].includes(activeCall.status);

  // Render expandable panel wrapper
  const renderPanel = (
    panelKey: 'settings' | 'call' | 'context' | 'logs',
    title: string,
    description: string,
    content: React.ReactNode,
    defaultColSpan: string
  ) => {
    const isExpanded = expandedPanel === panelKey;

    if (expandedPanel && expandedPanel !== panelKey) {
      return null; // Hide other panels when one is expanded
    }

    return (
      <Card className={isExpanded ? 'xl:col-span-12' : defaultColSpan}>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-lg">{title}</CardTitle>
              <CardDescription>{description}</CardDescription>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpandedPanel(isExpanded ? null : panelKey)}
              title={isExpanded ? 'Minimize' : 'Expand'}
            >
              {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            </Button>
          </div>
        </CardHeader>
        <CardContent className={isExpanded ? 'max-h-[calc(100vh-200px)] overflow-y-auto' : ''}>
          {content}
        </CardContent>
      </Card>
    );
  };

  // Settings panel content
  const settingsContent = (
    <div className="space-y-5">
      {/* Goal */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="goal" className="flex items-center gap-2">
            <Target className="h-4 w-4" />
            Call Goal <span className="text-destructive">*</span>
          </Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowGoalTemplateEditor(true)}
            className="h-6 text-xs"
            title="Edit goal injection template"
          >
            <Code className="h-3 w-3 mr-1" />
            Template
          </Button>
        </div>
        <Textarea
          id="goal"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="e.g., Get store hours for next Monday"
          className="min-h-[80px] resize-none text-sm"
          maxLength={250}
        />
        <div className="flex justify-between">
          <p className="text-xs text-muted-foreground">
            The specific objective for this call
          </p>
          <p className="text-xs text-muted-foreground">
            {goal.length}/250
          </p>
        </div>
      </div>

      {/* Additional Context */}
      <div className="space-y-2">
        <Label htmlFor="context" className="flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Additional Context
        </Label>
        <Textarea
          id="context"
          value={additionalContext}
          onChange={(e) => setAdditionalContext(e.target.value)}
          placeholder="e.g., The store is located in downtown Seattle"
          className="min-h-[60px] resize-none text-sm"
          maxLength={500}
        />
        <div className="flex justify-between">
          <p className="text-xs text-muted-foreground">
            Background info for the assistant
          </p>
          <p className="text-xs text-muted-foreground">
            {additionalContext.length}/500
          </p>
        </div>
      </div>

      {/* Names */}
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="assistantName" className="flex items-center gap-1 text-xs">
            <Bot className="h-3 w-3" />
            Assistant
          </Label>
          <Input
            id="assistantName"
            value={assistantName}
            onChange={(e) => setAssistantName(e.target.value)}
            placeholder="Ferguson"
            className="text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="userName" className="flex items-center gap-1 text-xs">
            <User className="h-3 w-3" />
            User
          </Label>
          <Input
            id="userName"
            value={userName}
            onChange={(e) => setUserName(e.target.value)}
            placeholder="Aaron"
            className="text-sm"
          />
        </div>
      </div>

      {/* Divider */}
      <div className="border-t border-border/50 pt-4">
        <p className="text-xs font-medium text-muted-foreground mb-3">LLM Parameters (for call)</p>
      </div>

      {/* Model Selection */}
      <div className="space-y-2">
        <Label htmlFor="model">Model</Label>
        <Select value={selectedModel} onValueChange={setSelectedModel}>
          <SelectTrigger className="text-sm">
            <SelectValue placeholder="Select a model" />
          </SelectTrigger>
          <SelectContent>
            {models.map((model) => (
              <SelectItem key={model.id} value={model.id}>
                {model.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Temperature */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="temperature" className="text-sm">Temperature</Label>
          <span className="text-xs text-muted-foreground font-mono">{temperature}</span>
        </div>
        <Input
          id="temperature"
          type="number"
          min="0"
          max="2"
          step="0.1"
          value={temperature}
          onChange={(e) => setTemperature(parseFloat(e.target.value) || 0)}
          className="text-sm"
        />
      </div>

      {/* Max Tokens */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="maxTokens" className="text-sm">Max Tokens</Label>
          <span className="text-xs text-muted-foreground font-mono">{maxTokens}</span>
        </div>
        <Input
          id="maxTokens"
          type="number"
          min="1"
          max="32768"
          step="64"
          value={maxTokens}
          onChange={(e) => setMaxTokens(parseInt(e.target.value) || 1024)}
          className="text-sm"
        />
      </div>

      {/* Top P */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="topP" className="text-sm">Top P</Label>
          <span className="text-xs text-muted-foreground font-mono">{topP}</span>
        </div>
        <Input
          id="topP"
          type="number"
          min="0"
          max="1"
          step="0.05"
          value={topP}
          onChange={(e) => setTopP(parseFloat(e.target.value) || 1)}
          className="text-sm"
        />
      </div>

      {/* Custom System Prompt Toggle */}
      <div className="border-t border-border/50 pt-4">
        <div className="flex items-center justify-between mb-2">
          <Label className="text-sm">Custom System Prompt</Label>
          <Button
            variant={useCustomPrompt ? 'default' : 'outline'}
            size="sm"
            onClick={() => setUseCustomPrompt(!useCustomPrompt)}
            className="h-7 text-xs"
          >
            {useCustomPrompt ? 'On' : 'Off'}
          </Button>
        </div>
        {useCustomPrompt && (
          <Textarea
            value={customSystemPrompt}
            onChange={(e) => setCustomSystemPrompt(e.target.value)}
            placeholder="Enter your custom system prompt..."
            className="min-h-[100px] resize-none text-xs font-mono"
          />
        )}
      </div>

      {/* Reset Button */}
      <Button
        variant="outline"
        size="sm"
        onClick={handleResetSettings}
        className="w-full"
      >
        <RotateCcw className="h-4 w-4 mr-2" />
        Reset All Settings
      </Button>
    </div>
  );

  // Call panel content
  const callContent = (
    <div className="space-y-6">
      {/* Phone Number Input */}
      <div className="space-y-2">
        <Label htmlFor="to_number" className="flex items-center gap-2">
          <Phone className="h-4 w-4" />
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
          className="text-lg"
        />
        <p className="text-xs text-muted-foreground">
          Enter phone number in E.164 format (e.g., +14155551234)
        </p>
      </div>

      {/* Call Summary */}
      <div className="bg-muted/30 rounded-lg p-4 space-y-3">
        <h4 className="text-sm font-medium">Call Preview</h4>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Goal:</span>
            <span className="font-mono text-right max-w-[200px] truncate">{goal || '(not set)'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Context:</span>
            <span className="font-mono text-right max-w-[200px] truncate">
              {additionalContext ? `${additionalContext.slice(0, 30)}...` : '(none)'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Assistant:</span>
            <span className="font-mono">{assistantName || 'Ferguson'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Calling on behalf of:</span>
            <span className="font-mono">{userName || 'Aaron'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Model:</span>
            <span className="font-mono text-xs">{selectedModel}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Temperature:</span>
            <span className="font-mono">{temperature}</span>
          </div>
        </div>
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
        onClick={handleDelegateCall}
        className="w-full h-12 text-lg"
        disabled={loading || !goal || !toNumber}
      >
        {loading ? (
          <>
            <div className="mr-2 h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
            Delegating Call...
          </>
        ) : (
          <>
            <PhoneCall className="mr-2 h-5 w-5" />
            Make Call
          </>
        )}
      </Button>

      {/* Requirements Note */}
      {(!goal || !toNumber) && (
        <p className="text-xs text-muted-foreground text-center">
          {!goal && !toNumber
            ? 'Set a goal and enter a phone number to make a call'
            : !goal
            ? 'Set a goal to continue'
            : 'Enter a phone number to continue'}
        </p>
      )}
    </div>
  );

  // Context panel content
  const contextContent = (
    <div className="space-y-4">
      {/* Built System Prompt Preview */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-2 text-sm font-medium">
            <Settings2 className="h-4 w-4" />
            System Prompt Preview
          </Label>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCopyPrompt}
              className="h-6 text-xs"
            >
              {copiedPrompt ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
              {copiedPrompt ? 'Copied!' : 'Copy'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setExpandedSystemPrompt(!expandedSystemPrompt)}
              className="h-6 text-xs"
            >
              {expandedSystemPrompt ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
          </div>
        </div>
        <div className={`bg-muted/30 rounded-md p-3 text-xs font-mono overflow-y-auto ${expandedSystemPrompt || expandedPanel === 'context' ? 'max-h-[500px]' : 'max-h-[200px]'}`}>
          <pre className="whitespace-pre-wrap">
            {buildFullSystemPrompt()}
          </pre>
        </div>
      </div>

      {/* Goal Template Preview */}
      {goal && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm font-medium">
            <Target className="h-4 w-4" />
            Goal Injection (added to prompt)
          </Label>
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-md p-3 text-xs font-mono max-h-[150px] overflow-y-auto">
            <pre className="whitespace-pre-wrap">
              {goalTemplate.replace('{goal}', goal)}
            </pre>
          </div>
        </div>
      )}

      {/* Additional Context Preview */}
      {additionalContext && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm font-medium">
            <FileText className="h-4 w-4" />
            Additional Context (added to prompt)
          </Label>
          <div className="bg-green-50 dark:bg-green-900/20 rounded-md p-3 text-xs font-mono max-h-[100px] overflow-y-auto">
            <pre className="whitespace-pre-wrap">{additionalContext}</pre>
          </div>
        </div>
      )}

      {/* Current Config Summary */}
      <div className="border-t border-border/50 pt-4">
        <Label className="text-xs font-medium text-muted-foreground mb-2 block">Configuration Summary</Label>
        <div className="bg-muted/30 rounded-md p-3 text-xs space-y-1">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Model:</span>
            <span className="font-mono">{selectedModel}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Temperature:</span>
            <span className="font-mono">{temperature}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Max Tokens:</span>
            <span className="font-mono">{maxTokens}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Top P:</span>
            <span className="font-mono">{topP}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Goal Set:</span>
            <span className="font-mono">{goal ? 'Yes' : 'No'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Context Set:</span>
            <span className="font-mono">{additionalContext ? 'Yes' : 'No'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Custom Prompt:</span>
            <span className="font-mono">{useCustomPrompt ? 'Yes' : 'No'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Phone Number:</span>
            <span className="font-mono">{toNumber || '(not set)'}</span>
          </div>
        </div>
      </div>

      {/* Info Box */}
      <div className="bg-muted/20 border border-border/50 rounded-md p-3">
        <p className="text-xs text-muted-foreground">
          This panel shows exactly what configuration will be used when you make a call.
          The system prompt, goal injection, and context are combined to guide your AI assistant's behavior during the call.
        </p>
      </div>
    </div>
  );

  // LLM Logs panel content
  const logsContent = (
    <div className="space-y-4">
      {/* Active Call Header */}
      {activeCall && (
        <div className="flex items-center justify-between p-3 bg-muted/30 rounded-lg">
          <div className="flex items-center gap-3">
            {isCallActive ? (
              <Badge variant="success" className="animate-pulse">
                <span className="h-2 w-2 rounded-full bg-green-500 mr-2" />
                {activeCall.status.charAt(0).toUpperCase() + activeCall.status.slice(1)}
              </Badge>
            ) : (
              <Badge variant="secondary">
                <PhoneOff className="h-3 w-3 mr-1" />
                {activeCall.status.charAt(0).toUpperCase() + activeCall.status.slice(1)}
              </Badge>
            )}
            <span className="text-sm text-muted-foreground truncate max-w-[200px]">
              {activeCall.goal}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {llmLogs.length > 0 && (
              <>
                <Badge variant="outline" className="gap-1">
                  <Zap className="h-3 w-3" />
                  {totalLlmTokens.toLocaleString()}
                </Badge>
                <Badge variant="outline" className="gap-1">
                  <Clock className="h-3 w-3" />
                  ~{avgLlmLatency}ms
                </Badge>
              </>
            )}
            {!isCallActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearActiveCall}
                className="h-7 text-xs"
              >
                Clear
              </Button>
            )}
          </div>
        </div>
      )}

      {/* LLM Logs List */}
      {!activeCall ? (
        <div className="text-center py-8 text-muted-foreground">
          <Brain className="h-10 w-10 mx-auto mb-3 opacity-20" />
          <p>No active call</p>
          <p className="text-xs mt-1">Make a call to see live LLM logs</p>
        </div>
      ) : llmLogs.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground">
          <Brain className="h-10 w-10 mx-auto mb-3 opacity-20" />
          {isCallActive ? (
            <>
              <RefreshCw className="h-5 w-5 mx-auto mb-2 animate-spin" />
              <p>Waiting for LLM interactions...</p>
              <p className="text-xs mt-1">Logs will appear as the AI processes the call</p>
            </>
          ) : (
            <>
              <p>No LLM logs recorded</p>
              <p className="text-xs mt-1">The call may have ended before any LLM interactions</p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
          {llmLogs.map((log) => {
            const isExpanded = expandedLlmLogs.has(log.id);
            return (
              <div
                key={log.id}
                className={`border rounded-lg p-3 ${
                  log.request_type === 'summary'
                    ? 'bg-blue-50/50 dark:bg-blue-900/10 border-blue-200 dark:border-blue-800'
                    : 'bg-card'
                }`}
              >
                {/* Log Header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <Badge
                      variant={log.request_type === 'summary' ? 'secondary' : 'default'}
                      className="text-xs"
                    >
                      {log.request_type === 'summary' ? (
                        <>
                          <FileText className="h-3 w-3 mr-1" />
                          Summary
                        </>
                      ) : (
                        <>
                          <MessageSquare className="h-3 w-3 mr-1" />
                          Chat
                        </>
                      )}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      {formatLogTime(log.created_at)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {log.total_tokens && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Zap className="h-3 w-3" />
                        {log.total_tokens}
                      </span>
                    )}
                    {log.latency_ms && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {log.latency_ms}ms
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleLlmLogExpanded(log.id)}
                      className="h-6 w-6 p-0"
                    >
                      {isExpanded ? (
                        <ChevronUp className="h-4 w-4" />
                      ) : (
                        <ChevronDown className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>

                {/* User Input Preview */}
                {log.user_input && (
                  <div className="mb-2">
                    <p className="text-xs text-muted-foreground mb-1">Input:</p>
                    <div className="bg-muted/50 rounded p-2 text-xs font-mono max-h-16 overflow-hidden">
                      {log.user_input.slice(0, 150)}
                      {log.user_input.length > 150 && '...'}
                    </div>
                  </div>
                )}

                {/* Assistant Response Preview */}
                {log.assistant_response && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Output:</p>
                    <div className="bg-green-50 dark:bg-green-900/20 rounded p-2 text-xs font-mono max-h-16 overflow-hidden">
                      {log.assistant_response.slice(0, 200)}
                      {log.assistant_response.length > 200 && '...'}
                    </div>
                  </div>
                )}

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="mt-3 pt-3 border-t border-border/50 space-y-3">
                    {/* Model & Parameters */}
                    <div className="flex flex-wrap gap-2">
                      <Badge variant="outline" className="text-xs">{log.model}</Badge>
                      {log.temperature !== undefined && (
                        <Badge variant="outline" className="text-xs">Temp: {log.temperature}</Badge>
                      )}
                      {log.recent_turns_count !== undefined && (
                        <Badge variant="outline" className="text-xs">{log.recent_turns_count} turns</Badge>
                      )}
                    </div>

                    {/* Rolling Summary */}
                    {log.rolling_summary && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Rolling Summary:</p>
                        <div className="bg-muted/30 rounded p-2 text-xs font-mono max-h-20 overflow-y-auto">
                          {log.rolling_summary}
                        </div>
                      </div>
                    )}

                    {/* Full User Input */}
                    {log.user_input && log.user_input.length > 150 && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Full Input:</p>
                        <div className="bg-muted/50 rounded p-2 text-xs font-mono max-h-32 overflow-y-auto">
                          {log.user_input}
                        </div>
                      </div>
                    )}

                    {/* Full Response */}
                    {log.assistant_response && log.assistant_response.length > 200 && (
                      <div>
                        <p className="text-xs text-muted-foreground mb-1">Full Output:</p>
                        <div className="bg-green-50 dark:bg-green-900/20 rounded p-2 text-xs font-mono max-h-32 overflow-y-auto">
                          {log.assistant_response}
                        </div>
                      </div>
                    )}

                    {/* View Full Details Button */}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSelectedLlmLog(log);
                        setShowLlmLogModal(true);
                      }}
                      className="text-xs"
                    >
                      <Code className="h-3 w-3 mr-1" />
                      View Full Messages Array
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-2">
          <PhoneCall className="h-6 w-6" />
          <h2 className="text-2xl font-bold">Groq Call</h2>
          <Badge variant="secondary" className="ml-2">
            Make Real Calls
          </Badge>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {isCallActive && (
            <Badge variant="success" className="gap-1 animate-pulse">
              <span className="h-2 w-2 rounded-full bg-green-500 mr-1" />
              Call Active
            </Badge>
          )}
          {goal && !isCallActive && (
            <Badge variant="outline" className="gap-1">
              <Target className="h-3 w-3" />
              Goal Set
            </Badge>
          )}
          {toNumber && !isCallActive && (
            <Badge variant="success" className="gap-1">
              <Phone className="h-3 w-3" />
              Ready to Call
            </Badge>
          )}
          {llmLogs.length > 0 && (
            <Badge variant="outline" className="gap-1">
              <Brain className="h-3 w-3" />
              {llmLogs.length} LLM Calls
            </Badge>
          )}
          {!expandedPanel && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowSettings(!showSettings)}
              >
                <Settings2 className="h-4 w-4 mr-2" />
                {showSettings ? 'Hide' : 'Show'} Settings
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowContextPanel(!showContextPanel)}
              >
                {showContextPanel ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
                {showContextPanel ? 'Hide' : 'Show'} Context
              </Button>
              <Button
                variant={showLlmLogs ? 'default' : 'outline'}
                size="sm"
                onClick={() => setShowLlmLogs(!showLlmLogs)}
              >
                <Brain className="h-4 w-4 mr-2" />
                {showLlmLogs ? 'Hide' : 'Show'} LLM Logs
              </Button>
            </>
          )}
          {expandedPanel && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setExpandedPanel(null)}
            >
              <Minimize2 className="h-4 w-4 mr-2" />
              Exit Fullscreen
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Settings Panel */}
        {(showSettings || expandedPanel === 'settings') &&
          renderPanel(
            'settings',
            'Call Settings',
            'Configure the call parameters',
            settingsContent,
            'xl:col-span-3'
          )}

        {/* Call Panel */}
        {(!expandedPanel || expandedPanel === 'call') &&
          renderPanel(
            'call',
            'Make a Call',
            'Enter phone number and delegate',
            callContent,
            `${showSettings && showContextPanel ? 'xl:col-span-5' : showSettings || showContextPanel ? 'xl:col-span-8' : 'xl:col-span-12'}`
          )}

        {/* Context Visibility Panel */}
        {(showContextPanel || expandedPanel === 'context') &&
          renderPanel(
            'context',
            'Context Visibility',
            "What's being configured for the call",
            contextContent,
            'xl:col-span-4'
          )}
      </div>

      {/* LLM Logs Panel - Separate full-width section below */}
      {(showLlmLogs || expandedPanel === 'logs') && (
        <div className="mt-6">
          {renderPanel(
            'logs',
            'Live LLM Logs',
            activeCall ? `Call ${activeCall.id.slice(-8)} - ${llmLogs.length} interactions` : 'Real-time AI input/output during calls',
            logsContent,
            'xl:col-span-12'
          )}
        </div>
      )}

      {/* Goal Template Editor Dialog */}
      <Dialog open={showGoalTemplateEditor} onOpenChange={setShowGoalTemplateEditor}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Goal Injection Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <p className="text-sm text-muted-foreground">
              This template is appended to the system prompt when a goal is set. Use <code className="bg-muted px-1 rounded">{'{goal}'}</code> as a placeholder for the actual goal text.
            </p>
            <Textarea
              value={goalTemplate}
              onChange={(e) => setGoalTemplate(e.target.value)}
              className="min-h-[300px] font-mono text-sm"
            />
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setGoalTemplate(DEFAULT_GOAL_TEMPLATE)}
              >
                Reset to Default
              </Button>
              <Button onClick={() => setShowGoalTemplateEditor(false)}>
                Done
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* LLM Log Detail Modal */}
      <Dialog open={showLlmLogModal} onOpenChange={setShowLlmLogModal}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>LLM Interaction Details</DialogTitle>
          </DialogHeader>
          {selectedLlmLog && (
            <div className="space-y-4 py-4">
              {/* Metadata */}
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">Type: {selectedLlmLog.request_type}</Badge>
                <Badge variant="outline">Model: {selectedLlmLog.model}</Badge>
                {selectedLlmLog.temperature !== undefined && (
                  <Badge variant="outline">Temp: {selectedLlmLog.temperature}</Badge>
                )}
                {selectedLlmLog.max_tokens && (
                  <Badge variant="outline">Max Tokens: {selectedLlmLog.max_tokens}</Badge>
                )}
                {selectedLlmLog.latency_ms && (
                  <Badge variant="outline">Latency: {selectedLlmLog.latency_ms}ms</Badge>
                )}
                {selectedLlmLog.total_tokens && (
                  <Badge variant="outline">
                    Tokens: {selectedLlmLog.prompt_tokens} + {selectedLlmLog.completion_tokens} = {selectedLlmLog.total_tokens}
                  </Badge>
                )}
              </div>

              {/* System Prompt */}
              {selectedLlmLog.system_prompt && (
                <div>
                  <p className="text-sm font-medium mb-2">System Prompt</p>
                  <div className="bg-purple-50 dark:bg-purple-900/20 rounded-md p-3 text-xs font-mono max-h-60 overflow-y-auto">
                    <pre className="whitespace-pre-wrap">{selectedLlmLog.system_prompt}</pre>
                  </div>
                </div>
              )}

              {/* Rolling Summary */}
              {selectedLlmLog.rolling_summary && (
                <div>
                  <p className="text-sm font-medium mb-2">
                    Rolling Summary ({selectedLlmLog.recent_turns_count || 0} turns in context)
                  </p>
                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded-md p-3 text-xs font-mono max-h-40 overflow-y-auto">
                    <pre className="whitespace-pre-wrap">{selectedLlmLog.rolling_summary}</pre>
                  </div>
                </div>
              )}

              {/* Full Messages Array */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-sm font-medium">Messages Array ({selectedLlmLog.messages.length} messages)</p>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(JSON.stringify(selectedLlmLog.messages, null, 2));
                    }}
                    className="text-xs"
                  >
                    <Copy className="h-3 w-3 mr-1" />
                    Copy JSON
                  </Button>
                </div>
                <div className="space-y-2 max-h-80 overflow-y-auto">
                  {selectedLlmLog.messages.map((msg, i) => (
                    <div
                      key={i}
                      className={`rounded-md p-3 text-xs ${
                        msg.role === 'system'
                          ? 'bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800'
                          : msg.role === 'assistant'
                          ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800'
                          : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <Badge variant="outline" className="text-xs font-mono">
                          [{i}] {msg.role.toUpperCase()}
                        </Badge>
                        <span className="text-muted-foreground">
                          {msg.content.length.toLocaleString()} chars
                        </span>
                      </div>
                      <pre className="whitespace-pre-wrap font-mono">{msg.content}</pre>
                    </div>
                  ))}
                </div>
              </div>

              {/* User Input */}
              {selectedLlmLog.user_input && (
                <div>
                  <p className="text-sm font-medium mb-2">User Input (this turn)</p>
                  <div className="bg-green-50 dark:bg-green-900/20 rounded-md p-3 text-xs font-mono">
                    <pre className="whitespace-pre-wrap">{selectedLlmLog.user_input}</pre>
                  </div>
                </div>
              )}

              {/* Assistant Response */}
              {selectedLlmLog.assistant_response && (
                <div>
                  <p className="text-sm font-medium mb-2">Assistant Response</p>
                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded-md p-3 text-xs font-mono">
                    <pre className="whitespace-pre-wrap">{selectedLlmLog.assistant_response}</pre>
                  </div>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
