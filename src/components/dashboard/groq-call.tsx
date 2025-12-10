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
  Volume2,
  Headphones,
  Radio,
} from 'lucide-react';
import { LiveCallObserver } from './live-call-observer';

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

// =============================================================================
// VARIABLE KEYS (use these placeholders in prompts)
// =============================================================================
// {ASSISTANT_NAME} - Replaced with the assistant's name
// {USER_NAME} - Replaced with the user's name
// =============================================================================

// No default system prompt - must be provided by user
const SYSTEM_PROMPT_REQUIRED_MESSAGE = `⚠️ CUSTOM SYSTEM PROMPT REQUIRED

You must provide a custom system prompt to start calls.

Available variable keys:
• {ASSISTANT_NAME} - Will be replaced with the assistant name
• {USER_NAME} - Will be replaced with the user name

The call goal will be automatically appended at the bottom:
CALL GOAL (YOUR ONLY MISSION): "your goal here"`;

// Audio sounds that can be played during calls
const CALL_AUDIO_SOUNDS = [
  {
    id: 'standard-fart',
    name: 'Standard Fart',
    url: 'https://www.myinstants.com/media/sounds/dry-fart.mp3',
  },
  {
    id: 'fart-song',
    name: 'Fart Song',
    url: 'https://www.myinstants.com/media/sounds/jerry-farts-united-clean-loop-original-3_48-hd-by-jtf-entertainment_chzyMf5.mp3',
  },
  {
    id: 'quick-fart',
    name: 'Quick Fart',
    url: 'https://www.myinstants.com/media/sounds/dry-fart.mp3',
  },
];

// Groq settings interface for saved configuration
interface SavedGroqSettings {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  reasoning?: 'low' | 'medium' | 'high';
  stream?: boolean;
  jsonMode?: boolean;
  customSystemPrompt?: string;
  rollingSummaryPrompt?: string;
  callControlSettings?: {
    ttsDebounceMs?: number;
    bargeInCooldownMs?: number;
    callerUtteranceFlushMs?: number;
    hangupDelayMs?: number;
    holdCheckInIntervalMs?: number;
    holdMaxCheckIns?: number;
  };
  ivrSettings?: {
    debounceMs?: number;
    utteranceFlushMs?: number;
    dtmfMinPauseMs?: number;
    dtmfDurationMs?: number;
    autoDetectThreshold?: number;
    responseTimeoutMs?: number;
    maxDtmfRetries?: number;
    disableBargeInGracePeriod?: boolean;
  };
}

interface GroqCallProps {
  customAssistantName?: string;
  firstName?: string;
  groqSettings?: SavedGroqSettings | null;
  onSettingsSaved?: () => void;
}

export function GroqCall({ customAssistantName = 'Ferguson', firstName = 'Aaron', groqSettings, onSettingsSaved }: GroqCallProps) {
  // Call state
  const [toNumber, setToNumber] = useState('');
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsSaveStatus, setSettingsSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
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
  const [additionalContext, setAdditionalContext] = useState('');
  const [assistantName, setAssistantName] = useState(customAssistantName);
  const [userName, setUserName] = useState(firstName);

  // Settings state
  const [showSettings, setShowSettings] = useState(true);
  const [showContextPanel, setShowContextPanel] = useState(true);
  const [models, setModels] = useState<GroqModel[]>([]);
  const [selectedModel, setSelectedModel] = useState('llama-3.1-8b-instant');
  // Custom system prompt is REQUIRED - no default
  const [customSystemPrompt, setCustomSystemPrompt] = useState('');
  // Rolling summary prompt for context management
  const [rollingSummaryPrompt, setRollingSummaryPrompt] = useState('');
  const [temperature, setTemperature] = useState(0.7);
  const [maxTokens, setMaxTokens] = useState(1024);
  const [topP, setTopP] = useState(1);
  const [reasoning, setReasoning] = useState<'low' | 'medium' | 'high'>('medium');
  const [stream, setStream] = useState(false);
  const [jsonMode, setJsonMode] = useState(false);
  const [contextConfig, setContextConfig] = useState<ContextConfig>({
    maxTurnsInWindow: 12,
    summaryUpdateIntervalTurns: 6,
    maxSummaryTokensHint: 300,
  });

  // Call control settings
  const [callControlSettings, setCallControlSettings] = useState({
    ttsDebounceMs: 500,
    bargeInCooldownMs: 300,
    callerUtteranceFlushMs: 300,
    hangupDelayMs: 2000,
    holdCheckInIntervalMs: 30000,
    holdMaxCheckIns: 5,
  });
  const [showCallControlSettings, setShowCallControlSettings] = useState(false);

  // IVR/Phone Tree settings
  const [ivrSettings, setIvrSettings] = useState({
    debounceMs: 150,
    utteranceFlushMs: 200,
    dtmfMinPauseMs: 500,
    dtmfDurationMs: 250,
    autoDetectThreshold: 0.7,
    responseTimeoutMs: 8000,
    maxDtmfRetries: 2,
    disableBargeInGracePeriod: true,
  });
  const [showIvrSettings, setShowIvrSettings] = useState(false);

  // UI state
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [expandedSystemPrompt, setExpandedSystemPrompt] = useState(false);

  // Expanded panel states
  const [expandedPanel, setExpandedPanel] = useState<'settings' | 'call' | 'context' | 'logs' | null>(null);

  // Audio playback state
  const [showAudioPopup, setShowAudioPopup] = useState(false);
  const [playingAudioId, setPlayingAudioId] = useState<string | null>(null);

  // Live observer state
  const [showObserver, setShowObserver] = useState(false);

  // Update names when props change
  useEffect(() => {
    setAssistantName(customAssistantName);
  }, [customAssistantName]);

  useEffect(() => {
    setUserName(firstName);
  }, [firstName]);

  // Load saved settings when groqSettings prop is available
  useEffect(() => {
    if (groqSettings) {
      console.log('[GroqCall] Loading saved settings:', groqSettings);
      if (groqSettings.model) setSelectedModel(groqSettings.model);
      if (groqSettings.temperature !== undefined) setTemperature(groqSettings.temperature);
      if (groqSettings.maxTokens !== undefined) setMaxTokens(groqSettings.maxTokens);
      if (groqSettings.topP !== undefined) setTopP(groqSettings.topP);
      if (groqSettings.reasoning) setReasoning(groqSettings.reasoning);
      if (groqSettings.stream !== undefined) setStream(groqSettings.stream);
      if (groqSettings.jsonMode !== undefined) setJsonMode(groqSettings.jsonMode);
      if (groqSettings.customSystemPrompt !== undefined) setCustomSystemPrompt(groqSettings.customSystemPrompt);
      if (groqSettings.rollingSummaryPrompt !== undefined) setRollingSummaryPrompt(groqSettings.rollingSummaryPrompt);
      if (groqSettings.callControlSettings) {
        setCallControlSettings(prev => ({
          ...prev,
          ...groqSettings.callControlSettings,
        }));
      }
      if (groqSettings.ivrSettings) {
        setIvrSettings(prev => ({
          ...prev,
          ...groqSettings.ivrSettings,
        }));
      }
    }
  }, [groqSettings]);

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
    const callId = activeCall.id;

    console.log('[GroqCall] Setting up LLM logs for call:', callId);

    // Initial fetch of existing logs directly from Supabase (not API)
    const fetchLogs = async () => {
      try {
        console.log('[GroqCall] Fetching existing LLM logs from Supabase...');
        const { data: logs, error } = await supabase
          .from('call_llm_exchanges')
          .select('*')
          .eq('call_id', callId)
          .order('created_at', { ascending: true });

        if (error) {
          console.error('[GroqCall] Supabase query error:', error);
          return;
        }

        console.log('[GroqCall] Fetched logs:', logs?.length || 0, 'records');

        // Map call_llm_exchanges columns to expected format
        const mappedLogs = (logs || []).map((log: any) => ({
          ...log,
          assistant_response: log.response_text,
          latency_ms: log.duration_ms,
        }));
        setLlmLogs(mappedLogs);
      } catch (err) {
        console.error('[GroqCall] Failed to fetch LLM logs:', err);
      }
    };
    fetchLogs();

    // Subscribe to new logs from call_llm_exchanges table (existing table with realtime)
    // Note: We subscribe to ALL inserts and filter client-side because call_id contains
    // special characters (like ':') that can break Supabase realtime filters
    const channel = supabase
      .channel(`llm-exchanges-${callId.slice(-8)}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'call_llm_exchanges',
        },
        (payload) => {
          const rawLog = payload.new as any;
          // Filter client-side for our specific call
          if (rawLog.call_id !== callId) {
            return;
          }
          console.log('[GroqCall] Received new LLM log via realtime:', rawLog.id);
          // Map call_llm_exchanges columns to expected format
          const newLog: LlmLog = {
            ...rawLog,
            assistant_response: rawLog.response_text,
            latency_ms: rawLog.duration_ms,
          };
          setLlmLogs((prev) => [...prev, newLog]);
        }
      )
      .subscribe((status) => {
        console.log('[GroqCall] LLM logs realtime status:', status);
      });

    return () => {
      console.log('[GroqCall] Cleaning up LLM logs subscription');
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
        // No default system prompt - must be provided by user
        if (data.contextConfig) {
          setContextConfig(data.contextConfig);
        }
        if (data.callControlDefaults) {
          setCallControlSettings(data.callControlDefaults);
        }
        // Load default rolling summary prompt if available
        if (data.rollingSummaryPrompt) {
          setRollingSummaryPrompt(data.rollingSummaryPrompt);
        }
      }
    } catch (err) {
      console.error('Failed to load models:', err);
    }
  };

  // Build the full system prompt (for display)
  // Uses variable keys: {ASSISTANT_NAME}, {USER_NAME}
  // Goal is always injected at bottom in format: CALL GOAL (YOUR ONLY MISSION): "goal"
  const buildFullSystemPrompt = () => {
    // Custom system prompt is REQUIRED
    if (!customSystemPrompt) {
      return SYSTEM_PROMPT_REQUIRED_MESSAGE;
    }

    let prompt = customSystemPrompt;

    // Replace variable keys {ASSISTANT_NAME} and {USER_NAME}
    const finalAssistantName = assistantName || 'Ferguson';
    const finalUserName = userName || 'Aaron';
    prompt = prompt.replace(/\{ASSISTANT_NAME\}/g, finalAssistantName);
    prompt = prompt.replace(/\{USER_NAME\}/g, finalUserName);

    // Also replace legacy hardcoded names for backwards compatibility
    prompt = prompt.replace(/Ferguson/g, finalAssistantName);
    prompt = prompt.replace(/ferguson/g, finalAssistantName.toLowerCase());
    prompt = prompt.replace(/Aaron/g, finalUserName);

    // Add context if provided
    if (additionalContext) {
      prompt += `\n\nADDITIONAL CONTEXT:\n${additionalContext}`;
    }

    // Goal is always injected at bottom in simple format
    if (goal) {
      prompt += `\n\nCALL GOAL (YOUR ONLY MISSION): "${goal}"`;
    }

    return prompt;
  };

  const handleDelegateCall = async () => {
    // Require goal, phone number, AND custom system prompt
    if (!goal || !toNumber || !customSystemPrompt) return;

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
          custom_system_prompt: customSystemPrompt,
          rolling_summary_prompt: rollingSummaryPrompt,
          hold_check_in_interval_ms: callControlSettings.holdCheckInIntervalMs,
          hold_max_check_ins: callControlSettings.holdMaxCheckIns,
          model: selectedModel,
          temperature: temperature,
          max_tokens: maxTokens,
          top_p: topP,
          reasoning: reasoning,
          stream: stream,
          json_mode: jsonMode,
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
      console.log('[GroqCall] Delegate response:', data);
      console.log('[GroqCall] Extracted call_control_id:', callControlId);

      if (callControlId) {
        console.log('[GroqCall] Setting active call with ID:', callControlId);
        setActiveCall({
          id: callControlId,
          status: 'initiated',
          goal: goal,
          started_at: new Date().toISOString(),
        });
      } else {
        console.warn('[GroqCall] No call_control_id found in response - LLM logs will not be tracked');
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
    setAdditionalContext('');
    setAssistantName(customAssistantName);
    setUserName(firstName);
    setCustomSystemPrompt('');
    setRollingSummaryPrompt('');
    setTemperature(0.7);
    setMaxTokens(1024);
    setTopP(1);
    setCallControlSettings({
      ttsDebounceMs: 500,
      bargeInCooldownMs: 300,
      callerUtteranceFlushMs: 300,
      hangupDelayMs: 2000,
      holdCheckInIntervalMs: 30000,
      holdMaxCheckIns: 5,
    });
    setIvrSettings({
      debounceMs: 150,
      utteranceFlushMs: 200,
      dtmfMinPauseMs: 500,
      dtmfDurationMs: 250,
      autoDetectThreshold: 0.7,
      responseTimeoutMs: 8000,
      maxDtmfRetries: 2,
      disableBargeInGracePeriod: true,
    });
    if (models.length > 0) {
      setSelectedModel(models[0].id);
    }
    // Reload defaults
    loadModels();
  };

  const handleSaveSettings = async () => {
    setSavingSettings(true);
    setSettingsSaveStatus('idle');

    const settingsToSave: SavedGroqSettings = {
      model: selectedModel,
      temperature,
      maxTokens,
      topP,
      reasoning,
      stream,
      jsonMode,
      customSystemPrompt,
      rollingSummaryPrompt,
      callControlSettings,
      ivrSettings,
    };

    try {
      const response = await fetch('/api/profile/update-groq-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsToSave),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to save settings');
      }

      setSettingsSaveStatus('success');
      console.log('[GroqCall] Settings saved successfully');

      // Notify parent component
      if (onSettingsSaved) {
        onSettingsSaved();
      }

      // Clear success status after 3 seconds
      setTimeout(() => setSettingsSaveStatus('idle'), 3000);
    } catch (error: any) {
      console.error('[GroqCall] Error saving settings:', error);
      setSettingsSaveStatus('error');
      // Clear error status after 5 seconds
      setTimeout(() => setSettingsSaveStatus('idle'), 5000);
    } finally {
      setSavingSettings(false);
    }
  };

  // Play audio into the active call via Telnyx API
  const [audioStatus, setAudioStatus] = useState<string | null>(null);

  const handlePlayAudio = async (soundId: string, url: string) => {
    if (!activeCall?.id) {
      console.error('No active call to play audio into');
      setAudioStatus('No active call');
      setTimeout(() => setAudioStatus(null), 3000);
      return;
    }

    setPlayingAudioId(soundId);
    setAudioStatus('Sending to call...');

    try {
      console.log('[Frontend] Playing audio:', { soundId, url, callId: activeCall.id });
      const response = await fetch('/api/calls/play-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          call_control_id: activeCall.id,
          audio_url: url,
        }),
      });

      const data = await response.json();
      console.log('[Frontend] Play audio response:', data);

      if (!response.ok) {
        console.error('Failed to play audio:', data);
        setAudioStatus(`Error: ${data.error || 'Failed'}`);
      } else {
        setAudioStatus('Playing in call!');
      }
    } catch (err) {
      console.error('Error playing audio:', err);
      setAudioStatus('Network error');
    } finally {
      // Reset after a delay
      setTimeout(() => {
        setPlayingAudioId(null);
        setAudioStatus(null);
      }, 3000);
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
        <Label htmlFor="goal" className="flex items-center gap-2">
          <Target className="h-4 w-4" />
          Call Goal <span className="text-destructive">*</span>
        </Label>
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
            Injected at bottom: CALL GOAL (YOUR ONLY MISSION): &quot;goal&quot;
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

      {/* Reasoning */}
      <div className="space-y-2">
        <Label htmlFor="reasoning" className="text-sm">Reasoning</Label>
        <Select value={reasoning} onValueChange={(value: 'low' | 'medium' | 'high') => setReasoning(value)}>
          <SelectTrigger className="text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">Low</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="high">High</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Stream */}
      <div className="flex items-center justify-between">
        <Label htmlFor="stream" className="text-sm">Stream</Label>
        <button
          type="button"
          role="switch"
          aria-checked={stream}
          onClick={() => setStream(!stream)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            stream ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              stream ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* JSON Mode */}
      <div className="flex items-center justify-between">
        <Label htmlFor="jsonMode" className="text-sm">JSON Mode</Label>
        <button
          type="button"
          role="switch"
          aria-checked={jsonMode}
          onClick={() => setJsonMode(!jsonMode)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
            jsonMode ? 'bg-primary' : 'bg-muted'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
              jsonMode ? 'translate-x-6' : 'translate-x-1'
            }`}
          />
        </button>
      </div>

      {/* System Prompt (REQUIRED) */}
      <div className="border-t border-border/50 pt-4">
        <div className="space-y-2">
          <Label className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4" />
            System Prompt <span className="text-destructive">*</span>
          </Label>
          <p className="text-xs text-muted-foreground">
            Variable keys: <code className="bg-muted px-1 rounded">{'{ASSISTANT_NAME}'}</code>, <code className="bg-muted px-1 rounded">{'{USER_NAME}'}</code>
          </p>
          <Textarea
            value={customSystemPrompt}
            onChange={(e) => setCustomSystemPrompt(e.target.value)}
            placeholder="Enter your system prompt... Use {ASSISTANT_NAME} and {USER_NAME} as placeholders."
            className={`min-h-[150px] resize-none text-xs font-mono ${!customSystemPrompt ? 'border-destructive' : ''}`}
          />
          {!customSystemPrompt && (
            <p className="text-xs text-destructive">Required to start calls</p>
          )}
        </div>
      </div>

      {/* Rolling Summary Prompt */}
      <div className="border-t border-border/50 pt-4">
        <div className="space-y-2">
          <Label className="text-sm flex items-center gap-2">
            <Brain className="h-4 w-4" />
            Rolling Summary Prompt
          </Label>
          <p className="text-xs text-muted-foreground">
            Template for generating call summaries. Available keys: <code className="bg-muted px-1 rounded">{'{EXISTING_SUMMARY}'}</code>, <code className="bg-muted px-1 rounded">{'{TURNS_TEXT}'}</code>, <code className="bg-muted px-1 rounded">{'{MAX_TOKENS}'}</code>
          </p>
          <Textarea
            value={rollingSummaryPrompt}
            onChange={(e) => setRollingSummaryPrompt(e.target.value)}
            placeholder="Enter your rolling summary prompt template... Use {EXISTING_SUMMARY}, {TURNS_TEXT}, and {MAX_TOKENS} as placeholders."
            className="min-h-[120px] resize-none text-xs font-mono"
          />
          <p className="text-xs text-muted-foreground">
            Optional: Used to condense conversation history. Leave empty to use default.
          </p>
        </div>
      </div>

      {/* Call Control Settings */}
      <div className="border-t border-border/50 pt-4">
        <div className="flex items-center justify-between mb-2">
          <Label className="text-sm flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Call Control Settings
          </Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCallControlSettings(!showCallControlSettings)}
            className="h-6 text-xs"
          >
            {showCallControlSettings ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>
        </div>
        {showCallControlSettings && (
          <div className="space-y-3 bg-muted/30 rounded-md p-3">
            <div className="space-y-1">
              <Label className="text-xs">TTS Debounce (ms)</Label>
              <Input
                type="number"
                min="100"
                max="2000"
                step="50"
                value={callControlSettings.ttsDebounceMs}
                onChange={(e) => setCallControlSettings(prev => ({ ...prev, ttsDebounceMs: parseInt(e.target.value) || 500 }))}
                className="text-xs h-8"
              />
              <p className="text-[10px] text-muted-foreground">Silence before AI responds</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Barge-In Cooldown (ms)</Label>
              <Input
                type="number"
                min="100"
                max="1000"
                step="50"
                value={callControlSettings.bargeInCooldownMs}
                onChange={(e) => setCallControlSettings(prev => ({ ...prev, bargeInCooldownMs: parseInt(e.target.value) || 300 }))}
                className="text-xs h-8"
              />
              <p className="text-[10px] text-muted-foreground">Time between stop commands</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Utterance Flush (ms)</Label>
              <Input
                type="number"
                min="100"
                max="1000"
                step="50"
                value={callControlSettings.callerUtteranceFlushMs}
                onChange={(e) => setCallControlSettings(prev => ({ ...prev, callerUtteranceFlushMs: parseInt(e.target.value) || 300 }))}
                className="text-xs h-8"
              />
              <p className="text-[10px] text-muted-foreground">Wait before logging utterance</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Hangup Delay (ms)</Label>
              <Input
                type="number"
                min="500"
                max="5000"
                step="100"
                value={callControlSettings.hangupDelayMs}
                onChange={(e) => setCallControlSettings(prev => ({ ...prev, hangupDelayMs: parseInt(e.target.value) || 2000 }))}
                className="text-xs h-8"
              />
              <p className="text-[10px] text-muted-foreground">Wait for TTS before hangup</p>
            </div>
            <div className="border-t border-border/30 pt-3 mt-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">Hold Settings</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Hold Check-In Interval (ms)</Label>
              <Input
                type="number"
                min="5000"
                max="120000"
                step="5000"
                value={callControlSettings.holdCheckInIntervalMs}
                onChange={(e) => setCallControlSettings(prev => ({ ...prev, holdCheckInIntervalMs: parseInt(e.target.value) || 30000 }))}
                className="text-xs h-8"
              />
              <p className="text-[10px] text-muted-foreground">Time between check-ins while on hold (default: 30s)</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Max Hold Check-Ins</Label>
              <Input
                type="number"
                min="1"
                max="20"
                step="1"
                value={callControlSettings.holdMaxCheckIns}
                onChange={(e) => setCallControlSettings(prev => ({ ...prev, holdMaxCheckIns: parseInt(e.target.value) || 5 }))}
                className="text-xs h-8"
              />
              <p className="text-[10px] text-muted-foreground">Max check-ins before ending call (default: 5)</p>
            </div>
          </div>
        )}
      </div>

      {/* IVR/Phone Tree Settings */}
      <div className="border-t border-border/50 pt-4">
        <div className="flex items-center justify-between mb-2">
          <Label className="text-sm flex items-center gap-2">
            <Phone className="h-4 w-4" />
            IVR/Phone Tree Settings
          </Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowIvrSettings(!showIvrSettings)}
            className="h-6 text-xs"
          >
            {showIvrSettings ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mb-2">
          Settings for navigating automated phone systems and IVRs
        </p>
        {showIvrSettings && (
          <div className="space-y-3 bg-muted/30 rounded-md p-3">
            <div className="space-y-1">
              <Label className="text-xs">IVR Debounce (ms)</Label>
              <Input
                type="number"
                min="50"
                max="500"
                step="25"
                value={ivrSettings.debounceMs}
                onChange={(e) => setIvrSettings(prev => ({ ...prev, debounceMs: parseInt(e.target.value) || 150 }))}
                className="text-xs h-8"
              />
              <p className="text-[10px] text-muted-foreground">Faster response to IVR prompts (default: 150ms)</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">IVR Utterance Flush (ms)</Label>
              <Input
                type="number"
                min="50"
                max="500"
                step="25"
                value={ivrSettings.utteranceFlushMs}
                onChange={(e) => setIvrSettings(prev => ({ ...prev, utteranceFlushMs: parseInt(e.target.value) || 200 }))}
                className="text-xs h-8"
              />
              <p className="text-[10px] text-muted-foreground">Quick utterance finalization for IVR (default: 200ms)</p>
            </div>
            <div className="border-t border-border/30 pt-3 mt-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">DTMF Settings</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">DTMF Duration (ms)</Label>
              <Input
                type="number"
                min="100"
                max="500"
                step="50"
                value={ivrSettings.dtmfDurationMs}
                onChange={(e) => setIvrSettings(prev => ({ ...prev, dtmfDurationMs: parseInt(e.target.value) || 250 }))}
                className="text-xs h-8"
              />
              <p className="text-[10px] text-muted-foreground">Duration of each DTMF tone (default: 250ms)</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">DTMF Min Pause (ms)</Label>
              <Input
                type="number"
                min="200"
                max="1000"
                step="100"
                value={ivrSettings.dtmfMinPauseMs}
                onChange={(e) => setIvrSettings(prev => ({ ...prev, dtmfMinPauseMs: parseInt(e.target.value) || 500 }))}
                className="text-xs h-8"
              />
              <p className="text-[10px] text-muted-foreground">Minimum pause between DTMF sends (default: 500ms)</p>
            </div>
            <div className="border-t border-border/30 pt-3 mt-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">Auto-Detection</p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Auto-Detect Threshold</Label>
              <Input
                type="number"
                min="0.1"
                max="1.0"
                step="0.1"
                value={ivrSettings.autoDetectThreshold}
                onChange={(e) => setIvrSettings(prev => ({ ...prev, autoDetectThreshold: parseFloat(e.target.value) || 0.7 }))}
                className="text-xs h-8"
              />
              <p className="text-[10px] text-muted-foreground">Confidence threshold for IVR mode (0.1-1.0, default: 0.7)</p>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-xs">Disable Grace Period in IVR</Label>
              <input
                type="checkbox"
                checked={ivrSettings.disableBargeInGracePeriod}
                onChange={(e) => setIvrSettings(prev => ({ ...prev, disableBargeInGracePeriod: e.target.checked }))}
                className="h-4 w-4"
              />
            </div>
            <p className="text-[10px] text-muted-foreground">IVRs don&apos;t have echo issues, so grace period can be disabled</p>
          </div>
        )}
      </div>

      {/* Save & Reset Buttons */}
      <div className="flex gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={handleSaveSettings}
          disabled={savingSettings}
          className="flex-1"
        >
          {savingSettings ? (
            <>
              <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
              Saving...
            </>
          ) : settingsSaveStatus === 'success' ? (
            <>
              <Check className="h-4 w-4 mr-2" />
              Saved!
            </>
          ) : settingsSaveStatus === 'error' ? (
            <>
              <AlertCircle className="h-4 w-4 mr-2" />
              Error
            </>
          ) : (
            <>
              <CheckCircle2 className="h-4 w-4 mr-2" />
              Save Settings
            </>
          )}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleResetSettings}
          className="flex-1"
        >
          <RotateCcw className="h-4 w-4 mr-2" />
          Reset
        </Button>
      </div>
      {settingsSaveStatus === 'success' && (
        <p className="text-xs text-green-600 dark:text-green-400 text-center">
          Settings saved successfully!
        </p>
      )}
      {settingsSaveStatus === 'error' && (
        <p className="text-xs text-red-600 dark:text-red-400 text-center">
          Failed to save settings. Please try again.
        </p>
      )}
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
        disabled={loading || !goal || !toNumber || !customSystemPrompt}
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
      {(!goal || !toNumber || !customSystemPrompt) && (
        <p className="text-xs text-muted-foreground text-center">
          {!customSystemPrompt
            ? 'Enter a system prompt to continue'
            : !goal && !toNumber
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

      {/* Goal Preview */}
      {goal && (
        <div className="space-y-2">
          <Label className="flex items-center gap-2 text-sm font-medium">
            <Target className="h-4 w-4" />
            Goal Injection (appended to prompt)
          </Label>
          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-md p-3 text-xs font-mono">
            <pre className="whitespace-pre-wrap">CALL GOAL (YOUR ONLY MISSION): &quot;{goal}&quot;</pre>
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
            <span className="text-muted-foreground">System Prompt:</span>
            <span className={`font-mono ${customSystemPrompt ? '' : 'text-destructive'}`}>{customSystemPrompt ? 'Set' : 'REQUIRED'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Phone Number:</span>
            <span className="font-mono">{toNumber || '(not set)'}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">TTS Debounce:</span>
            <span className="font-mono">{callControlSettings.ttsDebounceMs}ms</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Hold Check-In:</span>
            <span className="font-mono">{callControlSettings.holdCheckInIntervalMs / 1000}s</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Max Hold Check-Ins:</span>
            <span className="font-mono">{callControlSettings.holdMaxCheckIns}</span>
          </div>
          <div className="border-t border-border/30 pt-2 mt-2">
            <p className="text-xs font-medium text-muted-foreground mb-1">IVR Settings</p>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">IVR Debounce:</span>
            <span className="font-mono">{ivrSettings.debounceMs}ms</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">DTMF Duration:</span>
            <span className="font-mono">{ivrSettings.dtmfDurationMs}ms</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Auto-Detect Threshold:</span>
            <span className="font-mono">{ivrSettings.autoDetectThreshold}</span>
          </div>
        </div>
      </div>

      {/* Info Box */}
      <div className="bg-muted/20 border border-border/50 rounded-md p-3">
        <p className="text-xs text-muted-foreground">
          This panel shows exactly what configuration will be used when you make a call.
          The system prompt, goal injection, and context are combined to guide your AI assistant&apos;s behavior during the call.
          IVR navigation is automatically detected and optimized with DTMF support for phone tree navigation.
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
          {showObserver && isCallActive && (
            <Badge variant="success" className="gap-1 animate-pulse">
              <Radio className="h-3 w-3" />
              Listening Live
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
              <Button
                variant={isCallActive ? 'default' : 'outline'}
                size="sm"
                onClick={() => setShowAudioPopup(true)}
                disabled={!isCallActive}
                title={isCallActive ? 'Play audio into the call' : 'Start a call to play audio'}
              >
                <Volume2 className="h-4 w-4 mr-2" />
                Play Audio
              </Button>
              <Button
                variant={showObserver ? 'default' : 'outline'}
                size="sm"
                onClick={() => setShowObserver(!showObserver)}
                disabled={!isCallActive}
                title={isCallActive ? 'Listen to the call live' : 'Start a call to listen live'}
              >
                <Headphones className="h-4 w-4 mr-2" />
                Listen Live
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

      {/* Live Call Observer Panel */}
      {showObserver && activeCall && isCallActive && (
        <div className="mt-6">
          <LiveCallObserver
            callControlId={activeCall.id}
            onDisconnect={() => {
              // Optionally close the observer panel when disconnected
              // setShowObserver(false);
            }}
          />
        </div>
      )}

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

      {/* Audio Playback Popup */}
      <Dialog open={showAudioPopup} onOpenChange={setShowAudioPopup}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Volume2 className="h-5 w-5" />
              Play Audio Into Call
            </DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            {/* Status message */}
            {audioStatus && (
              <div className={`text-center py-2 px-3 rounded-md text-sm ${
                audioStatus.includes('Error') || audioStatus.includes('error')
                  ? 'bg-red-50 text-red-700 dark:bg-red-900/20 dark:text-red-400'
                  : audioStatus.includes('Playing')
                  ? 'bg-green-50 text-green-700 dark:bg-green-900/20 dark:text-green-400'
                  : 'bg-blue-50 text-blue-700 dark:bg-blue-900/20 dark:text-blue-400'
              }`}>
                {audioStatus}
              </div>
            )}
            {!isCallActive && (
              <div className="text-center py-4 text-muted-foreground">
                <PhoneOff className="h-8 w-8 mx-auto mb-2 opacity-50" />
                <p>No active call</p>
                <p className="text-xs mt-1">Start a call to play audio to the recipient</p>
              </div>
            )}
            {isCallActive && CALL_AUDIO_SOUNDS.map((sound) => (
              <Button
                key={sound.id}
                variant={playingAudioId === sound.id ? 'default' : 'outline'}
                className="w-full h-12 text-lg justify-start gap-3"
                onClick={() => handlePlayAudio(sound.id, sound.url)}
                disabled={playingAudioId !== null}
              >
                {playingAudioId === sound.id ? (
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <Volume2 className="h-4 w-4" />
                )}
                {sound.name}
              </Button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
