'use client';

/**
 * AI Outbound Call Checklist Component
 * A comprehensive checklist for configuring professional AI outbound calls.
 *
 * Features:
 * - Categorized settings with status indicators
 * - Collapsible/hideable sections
 * - Integrated AI assistant for help with configuration
 * - Real-time validation of settings
 */

import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Send,
  Bot,
  User,
  Phone,
  Radio,
  Clock,
  Zap,
  Volume2,
  Brain,
  Settings2,
  FileText,
  Target,
  RefreshCw,
  Info,
  HelpCircle,
  Sparkles,
  MessageSquare,
  Loader2,
  X,
  Minimize2,
  Maximize2,
} from 'lucide-react';

// Checklist category configuration
interface ChecklistItem {
  id: string;
  name: string;
  description: string;
  importance: 'critical' | 'important' | 'recommended' | 'optional';
  settingKey?: string;
  checkValue?: (value: any, allSettings: any) => 'complete' | 'warning' | 'error' | 'info';
  tips?: string[];
  humanValue?: string;
  ivrValue?: string;
}

interface ChecklistCategory {
  id: string;
  name: string;
  icon: React.ReactNode;
  description: string;
  items: ChecklistItem[];
}

// Chat message type
interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
}

// Saved settings interface (mirrors groq-call.tsx)
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

interface AIOutboundChecklistProps {
  groqSettings?: SavedGroqSettings | null;
  customAssistantName?: string;
  firstName?: string;
  onNavigateToSettings?: () => void;
}

// Define all checklist categories and items
const getChecklistCategories = (): ChecklistCategory[] => [
  {
    id: 'detection',
    name: 'Human vs IVR Detection',
    icon: <Radio className="h-5 w-5" />,
    description: 'Configure how the AI identifies whether it\'s talking to a human or an automated system (IVR/phone tree)',
    items: [
      {
        id: 'auto-detect-threshold',
        name: 'Auto-Detection Threshold',
        description: 'Confidence level (0-1) required to classify as IVR. Higher = more certain before switching modes.',
        importance: 'critical',
        settingKey: 'ivrSettings.autoDetectThreshold',
        humanValue: 'N/A (only triggers on IVR detection)',
        ivrValue: '0.7 (default) - triggers IVR mode when 70% confident',
        tips: [
          'Lower threshold (0.5) = More aggressive IVR detection, may false-positive on humans',
          'Higher threshold (0.9) = Conservative, may miss some IVRs',
          'Start with 0.7 and adjust based on call results',
        ],
        checkValue: (value) => {
          if (value === undefined) return 'warning';
          if (value >= 0.6 && value <= 0.8) return 'complete';
          if (value < 0.5 || value > 0.9) return 'warning';
          return 'complete';
        },
      },
      {
        id: 'debounce-difference',
        name: 'Debounce Settings (Human vs IVR)',
        description: 'Different silence thresholds for humans (slower, more natural) vs IVRs (faster response needed)',
        importance: 'critical',
        humanValue: '500ms (default) - natural conversation pace',
        ivrValue: '150ms (default) - fast response to IVR prompts',
        tips: [
          'Humans need longer pauses to think - 400-600ms is natural',
          'IVRs timeout quickly - 100-200ms keeps the system engaged',
          'Too fast for humans = interrupting them, too slow for IVR = missed prompts',
        ],
        checkValue: (_, allSettings) => {
          const ttsDebounce = allSettings?.callControlSettings?.ttsDebounceMs;
          const ivrDebounce = allSettings?.ivrSettings?.debounceMs;
          if (!ttsDebounce || !ivrDebounce) return 'warning';
          if (ttsDebounce > ivrDebounce * 2) return 'complete';
          return 'warning';
        },
      },
      {
        id: 'utterance-flush-difference',
        name: 'Utterance Flush (Human vs IVR)',
        description: 'How long to wait before finalizing what was heard. Shorter for IVRs, longer for humans.',
        importance: 'important',
        humanValue: '300ms - allows for natural speech pauses',
        ivrValue: '200ms - quick finalization for IVR prompts',
        tips: [
          'This affects how quickly the AI "locks in" what it heard',
          'Too short with humans = cutting off mid-sentence',
          'IVRs give clear, complete prompts so faster flush is fine',
        ],
      },
      {
        id: 'barge-in-grace-period',
        name: 'Barge-In Grace Period',
        description: 'Whether to use grace period before allowing interrupts. Disable for IVR (no echo issues).',
        importance: 'recommended',
        humanValue: 'Enabled - prevents echo-triggered interrupts',
        ivrValue: 'Disabled - IVRs don\'t have echo issues',
        tips: [
          'Grace period prevents the AI from stopping when it hears its own voice',
          'IVRs don\'t create this echo problem',
          'If calls with humans get cut off, increase grace period',
        ],
      },
    ],
  },
  {
    id: 'voice-timing',
    name: 'Voice & Timing Settings',
    icon: <Volume2 className="h-5 w-5" />,
    description: 'Control the pace and timing of speech interactions',
    items: [
      {
        id: 'tts-debounce',
        name: 'TTS Debounce (Silence Before Response)',
        description: 'How long to wait after silence before the AI starts speaking',
        importance: 'critical',
        settingKey: 'callControlSettings.ttsDebounceMs',
        humanValue: '400-600ms - natural conversation rhythm',
        ivrValue: '100-200ms - quick response to prompts',
        tips: [
          'This is the main "conversation pace" setting',
          'Too low = AI interrupts, too high = awkward pauses',
          '500ms is a good starting point for humans',
        ],
        checkValue: (value) => {
          if (!value) return 'error';
          if (value >= 400 && value <= 600) return 'complete';
          if (value < 300 || value > 800) return 'warning';
          return 'complete';
        },
      },
      {
        id: 'barge-in-cooldown',
        name: 'Barge-In Cooldown',
        description: 'Minimum time between stop commands when caller interrupts',
        importance: 'important',
        settingKey: 'callControlSettings.bargeInCooldownMs',
        tips: [
          'Prevents spam-stopping the AI',
          '200-400ms is typically good',
          'Lower if caller complaints about not being able to interrupt',
        ],
        checkValue: (value) => {
          if (!value) return 'warning';
          if (value >= 200 && value <= 400) return 'complete';
          return 'info';
        },
      },
      {
        id: 'utterance-flush',
        name: 'Caller Utterance Flush',
        description: 'Time to wait before logging what the caller said',
        importance: 'important',
        settingKey: 'callControlSettings.callerUtteranceFlushMs',
        tips: [
          'Affects transcription accuracy',
          '200-400ms captures complete sentences',
          'Too short = incomplete transcriptions',
        ],
        checkValue: (value) => {
          if (!value) return 'warning';
          if (value >= 200 && value <= 400) return 'complete';
          return 'info';
        },
      },
      {
        id: 'hangup-delay',
        name: 'Hangup Delay',
        description: 'Time to wait for TTS to finish before ending call',
        importance: 'recommended',
        settingKey: 'callControlSettings.hangupDelayMs',
        tips: [
          'Ensures goodbye message completes',
          '1500-2500ms is usually enough',
          'Increase if messages get cut off at end of call',
        ],
        checkValue: (value) => {
          if (!value) return 'warning';
          if (value >= 1500 && value <= 3000) return 'complete';
          return 'info';
        },
      },
    ],
  },
  {
    id: 'ivr-navigation',
    name: 'IVR/Phone Tree Navigation',
    icon: <Phone className="h-5 w-5" />,
    description: 'Settings for navigating automated phone systems using DTMF tones',
    items: [
      {
        id: 'dtmf-duration',
        name: 'DTMF Tone Duration',
        description: 'How long each button press tone lasts',
        importance: 'important',
        settingKey: 'ivrSettings.dtmfDurationMs',
        tips: [
          '200-300ms is standard',
          'Some older systems need longer tones (400ms)',
          'Too short = tone not recognized',
        ],
        checkValue: (value) => {
          if (!value) return 'warning';
          if (value >= 200 && value <= 300) return 'complete';
          return 'info';
        },
      },
      {
        id: 'dtmf-pause',
        name: 'DTMF Minimum Pause',
        description: 'Minimum time between sending DTMF tones',
        importance: 'important',
        settingKey: 'ivrSettings.dtmfMinPauseMs',
        tips: [
          '400-600ms prevents tones from blending',
          'Some systems need longer gaps',
          'If menu navigation fails, try increasing this',
        ],
        checkValue: (value) => {
          if (!value) return 'warning';
          if (value >= 400 && value <= 600) return 'complete';
          return 'info';
        },
      },
      {
        id: 'response-timeout',
        name: 'IVR Response Timeout',
        description: 'How long to wait for IVR to respond before retrying',
        importance: 'recommended',
        settingKey: 'ivrSettings.responseTimeoutMs',
        tips: [
          '6000-10000ms (6-10 seconds) is typical',
          'Some complex IVRs need longer',
          'Too short = premature retries',
        ],
        checkValue: (value) => {
          if (!value) return 'info';
          if (value >= 6000 && value <= 10000) return 'complete';
          return 'info';
        },
      },
      {
        id: 'max-dtmf-retries',
        name: 'Maximum DTMF Retries',
        description: 'How many times to retry DTMF if no response',
        importance: 'optional',
        settingKey: 'ivrSettings.maxDtmfRetries',
        tips: [
          '2-3 retries is usually enough',
          'More retries can annoy IVR systems',
          'If stuck in loops, reduce this',
        ],
        checkValue: (value) => {
          if (!value) return 'info';
          if (value >= 2 && value <= 3) return 'complete';
          return 'info';
        },
      },
    ],
  },
  {
    id: 'llm-config',
    name: 'LLM Configuration',
    icon: <Brain className="h-5 w-5" />,
    description: 'Configure the AI model behavior and response generation',
    items: [
      {
        id: 'model-selection',
        name: 'Model Selection',
        description: 'Choose the AI model for generating responses',
        importance: 'critical',
        settingKey: 'model',
        tips: [
          'llama-3.1-8b-instant: Fast, good for simple tasks',
          'llama-3.1-70b-versatile: Slower but smarter',
          'Consider latency vs quality tradeoff for calls',
        ],
        checkValue: (value) => {
          if (!value) return 'error';
          return 'complete';
        },
      },
      {
        id: 'temperature',
        name: 'Temperature',
        description: 'Controls randomness/creativity in responses (0-2)',
        importance: 'important',
        settingKey: 'temperature',
        tips: [
          '0.5-0.7: Focused, consistent responses (good for business calls)',
          '0.8-1.0: More varied, creative responses',
          'Lower = more predictable, higher = more varied',
        ],
        checkValue: (value) => {
          if (value === undefined) return 'warning';
          if (value >= 0.5 && value <= 0.8) return 'complete';
          return 'info';
        },
      },
      {
        id: 'max-tokens',
        name: 'Max Tokens',
        description: 'Maximum length of AI responses',
        importance: 'important',
        settingKey: 'maxTokens',
        tips: [
          '512-1024: Good for concise phone responses',
          'Higher values allow longer explanations',
          'Phone calls typically need shorter responses',
        ],
        checkValue: (value) => {
          if (!value) return 'warning';
          if (value >= 512 && value <= 1500) return 'complete';
          return 'info';
        },
      },
      {
        id: 'reasoning',
        name: 'Reasoning Level',
        description: 'How much "thinking" the model does before responding',
        importance: 'recommended',
        settingKey: 'reasoning',
        tips: [
          'Low: Quick responses, less complex reasoning',
          'Medium: Balanced (recommended for most calls)',
          'High: More thoughtful but slower responses',
        ],
        checkValue: (value) => {
          if (!value) return 'info';
          return 'complete';
        },
      },
    ],
  },
  {
    id: 'prompts',
    name: 'System Prompts',
    icon: <FileText className="h-5 w-5" />,
    description: 'Configure the AI\'s personality, behavior, and instructions',
    items: [
      {
        id: 'system-prompt',
        name: 'Custom System Prompt',
        description: 'The main instructions that define how your AI behaves on calls',
        importance: 'critical',
        settingKey: 'customSystemPrompt',
        tips: [
          'REQUIRED for calls to work',
          'Use {ASSISTANT_NAME} and {USER_NAME} placeholders',
          'Be specific about tone, goals, and constraints',
          'Include instructions for IVR navigation if needed',
        ],
        checkValue: (value) => {
          if (!value || value.length < 50) return 'error';
          if (value.length < 200) return 'warning';
          return 'complete';
        },
      },
      {
        id: 'rolling-summary',
        name: 'Rolling Summary Prompt',
        description: 'Template for condensing conversation history',
        importance: 'recommended',
        settingKey: 'rollingSummaryPrompt',
        tips: [
          'Helps maintain context in long calls',
          'Use {EXISTING_SUMMARY}, {TURNS_TEXT}, {MAX_TOKENS} placeholders',
          'Optional - system has a default',
        ],
        checkValue: (value) => {
          if (!value) return 'info';
          return 'complete';
        },
      },
    ],
  },
  {
    id: 'hold-handling',
    name: 'Hold & Wait Handling',
    icon: <Clock className="h-5 w-5" />,
    description: 'Configure behavior when placed on hold or waiting',
    items: [
      {
        id: 'hold-check-in-interval',
        name: 'Hold Check-In Interval',
        description: 'How often to check in while on hold',
        importance: 'recommended',
        settingKey: 'callControlSettings.holdCheckInIntervalMs',
        tips: [
          '20-40 seconds is typical',
          'Too frequent = annoying, too rare = might miss when hold ends',
          'Adjust based on typical hold times you encounter',
        ],
        checkValue: (value) => {
          if (!value) return 'info';
          if (value >= 20000 && value <= 40000) return 'complete';
          return 'info';
        },
      },
      {
        id: 'max-hold-check-ins',
        name: 'Maximum Hold Check-Ins',
        description: 'How many times to check in before ending call',
        importance: 'recommended',
        settingKey: 'callControlSettings.holdMaxCheckIns',
        tips: [
          '3-5 check-ins is usually reasonable',
          'This determines max hold time (interval x check-ins)',
          'Increase for businesses known to have long holds',
        ],
        checkValue: (value) => {
          if (!value) return 'info';
          if (value >= 3 && value <= 7) return 'complete';
          return 'info';
        },
      },
    ],
  },
];

// Helper to get nested value from object
const getNestedValue = (obj: any, path: string): any => {
  if (!obj || !path) return undefined;
  return path.split('.').reduce((current, key) => current?.[key], obj);
};

// Get status icon
const StatusIcon = ({ status }: { status: 'complete' | 'warning' | 'error' | 'info' }) => {
  switch (status) {
    case 'complete':
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    case 'warning':
      return <AlertTriangle className="h-5 w-5 text-yellow-500" />;
    case 'error':
      return <XCircle className="h-5 w-5 text-red-500" />;
    case 'info':
      return <Info className="h-5 w-5 text-blue-500" />;
  }
};

// Importance badge
const ImportanceBadge = ({ importance }: { importance: ChecklistItem['importance'] }) => {
  const variants: Record<string, string> = {
    critical: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
    important: 'bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400',
    recommended: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
    optional: 'bg-gray-100 text-gray-800 dark:bg-gray-800/30 dark:text-gray-400',
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${variants[importance]}`}>
      {importance}
    </span>
  );
};

export function AIOutboundChecklist({
  groqSettings,
  customAssistantName = 'Ferguson',
  firstName = 'Aaron',
  onNavigateToSettings,
}: AIOutboundChecklistProps) {
  // Section visibility state
  const [hiddenSections, setHiddenSections] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());

  // AI Chat state
  const [showChat, setShowChat] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatExpanded, setChatExpanded] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // Calculate checklist stats
  const categories = getChecklistCategories();
  const allItems = categories.flatMap(cat => cat.items);

  const getItemStatus = (item: ChecklistItem): 'complete' | 'warning' | 'error' | 'info' => {
    if (item.checkValue) {
      const value = item.settingKey ? getNestedValue(groqSettings, item.settingKey) : undefined;
      return item.checkValue(value, groqSettings);
    }
    return 'info';
  };

  const stats = {
    complete: allItems.filter(item => getItemStatus(item) === 'complete').length,
    warning: allItems.filter(item => getItemStatus(item) === 'warning').length,
    error: allItems.filter(item => getItemStatus(item) === 'error').length,
    total: allItems.length,
  };

  // Scroll chat to bottom when new messages arrive
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  // Toggle section visibility
  const toggleSectionVisibility = (sectionId: string) => {
    setHiddenSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  };

  // Toggle section collapse
  const toggleSectionCollapse = (sectionId: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  };

  // Send message to AI assistant
  const sendChatMessage = async () => {
    if (!chatInput.trim() || chatLoading) return;

    const userMessage: ChatMessage = {
      role: 'user',
      content: chatInput.trim(),
      timestamp: new Date(),
    };

    setChatMessages(prev => [...prev, userMessage]);
    setChatInput('');
    setChatLoading(true);

    try {
      const response = await fetch('/api/openai-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            ...chatMessages.map(m => ({ role: m.role, content: m.content })),
            { role: 'user', content: userMessage.content },
          ],
          context: {
            currentSettings: groqSettings,
            assistantName: customAssistantName,
            userName: firstName,
            checklistStats: stats,
          },
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to get response');
      }

      const data = await response.json();

      const assistantMessage: ChatMessage = {
        role: 'assistant',
        content: data.message,
        timestamp: new Date(),
      };

      setChatMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Chat error:', error);
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Sorry, I encountered an error. Please make sure the OpenAI API is configured correctly.',
        timestamp: new Date(),
      }]);
    } finally {
      setChatLoading(false);
    }
  };

  // Quick prompts for AI assistant
  const quickPrompts = [
    "What settings should I change for better call quality?",
    "Explain human vs IVR detection",
    "Why are my calls getting cut off?",
    "How do I configure DTMF settings?",
  ];

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div className="flex items-center gap-3">
          <Target className="h-6 w-6" />
          <div>
            <h2 className="text-2xl font-bold">AI Outbound Call Checklist</h2>
            <p className="text-sm text-muted-foreground">
              Configure all settings for professional AI phone calls
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* Stats badges */}
          <Badge variant="outline" className="gap-1">
            <CheckCircle2 className="h-3 w-3 text-green-500" />
            {stats.complete}/{stats.total} Complete
          </Badge>
          {stats.warning > 0 && (
            <Badge variant="outline" className="gap-1 border-yellow-300">
              <AlertTriangle className="h-3 w-3 text-yellow-500" />
              {stats.warning} Warnings
            </Badge>
          )}
          {stats.error > 0 && (
            <Badge variant="outline" className="gap-1 border-red-300">
              <XCircle className="h-3 w-3 text-red-500" />
              {stats.error} Errors
            </Badge>
          )}
          {onNavigateToSettings && (
            <Button variant="outline" size="sm" onClick={onNavigateToSettings}>
              <Settings2 className="h-4 w-4 mr-2" />
              Go to Settings
            </Button>
          )}
          <Button
            variant={showChat ? 'default' : 'outline'}
            size="sm"
            onClick={() => setShowChat(!showChat)}
          >
            <Sparkles className="h-4 w-4 mr-2" />
            AI Assistant
          </Button>
        </div>
      </div>

      {/* Overall Progress */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center gap-4">
            <div className="flex-1">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Configuration Progress</span>
                <span className="text-sm text-muted-foreground">
                  {Math.round((stats.complete / stats.total) * 100)}%
                </span>
              </div>
              <div className="h-3 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-green-500 to-green-400 transition-all duration-500"
                  style={{ width: `${(stats.complete / stats.total) * 100}%` }}
                />
              </div>
            </div>
            <div className="flex gap-6 text-sm">
              <div className="text-center">
                <div className="text-2xl font-bold text-green-500">{stats.complete}</div>
                <div className="text-muted-foreground">Complete</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-yellow-500">{stats.warning}</div>
                <div className="text-muted-foreground">Warnings</div>
              </div>
              <div className="text-center">
                <div className="text-2xl font-bold text-red-500">{stats.error}</div>
                <div className="text-muted-foreground">Errors</div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main Content Grid */}
      <div className={`grid gap-6 ${showChat && !chatExpanded ? 'lg:grid-cols-3' : ''}`}>
        {/* Checklist Categories */}
        <div className={`space-y-4 ${showChat && !chatExpanded ? 'lg:col-span-2' : ''}`}>
          {/* Section Toggle Bar */}
          <div className="flex items-center gap-2 flex-wrap bg-muted/30 rounded-lg p-3">
            <span className="text-sm text-muted-foreground mr-2">Show sections:</span>
            {categories.map(category => (
              <Button
                key={category.id}
                variant={hiddenSections.has(category.id) ? 'ghost' : 'secondary'}
                size="sm"
                onClick={() => toggleSectionVisibility(category.id)}
                className="h-7 text-xs"
              >
                {hiddenSections.has(category.id) ? (
                  <EyeOff className="h-3 w-3 mr-1" />
                ) : (
                  <Eye className="h-3 w-3 mr-1" />
                )}
                {category.name}
              </Button>
            ))}
          </div>

          {/* Category Cards */}
          {categories.filter(cat => !hiddenSections.has(cat.id)).map(category => {
            const categoryStats = {
              complete: category.items.filter(item => getItemStatus(item) === 'complete').length,
              total: category.items.length,
            };
            const isCollapsed = collapsedSections.has(category.id);

            return (
              <Card key={category.id} className="overflow-hidden">
                <CardHeader
                  className="cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => toggleSectionCollapse(category.id)}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div className="p-2 bg-primary/10 rounded-lg">
                        {category.icon}
                      </div>
                      <div>
                        <CardTitle className="text-lg flex items-center gap-2">
                          {category.name}
                          <Badge variant="outline" className="ml-2">
                            {categoryStats.complete}/{categoryStats.total}
                          </Badge>
                        </CardTitle>
                        <CardDescription>{category.description}</CardDescription>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleSectionVisibility(category.id);
                        }}
                      >
                        <EyeOff className="h-4 w-4" />
                      </Button>
                      {isCollapsed ? (
                        <ChevronDown className="h-5 w-5 text-muted-foreground" />
                      ) : (
                        <ChevronUp className="h-5 w-5 text-muted-foreground" />
                      )}
                    </div>
                  </div>
                </CardHeader>

                {!isCollapsed && (
                  <CardContent className="space-y-4">
                    {category.items.map(item => {
                      const status = getItemStatus(item);
                      const currentValue = item.settingKey
                        ? getNestedValue(groqSettings, item.settingKey)
                        : undefined;

                      return (
                        <div
                          key={item.id}
                          className="border rounded-lg p-4 hover:border-primary/50 transition-colors"
                        >
                          <div className="flex items-start gap-3">
                            <StatusIcon status={status} />
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2 flex-wrap mb-1">
                                <h4 className="font-medium">{item.name}</h4>
                                <ImportanceBadge importance={item.importance} />
                              </div>
                              <p className="text-sm text-muted-foreground mb-3">
                                {item.description}
                              </p>

                              {/* Current Value */}
                              {currentValue !== undefined && (
                                <div className="bg-muted/50 rounded p-2 mb-3">
                                  <span className="text-xs text-muted-foreground">Current: </span>
                                  <span className="text-sm font-mono">{String(currentValue)}</span>
                                </div>
                              )}

                              {/* Human vs IVR Values */}
                              {(item.humanValue || item.ivrValue) && (
                                <div className="grid grid-cols-2 gap-2 mb-3">
                                  {item.humanValue && (
                                    <div className="bg-blue-50 dark:bg-blue-900/20 rounded p-2">
                                      <div className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 mb-1">
                                        <User className="h-3 w-3" />
                                        Human Calls
                                      </div>
                                      <p className="text-xs">{item.humanValue}</p>
                                    </div>
                                  )}
                                  {item.ivrValue && (
                                    <div className="bg-purple-50 dark:bg-purple-900/20 rounded p-2">
                                      <div className="flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400 mb-1">
                                        <Radio className="h-3 w-3" />
                                        IVR Calls
                                      </div>
                                      <p className="text-xs">{item.ivrValue}</p>
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Tips */}
                              {item.tips && item.tips.length > 0 && (
                                <div className="bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800 rounded p-2">
                                  <div className="flex items-center gap-1 text-xs text-yellow-700 dark:text-yellow-400 mb-1">
                                    <HelpCircle className="h-3 w-3" />
                                    Tips
                                  </div>
                                  <ul className="text-xs space-y-1">
                                    {item.tips.map((tip, i) => (
                                      <li key={i} className="flex items-start gap-1">
                                        <span className="text-yellow-500">•</span>
                                        {tip}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>

        {/* AI Chat Panel */}
        {showChat && (
          <div className={chatExpanded ? 'fixed inset-4 z-50' : 'lg:col-span-1'}>
            <Card className={`flex flex-col ${chatExpanded ? 'h-full' : 'h-[600px] sticky top-4'}`}>
              <CardHeader className="pb-3 border-b">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="p-2 bg-gradient-to-br from-purple-500 to-pink-500 rounded-lg">
                      <Sparkles className="h-4 w-4 text-white" />
                    </div>
                    <div>
                      <CardTitle className="text-base">AI Configuration Assistant</CardTitle>
                      <CardDescription className="text-xs">
                        Ask me anything about call settings
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setChatExpanded(!chatExpanded)}
                    >
                      {chatExpanded ? (
                        <Minimize2 className="h-4 w-4" />
                      ) : (
                        <Maximize2 className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowChat(false)}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>

              <CardContent className="flex-1 overflow-hidden p-0 flex flex-col">
                {/* Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-4">
                  {chatMessages.length === 0 ? (
                    <div className="text-center py-8">
                      <Bot className="h-12 w-12 mx-auto mb-4 text-muted-foreground/50" />
                      <p className="text-sm text-muted-foreground mb-4">
                        I can help you understand and configure your AI call settings.
                        Ask me anything!
                      </p>
                      <div className="space-y-2">
                        {quickPrompts.map((prompt, i) => (
                          <Button
                            key={i}
                            variant="outline"
                            size="sm"
                            className="text-xs w-full justify-start"
                            onClick={() => {
                              setChatInput(prompt);
                            }}
                          >
                            <MessageSquare className="h-3 w-3 mr-2" />
                            {prompt}
                          </Button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    chatMessages.map((msg, i) => (
                      <div
                        key={i}
                        className={`flex gap-3 ${
                          msg.role === 'user' ? 'flex-row-reverse' : ''
                        }`}
                      >
                        <div
                          className={`p-2 rounded-full ${
                            msg.role === 'user'
                              ? 'bg-primary'
                              : 'bg-gradient-to-br from-purple-500 to-pink-500'
                          }`}
                        >
                          {msg.role === 'user' ? (
                            <User className="h-4 w-4 text-primary-foreground" />
                          ) : (
                            <Sparkles className="h-4 w-4 text-white" />
                          )}
                        </div>
                        <div
                          className={`flex-1 rounded-lg p-3 ${
                            msg.role === 'user'
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted'
                          }`}
                        >
                          <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                          <p className="text-xs opacity-50 mt-1">
                            {msg.timestamp.toLocaleTimeString()}
                          </p>
                        </div>
                      </div>
                    ))
                  )}
                  {chatLoading && (
                    <div className="flex gap-3">
                      <div className="p-2 rounded-full bg-gradient-to-br from-purple-500 to-pink-500">
                        <Sparkles className="h-4 w-4 text-white" />
                      </div>
                      <div className="bg-muted rounded-lg p-3">
                        <Loader2 className="h-4 w-4 animate-spin" />
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Input */}
                <div className="border-t p-4">
                  <div className="flex gap-2">
                    <Input
                      placeholder="Ask about call settings..."
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          sendChatMessage();
                        }
                      }}
                      disabled={chatLoading}
                    />
                    <Button
                      size="sm"
                      onClick={sendChatMessage}
                      disabled={!chatInput.trim() || chatLoading}
                    >
                      <Send className="h-4 w-4" />
                    </Button>
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
