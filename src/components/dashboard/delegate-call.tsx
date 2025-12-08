'use client';

/**
 * Delegate A Call Component
 * 3-panel interface for configuring and testing AI phone calls
 * - Left: Call Settings
 * - Middle: Conversation/Call Actions
 * - Right: Context Visibility & LLM I/O
 */

import { useState, useRef, useEffect } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Phone,
  Send,
  CheckCircle2,
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Settings2,
  MessageSquare,
  Eye,
  EyeOff,
  FileText,
  RefreshCw,
  Maximize2,
  Edit3,
  Save,
  X
} from 'lucide-react';

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

/**
 * Turn represents a single conversation turn
 */
interface Turn {
  speaker: 'caller' | 'assistant' | 'agent' | 'ivr';
  text: string;
  timestamp: string;
}

/**
 * LLM Request/Response log entry
 */
interface LLMLogEntry {
  id: string;
  timestamp: string;
  type: 'request' | 'response';
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  response?: string;
  tokens?: { input?: number; output?: number };
}

interface DelegateCallProps {
  customAssistantName?: string;
  customUserName?: string;
}

// Default values for AI configuration
const DEFAULT_AI_CONFIG = {
  silenceTimeoutMs: 500,
  maxTurnsInWindow: 12,
  summaryUpdateInterval: 6,
  temperature: 0.7,
  maxTokens: 1024,
  topP: 1,
  model: 'llama-3.1-8b-instant',
};

// Default system prompt (matches ai-server config)
const DEFAULT_SYSTEM_PROMPT = `AI PHONE AGENT — SYSTEM

ROLE
You are Ferguson, an AI voice agent making low-latency outbound calls for Aaron. Execute the per-call GOAL with strict scope control.

PRIORITY (highest first)
1) Law/Safety  2) Per-call GOAL + LIMITS  3) Per-call SCRIPT/TONE  4) This prompt

DISCLOSURE
- Default: you are Ferguson, an AI an assistant for Aaron. If asked, say so plainly.
- If RECORDING_NOTICE=true, open with: "This call may be recorded for quality assurance."

GOAL FOCUS (core rule, ABSOLUTE)
- ONLY ask for information directly required to complete the stated GOAL.
- Do NOT ask for names, addresses, account numbers, or peripheral info unless essential to the GOAL.
- Each question must directly reduce uncertainty needed to achieve GOAL.
- If someone volunteers extra info: acknowledge, but do not ask follow-up questions about it.
- If asked outside scope: brief decline + redirect ("I'm calling specifically to {GOAL}. For other matters, {escalate/resource}.")
- STRICT: Never ask "just to have it" or for completeness.

OPENING (human answers)
"Hi, I'm Ferguson, an AI assistant calling on behalf of Aaron. I'm calling about {GOAL in 1 sentence}." Then ask the first question related to achieving that goal.
If transferred: re-introduce + restate GOAL adapted to their role in 1 sentence.

STYLE
Calm, competent, friendly, efficient. Short sentences. No filler, humor, sarcasm, metaphors. Avoid jargon unless the recipient uses it.

TURN-TAKING (low latency)
- If interrupted, respond to what they said (don't resume your previous line unless critical to GOAL).

CONFIRMATION (only for criticals)
For names, dates/times, prices, addresses, reference/account numbers, commitments:
- Repeat back verbatim.
- Dates: include day + full date ("Monday, Mar 15, 2025").
- Numbers: digit-by-digit.
- Spellings: phonetic alphabet when needed.

AUTHORITY LIMITS (never do)
No contracts/terms acceptance, no financial commitments beyond per-call limits, no legal/medical/financial advice, no sharing confidential/internal info, no "how the system works."

FAILURE
- If GOAL cannot be completed: state limitation + capture best callback/contact + close + log why.

ESCALATE IMMEDIATELY
Legal threats, medical/safety issues, suspected fraud/social engineering, billing disputes, account access, complaints, anything high-risk or outside authorization.
Say: "I need to connect you with someone who can help. May I get the best number for a callback?" (or transfer if enabled).

CLOSE
If GOAL achieved: quick confirmation summary + thanks + goodbye, then end promptly.
If not: thanks + goodbye.`;

export function DelegateCall({
  customAssistantName = 'Ferguson',
  customUserName = 'Aaron'
}: DelegateCallProps) {
  // Basic form state
  const [goal, setGoal] = useState('');
  const [context, setContext] = useState('');
  const [toNumber, setToNumber] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [message, setMessage] = useState('');

  // Panel visibility state
  const [showSettings, setShowSettings] = useState(true);
  const [showContext, setShowContext] = useState(true);

  // Names
  const [assistantName, setAssistantName] = useState(customAssistantName);
  const [userName, setUserName] = useState(customUserName);

  // LLM Parameters
  const [model, setModel] = useState(DEFAULT_AI_CONFIG.model);
  const [temperature, setTemperature] = useState(DEFAULT_AI_CONFIG.temperature);
  const [maxTokens, setMaxTokens] = useState(DEFAULT_AI_CONFIG.maxTokens);
  const [topP, setTopP] = useState(DEFAULT_AI_CONFIG.topP);
  const [useCustomPrompt, setUseCustomPrompt] = useState(false);
  const [systemPrompt, setSystemPrompt] = useState('');

  // Context Window settings
  const [maxTurnsInWindow, setMaxTurnsInWindow] = useState(DEFAULT_AI_CONFIG.maxTurnsInWindow);
  const [summaryUpdateInterval, setSummaryUpdateInterval] = useState(DEFAULT_AI_CONFIG.summaryUpdateInterval);
  const [silenceTimeoutMs, setSilenceTimeoutMs] = useState(DEFAULT_AI_CONFIG.silenceTimeoutMs);

  // Rolling Summary (editable)
  const [rollingSummary, setRollingSummary] = useState('');
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [editSummaryValue, setEditSummaryValue] = useState('');

  // Conversation turns (simulation)
  const [turns, setTurns] = useState<Turn[]>([]);
  const [turnsSinceSummary, setTurnsSinceSummary] = useState(0);

  // LLM I/O Log
  const [llmLogs, setLlmLogs] = useState<LLMLogEntry[]>([]);
  const [showSystemPromptPreview, setShowSystemPromptPreview] = useState(false);

  // Conversation input (for simulation mode)
  const [conversationInput, setConversationInput] = useState('');

  const llmLogRef = useRef<HTMLDivElement>(null);

  // Auto-scroll LLM logs
  useEffect(() => {
    if (llmLogRef.current) {
      llmLogRef.current.scrollTop = llmLogRef.current.scrollHeight;
    }
  }, [llmLogs]);

  // Build the effective system prompt with name replacements and goal injection
  const buildEffectiveSystemPrompt = () => {
    let prompt = useCustomPrompt && systemPrompt.trim()
      ? systemPrompt
      : DEFAULT_SYSTEM_PROMPT;

    // Replace names
    prompt = prompt.replace(/Ferguson/g, assistantName);
    prompt = prompt.replace(/ferguson/g, assistantName.toLowerCase());
    prompt = prompt.replace(/Aaron/g, userName);

    // Simplified goal injection (no template, just direct injection)
    if (goal.trim()) {
      prompt += `

CALL GOAL (YOUR ONLY MISSION):
"${goal.trim()}"`;
    }

    return prompt;
  };

  // Log an LLM interaction
  const logLLMInteraction = (entry: Omit<LLMLogEntry, 'id' | 'timestamp'>) => {
    const newEntry: LLMLogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };
    setLlmLogs(prev => [...prev, newEntry]);
  };

  // Handle starting edit of summary
  const handleEditSummary = () => {
    setEditSummaryValue(rollingSummary);
    setIsEditingSummary(true);
  };

  // Handle saving edited summary
  const handleSaveSummary = () => {
    setRollingSummary(editSummaryValue);
    setIsEditingSummary(false);
  };

  // Handle canceling edit
  const handleCancelEditSummary = () => {
    setIsEditingSummary(false);
    setEditSummaryValue('');
  };

  // Reset all settings to defaults
  const resetAllSettings = () => {
    setAssistantName(customAssistantName);
    setUserName(customUserName);
    setModel(DEFAULT_AI_CONFIG.model);
    setTemperature(DEFAULT_AI_CONFIG.temperature);
    setMaxTokens(DEFAULT_AI_CONFIG.maxTokens);
    setTopP(DEFAULT_AI_CONFIG.topP);
    setUseCustomPrompt(false);
    setSystemPrompt('');
    setMaxTurnsInWindow(DEFAULT_AI_CONFIG.maxTurnsInWindow);
    setSummaryUpdateInterval(DEFAULT_AI_CONFIG.summaryUpdateInterval);
    setSilenceTimeoutMs(DEFAULT_AI_CONFIG.silenceTimeoutMs);
    setGoal('');
    setContext('');
    setRollingSummary('');
    setTurns([]);
    setTurnsSinceSummary(0);
    setLlmLogs([]);
  };

  // Submit actual call
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStatus('idle');
    setMessage('');

    try {
      // Build AI config object
      const aiConfig: AIConfig = {};

      if (useCustomPrompt && systemPrompt.trim()) {
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

      // Log the request to LLM log
      const effectivePrompt = buildEffectiveSystemPrompt();
      logLLMInteraction({
        type: 'request',
        model,
        messages: [
          { role: 'system', content: effectivePrompt },
          ...(rollingSummary ? [{ role: 'user', content: `CALL CONTEXT SUMMARY:\n${rollingSummary}` }] : []),
          ...turns.map(t => ({
            role: t.speaker === 'assistant' ? 'assistant' : 'user',
            content: t.speaker === 'assistant' ? t.text : `[${t.speaker.toUpperCase()}] ${t.text}`
          })),
        ],
      });

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
          ...(Object.keys(aiConfig).length > 0 && { aiConfig }),
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
      setMessage('Call delegated successfully!');

      // Log successful call initiation
      logLLMInteraction({
        type: 'response',
        response: `Call initiated successfully. Call ID: ${data.flyResponse?.call_control_id || 'unknown'}`,
      });

    } catch (error: any) {
      console.error('Error delegating call:', error);
      setStatus('error');
      setMessage(error.message || 'Failed to delegate call. Please try again.');

      logLLMInteraction({
        type: 'response',
        response: `Error: ${error.message}`,
      });
    } finally {
      setLoading(false);
    }
  };

  // Simulate sending a message (for testing without making real calls)
  const handleSimulateSend = async () => {
    if (!conversationInput.trim()) return;

    // Add user turn
    const newTurn: Turn = {
      speaker: 'caller',
      text: conversationInput.trim(),
      timestamp: new Date().toISOString(),
    };

    setTurns(prev => [...prev, newTurn]);
    setTurnsSinceSummary(prev => prev + 1);
    setConversationInput('');

    // Log the LLM request
    const effectivePrompt = buildEffectiveSystemPrompt();
    logLLMInteraction({
      type: 'request',
      model,
      messages: [
        { role: 'system', content: effectivePrompt },
        ...(rollingSummary ? [{ role: 'user', content: `CALL CONTEXT SUMMARY:\n${rollingSummary}` }] : []),
        ...turns.map(t => ({
          role: t.speaker === 'assistant' ? 'assistant' : 'user',
          content: t.speaker === 'assistant' ? t.text : `[${t.speaker.toUpperCase()}] ${t.text}`
        })),
        { role: 'user', content: conversationInput.trim() },
      ],
    });

    // Simulate AI response (placeholder)
    setTimeout(() => {
      const simulatedResponse = `[Simulated response to: "${conversationInput.trim().slice(0, 30)}..."]`;
      const assistantTurn: Turn = {
        speaker: 'assistant',
        text: simulatedResponse,
        timestamp: new Date().toISOString(),
      };
      setTurns(prev => [...prev, assistantTurn]);
      setTurnsSinceSummary(prev => prev + 1);

      logLLMInteraction({
        type: 'response',
        response: simulatedResponse,
        tokens: { input: 150, output: 25 },
      });
    }, 500);
  };

  return (
    <div className="w-full space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Phone className="h-6 w-6" />
          <h2 className="text-2xl font-bold">Assign a call to {assistantName}</h2>
        </div>
        <div className="flex items-center gap-2">
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
            onClick={() => setShowContext(!showContext)}
          >
            {showContext ? <EyeOff className="h-4 w-4 mr-2" /> : <Eye className="h-4 w-4 mr-2" />}
            {showContext ? 'Hide' : 'Show'} Context
          </Button>
        </div>
      </div>

      {/* 3-Panel Layout */}
      <div className="grid grid-cols-12 gap-4">
        {/* Left Panel - Call Settings */}
        {showSettings && (
          <div className="col-span-3">
            <Card className="h-full">
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">Call Settings</h3>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                    <Maximize2 className="h-3 w-3" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">Configure the call</p>

                {/* Call Goal */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    <Label className="text-sm font-medium">Call Goal</Label>
                  </div>
                  <Textarea
                    placeholder="e.g., Get store hours for next Monday"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    className="resize-none text-sm"
                    rows={3}
                  />
                  <p className="text-xs text-muted-foreground">
                    The specific objective for this conversation
                  </p>
                </div>

                {/* Additional Context */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <FileText className="h-4 w-4" />
                    <Label className="text-sm font-medium">Additional Context</Label>
                  </div>
                  <Textarea
                    placeholder="e.g., The store is located in downtown Seattle"
                    value={context}
                    onChange={(e) => setContext(e.target.value)}
                    className="resize-none text-sm"
                    rows={2}
                  />
                  <p className="text-xs text-muted-foreground">
                    Background info for the assistant
                  </p>
                </div>

                {/* Names */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label className="text-xs">Assistant</Label>
                    <Input
                      value={assistantName}
                      onChange={(e) => setAssistantName(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">User</Label>
                    <Input
                      value={userName}
                      onChange={(e) => setUserName(e.target.value)}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>

                {/* LLM Parameters Section */}
                <div className="space-y-3 pt-2 border-t">
                  <Label className="text-sm font-medium">LLM Parameters</Label>

                  {/* Model */}
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Model</Label>
                    <select
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      className="w-full h-8 text-sm rounded-md border border-input bg-background px-3"
                    >
                      <option value="llama-3.1-8b-instant">Llama 3.1 8B Instant</option>
                      <option value="llama-3.1-70b-versatile">Llama 3.1 70B Versatile</option>
                      <option value="mixtral-8x7b-32768">Mixtral 8x7B</option>
                    </select>
                  </div>

                  {/* Temperature */}
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <Label className="text-xs text-muted-foreground">Temperature</Label>
                      <span className="text-xs text-muted-foreground">{temperature}</span>
                    </div>
                    <Input
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      value={temperature}
                      onChange={(e) => setTemperature(parseFloat(e.target.value) || 0)}
                      className="h-8 text-sm"
                    />
                  </div>

                  {/* Max Tokens */}
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <Label className="text-xs text-muted-foreground">Max Tokens</Label>
                      <span className="text-xs text-muted-foreground">{maxTokens}</span>
                    </div>
                    <Input
                      type="number"
                      min={1}
                      max={8192}
                      value={maxTokens}
                      onChange={(e) => setMaxTokens(parseInt(e.target.value) || 1024)}
                      className="h-8 text-sm"
                    />
                  </div>

                  {/* Top P */}
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <Label className="text-xs text-muted-foreground">Top P</Label>
                      <span className="text-xs text-muted-foreground">{topP}</span>
                    </div>
                    <Input
                      type="number"
                      min={0}
                      max={1}
                      step={0.1}
                      value={topP}
                      onChange={(e) => setTopP(parseFloat(e.target.value) || 1)}
                      className="h-8 text-sm"
                    />
                  </div>

                  {/* Custom System Prompt Toggle */}
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Custom System Prompt</Label>
                    <button
                      type="button"
                      onClick={() => setUseCustomPrompt(!useCustomPrompt)}
                      className={`px-2 py-1 text-xs rounded ${
                        useCustomPrompt
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {useCustomPrompt ? 'On' : 'Off'}
                    </button>
                  </div>

                  {useCustomPrompt && (
                    <Textarea
                      placeholder="Enter custom system prompt..."
                      value={systemPrompt}
                      onChange={(e) => setSystemPrompt(e.target.value)}
                      className="resize-none text-xs font-mono"
                      rows={4}
                    />
                  )}
                </div>

                {/* Reset Button */}
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={resetAllSettings}
                >
                  <RefreshCw className="h-3 w-3 mr-2" />
                  Reset All Settings
                </Button>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Middle Panel - Call Actions & Conversation */}
        <div className={`${showSettings && showContext ? 'col-span-6' : showSettings || showContext ? 'col-span-9' : 'col-span-12'}`}>
          <Card className="h-full">
            <CardContent className="p-4 flex flex-col h-full">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h3 className="font-semibold">Make Call</h3>
                  <p className="text-xs text-muted-foreground">
                    {turns.length} turns
                  </p>
                </div>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                  <Maximize2 className="h-3 w-3" />
                </Button>
              </div>

              {/* Phone Number & Submit */}
              <form onSubmit={handleSubmit} className="space-y-4 mb-4">
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
                    E.164 format (e.g., +14155551234)
                  </p>
                </div>

                {/* Status Message */}
                {status !== 'idle' && (
                  <div
                    className={`flex items-center gap-2 p-3 rounded-md text-sm ${
                      status === 'success'
                        ? 'bg-green-50 text-green-900 dark:bg-green-900/10 dark:text-green-400'
                        : 'bg-red-50 text-red-900 dark:bg-red-900/10 dark:text-red-400'
                    }`}
                  >
                    {status === 'success' ? (
                      <CheckCircle2 className="h-4 w-4" />
                    ) : (
                      <AlertCircle className="h-4 w-4" />
                    )}
                    <span>{message}</span>
                  </div>
                )}

                <Button
                  type="submit"
                  className="w-full"
                  disabled={loading || !goal || !toNumber}
                >
                  {loading ? (
                    <>
                      <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                      Delegating...
                    </>
                  ) : (
                    <>
                      <Phone className="mr-2 h-4 w-4" />
                      Delegate Call
                    </>
                  )}
                </Button>
              </form>

              {/* Conversation Display */}
              <div className="flex-1 border rounded-lg p-4 bg-muted/20 overflow-y-auto min-h-[200px] mb-4">
                {turns.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                    <MessageSquare className="h-8 w-8 mb-2 opacity-50" />
                    <p className="text-sm">No messages yet</p>
                    <p className="text-xs">Set a goal and start the conversation</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {turns.map((turn, index) => (
                      <div
                        key={index}
                        className={`flex ${turn.speaker === 'assistant' ? 'justify-start' : 'justify-end'}`}
                      >
                        <div
                          className={`max-w-[80%] p-2 rounded-lg text-sm ${
                            turn.speaker === 'assistant'
                              ? 'bg-muted'
                              : 'bg-primary text-primary-foreground'
                          }`}
                        >
                          <p className="text-xs opacity-70 mb-1">
                            {turn.speaker.toUpperCase()}
                          </p>
                          <p>{turn.text}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Simulation Input */}
              <div className="flex gap-2">
                <Input
                  placeholder="Type your message..."
                  value={conversationInput}
                  onChange={(e) => setConversationInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSimulateSend();
                    }
                  }}
                />
                <Button onClick={handleSimulateSend} disabled={!conversationInput.trim()}>
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Right Panel - Context Visibility */}
        {showContext && (
          <div className="col-span-3">
            <Card className="h-full">
              <CardContent className="p-4 space-y-4">
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">Context Visibility</h3>
                  <Button variant="ghost" size="sm" className="h-6 w-6 p-0">
                    <Maximize2 className="h-3 w-3" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">What's being sent to the LLM</p>

                {/* Rolling Summary - Editable */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <FileText className="h-4 w-4" />
                      <Label className="text-sm font-medium">Rolling Summary</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs bg-muted px-2 py-0.5 rounded">
                        {summaryUpdateInterval - turnsSinceSummary}/{summaryUpdateInterval} TURNS UNTIL UPDATE
                      </span>
                    </div>
                  </div>

                  {isEditingSummary ? (
                    <div className="space-y-2">
                      <Textarea
                        value={editSummaryValue}
                        onChange={(e) => setEditSummaryValue(e.target.value)}
                        className="resize-none text-xs font-mono"
                        rows={4}
                      />
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" onClick={handleSaveSummary}>
                          <Save className="h-3 w-3 mr-1" /> Save
                        </Button>
                        <Button size="sm" variant="ghost" onClick={handleCancelEditSummary}>
                          <X className="h-3 w-3 mr-1" /> Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="p-2 bg-muted/30 rounded text-xs font-mono min-h-[60px] cursor-pointer hover:bg-muted/50 transition-colors"
                      onClick={handleEditSummary}
                    >
                      {rollingSummary || (
                        <span className="text-muted-foreground italic">
                          No summary yet (generated after {summaryUpdateInterval} turns) - Click to edit
                        </span>
                      )}
                      <Edit3 className="h-3 w-3 float-right text-muted-foreground" />
                    </div>
                  )}
                </div>

                {/* Recent Turns */}
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    <Label className="text-sm font-medium">
                      Recent Turns ({Math.min(turns.length, maxTurnsInWindow)}/{maxTurnsInWindow} max)
                    </Label>
                  </div>
                  <div className="p-2 bg-muted/30 rounded text-xs font-mono max-h-[100px] overflow-y-auto">
                    {turns.length === 0 ? (
                      <span className="text-muted-foreground italic">No turns yet</span>
                    ) : (
                      turns.slice(-maxTurnsInWindow).map((turn, i) => (
                        <div key={i} className="mb-1">
                          <span className="text-muted-foreground">[{turn.speaker.toUpperCase()}]</span> {turn.text.slice(0, 50)}...
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* System Prompt Preview */}
                <div className="space-y-2">
                  <button
                    type="button"
                    className="flex items-center justify-between w-full text-left"
                    onClick={() => setShowSystemPromptPreview(!showSystemPromptPreview)}
                  >
                    <div className="flex items-center gap-2">
                      <Settings2 className="h-4 w-4" />
                      <Label className="text-sm font-medium cursor-pointer">System Prompt Preview</Label>
                    </div>
                    {showSystemPromptPreview ? (
                      <ChevronUp className="h-4 w-4" />
                    ) : (
                      <ChevronDown className="h-4 w-4" />
                    )}
                  </button>

                  {showSystemPromptPreview && (
                    <div className="p-2 bg-muted/30 rounded text-xs font-mono max-h-[150px] overflow-y-auto whitespace-pre-wrap">
                      {buildEffectiveSystemPrompt()}
                    </div>
                  )}
                </div>

                {/* Request Summary */}
                <div className="space-y-2 pt-2 border-t">
                  <Label className="text-sm font-medium">Request Summary</Label>
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    <span className="text-muted-foreground">Model:</span>
                    <span className="text-right font-mono">{model}</span>

                    <span className="text-muted-foreground">Temperature:</span>
                    <span className="text-right font-mono">{temperature}</span>

                    <span className="text-muted-foreground">Max Tokens:</span>
                    <span className="text-right font-mono">{maxTokens}</span>

                    <span className="text-muted-foreground">Goal Set:</span>
                    <span className="text-right font-mono">{goal ? 'Yes' : 'No'}</span>

                    <span className="text-muted-foreground">Summary Active:</span>
                    <span className="text-right font-mono">{rollingSummary ? 'Yes' : 'No'}</span>

                    <span className="text-muted-foreground">Turns in Context:</span>
                    <span className="text-right font-mono">{Math.min(turns.length, maxTurnsInWindow)}</span>
                  </div>
                </div>

                {/* LLM I/O Log */}
                <div className="space-y-2 pt-2 border-t">
                  <Label className="text-sm font-medium">LLM I/O Log</Label>
                  <div
                    ref={llmLogRef}
                    className="p-2 bg-muted/30 rounded text-xs font-mono max-h-[200px] overflow-y-auto"
                  >
                    {llmLogs.length === 0 ? (
                      <span className="text-muted-foreground italic">No LLM calls yet</span>
                    ) : (
                      llmLogs.map((log) => (
                        <div key={log.id} className="mb-2 pb-2 border-b border-muted last:border-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] ${
                              log.type === 'request'
                                ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                                : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                            }`}>
                              {log.type.toUpperCase()}
                            </span>
                            <span className="text-muted-foreground text-[10px]">
                              {new Date(log.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          {log.type === 'request' && log.messages && (
                            <div className="text-[10px] text-muted-foreground">
                              {log.messages.length} messages ({log.model})
                            </div>
                          )}
                          {log.type === 'response' && (
                            <div className="text-[10px]">
                              {log.response?.slice(0, 100)}...
                              {log.tokens && (
                                <span className="text-muted-foreground ml-1">
                                  (in:{log.tokens.input} out:{log.tokens.output})
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
