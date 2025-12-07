'use client';

/**
 * Groq Text Chat Component
 * Direct text interaction with Groq LLM with full settings visibility
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
} from 'lucide-react';

// Model type from API
interface GroqModel {
  id: string;
  name: string;
  description: string;
}

// Chat message type
interface ChatMessage {
  id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  timestamp: Date;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  latency_ms?: number;
  model?: string;
}

// Default system prompt
const DEFAULT_SYSTEM_PROMPT = `You are a helpful AI assistant. Be concise and accurate in your responses.`;

export function GroqTextChat() {
  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Settings state
  const [showSettings, setShowSettings] = useState(true);
  const [models, setModels] = useState<GroqModel[]>([]);
  const [selectedModel, setSelectedModel] = useState('llama-3.1-8b-instant');
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_SYSTEM_PROMPT);
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [topP, setTopP] = useState(1);

  // UI state
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load available models on mount
  useEffect(() => {
    loadModels();
  }, []);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
      }
    } catch (err) {
      console.error('Failed to load models:', err);
    }
  };

  const handleSendMessage = async () => {
    if (!inputMessage.trim() || loading) return;

    const userMessage: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: inputMessage.trim(),
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInputMessage('');
    setLoading(true);
    setError(null);

    try {
      // Build messages array for API
      const apiMessages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

      // Add system prompt
      if (systemPrompt.trim()) {
        apiMessages.push({ role: 'system', content: systemPrompt.trim() });
      }

      // Add conversation history
      messages.forEach((msg) => {
        if (msg.role !== 'system') {
          apiMessages.push({ role: msg.role, content: msg.content });
        }
      });

      // Add current user message
      apiMessages.push({ role: 'user', content: userMessage.content });

      const res = await fetch('/api/groq-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: apiMessages,
          model: selectedModel,
          temperature,
          max_tokens: maxTokens,
          top_p: topP,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || 'Failed to get response');
      }

      const assistantMessage: ChatMessage = {
        id: `assistant-${Date.now()}`,
        role: 'assistant',
        content: data.response,
        timestamp: new Date(),
        usage: data.usage,
        latency_ms: data.latency_ms,
        model: data.model,
      };

      setMessages((prev) => [...prev, assistantMessage]);
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
    setError(null);
  };

  const handleCopyMessage = (id: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleResetSettings = () => {
    setSystemPrompt(DEFAULT_SYSTEM_PROMPT);
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

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-6 w-6" />
          <h2 className="text-2xl font-bold">Groq Text Chat</h2>
          <Badge variant="secondary" className="ml-2">
            Direct LLM Access
          </Badge>
        </div>
        <div className="flex items-center gap-2">
          {totalTokensUsed > 0 && (
            <Badge variant="outline" className="gap-1">
              <Hash className="h-3 w-3" />
              {totalTokensUsed.toLocaleString()} tokens
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowSettings(!showSettings)}
          >
            <Settings2 className="h-4 w-4 mr-2" />
            {showSettings ? 'Hide' : 'Show'} Settings
            {showSettings ? (
              <ChevronUp className="h-4 w-4 ml-1" />
            ) : (
              <ChevronDown className="h-4 w-4 ml-1" />
            )}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Settings Panel */}
        {showSettings && (
          <Card className="lg:col-span-1">
            <CardHeader className="pb-4">
              <div className="flex items-center justify-between">
                <CardTitle className="text-lg">LLM Settings</CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleResetSettings}
                  title="Reset to defaults"
                >
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </div>
              <CardDescription>Configure the Groq LLM parameters</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* Model Selection */}
              <div className="space-y-2">
                <Label htmlFor="model">Model</Label>
                <Select value={selectedModel} onValueChange={setSelectedModel}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a model" />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((model) => (
                      <SelectItem key={model.id} value={model.id}>
                        <div className="flex flex-col">
                          <span>{model.name}</span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {models.find((m) => m.id === selectedModel)?.description && (
                  <p className="text-xs text-muted-foreground">
                    {models.find((m) => m.id === selectedModel)?.description}
                  </p>
                )}
              </div>

              {/* System Prompt */}
              <div className="space-y-2">
                <Label htmlFor="systemPrompt">System Prompt</Label>
                <Textarea
                  id="systemPrompt"
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="Enter system prompt..."
                  className="min-h-[120px] resize-none text-sm"
                />
                <p className="text-xs text-muted-foreground">
                  Instructions that define the AI's behavior and personality
                </p>
              </div>

              {/* Temperature */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="temperature">Temperature</Label>
                  <span className="text-sm text-muted-foreground">{temperature}</span>
                </div>
                <Input
                  id="temperature"
                  type="number"
                  min="0"
                  max="2"
                  step="0.1"
                  value={temperature}
                  onChange={(e) => setTemperature(parseFloat(e.target.value) || 0)}
                />
                <p className="text-xs text-muted-foreground">
                  0 = deterministic, 2 = very creative (default: 0.7)
                </p>
              </div>

              {/* Max Tokens */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="maxTokens">Max Tokens</Label>
                  <span className="text-sm text-muted-foreground">{maxTokens}</span>
                </div>
                <Input
                  id="maxTokens"
                  type="number"
                  min="1"
                  max="32768"
                  step="64"
                  value={maxTokens}
                  onChange={(e) => setMaxTokens(parseInt(e.target.value) || 1024)}
                />
                <p className="text-xs text-muted-foreground">
                  Maximum tokens in the response (1-32768)
                </p>
              </div>

              {/* Top P */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="topP">Top P (Nucleus Sampling)</Label>
                  <span className="text-sm text-muted-foreground">{topP}</span>
                </div>
                <Input
                  id="topP"
                  type="number"
                  min="0"
                  max="1"
                  step="0.05"
                  value={topP}
                  onChange={(e) => setTopP(parseFloat(e.target.value) || 1)}
                />
                <p className="text-xs text-muted-foreground">
                  Controls diversity via nucleus sampling (0-1)
                </p>
              </div>

              {/* Current Settings Summary */}
              <div className="pt-4 border-t border-border/50">
                <p className="text-xs font-medium text-muted-foreground mb-2">
                  Active Configuration
                </p>
                <div className="bg-muted/30 rounded-md p-3 text-xs font-mono space-y-1">
                  <div>model: {selectedModel}</div>
                  <div>temperature: {temperature}</div>
                  <div>max_tokens: {maxTokens}</div>
                  <div>top_p: {topP}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Chat Panel */}
        <Card className={showSettings ? 'lg:col-span-2' : 'lg:col-span-3'}>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="text-lg">Conversation</CardTitle>
                <CardDescription>
                  Chat directly with the Groq LLM - {messages.filter((m) => m.role !== 'system').length} messages
                </CardDescription>
              </div>
              {messages.length > 0 && (
                <Button variant="outline" size="sm" onClick={handleClearChat}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Clear Chat
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
                  <p className="text-sm">
                    Start a conversation by typing a message below
                  </p>
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
                        {msg.role === 'user' ? 'You' : 'Assistant'}
                      </Badge>
                      <span>
                        {msg.timestamp.toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                      {msg.model && (
                        <span className="text-xs opacity-60">{msg.model}</span>
                      )}
                    </div>

                    {/* Message Content */}
                    <div
                      className={`relative group max-w-[85%] rounded-lg px-4 py-3 ${
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
                      <div className="flex items-center gap-3 text-xs text-muted-foreground">
                        {msg.latency_ms && (
                          <span className="flex items-center gap-1">
                            <Clock className="h-3 w-3" />
                            {msg.latency_ms}ms
                          </span>
                        )}
                        {msg.usage && (
                          <>
                            <span className="flex items-center gap-1">
                              <Zap className="h-3 w-3" />
                              {msg.usage.prompt_tokens} prompt
                            </span>
                            <span>
                              {msg.usage.completion_tokens} completion
                            </span>
                            <span className="font-medium">
                              ({msg.usage.total_tokens} total)
                            </span>
                          </>
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
                ref={textareaRef}
                value={inputMessage}
                onChange={(e) => setInputMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type your message... (Enter to send, Shift+Enter for new line)"
                className="flex-1 min-h-[60px] max-h-[150px] resize-none"
                disabled={loading}
              />
              <Button
                onClick={handleSendMessage}
                disabled={loading || !inputMessage.trim()}
                className="self-end h-[60px] px-6"
              >
                {loading ? (
                  <>
                    <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                    Sending...
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4 mr-2" />
                    Send
                  </>
                )}
              </Button>
            </div>

            {/* Input Hints */}
            <p className="text-xs text-muted-foreground text-center">
              Press <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">Enter</kbd> to send,{' '}
              <kbd className="px-1.5 py-0.5 bg-muted rounded text-xs font-mono">Shift + Enter</kbd> for new line
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
