'use client';

/**
 * Prompt Control Component
 * Full control over all LLM prompting parameters for testing
 */

import { useState, useCallback, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Settings2,
  RotateCcw,
  Copy,
  Check,
  ChevronDown,
  ChevronUp,
  Sparkles,
  Zap,
  MessageSquare,
  AlertTriangle
} from 'lucide-react';

// Default system prompt matching config.ts
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
- After confirmation: end with "Thank you. Chow."
- Do NOT deviate from this goal

Remember: You are an AI phone agent. Strict scope control is mandatory.`;

// Available models
const AVAILABLE_MODELS = [
  { value: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B (Fast)', description: 'Fast, good for simple tasks' },
  { value: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B (Smart)', description: 'More capable, better instruction following' },
  { value: 'llama-3.1-70b-versatile', label: 'Llama 3.1 70B', description: 'Balanced performance' },
  { value: 'mixtral-8x7b-32768', label: 'Mixtral 8x7B', description: 'Good for longer contexts' },
  { value: 'gemma2-9b-it', label: 'Gemma 2 9B', description: 'Google model, instruction-tuned' },
];

export interface PromptSettings {
  // Core prompt
  systemPrompt: string;
  goalTemplate: string;

  // Variables
  assistantName: string;
  userName: string;

  // LLM parameters
  model: string;
  temperature: number;
  maxTokens: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;

  // Stop sequences
  stopSequences: string[];

  // Feature flags
  includeRollingSummary: boolean;
  maxContextTurns: number;
}

const DEFAULT_SETTINGS: PromptSettings = {
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  goalTemplate: DEFAULT_GOAL_TEMPLATE,
  assistantName: 'Ferguson',
  userName: 'Aaron',
  model: 'llama-3.1-8b-instant',
  temperature: 0.4,
  maxTokens: 150,
  topP: 0.9,
  frequencyPenalty: 0.0,
  presencePenalty: 0.0,
  stopSequences: [],
  includeRollingSummary: true,
  maxContextTurns: 12,
};

interface PromptControlProps {
  onSettingsChange?: (settings: PromptSettings) => void;
  initialSettings?: Partial<PromptSettings>;
  compact?: boolean;
}

export function PromptControl({
  onSettingsChange,
  initialSettings,
  compact = false
}: PromptControlProps) {
  const [settings, setSettings] = useState<PromptSettings>(() => ({
    ...DEFAULT_SETTINGS,
    ...initialSettings,
  }));

  const [expandedSections, setExpandedSections] = useState({
    systemPrompt: !compact,
    goalTemplate: false,
    parameters: true,
    advanced: false,
  });

  const [copied, setCopied] = useState(false);
  const [stopSequenceInput, setStopSequenceInput] = useState('');

  // Notify parent of changes
  useEffect(() => {
    onSettingsChange?.(settings);
  }, [settings, onSettingsChange]);

  const updateSetting = useCallback(<K extends keyof PromptSettings>(
    key: K,
    value: PromptSettings[K]
  ) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const resetToDefaults = useCallback(() => {
    setSettings({ ...DEFAULT_SETTINGS, ...initialSettings });
  }, [initialSettings]);

  const copySettings = useCallback(async () => {
    await navigator.clipboard.writeText(JSON.stringify(settings, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [settings]);

  const addStopSequence = useCallback(() => {
    if (stopSequenceInput.trim() && !settings.stopSequences.includes(stopSequenceInput.trim())) {
      updateSetting('stopSequences', [...settings.stopSequences, stopSequenceInput.trim()]);
      setStopSequenceInput('');
    }
  }, [stopSequenceInput, settings.stopSequences, updateSetting]);

  const removeStopSequence = useCallback((seq: string) => {
    updateSetting('stopSequences', settings.stopSequences.filter(s => s !== seq));
  }, [settings.stopSequences, updateSetting]);

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({ ...prev, [section]: !prev[section] }));
  };

  // Build preview of final prompt
  const buildPromptPreview = useCallback(() => {
    let prompt = settings.systemPrompt;
    prompt = prompt.replace(/Ferguson/g, settings.assistantName);
    prompt = prompt.replace(/Aaron/g, settings.userName);

    const goalSection = settings.goalTemplate.replace('{goal}', '[YOUR GOAL HERE]');
    prompt += '\n\n' + goalSection;

    return prompt;
  }, [settings]);

  return (
    <Card className="w-full">
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings2 className="h-5 w-5 text-primary" />
            <CardTitle className="text-lg">Prompt Control</CardTitle>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={copySettings}
              className="h-8 px-2"
            >
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={resetToDefaults}
              className="h-8 px-2"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <CardDescription>
          Fine-tune all LLM parameters for testing
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* Variables Section */}
        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Sparkles className="h-4 w-4" />
            Variables
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="assistantName">Assistant Name</Label>
              <Input
                id="assistantName"
                value={settings.assistantName}
                onChange={(e) => updateSetting('assistantName', e.target.value)}
                placeholder="Ferguson"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="userName">User Name</Label>
              <Input
                id="userName"
                value={settings.userName}
                onChange={(e) => updateSetting('userName', e.target.value)}
                placeholder="Aaron"
              />
            </div>
          </div>
        </div>

        {/* Model & Parameters Section */}
        <div className="space-y-4">
          <button
            onClick={() => toggleSection('parameters')}
            className="flex items-center justify-between w-full text-sm font-medium"
          >
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4" />
              Model & Parameters
            </div>
            {expandedSections.parameters ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>

          {expandedSections.parameters && (
            <div className="space-y-6 pl-6 border-l-2 border-border">
              {/* Model Selection */}
              <div className="space-y-2">
                <Label>Model</Label>
                <Select
                  value={settings.model}
                  onValueChange={(value) => updateSetting('model', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AVAILABLE_MODELS.map((model) => (
                      <SelectItem key={model.value} value={model.value}>
                        <div className="flex flex-col">
                          <span>{model.label}</span>
                          <span className="text-xs text-muted-foreground">
                            {model.description}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Temperature */}
              <div className="space-y-3">
                <div className="flex justify-between">
                  <Label>Temperature</Label>
                  <span className="text-sm text-muted-foreground font-mono">
                    {settings.temperature.toFixed(2)}
                  </span>
                </div>
                <Slider
                  value={[settings.temperature]}
                  onValueChange={([value]) => updateSetting('temperature', value)}
                  min={0}
                  max={2}
                  step={0.05}
                />
                <p className="text-xs text-muted-foreground">
                  Lower = more focused/deterministic. Higher = more creative/random.
                </p>
              </div>

              {/* Max Tokens */}
              <div className="space-y-3">
                <div className="flex justify-between">
                  <Label>Max Tokens</Label>
                  <span className="text-sm text-muted-foreground font-mono">
                    {settings.maxTokens}
                  </span>
                </div>
                <Slider
                  value={[settings.maxTokens]}
                  onValueChange={([value]) => updateSetting('maxTokens', value)}
                  min={50}
                  max={500}
                  step={10}
                />
                <p className="text-xs text-muted-foreground">
                  Maximum length of response. Phone calls need short responses (100-200).
                </p>
              </div>

              {/* Top P */}
              <div className="space-y-3">
                <div className="flex justify-between">
                  <Label>Top P (Nucleus Sampling)</Label>
                  <span className="text-sm text-muted-foreground font-mono">
                    {settings.topP.toFixed(2)}
                  </span>
                </div>
                <Slider
                  value={[settings.topP]}
                  onValueChange={([value]) => updateSetting('topP', value)}
                  min={0}
                  max={1}
                  step={0.05}
                />
                <p className="text-xs text-muted-foreground">
                  Controls diversity. 0.9 = consider top 90% probability mass.
                </p>
              </div>

              {/* Context Settings */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Max Context Turns</Label>
                  <Input
                    type="number"
                    value={settings.maxContextTurns}
                    onChange={(e) => updateSetting('maxContextTurns', parseInt(e.target.value) || 12)}
                    min={1}
                    max={50}
                  />
                </div>
                <div className="space-y-2 flex items-end">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={settings.includeRollingSummary}
                      onChange={(e) => updateSetting('includeRollingSummary', e.target.checked)}
                      className="rounded border-border"
                    />
                    <span className="text-sm">Include Rolling Summary</span>
                  </label>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* System Prompt Section */}
        <div className="space-y-4">
          <button
            onClick={() => toggleSection('systemPrompt')}
            className="flex items-center justify-between w-full text-sm font-medium"
          >
            <div className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4" />
              System Prompt
            </div>
            {expandedSections.systemPrompt ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>

          {expandedSections.systemPrompt && (
            <div className="space-y-2 pl-6 border-l-2 border-border">
              <Textarea
                value={settings.systemPrompt}
                onChange={(e) => updateSetting('systemPrompt', e.target.value)}
                className="min-h-[300px] font-mono text-xs"
                placeholder="Enter system prompt..."
              />
              <p className="text-xs text-muted-foreground">
                Use {"{{assistantName}}"} and {"{{userName}}"} for dynamic replacement.
              </p>
            </div>
          )}
        </div>

        {/* Goal Template Section */}
        <div className="space-y-4">
          <button
            onClick={() => toggleSection('goalTemplate')}
            className="flex items-center justify-between w-full text-sm font-medium"
          >
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Goal Injection Template
            </div>
            {expandedSections.goalTemplate ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>

          {expandedSections.goalTemplate && (
            <div className="space-y-2 pl-6 border-l-2 border-border">
              <Textarea
                value={settings.goalTemplate}
                onChange={(e) => updateSetting('goalTemplate', e.target.value)}
                className="min-h-[200px] font-mono text-xs"
                placeholder="Enter goal injection template..."
              />
              <p className="text-xs text-muted-foreground">
                Use {"{goal}"} where the actual goal will be inserted.
              </p>
            </div>
          )}
        </div>

        {/* Advanced Section */}
        <div className="space-y-4">
          <button
            onClick={() => toggleSection('advanced')}
            className="flex items-center justify-between w-full text-sm font-medium"
          >
            <div className="flex items-center gap-2">
              <Settings2 className="h-4 w-4" />
              Advanced Settings
            </div>
            {expandedSections.advanced ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            )}
          </button>

          {expandedSections.advanced && (
            <div className="space-y-6 pl-6 border-l-2 border-border">
              {/* Frequency Penalty */}
              <div className="space-y-3">
                <div className="flex justify-between">
                  <Label>Frequency Penalty</Label>
                  <span className="text-sm text-muted-foreground font-mono">
                    {settings.frequencyPenalty.toFixed(2)}
                  </span>
                </div>
                <Slider
                  value={[settings.frequencyPenalty]}
                  onValueChange={([value]) => updateSetting('frequencyPenalty', value)}
                  min={-2}
                  max={2}
                  step={0.1}
                />
                <p className="text-xs text-muted-foreground">
                  Penalizes repeated tokens. Positive = less repetition.
                </p>
              </div>

              {/* Presence Penalty */}
              <div className="space-y-3">
                <div className="flex justify-between">
                  <Label>Presence Penalty</Label>
                  <span className="text-sm text-muted-foreground font-mono">
                    {settings.presencePenalty.toFixed(2)}
                  </span>
                </div>
                <Slider
                  value={[settings.presencePenalty]}
                  onValueChange={([value]) => updateSetting('presencePenalty', value)}
                  min={-2}
                  max={2}
                  step={0.1}
                />
                <p className="text-xs text-muted-foreground">
                  Penalizes tokens that have appeared at all. Encourages new topics.
                </p>
              </div>

              {/* Stop Sequences */}
              <div className="space-y-3">
                <Label>Stop Sequences</Label>
                <div className="flex gap-2">
                  <Input
                    value={stopSequenceInput}
                    onChange={(e) => setStopSequenceInput(e.target.value)}
                    placeholder="e.g., [END], goodbye"
                    onKeyDown={(e) => e.key === 'Enter' && addStopSequence()}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={addStopSequence}
                  >
                    Add
                  </Button>
                </div>
                {settings.stopSequences.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {settings.stopSequences.map((seq) => (
                      <span
                        key={seq}
                        className="inline-flex items-center gap-1 px-2 py-1 bg-secondary rounded text-xs font-mono"
                      >
                        {seq}
                        <button
                          onClick={() => removeStopSequence(seq)}
                          className="hover:text-destructive"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Generation stops when any of these sequences are produced.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Prompt Preview */}
        <div className="pt-4 border-t border-border">
          <details className="group">
            <summary className="cursor-pointer text-sm font-medium flex items-center gap-2">
              <span>Preview Final Prompt</span>
              <span className="text-xs text-muted-foreground">
                ({buildPromptPreview().length} chars)
              </span>
            </summary>
            <pre className="mt-2 p-4 bg-muted rounded-lg text-xs font-mono whitespace-pre-wrap overflow-auto max-h-[300px]">
              {buildPromptPreview()}
            </pre>
          </details>
        </div>
      </CardContent>
    </Card>
  );
}

// Export settings type and defaults for use elsewhere
export { DEFAULT_SETTINGS, DEFAULT_SYSTEM_PROMPT, DEFAULT_GOAL_TEMPLATE, AVAILABLE_MODELS };
export type { PromptSettings as LLMPromptSettings };
