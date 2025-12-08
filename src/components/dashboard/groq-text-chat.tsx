'use client';

/**
 * Groq Text Chat Component
 * Direct text interaction with Groq LLM with call-like features:
 * - Goal injection (dynamic, editable template)
 * - Rolling summary generation
 * - Recent turns context window
 * - Full settings and context visibility
 * - Expandable panels
 * - Full AI input visibility per response
 */

import { useState, useEffect, useRef } from 'react';
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
  Maximize2,
  Minimize2,
  X,
  Code,
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

// Full request info for each message
interface RequestInfo {
  systemPrompt: string;
  rollingSummary: string | null;
  recentTurns: Turn[];
  userMessage: string;
  fullMessages: Array<{ role: string; content: string }>;
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
  requestInfo?: RequestInfo;
}

// Context config from API
interface ContextConfig {
  maxTurnsInWindow: number;
  summaryUpdateIntervalTurns: number;
  maxSummaryTokensHint: number;
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

// Default summary template
const DEFAULT_SUMMARY_TEMPLATE = `You are updating a rolling summary of a conversation between an AI assistant and a caller.

EXISTING SUMMARY (may be empty or partial):
{existingSummary}

NEW TRANSCRIPT TURNS (since that summary was created):
{turnsText}

Please return an UPDATED, CONCISE summary (max ~300 tokens) that preserves:
- The caller's main goal(s)
- Key facts (names, dates, constraints, identifiers)
- Important decisions / outcomes so far
- Current status (who we're talking to, which department, on hold or not, etc.)
- Any critical context for continuing the conversation

Be concise and focus on what's most important to continue this conversation effectively.`;

// Default summary system message
const DEFAULT_SUMMARY_SYSTEM_MESSAGE = `You are a concise conversation summary generator. Create summaries that preserve the most important context for continuing conversations.`;

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
  const [goalTemplate, setGoalTemplate] = useState(DEFAULT_GOAL_TEMPLATE);
  const [additionalContext, setAdditionalContext] = useState('');
  const [assistantName, setAssistantName] = useState('Ferguson');
  const [userName, setUserName] = useState('Aaron');
  const [rollingSummary, setRollingSummary] = useState('');
  const [lastSummaryTurnIndex, setLastSummaryTurnIndex] = useState(-1);
  const [generatingSummary, setGeneratingSummary] = useState(false);

  // Summary generation templates
  const [summaryTemplate, setSummaryTemplate] = useState(DEFAULT_SUMMARY_TEMPLATE);
  const [summarySystemMessage, setSummarySystemMessage] = useState(DEFAULT_SUMMARY_SYSTEM_MESSAGE);

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
  const [showGoalTemplateEditor, setShowGoalTemplateEditor] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Expanded panel states
  const [expandedPanel, setExpandedPanel] = useState<'settings' | 'chat' | 'context' | null>(null);

  // Request info modal state
  const [selectedRequestInfo, setSelectedRequestInfo] = useState<RequestInfo | null>(null);
  const [showRequestInfoModal, setShowRequestInfoModal] = useState(false);

  // Summary template editor state
  const [showSummaryTemplateEditor, setShowSummaryTemplateEditor] = useState(false);

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
          summaryTemplate: summaryTemplate !== DEFAULT_SUMMARY_TEMPLATE ? summaryTemplate : undefined,
          summarySystemMessage: summarySystemMessage !== DEFAULT_SUMMARY_SYSTEM_MESSAGE ? summarySystemMessage : undefined,
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

  // Build the full system prompt (for display and sending)
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

  // Build full messages array (for visibility)
  const buildFullMessages = (userMessageText: string, currentTurns: Turn[], currentSummary: string) => {
    const systemPrompt = buildFullSystemPrompt();
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    if (currentSummary) {
      messages.push({
        role: 'user',
        content: `CONVERSATION CONTEXT SUMMARY:\n${currentSummary}`,
      });
    }

    // Add recent turns
    const recentTurns = currentTurns.slice(-contextConfig.maxTurnsInWindow);
    recentTurns.forEach((turn) => {
      const role = turn.speaker === 'assistant' ? 'assistant' : 'user';
      const speakerLabel = turn.speaker === 'assistant' ? '' : `[${turn.speaker.toUpperCase()}] `;
      messages.push({
        role,
        content: `${speakerLabel}${turn.text}`,
      });
    });

    // Add current user message
    messages.push({ role: 'user', content: userMessageText });

    return messages;
  };

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || loading) return;

    const userMessageText = inputMessage.trim();
    const timestamp = new Date();

    // Capture current state for request info
    const currentTurns = [...turns];
    const currentSummary = rollingSummary;
    const systemPrompt = buildFullSystemPrompt();
    const fullMessages = buildFullMessages(userMessageText, currentTurns, currentSummary);

    // Build request info for this message
    const requestInfo: RequestInfo = {
      systemPrompt,
      rollingSummary: currentSummary || null,
      recentTurns: currentTurns.slice(-contextConfig.maxTurnsInWindow),
      userMessage: userMessageText,
      fullMessages,
    };

    // Add to display messages
    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: userMessageText,
      timestamp,
      requestInfo,
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
          goalTemplate: goal ? goalTemplate : undefined,
          additionalContext: additionalContext || undefined,
          assistantName: assistantName || undefined,
          userName: userName || undefined,
          turns: currentTurns.slice(-contextConfig.maxTurnsInWindow),
          rollingSummary: currentSummary || undefined,
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
        requestInfo, // Same request info that generated this response
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
    setGoalTemplate(DEFAULT_GOAL_TEMPLATE);
    setAdditionalContext('');
    setAssistantName('Ferguson');
    setUserName('Aaron');
    setUseCustomPrompt(false);
    setCustomSystemPrompt('');
    setTemperature(0.7);
    setMaxTokens(1024);
    setTopP(1);
    setSummaryTemplate(DEFAULT_SUMMARY_TEMPLATE);
    setSummarySystemMessage(DEFAULT_SUMMARY_SYSTEM_MESSAGE);
    if (models.length > 0) {
      setSelectedModel(models[0].id);
    }
  };

  const handleViewRequestInfo = (requestInfo: RequestInfo) => {
    setSelectedRequestInfo(requestInfo);
    setShowRequestInfoModal(true);
  };

  // Calculate total tokens used in conversation
  const totalTokensUsed = messages.reduce((sum, msg) => {
    return sum + (msg.usage?.total_tokens || 0);
  }, 0);

  // Render expandable panel wrapper
  const renderPanel = (
    panelKey: 'settings' | 'chat' | 'context',
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
            Call Goal
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

  // Chat panel content
  const chatContent = (
    <div className="space-y-4">
      {/* Messages Area */}
      <div className={`border rounded-lg bg-muted/20 overflow-y-auto p-4 space-y-4 ${expandedPanel === 'chat' ? 'min-h-[500px] max-h-[calc(100vh-400px)]' : 'min-h-[400px] max-h-[500px]'}`}>
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
                {/* View Request Info Button */}
                {msg.requestInfo && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleViewRequestInfo(msg.requestInfo!)}
                    className="h-5 px-2 text-xs"
                    title="View full AI input"
                  >
                    <Code className="h-3 w-3 mr-1" />
                    Input
                  </Button>
                )}
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

      {/* Clear Chat Button */}
      {messages.length > 0 && (
        <Button variant="outline" size="sm" onClick={handleClearChat} className="w-full">
          <Trash2 className="h-4 w-4 mr-2" />
          Clear Conversation
        </Button>
      )}
    </div>
  );

  // Context panel content
  const contextContent = (
    <div className="space-y-4">
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
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSummaryTemplateEditor(true)}
              className="h-6 text-xs"
              title="Edit summary generation template"
            >
              <Code className="h-3 w-3 mr-1" />
              Template
            </Button>
            <Badge variant="outline" className="text-xs">
              {turns.length - (lastSummaryTurnIndex + 1)}/{contextConfig.summaryUpdateIntervalTurns} turns until update
            </Badge>
          </div>
        </div>
        <div className={`bg-muted/30 rounded-md p-3 text-xs font-mono overflow-y-auto ${expandedPanel === 'context' ? 'min-h-[100px] max-h-[200px]' : 'min-h-[60px] max-h-[120px]'}`}>
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
        <div className={`bg-muted/30 rounded-md p-3 text-xs font-mono overflow-y-auto space-y-1 ${expandedPanel === 'context' ? 'max-h-[250px]' : 'max-h-[150px]'}`}>
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
        <div className={`bg-muted/30 rounded-md p-3 text-xs font-mono overflow-y-auto ${expandedSystemPrompt || expandedPanel === 'context' ? 'max-h-[400px]' : 'max-h-[100px]'}`}>
          <pre className="whitespace-pre-wrap">
            {buildFullSystemPrompt()}
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
    </div>
  );

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
            'Configure the simulated call',
            settingsContent,
            'xl:col-span-3'
          )}

        {/* Chat Panel */}
        {(!expandedPanel || expandedPanel === 'chat') &&
          renderPanel(
            'chat',
            'Conversation',
            `${turns.length} turns • ${messages.filter((m) => m.role === 'assistant').length} responses`,
            chatContent,
            `${showSettings && showContextPanel ? 'xl:col-span-5' : showSettings || showContextPanel ? 'xl:col-span-8' : 'xl:col-span-12'}`
          )}

        {/* Context Visibility Panel */}
        {(showContextPanel || expandedPanel === 'context') &&
          renderPanel(
            'context',
            'Context Visibility',
            "What's being sent to the LLM",
            contextContent,
            'xl:col-span-4'
          )}
      </div>

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

      {/* Summary Template Editor Dialog */}
      <Dialog open={showSummaryTemplateEditor} onOpenChange={setShowSummaryTemplateEditor}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Summary Generation Template</DialogTitle>
          </DialogHeader>
          <div className="space-y-6 py-4">
            <p className="text-sm text-muted-foreground">
              Control how the rolling summary is generated. The template uses placeholders that get replaced with actual values.
            </p>

            {/* System Message */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Summary System Message</Label>
              <p className="text-xs text-muted-foreground">
                This is the system prompt used when generating summaries.
              </p>
              <Textarea
                value={summarySystemMessage}
                onChange={(e) => setSummarySystemMessage(e.target.value)}
                className="min-h-[80px] font-mono text-sm"
              />
            </div>

            {/* User Prompt Template */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Summary User Prompt Template</Label>
              <p className="text-xs text-muted-foreground">
                This template generates the user message for summary requests. Use these placeholders:
              </p>
              <div className="flex gap-2 text-xs">
                <code className="bg-muted px-2 py-1 rounded">{'{existingSummary}'}</code>
                <span className="text-muted-foreground">- Current summary (or "(empty)")</span>
              </div>
              <div className="flex gap-2 text-xs">
                <code className="bg-muted px-2 py-1 rounded">{'{turnsText}'}</code>
                <span className="text-muted-foreground">- New turns since last summary</span>
              </div>
              <Textarea
                value={summaryTemplate}
                onChange={(e) => setSummaryTemplate(e.target.value)}
                className="min-h-[300px] font-mono text-sm"
              />
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  setSummaryTemplate(DEFAULT_SUMMARY_TEMPLATE);
                  setSummarySystemMessage(DEFAULT_SUMMARY_SYSTEM_MESSAGE);
                }}
              >
                Reset to Defaults
              </Button>
              <Button onClick={() => setShowSummaryTemplateEditor(false)}>
                Done
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Request Info Modal */}
      <Dialog open={showRequestInfoModal} onOpenChange={setShowRequestInfoModal}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Full AI Input</DialogTitle>
          </DialogHeader>
          {selectedRequestInfo && (
            <div className="space-y-6 py-4">
              {/* System Prompt */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">System Prompt</Label>
                <div className="bg-muted/30 rounded-md p-4 text-xs font-mono max-h-[300px] overflow-y-auto">
                  <pre className="whitespace-pre-wrap">{selectedRequestInfo.systemPrompt}</pre>
                </div>
              </div>

              {/* Rolling Summary */}
              {selectedRequestInfo.rollingSummary && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Rolling Summary (sent as context)</Label>
                  <div className="bg-blue-50 dark:bg-blue-900/20 rounded-md p-4 text-xs font-mono max-h-[150px] overflow-y-auto">
                    <pre className="whitespace-pre-wrap">{selectedRequestInfo.rollingSummary}</pre>
                  </div>
                </div>
              )}

              {/* Recent Turns */}
              {selectedRequestInfo.recentTurns.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-sm font-medium">Recent Turns ({selectedRequestInfo.recentTurns.length})</Label>
                  <div className="bg-muted/30 rounded-md p-4 text-xs font-mono max-h-[200px] overflow-y-auto space-y-2">
                    {selectedRequestInfo.recentTurns.map((turn, i) => (
                      <div key={i} className={turn.speaker === 'assistant' ? 'text-blue-600 dark:text-blue-400' : ''}>
                        <span className="font-bold">{turn.speaker.toUpperCase()}:</span> {turn.text}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* User Message */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">User Message (this turn)</Label>
                <div className="bg-green-50 dark:bg-green-900/20 rounded-md p-4 text-xs font-mono">
                  <pre className="whitespace-pre-wrap">{selectedRequestInfo.userMessage}</pre>
                </div>
              </div>

              {/* Full Messages Array - Parsed View */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Complete Messages Array (as sent to API)</Label>
                <div className="bg-muted/30 rounded-md p-4 max-h-[400px] overflow-y-auto space-y-4">
                  {selectedRequestInfo.fullMessages.map((msg, i) => (
                    <div key={i} className="border-b border-border/30 pb-3 last:border-0 last:pb-0">
                      <div className="flex items-center gap-2 mb-2">
                        <Badge
                          variant={msg.role === 'system' ? 'outline' : msg.role === 'assistant' ? 'secondary' : 'default'}
                          className="text-xs font-mono"
                        >
                          [{i}] {msg.role.toUpperCase()}
                        </Badge>
                        <span className="text-xs text-muted-foreground">
                          {msg.content.length.toLocaleString()} chars
                        </span>
                      </div>
                      <div className={`text-xs rounded-md p-3 ${
                        msg.role === 'system'
                          ? 'bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800'
                          : msg.role === 'assistant'
                            ? 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800'
                            : 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
                      }`}>
                        <pre className="whitespace-pre-wrap font-mono">{msg.content}</pre>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Raw JSON */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-sm font-medium text-muted-foreground">Raw JSON</Label>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      navigator.clipboard.writeText(JSON.stringify(selectedRequestInfo.fullMessages, null, 2));
                    }}
                    className="h-6 text-xs"
                  >
                    <Copy className="h-3 w-3 mr-1" />
                    Copy
                  </Button>
                </div>
                <div className="bg-muted/30 rounded-md p-4 text-xs font-mono max-h-[200px] overflow-y-auto">
                  <pre className="whitespace-pre-wrap">{JSON.stringify(selectedRequestInfo.fullMessages, null, 2)}</pre>
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
