'use client';

/**
 * AI Outbound Call Checklist Component
 * A comprehensive checklist for configuring professional AI outbound calls.
 *
 * Features:
 * - Categorized settings with status indicators
 * - Collapsible/hideable sections
 * - Code references showing where each feature is implemented
 * - Real-time validation of settings
 */

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Phone,
  Radio,
  Clock,
  Volume2,
  Brain,
  Settings2,
  FileText,
  Target,
  Info,
  HelpCircle,
  Code,
  FolderOpen,
  ExternalLink,
  Copy,
  Check,
  User,
} from 'lucide-react';

// Code reference type
interface CodeReference {
  file: string;
  lines?: string;
  description: string;
  snippet?: string;
}

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
  codeRefs?: CodeReference[];
}

interface ChecklistCategory {
  id: string;
  name: string;
  icon: React.ReactNode;
  description: string;
  items: ChecklistItem[];
  mainCodeRefs: CodeReference[];
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

// Define all checklist categories with code references
const getChecklistCategories = (): ChecklistCategory[] => [
  {
    id: 'detection',
    name: 'Human vs IVR Detection',
    icon: <Radio className="h-5 w-5" />,
    description: 'Configure how the AI identifies whether it\'s talking to a human or an automated system (IVR/phone tree)',
    mainCodeRefs: [
      {
        file: 'ai-server/src/pipeline/ivr.ts',
        description: 'IVR pattern detection and analysis module',
        snippet: `// IVR detection patterns - 30+ patterns for menu prompts
const IVR_PATTERNS = [
  /press\\s*(?:one|1|two|2|three|3)/i,
  /for\\s+(?:sales|support|billing)/i,
  /main\\s+menu/i,
  /your\\s+(?:call|wait)\\s+(?:is|time)/i,
  // ... more patterns
];

export function analyzeForIvr(text: string): IvrAnalysis {
  // Returns confidence score 0-1, menu options, etc.
}`,
      },
      {
        file: 'ai-server/src/index.ts',
        lines: '~450-520',
        description: 'LLM-based human vs IVR detection at call start',
        snippet: `// Detect party type (human vs robotic) using LLM
const detectionPrompt = \`Analyze this greeting: "\${initialGreeting}"
Is this a human or an automated system (IVR/voicemail)?
Reply with just: HUMAN or ROBOTIC\`;

const partyType = await detectPartyType(detectionPrompt);
ctx.detectedPartyType = partyType; // "human" or "robotic"`,
      },
    ],
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
        ],
        checkValue: (value) => {
          if (value === undefined) return 'warning';
          if (value >= 0.6 && value <= 0.8) return 'complete';
          return 'info';
        },
        codeRefs: [
          {
            file: 'ai-server/src/pipeline/ivr.ts',
            lines: '45-80',
            description: 'Threshold comparison in IVR analysis',
            snippet: `if (analysis.confidence >= ctx.ivrAutoDetectThreshold) {
  ctx.isIvrMode = true;
  ctx.ivrConfidence = analysis.confidence;
}`,
          },
        ],
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
        ],
        checkValue: (_, allSettings) => {
          const ttsDebounce = allSettings?.callControlSettings?.ttsDebounceMs;
          const ivrDebounce = allSettings?.ivrSettings?.debounceMs;
          if (!ttsDebounce || !ivrDebounce) return 'warning';
          if (ttsDebounce > ivrDebounce * 2) return 'complete';
          return 'warning';
        },
        codeRefs: [
          {
            file: 'ai-server/src/index.ts',
            lines: '~380-420',
            description: 'Dynamic debounce switching based on party type',
            snippet: `// Use IVR debounce when in IVR mode
const debounceMs = ctx.isIvrMode
  ? (ctx.ivrDebounceMs || 150)
  : (ctx.ttsDebounceMs || 500);

// Schedule TTS after silence
debounceTimer = setTimeout(() => {
  generateAndSpeakResponse();
}, debounceMs);`,
          },
        ],
      },
      {
        id: 'barge-in-grace-period',
        name: 'Barge-In Grace Period',
        description: 'Whether to use grace period before allowing interrupts. Disable for IVR (no echo issues).',
        importance: 'recommended',
        humanValue: 'Enabled - prevents echo-triggered interrupts',
        ivrValue: 'Disabled - IVRs don\'t have echo issues',
        codeRefs: [
          {
            file: 'ai-server/src/index.ts',
            lines: '~300-340',
            description: 'Grace period logic for barge-in handling',
            snippet: `// Skip grace period in IVR mode
if (ctx.isIvrMode && ctx.ivrDisableBargeInGracePeriod) {
  // IVRs don't have echo, allow immediate barge-in
  handleBargeIn();
} else if (Date.now() - lastTtsStart > gracePeriodMs) {
  handleBargeIn();
}`,
          },
        ],
      },
    ],
  },
  {
    id: 'voice-timing',
    name: 'Voice & Timing Settings',
    icon: <Volume2 className="h-5 w-5" />,
    description: 'Control the pace and timing of speech interactions',
    mainCodeRefs: [
      {
        file: 'ai-server/src/index.ts',
        lines: '~200-400',
        description: 'Main call flow timing and debounce handling',
      },
      {
        file: 'ai-server/src/pipeline/tts.ts',
        description: 'Text-to-speech generation and audio handling',
      },
      {
        file: 'ai-server/src/callContextManager.ts',
        description: 'Per-call state including timing settings',
        snippet: `interface CallContext {
  ttsDebounceMs?: number;        // Silence before AI responds
  bargeInCooldownMs?: number;    // Time between stop commands
  callerUtteranceFlushMs?: number; // Wait before logging
  // ... more settings
}`,
      },
    ],
    items: [
      {
        id: 'tts-debounce',
        name: 'TTS Debounce (Silence Before Response)',
        description: 'How long to wait after silence before the AI starts speaking',
        importance: 'critical',
        settingKey: 'callControlSettings.ttsDebounceMs',
        humanValue: '400-600ms - natural conversation rhythm',
        ivrValue: '100-200ms - quick response to prompts',
        checkValue: (value) => {
          if (!value) return 'error';
          if (value >= 400 && value <= 600) return 'complete';
          return 'info';
        },
        codeRefs: [
          {
            file: 'ai-server/src/index.ts',
            lines: '~380-400',
            description: 'Debounce timer implementation',
            snippet: `// Reset debounce timer on new speech
clearTimeout(debounceTimer);
debounceTimer = setTimeout(async () => {
  const response = await generateLlmResponse(ctx);
  await speakResponse(response, ctx);
}, ctx.ttsDebounceMs || 500);`,
          },
        ],
      },
      {
        id: 'barge-in-cooldown',
        name: 'Barge-In Cooldown',
        description: 'Minimum time between stop commands when caller interrupts',
        importance: 'important',
        settingKey: 'callControlSettings.bargeInCooldownMs',
        checkValue: (value) => {
          if (!value) return 'warning';
          if (value >= 200 && value <= 400) return 'complete';
          return 'info';
        },
        codeRefs: [
          {
            file: 'ai-server/src/index.ts',
            lines: '~310-330',
            description: 'Barge-in cooldown enforcement',
            snippet: `if (Date.now() - lastBargeIn < ctx.bargeInCooldownMs) {
  return; // Too soon, ignore this barge-in
}
lastBargeIn = Date.now();
await stopCurrentTts();`,
          },
        ],
      },
      {
        id: 'utterance-flush',
        name: 'Caller Utterance Flush',
        description: 'Time to wait before logging what the caller said',
        importance: 'important',
        settingKey: 'callControlSettings.callerUtteranceFlushMs',
        codeRefs: [
          {
            file: 'ai-server/src/index.ts',
            lines: '~420-450',
            description: 'Utterance accumulation and flushing',
            snippet: `// Accumulate speech, flush after silence
utteranceBuffer += transcript;
clearTimeout(flushTimer);
flushTimer = setTimeout(() => {
  ctx.conversationHistory.push({
    role: 'user',
    content: utteranceBuffer
  });
  utteranceBuffer = '';
}, ctx.callerUtteranceFlushMs || 300);`,
          },
        ],
      },
    ],
  },
  {
    id: 'ivr-navigation',
    name: 'IVR/Phone Tree Navigation',
    icon: <Phone className="h-5 w-5" />,
    description: 'Settings for navigating automated phone systems using DTMF tones',
    mainCodeRefs: [
      {
        file: 'ai-server/src/pipeline/ivr.ts',
        description: 'Complete IVR analysis and DTMF handling',
        snippet: `// Extract menu options from IVR prompt
export function extractMenuOptions(text: string): string[] {
  const options: string[] = [];
  // "Press 1 for sales" -> ["1: sales"]
  // "Say 'representative'" -> ["representative"]
  return options;
}

// Send DTMF tone via Telnyx
export async function sendDtmf(
  callControlId: string,
  digit: string,
  durationMs: number
) {
  await telnyx.calls.sendDTMF(callControlId, {
    digit,
    duration_millis: durationMs
  });
}`,
      },
    ],
    items: [
      {
        id: 'dtmf-duration',
        name: 'DTMF Tone Duration',
        description: 'How long each button press tone lasts',
        importance: 'important',
        settingKey: 'ivrSettings.dtmfDurationMs',
        checkValue: (value) => {
          if (!value) return 'warning';
          if (value >= 200 && value <= 300) return 'complete';
          return 'info';
        },
        codeRefs: [
          {
            file: 'ai-server/src/pipeline/ivr.ts',
            lines: '~120-140',
            description: 'DTMF sending with configurable duration',
            snippet: `await telnyx.calls.sendDTMF(callControlId, {
  digit: dtmfDigit,
  duration_millis: ctx.ivrDtmfDurationMs || 250
});`,
          },
        ],
      },
      {
        id: 'dtmf-pause',
        name: 'DTMF Minimum Pause',
        description: 'Minimum time between sending DTMF tones',
        importance: 'important',
        settingKey: 'ivrSettings.dtmfMinPauseMs',
        codeRefs: [
          {
            file: 'ai-server/src/pipeline/ivr.ts',
            lines: '~140-160',
            description: 'Pause between DTMF tones',
            snippet: `// Wait between digits to ensure recognition
await sleep(ctx.ivrDtmfMinPauseMs || 500);`,
          },
        ],
      },
      {
        id: 'response-timeout',
        name: 'IVR Response Timeout',
        description: 'How long to wait for IVR to respond before retrying',
        importance: 'recommended',
        settingKey: 'ivrSettings.responseTimeoutMs',
        codeRefs: [
          {
            file: 'ai-server/src/pipeline/ivr.ts',
            lines: '~160-180',
            description: 'Timeout handling for IVR responses',
          },
        ],
      },
    ],
  },
  {
    id: 'llm-config',
    name: 'LLM Configuration',
    icon: <Brain className="h-5 w-5" />,
    description: 'Configure the AI model behavior and response generation',
    mainCodeRefs: [
      {
        file: 'ai-server/src/pipeline/llm.ts',
        description: 'LLM interaction and response generation',
        snippet: `export async function generateResponse(
  systemPrompt: string,
  messages: Message[],
  options: LlmOptions
): Promise<string> {
  const response = await groq.chat.completions.create({
    model: options.model || 'llama-3.1-8b-instant',
    temperature: options.temperature || 0.7,
    max_tokens: options.maxTokens || 1024,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages
    ]
  });
  return response.choices[0].message.content;
}`,
      },
      {
        file: 'src/components/dashboard/groq-call.tsx',
        lines: '206-950',
        description: 'Frontend LLM settings UI',
      },
    ],
    items: [
      {
        id: 'model-selection',
        name: 'Model Selection',
        description: 'Choose the AI model for generating responses',
        importance: 'critical',
        settingKey: 'model',
        checkValue: (value) => {
          if (!value) return 'error';
          return 'complete';
        },
        codeRefs: [
          {
            file: 'ai-server/src/pipeline/llm.ts',
            lines: '~20-40',
            description: 'Model selection in Groq API call',
          },
        ],
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
          'Phone calls typically need shorter responses',
        ],
        checkValue: (value) => {
          if (!value) return 'warning';
          if (value >= 512 && value <= 1500) return 'complete';
          return 'info';
        },
      },
    ],
  },
  {
    id: 'prompts',
    name: 'System Prompts',
    icon: <FileText className="h-5 w-5" />,
    description: 'Configure the AI\'s personality, behavior, and instructions',
    mainCodeRefs: [
      {
        file: 'ai-server/src/pipeline/llm.ts',
        lines: '~60-120',
        description: 'System prompt building and variable substitution',
        snippet: `// Build system prompt with variable substitution
let prompt = customSystemPrompt;
prompt = prompt.replace(/\\{ASSISTANT_NAME\\}/g, assistantName);
prompt = prompt.replace(/\\{USER_NAME\\}/g, userName);

// Append goal at bottom
if (goal) {
  prompt += \`\\n\\nCALL GOAL (YOUR ONLY MISSION): "\${goal}"\`;
}`,
      },
      {
        file: 'ai-server/src/pipeline/llm.ts',
        lines: '~150-200',
        description: 'Rolling summary generation for long calls',
        snippet: `// Generate rolling summary when turns exceed threshold
if (turns.length > maxTurnsInWindow) {
  const summaryPrompt = rollingSummaryPrompt
    .replace('{EXISTING_SUMMARY}', existingSummary)
    .replace('{TURNS_TEXT}', turnsToSummarize)
    .replace('{MAX_TOKENS}', maxSummaryTokens);

  ctx.rollingSummary = await generateSummary(summaryPrompt);
}`,
      },
    ],
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
    mainCodeRefs: [
      {
        file: 'ai-server/src/index.ts',
        lines: '~550-620',
        description: 'Hold detection and check-in logic',
        snippet: `// Detect hold message patterns
if (ivrAnalysis.isHoldMessage) {
  ctx.onHold = true;
  ctx.holdStartTime = Date.now();
  ctx.holdCheckIns = 0;

  // Schedule periodic check-ins
  holdCheckInTimer = setInterval(async () => {
    ctx.holdCheckIns++;
    if (ctx.holdCheckIns >= ctx.holdMaxCheckIns) {
      await endCall('Max hold time exceeded');
      return;
    }
    await speak('I\\'m still here waiting...');
  }, ctx.holdCheckInIntervalMs);
}`,
      },
    ],
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

// Code reference component
function CodeReferenceBlock({ ref, onCopy }: { ref: CodeReference; onCopy: (text: string) => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    const text = ref.snippet || `// ${ref.file}${ref.lines ? `:${ref.lines}` : ''}\n// ${ref.description}`;
    onCopy(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-slate-900 rounded-lg overflow-hidden text-sm">
      <div className="flex items-center justify-between px-3 py-2 bg-slate-800 border-b border-slate-700">
        <div className="flex items-center gap-2 text-slate-300">
          <FolderOpen className="h-3.5 w-3.5" />
          <span className="font-mono text-xs">{ref.file}</span>
          {ref.lines && (
            <span className="text-slate-500 text-xs">:{ref.lines}</span>
          )}
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-slate-400 hover:text-white"
          onClick={handleCopy}
        >
          {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
        </Button>
      </div>
      <div className="p-3">
        <p className="text-slate-400 text-xs mb-2">{ref.description}</p>
        {ref.snippet && (
          <pre className="text-green-400 text-xs overflow-x-auto whitespace-pre-wrap font-mono">
            {ref.snippet}
          </pre>
        )}
      </div>
    </div>
  );
}

export function AIOutboundChecklist({
  groqSettings,
  onNavigateToSettings,
}: AIOutboundChecklistProps) {
  // Section visibility state
  const [hiddenSections, setHiddenSections] = useState<Set<string>>(new Set());
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const [expandedCodeRefs, setExpandedCodeRefs] = useState<Set<string>>(new Set());

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

  // Toggle code refs expansion
  const toggleCodeRefs = (itemId: string) => {
    setExpandedCodeRefs(prev => {
      const next = new Set(prev);
      if (next.has(itemId)) {
        next.delete(itemId);
      } else {
        next.add(itemId);
      }
      return next;
    });
  };

  // Copy handler
  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

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
      <div className="space-y-4">
        {categories.filter(cat => !hiddenSections.has(cat.id)).map(category => {
          const categoryStats = {
            complete: category.items.filter(item => getItemStatus(item) === 'complete').length,
            total: category.items.length,
          };
          const isCollapsed = collapsedSections.has(category.id);
          const showMainCodeRefs = expandedCodeRefs.has(`main-${category.id}`);

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
                  {/* Main Code References for Category */}
                  {category.mainCodeRefs.length > 0 && (
                    <div className="border rounded-lg p-3 bg-slate-50 dark:bg-slate-900/50">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full justify-between mb-2"
                        onClick={() => toggleCodeRefs(`main-${category.id}`)}
                      >
                        <span className="flex items-center gap-2 text-sm font-medium">
                          <Code className="h-4 w-4" />
                          Main Implementation Files
                        </span>
                        {showMainCodeRefs ? (
                          <ChevronUp className="h-4 w-4" />
                        ) : (
                          <ChevronDown className="h-4 w-4" />
                        )}
                      </Button>
                      {showMainCodeRefs && (
                        <div className="space-y-3 mt-3">
                          {category.mainCodeRefs.map((ref, i) => (
                            <CodeReferenceBlock key={i} ref={ref} onCopy={handleCopy} />
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Individual Items */}
                  {category.items.map(item => {
                    const status = getItemStatus(item);
                    const currentValue = item.settingKey
                      ? getNestedValue(groqSettings, item.settingKey)
                      : undefined;
                    const showItemCodeRefs = expandedCodeRefs.has(item.id);

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
                              <div className="bg-yellow-50 dark:bg-yellow-900/10 border border-yellow-200 dark:border-yellow-800 rounded p-2 mb-3">
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

                            {/* Code References */}
                            {item.codeRefs && item.codeRefs.length > 0 && (
                              <div>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-xs mb-2"
                                  onClick={() => toggleCodeRefs(item.id)}
                                >
                                  <Code className="h-3 w-3 mr-1" />
                                  {showItemCodeRefs ? 'Hide' : 'Show'} Code ({item.codeRefs.length})
                                </Button>
                                {showItemCodeRefs && (
                                  <div className="space-y-2 mt-2">
                                    {item.codeRefs.map((ref, i) => (
                                      <CodeReferenceBlock key={i} ref={ref} onCopy={handleCopy} />
                                    ))}
                                  </div>
                                )}
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
    </div>
  );
}
