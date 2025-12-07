'use client';

/**
 * Groq Text Chat Component
 * Direct text interaction with Groq LLM with call-like features:
 * - Goal injection (dynamic)
 * - Rolling summary generation
 * - Recent turns context window
 * - Full settings and context visibility
 */

import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  MessageSquare,
  Send,
  Settings2,
  Trash2,
  Copy,
  Check,
  AlertCircle,
  Zap,
  Clock,
  Hash,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Target,
  FileText,
  User,
  Bot,
  RefreshCw,
  Eye,
  EyeOff,
} from 'lucide-react';

// Model type from API
interface GroqModel {
  id: string;
  name: string;
  description: string;
}

// Turn type for conversation history
interface Turn {
  speaker: 'caller' | 'assistant' | 'user';
  text: string;
  timestamp: string;
}

// Chat message type for display
interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  latency_ms?: number;
  model?: string;
  builtContext?: {
    systemPrompt: string;
    rollingSummaryIncluded: boolean;
    turnsIncluded: number;
    totalMessagesInRequest: number;
  };
}

// Context config from API
interface ContextConfig {
  maxTurnsInWindow: number;
  summaryUpdateIntervalTurns: number;
  maxSummaryTokensHint: number;
}

// Default system prompt placeholder
const DEFAULT_SYSTEM_PROMPT_PLACEHOLDER = 'Loading default system prompt...';

export function GroqTextChat() {
  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Call-like context state
  const [goal, setGoal] = useState('');
  const [additionalContext, setAdditionalContext] = useState('');
  const [assistantName, setAssistantName] = useState('Ferguson');
  const [userName, setUserName] = useState('Aaron');
  const [rollingSummary, setRollingSummary] = useState('');
  const [lastSummaryTurnIndex, setLastSummaryTurnIndex] = useState(-1);
  const [generatingSummary, setGeneratingSummary] = useState(false);

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
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedSystemPrompt, setExpandedSystemPrompt] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load available models and defaults on mount
  useEffect(() => {
    loadModels();
  }, []);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Check if we should generate a summary
  useEffect(() => {
    const newTurnsSinceLastSummary = turns.length - (lastSummaryTurnIndex + 1);
    if (newTurnsSinceLastSummary >= contextConfig.summaryUpdateIntervalTurns && !generatingSummary) {
      generateSummary();
    }
  }, [turns, lastSummaryTurnIndex, contextConfig.summaryUpdateIntervalTurns]);

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

  const generateSummary = async () => {
    if (turns.length === 0 || generatingSummary) return;

    setGeneratingSummary(true);
    try {
      const turnsForSummary = turns.slice(lastSummaryTurnIndex + 1);

      const res = await fetch('/api/groq-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestType: 'generate_summary',
          turns: turnsForSummary,
          rollingSummary: rollingSummary || undefined,
          model: selectedModel,
        }),
      });

      const data = await res.json();

      if (res.ok && data.summary) {
        setRollingSummary(data.summary);
        setLastSummaryTurnIndex(turns.length - 1);
      }
    } catch (err) {
      console.error('Failed to generate summary:', err);
    } finally {
      setGeneratingSummary(false);
    }
  };

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || loading) return;

    const userMessageText = inputMessage.trim();
    const timestamp = new Date();

    // Add to display messages
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userMessageText,
      timestamp,
    };
    setMessages((prev) => [...prev, userMessage]);

    // Add to turns
    const userTurn: Turn = {
      speaker: 'user',
      text: userMessageText,
      timestamp: timestamp.toISOString(),
    };
    setTurns((prev) => [...prev, userTurn]);

    setInputMessage('');
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/groq-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userMessage: userMessageText,
          goal: goal || undefined,
          additionalContext: additionalContext || undefined,
          assistantName: assistantName || undefined,
          userName: userName || undefined,
          turns: turns.slice(-contextConfig.maxTurnsInWindow),
          rollingSummary: rollingSummary || undefined,
          model: selectedModel,
          temperature,
          max_tokens: maxTokens,
          top_p: topP,
          customSystemPrompt: useCustomPrompt ? customSystemPrompt : undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to get response');
      }

      const assistantTimestamp = new Date();

      // Add to display messages
      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: data.response,
        timestamp: assistantTimestamp,
        usage: data.usage,
        latency_ms: data.latency_ms,
        model: data.model,
        builtContext: data.builtContext,
      };
      setMessages((prev) => [...prev, assistantMessage]);

      // Add to turns
      const assistantTurn: Turn = {
        speaker: 'assistant',
        text: data.response,
        timestamp: assistantTimestamp.toISOString(),
      };
      setTurns((prev) => [...prev, assistantTurn]);
    } catch (err: any) {
      console.error('Chat error:', err);
      setError(err.message || 'Failed to send message');
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleClearChat = () => {
    setMessages([]);
    setTurns([]);
    setRollingSummary('');
    setLastSummaryTurnIndex(-1);
    setError(null);
  };

  const handleCopyMessage = (id: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleResetSettings = () => {
    setGoal('');
    setAdditionalContext('');
    setAssistantName('Ferguson');
    setUserName('Aaron');
    setUseCustomPrompt(false);
    setCustomSystemPrompt('');
    setTemperature(0.7);
    setMaxTokens(1024);
    setTopP(1);
    if (models.length > 0) {
      setSelectedModel(models[0].id);
    }
  };

  // Calculate total tokens used in conversation
  const totalTokensUsed = messages.reduce((sum, msg) => {
    return sum + (msg.usage?.total_tokens || 0);
  }, 0);

  // Get the current built system prompt for preview
  const getBuiltSystemPromptPreview = () => {
    let prompt = useCustomPrompt ? customSystemPrompt : defaultSystemPrompt;

    // Replace names
    const finalAssistantName = assistantName || 'Ferguson';
    const finalUserName = userName || 'Aaron';
    prompt = prompt.replace(/Ferguson/g, finalAssistantName);
    prompt = prompt.replace(/ferguson/g, finalAssistantName.toLowerCase());
    prompt = prompt.replace(/Aaron/g, finalUserName);

    // Add goal
    if (goal) {
      prompt += `\n\nCALL GOAL (YOUR ONLY MISSION):\n"${goal}"\n\nEXECUTION RULES FOR THIS CALL:\n- Ask ONLY questions necessary to achieve the goal above\n- Preserve the EXACT specificity of the goal\n- When you have what you need: confirm it back\n- After confirmation: end with "Thank you. Goodbye."\n- Do NOT deviate from this goal`;
    }

    // Add context
    if (additionalContext) {
      prompt += `\n\nADDITIONAL CONTEXT:\n${additionalContext}`;
    }

    return prompt;
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-6 w-6" />
          <h2 className="text-2xl font-bold">Groq Text Chat</h2>
          <Badge variant="secondary" className="ml-2">
            Call Simulation Mode
          </Badge>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {totalTokensUsed > 0 && (
            <Badge variant="outline" className="gap-1">
              <Hash className="h-3 w-3" />
              {totalTokensUsed.toLocaleString()} tokens
            </Badge>
          )}
          {rollingSummary && (
            <Badge variant="success" className="gap-1">
              <FileText className="h-3 w-3" />
              Summary Active
            </Badge>
          )}
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
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Settings Panel */}
        {showSettings && (
          <Card className="xl:col-span-3">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">Call Settings</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleResetSettings}
                  title="Reset to defaults"
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </div>
              <CardDescription>Configure the simulated call</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5 max-h-[calc(100vh-300px)] overflow-y-auto">
              {/* Goal */}
              <div className="space-y-2">
                <Label htmlFor="goal" className="flex items-center gap-2">
                  <Target className="h-4 w-4" />
                  Call Goal
                </Label>
                <Textarea
                  id="goal"
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  placeholder="e.g., Get store hours for next Monday"
                  className="min-h-[80px] resize-none text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  The specific objective for this conversation
                </p>
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
                />
                <p className="text-xs text-muted-foreground">
                  Background info for the assistant
                </p>
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
                <p className="text-xs font-medium text-muted-foreground mb-3">LLM Parameters</p>
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
            </CardContent>
          </Card>
        )}

        {/* Chat Panel */}
        <Card className={`${showSettings && showContextPanel ? 'xl:col-span-5' : showSettings || showContextPanel ? 'xl:col-span-8' : 'xl:col-span-12'}`}>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">Conversation</CardTitle>
                <CardDescription>
                  {turns.length} turns • {messages.filter((m) => m.role === 'assistant').length} responses
                </CardDescription>
              </div>
              {messages.length > 0 && (
                <Button variant="outline" size="sm" onClick={handleClearChat}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Clear
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Messages Area */}
            <div className="border rounded-lg bg-muted/20 min-h-[400px] max-h-[500px] overflow-y-auto p-4 space-y-4">
              {messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-[350px] text-center text-muted-foreground">
                  <MessageSquare className="h-12 w-12 mb-4 opacity-20" />
                  <p className="text-lg font-medium">No messages yet</p>
                  <p className="text-sm">Set a goal and start the conversation</p>
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`flex flex-col gap-2 ${
                      msg.role === 'user' ? 'items-end' : 'items-start'
                    }`}
                  >
                    {/* Message Header */}
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge
                        variant={msg.role === 'user' ? 'default' : 'secondary'}
                        className="text-xs"
                      >
                        {msg.role === 'user' ? userName || 'You' : assistantName || 'Assistant'}
                      </Badge>
                      <span>
                        {msg.timestamp.toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </div>

                    {/* Message Content */}
                    <div
                      className={`relative group max-w-[90%] rounded-lg px-4 py-3 ${
                        msg.role === 'user'
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-card border border-border/50'
                      }`}
                    >
                      <pre className="whitespace-pre-wrap font-sans text-sm">
                        {msg.content}
                      </pre>

                      {/* Copy Button */}
                      <button
                        onClick={() => handleCopyMessage(msg.id, msg.content)}
                        className={`absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity ${
                          msg.role === 'user'
                            ? 'hover:bg-primary-foreground/20'
                            : 'hover:bg-muted'
                        }`}
                      >
                        {copiedId === msg.id ? (
                          <Check className="h-3 w-3" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                    </div>

                    {/* Message Stats (for assistant messages) */}
                    {msg.role === 'assistant' && (msg.usage || msg.latency_ms) && (
                      <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
                        {msg.latency_ms && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {msg.latency_ms}ms
                          </span>
                        )}
                        {msg.usage && (
                          <span className="flex items-center gap-1">
                            <Zap className="h-3 w-3" />
                            {msg.usage.total_tokens} tokens
                          </span>
                        )}
                        {msg.builtContext && (
                          <span className="text-xs opacity-60">
                            ({msg.builtContext.totalMessagesInRequest} msgs sent)
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Error Message */}
            {error && (
              <div className="flex items-center gap-2 p-3 rounded-md bg-red-50 text-red-900 dark:bg-red-900/10 dark:text-red-400">
                <AlertCircle className="h-5 w-5 flex-shrink-0" />
                <span className="text-sm">{error}</span>
              </div>
            )}

            {/* Input Area */}
            <div className="flex gap-3">
              <Textarea
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={goal ? `Respond as the caller about: ${goal.slice(0, 50)}...` : 'Type your message...'}
                className="flex-1 min-h-[60px] max-h-[150px] resize-none"
                disabled={loading}
              />
              <Button
                onClick={handleSendMessage}
                disabled={loading || !inputMessage.trim()}
                className="self-end h-[60px] px-6"
              >
                {loading ? (
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Context Visibility Panel */}
        {showContextPanel && (
          <Card className="xl:col-span-4">
            <CardHeader className="pb-4">
              <CardTitle className="text-lg">Context Visibility</CardTitle>
              <CardDescription>What's being sent to the LLM</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4 max-h-[calc(100vh-300px)] overflow-y-auto">
              {/* Rolling Summary */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-2 text-sm font-medium">
                    <FileText className="h-4 w-4" />
                    Rolling Summary
                  </Label>
                  <div className="flex items-center gap-2">
                    {generatingSummary && (
                      <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />
                    )}
                    <Badge variant="outline" className="text-xs">
                      {turns.length - (lastSummaryTurnIndex + 1)}/{contextConfig.summaryUpdateIntervalTurns} turns until update
                    </Badge>
                  </div>
                </div>
                <div className="bg-muted/30 rounded-md p-3 text-xs font-mono min-h-[60px] max-h-[120px] overflow-y-auto">
                  {rollingSummary || <span className="text-muted-foreground italic">No summary yet (generated after {contextConfig.summaryUpdateIntervalTurns} turns)</span>}
                </div>
                {rollingSummary && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={generateSummary}
                    disabled={generatingSummary}
                    className="w-full text-xs"
                  >
                    <RefreshCw className={`h-3 w-3 mr-2 ${generatingSummary ? 'animate-spin' : ''}`} />
                    Regenerate Summary
                  </Button>
                )}
              </div>

              {/* Recent Turns */}
              <div className="space-y-2">
                <Label className="flex items-center gap-2 text-sm font-medium">
                  <MessageSquare className="h-4 w-4" />
                  Recent Turns ({Math.min(turns.length, contextConfig.maxTurnsInWindow)}/{contextConfig.maxTurnsInWindow} max)
                </Label>
                <div className="bg-muted/30 rounded-md p-3 text-xs font-mono max-h-[150px] overflow-y-auto space-y-1">
                  {turns.length === 0 ? (
                    <span className="text-muted-foreground italic">No turns yet</span>
                  ) : (
                    turns.slice(-contextConfig.maxTurnsInWindow).map((turn, i) => (
                      <div key={i} className={`${turn.speaker === 'assistant' ? 'text-blue-600 dark:text-blue-400' : ''}`}>
                        <span className="font-semibold">{turn.speaker.toUpperCase()}:</span> {turn.text.slice(0, 100)}{turn.text.length > 100 ? '...' : ''}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Built System Prompt Preview */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-2 text-sm font-medium">
                    <Settings2 className="h-4 w-4" />
                    System Prompt Preview
                  </Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpandedSystemPrompt(!expandedSystemPrompt)}
                    className="h-6 text-xs"
                  >
                    {expandedSystemPrompt ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                  </Button>
                </div>
                <div className={`bg-muted/30 rounded-md p-3 text-xs font-mono overflow-y-auto ${expandedSystemPrompt ? 'max-h-[400px]' : 'max-h-[100px]'}`}>
                  <pre className="whitespace-pre-wrap">
                    {getBuiltSystemPromptPreview()}
                  </pre>
                </div>
              </div>

              {/* Current Config Summary */}
              <div className="border-t border-border/50 pt-4">
                <Label className="text-xs font-medium text-muted-foreground mb-2 block">Request Summary</Label>
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
                    <span className="text-muted-foreground">Goal Set:</span>
                    <span className="font-mono">{goal ? 'Yes' : 'No'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Summary Active:</span>
                    <span className="font-mono">{rollingSummary ? 'Yes' : 'No'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Turns in Context:</span>
                    <span className="font-mono">{Math.min(turns.length, contextConfig.maxTurnsInWindow)}</span>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
