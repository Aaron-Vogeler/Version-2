'use client';

/**
 * Delegate A Call Component
 * 3-panel interface for configuring and monitoring AI phone calls
 * - Left: Call Settings & AI Controls
 * - Middle: Live Call Monitoring
 * - Right: Context Visibility & LLM I/O
 */

import { useState, useRef, useEffect, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { createClient } from '@/lib/supabase/client';
import {
  Phone,
  PhoneOff,
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
  X,
  Radio,
  Volume2,
  Mic,
  Clock,
  Zap
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
  interruptionMode?: 'normal' | 'sensitive' | 'patient';
  voiceId?: string;
  speechRate?: number;
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
  type: 'request' | 'response' | 'transcript' | 'system';
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  response?: string;
  tokens?: { input?: number; output?: number };
  speaker?: string;
}

/**
 * Active call state
 */
interface ActiveCall {
  callControlId: string;
  callSessionId?: string;
  status: 'initiated' | 'ringing' | 'answered' | 'completed' | 'failed';
  startedAt: string;
}

interface DelegateCallProps {
  customAssistantName?: string;
  customUserName?: string;
}

// Available TTS voices
const VOICE_OPTIONS = [
  { id: 'Telnyx.KokoroTTS.bm_george', name: 'George (Male, British)' },
  { id: 'Telnyx.KokoroTTS.af_sky', name: 'Sky (Female, American)' },
  { id: 'Telnyx.KokoroTTS.am_adam', name: 'Adam (Male, American)' },
  { id: 'Telnyx.KokoroTTS.bf_emma', name: 'Emma (Female, British)' },
  { id: 'Telnyx.KokoroTTS.af_nicole', name: 'Nicole (Female, American)' },
  { id: 'Telnyx.KokoroTTS.am_michael', name: 'Michael (Male, American)' },
];

// Interruption mode presets
const INTERRUPTION_MODES = {
  sensitive: { silenceMs: 300, label: 'Sensitive (300ms)', description: 'Quick to respond, may cut off speaker' },
  normal: { silenceMs: 500, label: 'Normal (500ms)', description: 'Balanced response timing' },
  patient: { silenceMs: 800, label: 'Patient (800ms)', description: 'Waits longer before responding' },
};

// Default values for AI configuration
const DEFAULT_AI_CONFIG = {
  silenceTimeoutMs: 500,
  maxTurnsInWindow: 12,
  summaryUpdateInterval: 6,
  temperature: 0.7,
  maxTokens: 1024,
  topP: 1,
  model: 'llama-3.1-8b-instant',
  interruptionMode: 'normal' as const,
  voiceId: 'Telnyx.KokoroTTS.bm_george',
  speechRate: 1.0,
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

  // Rolling Summary Prompt (editable)
  const DEFAULT_SUMMARY_PROMPT = `Summarize the conversation concisely, capturing key points, decisions, and action items.`;
  const [summaryPrompt, setSummaryPrompt] = useState(DEFAULT_SUMMARY_PROMPT);
  const [isEditingSummaryPrompt, setIsEditingSummaryPrompt] = useState(false);
  const [editSummaryPromptValue, setEditSummaryPromptValue] = useState('');

  // Telephony & Voice Settings
  const [interruptionMode, setInterruptionMode] = useState<'normal' | 'sensitive' | 'patient'>(DEFAULT_AI_CONFIG.interruptionMode);
  const [voiceId, setVoiceId] = useState(DEFAULT_AI_CONFIG.voiceId);
  const [speechRate, setSpeechRate] = useState(DEFAULT_AI_CONFIG.speechRate);
  const [responseDelaySec, setResponseDelaySec] = useState(DEFAULT_AI_CONFIG.silenceTimeoutMs / 1000);

  // Rolling Summary (editable)
  const [rollingSummary, setRollingSummary] = useState('');
  const [isEditingSummary, setIsEditingSummary] = useState(false);
  const [editSummaryValue, setEditSummaryValue] = useState('');

  // LLM Logs fullscreen
  const [isLogsFullscreen, setIsLogsFullscreen] = useState(false);

  // Conversation turns (from live call)
  const [turns, setTurns] = useState<Turn[]>([]);
  const [turnsSinceSummary, setTurnsSinceSummary] = useState(0);

  // LLM I/O Log
  const [llmLogs, setLlmLogs] = useState<LLMLogEntry[]>([]);
  const [showSystemPromptPreview, setShowSystemPromptPreview] = useState(false);

  // Active call state for real-time monitoring
  const [activeCall, setActiveCall] = useState<ActiveCall | null>(null);
  const [liveTranscript, setLiveTranscript] = useState('');
  const [isCallLive, setIsCallLive] = useState(false);

  // WebSocket connection for LLM logs
  const wsRef = useRef<WebSocket | null>(null);

  // Supabase client for realtime
  const supabase = useMemo(() => createClient(), []);

  const llmLogRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  // Auto-scroll LLM logs
  useEffect(() => {
    if (llmLogRef.current) {
      llmLogRef.current.scrollTop = llmLogRef.current.scrollHeight;
    }
  }, [llmLogs]);

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [liveTranscript]);

  // Subscribe to real-time call updates when a call is active
  useEffect(() => {
    if (!activeCall?.callControlId) return;

    console.log('Setting up realtime subscription for call:', activeCall.callControlId);

    const channel = supabase
      .channel(`delegate-call-${activeCall.callControlId}`)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'calls',
          filter: `call_control_id=eq.${activeCall.callControlId}`,
        },
        (payload) => {
          console.log('Received call update:', payload);
          const newCall = payload.new as any;

          // Update live transcript
          if (newCall.live_transcript !== undefined && newCall.live_transcript !== liveTranscript) {
            setLiveTranscript(newCall.live_transcript || '');

            // Parse transcript into turns for display
            if (newCall.live_transcript) {
              const lines = newCall.live_transcript.split('\n').filter((l: string) => l.trim());
              const newTurns: Turn[] = lines.map((line: string, i: number) => {
                const match = line.match(/^\[([^\]]+)\]\s*(.*)$/);
                if (match) {
                  const speakerRaw = match[1].toLowerCase();
                  const speaker = speakerRaw.includes('assistant') || speakerRaw.includes('ai')
                    ? 'assistant'
                    : speakerRaw.includes('caller') || speakerRaw.includes('user')
                    ? 'caller'
                    : 'agent';
                  return { speaker, text: match[2], timestamp: new Date().toISOString() };
                }
                return { speaker: 'caller' as const, text: line, timestamp: new Date().toISOString() };
              });
              setTurns(newTurns);
            }

            // Log transcript update
            logLLMInteraction({
              type: 'transcript',
              response: `Transcript updated (${(newCall.live_transcript || '').length} chars)`,
            });
          }

          // Handle LLM logs from Supabase - directly set from database
          if (newCall.llm_logs && Array.isArray(newCall.llm_logs)) {
            const displayLogs = newCall.llm_logs.map((log: any, index: number) => ({
              id: `${activeCall?.callControlId}-${index}`,
              timestamp: log.timestamp,
              type: log.type === 'request' ? 'request' :
                     log.type === 'response' ? 'response' :
                     log.type === 'summary_request' ? 'system' :
                     log.type === 'summary_response' ? 'system' :
                     'system' as const,
              model: log.type === 'summary_request' || log.type === 'summary_response' ? 'rolling-summary' : undefined,
              response: log.type === 'response' ? log.data?.response :
                       log.type === 'summary_response' ? log.data?.summary :
                       log.type === 'error' ? `Error: ${log.data?.error}` :
                       log.type === 'summary_error' ? `Summary Error: ${log.data?.error}` :
                       JSON.stringify(log.data),
              tokens: log.data?.tokens,
            }));
            setLlmLogs(displayLogs);
          }

          // Update call status
          if (newCall.status) {
            const callIsLive = ['initiated', 'ringing', 'answered'].includes(newCall.status);
            setIsCallLive(callIsLive);

            setActiveCall(prev => prev ? { ...prev, status: newCall.status } : null);

            // Log status change
            logLLMInteraction({
              type: 'system',
              response: `Call status: ${newCall.status}`,
            });

            // If call ended, clear active state
            if (['completed', 'failed', 'busy', 'no-answer'].includes(newCall.status)) {
              setStatus('success');
              setMessage(`Call ${newCall.status}`);
            }
          }
        }
      )
      .subscribe((status) => {
        console.log('Realtime subscription status:', status);
      });

    return () => {
      console.log('Cleaning up realtime subscription');
      supabase.removeChannel(channel);
    };
  }, [activeCall?.callControlId, supabase]);

  // Sync response delay with interruption mode
  useEffect(() => {
    const modeConfig = INTERRUPTION_MODES[interruptionMode];
    setResponseDelaySec(modeConfig.silenceMs / 1000);
    setSilenceTimeoutMs(modeConfig.silenceMs);
  }, [interruptionMode]);


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

  // Handle editing summary prompt
  const handleEditSummaryPrompt = () => {
    setEditSummaryPromptValue(summaryPrompt);
    setIsEditingSummaryPrompt(true);
  };

  // Handle saving summary prompt
  const handleSaveSummaryPrompt = () => {
    setSummaryPrompt(editSummaryPromptValue);
    setIsEditingSummaryPrompt(false);
  };

  // Handle canceling summary prompt edit
  const handleCancelSummaryPromptEdit = () => {
    setIsEditingSummaryPrompt(false);
    setEditSummaryPromptValue('');
  };

  // Export LLM logs as JSON
  const exportLLMLogs = () => {
    const data = {
      exportedAt: new Date().toISOString(),
      callControlId: activeCall?.callControlId || 'no-active-call',
      logs: llmLogs,
      summary: {
        totalLogs: llmLogs.length,
        byType: {
          requests: llmLogs.filter(l => l.type === 'request').length,
          responses: llmLogs.filter(l => l.type === 'response').length,
          transcripts: llmLogs.filter(l => l.type === 'transcript').length,
          system: llmLogs.filter(l => l.type === 'system').length,
        },
      },
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `llm-logs-${activeCall?.callControlId || 'export'}-${new Date().getTime()}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
    setSummaryPrompt(DEFAULT_SUMMARY_PROMPT);
    setSilenceTimeoutMs(DEFAULT_AI_CONFIG.silenceTimeoutMs);
    setInterruptionMode(DEFAULT_AI_CONFIG.interruptionMode);
    setVoiceId(DEFAULT_AI_CONFIG.voiceId);
    setSpeechRate(DEFAULT_AI_CONFIG.speechRate);
    setResponseDelaySec(DEFAULT_AI_CONFIG.silenceTimeoutMs / 1000);
    setGoal('');
    setContext('');
    setRollingSummary('');
    setTurns([]);
    setTurnsSinceSummary(0);
    setLlmLogs([]);
    setActiveCall(null);
    setLiveTranscript('');
    setIsCallLive(false);
  };

  // Hang up active call
  const handleHangup = async () => {
    if (!activeCall?.callControlId) return;

    try {
      const response = await fetch('/api/calls/hangup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ call_control_id: activeCall.callControlId }),
      });

      if (response.ok) {
        setStatus('success');
        setMessage('Call ended');
        setIsCallLive(false);
        logLLMInteraction({
          type: 'system',
          response: 'Call ended by user',
        });
      } else {
        const data = await response.json();
        setStatus('error');
        setMessage(data.error || 'Failed to end call');
      }
    } catch (error: any) {
      setStatus('error');
      setMessage(error.message || 'Failed to end call');
    }
  };

  // Submit actual call
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setStatus('idle');
    setMessage('');

    // Clear previous call state
    setActiveCall(null);
    setLiveTranscript('');
    setTurns([]);
    setIsCallLive(false);

    try {
      // Build AI config object with all telephony/AI settings
      const aiConfig: AIConfig = {};

      if (useCustomPrompt && systemPrompt.trim()) {
        aiConfig.systemPrompt = systemPrompt.trim();
      }

      // Always include summary prompt
      if (summaryPrompt.trim()) {
        aiConfig.summaryPrompt = summaryPrompt.trim();
      }

      // Always include silence timeout based on response delay
      const effectiveSilenceMs = Math.round(responseDelaySec * 1000);
      if (effectiveSilenceMs !== DEFAULT_AI_CONFIG.silenceTimeoutMs) {
        aiConfig.silenceTimeoutMs = effectiveSilenceMs;
      }

      if (maxTurnsInWindow !== DEFAULT_AI_CONFIG.maxTurnsInWindow) {
        aiConfig.maxTurnsInWindow = maxTurnsInWindow;
      }
      if (summaryUpdateInterval !== DEFAULT_AI_CONFIG.summaryUpdateInterval) {
        aiConfig.summaryUpdateInterval = summaryUpdateInterval;
      }
      if (interruptionMode !== DEFAULT_AI_CONFIG.interruptionMode) {
        aiConfig.interruptionMode = interruptionMode;
      }
      if (voiceId !== DEFAULT_AI_CONFIG.voiceId) {
        aiConfig.voiceId = voiceId;
      }
      if (speechRate !== DEFAULT_AI_CONFIG.speechRate) {
        aiConfig.speechRate = speechRate;
      }

      // Log the request to LLM log
      const effectivePrompt = buildEffectiveSystemPrompt();
      logLLMInteraction({
        type: 'request',
        model,
        messages: [
          { role: 'system', content: effectivePrompt },
        ],
      });

      // Log AI config being used
      logLLMInteraction({
        type: 'system',
        response: `Config: Voice=${VOICE_OPTIONS.find(v => v.id === voiceId)?.name || voiceId}, Response Delay=${responseDelaySec}s, Mode=${interruptionMode}`,
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

      // Set up active call for real-time monitoring
      const callControlId = data.flyResponse?.call_control_id;
      if (callControlId) {
        setActiveCall({
          callControlId,
          callSessionId: data.flyResponse?.call_session_id,
          status: 'initiated',
          startedAt: new Date().toISOString(),
        });
        setIsCallLive(true);
      }

      setStatus('success');
      setMessage('Call initiated - monitoring live...');

      // Log successful call initiation
      logLLMInteraction({
        type: 'system',
        response: `Call initiated. ID: ${callControlId || 'unknown'}. Monitoring live transcript...`,
      });

    } catch (error: any) {
      console.error('Error delegating call:', error);
      setStatus('error');
      setMessage(error.message || 'Failed to delegate call. Please try again.');

      logLLMInteraction({
        type: 'system',
        response: `Error: ${error.message}`,
      });
    } finally {
      setLoading(false);
    }
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

                {/* Telephony & Voice Settings */}
                <div className="space-y-3 pt-2 border-t">
                  <div className="flex items-center gap-2">
                    <Volume2 className="h-4 w-4" />
                    <Label className="text-sm font-medium">Voice & Timing</Label>
                  </div>

                  {/* Response Delay (seconds) */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <Clock className="h-3 w-3 text-muted-foreground" />
                        <Label className="text-xs text-muted-foreground">Response Delay</Label>
                      </div>
                      <span className="text-xs font-mono">{responseDelaySec.toFixed(2)}s</span>
                    </div>
                    <Input
                      type="number"
                      min={0.1}
                      max={3}
                      step={0.1}
                      value={responseDelaySec}
                      onChange={(e) => {
                        const val = parseFloat(e.target.value) || 0.5;
                        setResponseDelaySec(val);
                        setSilenceTimeoutMs(Math.round(val * 1000));
                      }}
                      className="h-8 text-sm"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      How long AI waits after you stop speaking before responding
                    </p>
                  </div>

                  {/* Interruption Mode */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-1">
                      <Zap className="h-3 w-3 text-muted-foreground" />
                      <Label className="text-xs text-muted-foreground">Interruption Mode</Label>
                    </div>
                    <select
                      value={interruptionMode}
                      onChange={(e) => setInterruptionMode(e.target.value as 'normal' | 'sensitive' | 'patient')}
                      className="w-full h-8 text-sm rounded-md border border-input bg-background px-3"
                    >
                      {Object.entries(INTERRUPTION_MODES).map(([key, config]) => (
                        <option key={key} value={key}>
                          {config.label}
                        </option>
                      ))}
                    </select>
                    <p className="text-[10px] text-muted-foreground">
                      {INTERRUPTION_MODES[interruptionMode].description}
                    </p>
                  </div>

                  {/* Voice Selection */}
                  <div className="space-y-1">
                    <div className="flex items-center gap-1">
                      <Mic className="h-3 w-3 text-muted-foreground" />
                      <Label className="text-xs text-muted-foreground">Voice</Label>
                    </div>
                    <select
                      value={voiceId}
                      onChange={(e) => setVoiceId(e.target.value)}
                      className="w-full h-8 text-sm rounded-md border border-input bg-background px-3"
                    >
                      {VOICE_OPTIONS.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Speech Rate */}
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <Label className="text-xs text-muted-foreground">Speech Rate</Label>
                      <span className="text-xs font-mono">{speechRate}x</span>
                    </div>
                    <Input
                      type="number"
                      min={0.5}
                      max={2}
                      step={0.1}
                      value={speechRate}
                      onChange={(e) => setSpeechRate(parseFloat(e.target.value) || 1)}
                      className="h-8 text-sm"
                    />
                  </div>
                </div>

                {/* Context Window Settings Section */}
                <div className="space-y-3 pt-2 border-t">
                  <Label className="text-sm font-medium">Context Window</Label>

                  {/* Rolling Summary Prompt */}
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs text-muted-foreground">Rolling Summary Prompt</Label>
                      {!isEditingSummaryPrompt && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-5 w-5 p-0"
                          onClick={handleEditSummaryPrompt}
                        >
                          <Edit3 className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                    {isEditingSummaryPrompt ? (
                      <div className="space-y-2">
                        <Textarea
                          value={editSummaryPromptValue}
                          onChange={(e) => setEditSummaryPromptValue(e.target.value)}
                          className="resize-none text-xs font-mono"
                          rows={3}
                        />
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={handleSaveSummaryPrompt}>
                            <Save className="h-3 w-3 mr-1" /> Save
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={handleCancelSummaryPromptEdit}>
                            <X className="h-3 w-3 mr-1" /> Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="p-2 bg-muted/30 rounded text-xs font-mono max-h-[80px] overflow-y-auto">
                        {summaryPrompt}
                      </div>
                    )}
                  </div>

                  {/* Max Turns in Window */}
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <Label className="text-xs text-muted-foreground">Recent Turns Max</Label>
                      <span className="text-xs font-mono">{maxTurnsInWindow}</span>
                    </div>
                    <Input
                      type="number"
                      min={1}
                      max={100}
                      value={maxTurnsInWindow}
                      onChange={(e) => setMaxTurnsInWindow(parseInt(e.target.value) || 12)}
                      className="h-8 text-sm"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Max recent turns to keep in context window
                    </p>
                  </div>

                  {/* Summary Update Interval */}
                  <div className="space-y-1">
                    <div className="flex justify-between">
                      <Label className="text-xs text-muted-foreground">Summary Refresh Turns</Label>
                      <span className="text-xs font-mono">{summaryUpdateInterval}</span>
                    </div>
                    <Input
                      type="number"
                      min={1}
                      max={50}
                      value={summaryUpdateInterval}
                      onChange={(e) => setSummaryUpdateInterval(parseInt(e.target.value) || 6)}
                      className="h-8 text-sm"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      Update rolling summary after this many new turns
                    </p>
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

        {/* Middle Panel - Live Call Monitoring */}
        <div className={`${showSettings && showContext ? 'col-span-6' : showSettings || showContext ? 'col-span-9' : 'col-span-12'}`}>
          <Card className="h-full">
            <CardContent className="p-4 flex flex-col h-full">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div>
                    <h3 className="font-semibold">
                      {isCallLive ? 'Live Call' : 'Make Call'}
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      {activeCall ? `Status: ${activeCall.status}` : 'Enter details below'}
                    </p>
                  </div>
                  {isCallLive && (
                    <div className="flex items-center gap-1 px-2 py-1 bg-red-100 dark:bg-red-900/30 rounded-full">
                      <Radio className="h-3 w-3 text-red-500 animate-pulse" />
                      <span className="text-xs text-red-600 dark:text-red-400 font-medium">LIVE</span>
                    </div>
                  )}
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
                    disabled={isCallLive}
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

                <div className="flex gap-2">
                  <Button
                    type="submit"
                    className="flex-1"
                    disabled={loading || !goal || !toNumber || isCallLive}
                  >
                    {loading ? (
                      <>
                        <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                        Connecting...
                      </>
                    ) : (
                      <>
                        <Phone className="mr-2 h-4 w-4" />
                        Start Call
                      </>
                    )}
                  </Button>

                  {isCallLive && (
                    <Button
                      type="button"
                      variant="destructive"
                      onClick={handleHangup}
                    >
                      <PhoneOff className="mr-2 h-4 w-4" />
                      End Call
                    </Button>
                  )}
                </div>
              </form>

              {/* LLM Activity Logs - Fullscreen Modal */}
              {isLogsFullscreen && (
                <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
                  <Card className="w-full h-full max-w-4xl flex flex-col">
                    <CardContent className="p-4 flex flex-col h-full">
                      <div className="flex items-center justify-between mb-4">
                        <h3 className="font-bold text-lg">All LLM Activity</h3>
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={exportLLMLogs}
                            disabled={llmLogs.length === 0}
                          >
                            <FileText className="h-4 w-4 mr-2" />
                            Export JSON
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setIsLogsFullscreen(false)}
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      <div className="flex-1 overflow-y-auto border rounded-lg p-4 bg-muted/20">
                        {llmLogs.length === 0 ? (
                          <span className="text-muted-foreground italic">No activity yet</span>
                        ) : (
                          llmLogs.map((log) => (
                            <div key={log.id} className="mb-4 pb-4 border-b border-muted last:border-0">
                              <div className="flex items-center gap-2 mb-2">
                                <span className={`px-2 py-1 rounded text-xs font-semibold ${
                                  log.type === 'request'
                                    ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                                    : log.type === 'response'
                                    ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                                    : log.type === 'transcript'
                                    ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400'
                                    : 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400'
                                }`}>
                                  {log.type === 'system' ? 'SYSTEM' : log.type.toUpperCase()}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {new Date(log.timestamp).toLocaleTimeString()}
                                </span>
                              </div>
                              {log.type === 'request' && log.messages && (
                                <div className="text-sm text-muted-foreground mb-2">
                                  <div className="font-medium text-sm mb-1">{log.messages.length} messages • {log.model}</div>
                                  {log.messages.map((msg, i) => (
                                    <div key={i} className="ml-4 mb-2 text-xs">
                                      <span className="font-mono text-xs text-blue-600 dark:text-blue-400">[{msg.role}]</span>
                                      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed">{msg.content.slice(0, 300)}{msg.content.length > 300 ? '...' : ''}</p>
                                    </div>
                                  ))}
                                </div>
                              )}
                              {(log.type === 'response' || log.type === 'system' || log.type === 'transcript') && log.response && (
                                <div className="text-sm whitespace-pre-wrap break-words">
                                  {log.response}
                                  {log.tokens && (
                                    <div className="text-xs text-muted-foreground mt-1">
                                      Tokens - In: {log.tokens.input}, Out: {log.tokens.output}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}

              {/* Live Transcript Display */}
              <div className="flex-1 flex flex-col min-h-0">
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-sm font-medium flex items-center gap-2">
                    <MessageSquare className="h-4 w-4" />
                    Live Transcript
                  </Label>
                  {liveTranscript && (
                    <span className="text-xs text-muted-foreground">
                      {liveTranscript.split('\n').filter(l => l.trim()).length} messages
                    </span>
                  )}
                </div>

                <div
                  ref={transcriptRef}
                  className="flex-1 border rounded-lg p-4 bg-muted/20 overflow-y-auto min-h-[200px]"
                >
                  {!liveTranscript && !isCallLive ? (
                    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                      <Phone className="h-8 w-8 mb-2 opacity-50" />
                      <p className="text-sm">No active call</p>
                      <p className="text-xs">Start a call to see the live transcript</p>
                    </div>
                  ) : !liveTranscript && isCallLive ? (
                    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                      <div className="flex items-center gap-2 mb-2">
                        <div className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                        <span className="text-sm">Waiting for transcript...</span>
                      </div>
                      <p className="text-xs">The conversation will appear here as you speak</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {/* Show parsed turns as chat bubbles */}
                      {turns.map((turn, index) => (
                        <div
                          key={index}
                          className={`flex ${turn.speaker === 'assistant' ? 'justify-start' : 'justify-end'}`}
                        >
                          <div
                            className={`max-w-[85%] p-3 rounded-lg text-sm ${
                              turn.speaker === 'assistant'
                                ? 'bg-muted'
                                : 'bg-primary text-primary-foreground'
                            }`}
                          >
                            <p className="text-xs opacity-70 mb-1 font-medium">
                              {turn.speaker === 'assistant' ? assistantName : 'Caller'}
                            </p>
                            <p className="leading-relaxed">{turn.text}</p>
                          </div>
                        </div>
                      ))}

                      {/* Raw transcript fallback if no parsed turns */}
                      {turns.length === 0 && liveTranscript && (
                        <pre className="whitespace-pre-wrap font-mono text-xs bg-muted/30 p-3 rounded">
                          {liveTranscript}
                        </pre>
                      )}
                    </div>
                  )}
                </div>

                {/* LLM Activity Logs - Below Transcript */}
                <div className="mt-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Zap className="h-4 w-4" />
                      <Label className="text-sm font-medium">LLM Activity ({llmLogs.length})</Label>
                    </div>
                    <div className="flex gap-1">
                      {llmLogs.length > 0 && (
                        <>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-xs"
                            onClick={exportLLMLogs}
                          >
                            <FileText className="h-3 w-3 mr-1" />
                            Export
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-xs"
                            onClick={() => setIsLogsFullscreen(true)}
                          >
                            <Maximize2 className="h-3 w-3 mr-1" />
                            Fullscreen
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 text-xs"
                            onClick={() => setLlmLogs([])}
                          >
                            Clear
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <div
                    ref={llmLogRef}
                    className="border rounded-lg p-3 bg-muted/20 overflow-y-auto max-h-[300px] text-xs font-mono"
                  >
                    {llmLogs.length === 0 ? (
                      <span className="text-muted-foreground italic">
                        Activity will appear here during calls
                      </span>
                    ) : (
                      llmLogs.map((log) => (
                        <div key={log.id} className="mb-2 pb-2 border-b border-muted/50 last:border-0">
                          <div className="flex items-center gap-2 mb-1">
                            <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              log.type === 'request'
                                ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                                : log.type === 'response'
                                ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                                : log.type === 'transcript'
                                ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400'
                                : 'bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400'
                            }`}>
                              {log.type === 'system' ? 'SYS' : log.type.toUpperCase().slice(0, 4)}
                            </span>
                            <span className="text-muted-foreground text-[10px]">
                              {new Date(log.timestamp).toLocaleTimeString()}
                            </span>
                          </div>
                          {log.type === 'request' && log.messages && (
                            <div className="text-[10px] text-muted-foreground ml-4">
                              {log.messages.length} messages ({log.model})
                              {log.messages.map((msg, i) => (
                                <div key={i} className="text-[9px] mt-0.5 truncate">
                                  <span className="text-blue-600 dark:text-blue-400">[{msg.role}]</span> {msg.content.slice(0, 60)}...
                                </div>
                              ))}
                            </div>
                          )}
                          {(log.type === 'response' || log.type === 'system' || log.type === 'transcript') && log.response && (
                            <div className="text-[10px] break-words ml-4">
                              {log.response.slice(0, 150)}{log.response.length > 150 ? '...' : ''}
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
                  <Label className="text-sm font-medium">Active Config</Label>
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    <span className="text-muted-foreground">Model:</span>
                    <span className="text-right font-mono">{model}</span>

                    <span className="text-muted-foreground">Voice:</span>
                    <span className="text-right font-mono text-[10px]">
                      {VOICE_OPTIONS.find(v => v.id === voiceId)?.name.split(' ')[0] || 'Default'}
                    </span>

                    <span className="text-muted-foreground">Response Delay:</span>
                    <span className="text-right font-mono">{responseDelaySec}s</span>

                    <span className="text-muted-foreground">Mode:</span>
                    <span className="text-right font-mono">{interruptionMode}</span>

                    <span className="text-muted-foreground">Temperature:</span>
                    <span className="text-right font-mono">{temperature}</span>

                    <span className="text-muted-foreground">Call Active:</span>
                    <span className="text-right font-mono">{isCallLive ? 'Yes' : 'No'}</span>
                  </div>
                </div>

                {/* Activity Summary */}
                <div className="space-y-2 pt-2 border-t">
                  <Label className="text-sm font-medium">Activity Summary</Label>
                  <div className="grid grid-cols-2 gap-1 text-xs">
                    <span className="text-muted-foreground">Total Events:</span>
                    <span className="text-right font-mono">{llmLogs.length}</span>

                    <span className="text-muted-foreground">Requests:</span>
                    <span className="text-right font-mono text-blue-600 dark:text-blue-400">
                      {llmLogs.filter(l => l.type === 'request').length}
                    </span>

                    <span className="text-muted-foreground">Responses:</span>
                    <span className="text-right font-mono text-green-600 dark:text-green-400">
                      {llmLogs.filter(l => l.type === 'response').length}
                    </span>

                    <span className="text-muted-foreground">System Events:</span>
                    <span className="text-right font-mono text-gray-600 dark:text-gray-400">
                      {llmLogs.filter(l => l.type === 'system').length}
                    </span>
                  </div>
                  <p className="text-[10px] text-muted-foreground mt-2">
                    See full logs in the LLM Activity section below the transcript
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
