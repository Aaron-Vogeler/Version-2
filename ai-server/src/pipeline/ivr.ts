/**
 * IVR/Phone Tree Detection and Navigation Module
 * ===============================================
 * Provides utilities for detecting automated phone systems (IVR) and
 * extracting actionable information from their prompts.
 */

import config from "../config";
import type { CallContext } from "../callContextManager";

/**
 * Result of analyzing text for IVR patterns
 */
export interface IvrAnalysis {
  /** Confidence (0-1) that this is an IVR/automated system */
  confidence: number;
  /** Whether this appears to be a menu with options */
  isMenu: boolean;
  /** Detected menu options (e.g., ["1: sales", "2: support", "0: operator"]) */
  menuOptions: string[];
  /** Whether the IVR is asking for specific input */
  expectsInput: boolean;
  /** Type of expected input */
  expectedInputType: "dtmf" | "speech" | "either" | "unknown";
  /** Specific patterns matched */
  matchedPatterns: string[];
  /** Whether this appears to be hold music/message */
  isHoldMessage: boolean;
  /** Whether this appears to be a transfer announcement */
  isTransfer: boolean;
}

/**
 * Common IVR phrases that indicate an automated system
 */
const IVR_INDICATOR_PATTERNS: Array<{ pattern: RegExp; weight: number; name: string }> = [
  // Menu prompts
  { pattern: /press\s+(\d+|one|two|three|four|five|six|seven|eight|nine|zero|star|pound)/i, weight: 0.9, name: "press_digit" },
  { pattern: /dial\s+(\d+|one|two|three|four|five|six|seven|eight|nine|zero)/i, weight: 0.85, name: "dial_digit" },
  { pattern: /for\s+.+,?\s*press\s+(\d+|one|two)/i, weight: 0.95, name: "for_x_press" },
  { pattern: /option\s*(\d+|one|two|three|four|five)/i, weight: 0.7, name: "option_number" },
  { pattern: /say\s+(yes|no|agent|representative|operator|main menu)/i, weight: 0.8, name: "say_keyword" },

  // Standard IVR greetings
  { pattern: /thank\s*you\s*for\s*calling/i, weight: 0.6, name: "thank_you_calling" },
  { pattern: /welcome\s*to/i, weight: 0.5, name: "welcome_to" },
  { pattern: /your\s*call\s*(is|may\s*be)\s*(important|recorded|monitored)/i, weight: 0.85, name: "call_recorded" },
  { pattern: /this\s*call\s*(is|may\s*be)\s*(recorded|monitored)/i, weight: 0.85, name: "call_monitored" },
  { pattern: /for\s*quality\s*(assurance|purposes)/i, weight: 0.75, name: "quality_assurance" },

  // Hold indicators
  { pattern: /please\s*(hold|wait|stay\s*on\s*the\s*line)/i, weight: 0.8, name: "please_hold" },
  { pattern: /your\s*(estimated|approximate)?\s*wait\s*time/i, weight: 0.9, name: "wait_time" },
  { pattern: /you\s*are\s*(caller\s*)?(number|position)\s*\d+/i, weight: 0.9, name: "queue_position" },
  { pattern: /all\s*(of\s*our)?\s*(agents?|representatives?|operators?)\s*are\s*(currently\s*)?(busy|assisting|unavailable)/i, weight: 0.9, name: "agents_busy" },
  { pattern: /next\s*available\s*(agent|representative|operator)/i, weight: 0.85, name: "next_available" },

  // Transfer indicators
  { pattern: /transferring\s*(you|your\s*call)/i, weight: 0.9, name: "transferring" },
  { pattern: /connecting\s*(you|your\s*call)/i, weight: 0.85, name: "connecting" },
  { pattern: /one\s*moment\s*please/i, weight: 0.6, name: "one_moment" },

  // Menu navigation
  { pattern: /main\s*menu/i, weight: 0.8, name: "main_menu" },
  { pattern: /previous\s*menu/i, weight: 0.8, name: "previous_menu" },
  { pattern: /return\s*to\s*(the\s*)?(main|previous)\s*menu/i, weight: 0.85, name: "return_menu" },
  { pattern: /repeat\s*(these|this|the)?\s*options/i, weight: 0.85, name: "repeat_options" },
  { pattern: /listen\s*(to\s*)?again/i, weight: 0.7, name: "listen_again" },

  // Input requests
  { pattern: /enter\s*your/i, weight: 0.8, name: "enter_your" },
  { pattern: /please\s*enter/i, weight: 0.85, name: "please_enter" },
  { pattern: /(account|phone|zip|postal|member)\s*(number|code)/i, weight: 0.75, name: "enter_number" },
  { pattern: /followed\s*by\s*(the\s*)?(pound|hash|star)/i, weight: 0.9, name: "followed_by_key" },

  // Robotic speech patterns
  { pattern: /invalid\s*(entry|selection|input|option)/i, weight: 0.9, name: "invalid_entry" },
  { pattern: /i\s*didn't\s*(get|understand|hear)\s*that/i, weight: 0.8, name: "didnt_understand" },
  { pattern: /please\s*try\s*again/i, weight: 0.7, name: "try_again" },
  { pattern: /that\s*is\s*not\s*a\s*valid/i, weight: 0.85, name: "not_valid" },
];

/**
 * Patterns that indicate a human (not IVR)
 */
const HUMAN_INDICATOR_PATTERNS: Array<{ pattern: RegExp; weight: number; name: string }> = [
  // Natural conversation patterns
  { pattern: /how\s*(can|may)\s*i\s*help\s*(you|ya)/i, weight: 0.7, name: "how_can_help" },
  { pattern: /what\s*can\s*i\s*(do|help)/i, weight: 0.6, name: "what_can_do" },
  { pattern: /hi,?\s*(this\s*is|my\s*name\s*is)/i, weight: 0.8, name: "greeting_name" },
  { pattern: /speaking/i, weight: 0.5, name: "speaking" },
  { pattern: /let\s*me\s*(check|look|see|find)/i, weight: 0.7, name: "let_me_check" },
  { pattern: /one\s*sec(ond)?/i, weight: 0.6, name: "one_sec" },
  { pattern: /give\s*me\s*(a\s*)?(moment|second|sec)/i, weight: 0.7, name: "give_me_moment" },
  { pattern: /sorry\s*(about|for)\s*(that|the\s*wait)/i, weight: 0.6, name: "sorry_for_wait" },
  { pattern: /thank\s*you\s*for\s*(waiting|holding|your\s*patience)/i, weight: 0.6, name: "thanks_for_waiting" },
  // Questions that indicate human interaction
  { pattern: /what('s|\s*is)\s*your\s*name/i, weight: 0.7, name: "whats_your_name" },
  { pattern: /who\s*am\s*i\s*speaking\s*(with|to)/i, weight: 0.8, name: "who_speaking" },
  { pattern: /can\s*i\s*(get|have)\s*your/i, weight: 0.6, name: "can_i_get" },
];

/**
 * Patterns for extracting menu options from IVR prompts
 */
const MENU_OPTION_PATTERNS: RegExp[] = [
  // "Press 1 for sales"
  /press\s+(\d+)\s+(?:for|to)\s+([^,\.]+)/gi,
  // "For sales, press 1"
  /for\s+([^,]+),?\s*press\s+(\d+)/gi,
  // "Option 1: sales"
  /option\s+(\d+):?\s*([^,\.]+)/gi,
  // "1 for sales"
  /(\d+)\s+for\s+([^,\.]+)/gi,
  // "Say 'sales' or press 1"
  /say\s+['"]?([^'"]+)['"]?\s+or\s+press\s+(\d+)/gi,
];

/**
 * Analyze text to determine if it's from an IVR system
 */
export function analyzeForIvr(text: string): IvrAnalysis {
  const result: IvrAnalysis = {
    confidence: 0,
    isMenu: false,
    menuOptions: [],
    expectsInput: false,
    expectedInputType: "unknown",
    matchedPatterns: [],
    isHoldMessage: false,
    isTransfer: false,
  };

  if (!text || text.trim().length === 0) {
    return result;
  }

  const normalizedText = text.toLowerCase().trim();
  let ivrScore = 0;
  let humanScore = 0;
  let maxWeight = 0;

  // Check IVR indicator patterns
  for (const { pattern, weight, name } of IVR_INDICATOR_PATTERNS) {
    if (pattern.test(normalizedText)) {
      ivrScore += weight;
      maxWeight += weight;
      result.matchedPatterns.push(name);

      // Check for specific indicators
      if (name.includes("hold") || name.includes("wait") || name.includes("queue") || name.includes("agents_busy")) {
        result.isHoldMessage = true;
      }
      if (name.includes("transfer") || name.includes("connect")) {
        result.isTransfer = true;
      }
    }
  }

  // Check human indicator patterns (reduces confidence)
  for (const { pattern, weight, name } of HUMAN_INDICATOR_PATTERNS) {
    if (pattern.test(normalizedText)) {
      humanScore += weight;
      result.matchedPatterns.push(`human:${name}`);
    }
  }

  // Extract menu options
  for (const pattern of MENU_OPTION_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      // Handle both "press X for Y" and "for Y, press X" patterns
      const digit = match[1].match(/^\d+$/) ? match[1] : match[2];
      const description = match[1].match(/^\d+$/) ? match[2] : match[1];
      if (digit && description) {
        result.menuOptions.push(`${digit}: ${description.trim()}`);
        result.isMenu = true;
      }
    }
  }

  // Deduplicate menu options
  result.menuOptions = [...new Set(result.menuOptions)];

  // Calculate final confidence
  if (maxWeight > 0) {
    // Base confidence from IVR patterns matched
    result.confidence = Math.min(ivrScore / 3, 1); // Normalize - hitting 3+ weights = 100%
  }

  // Reduce confidence if human patterns detected
  if (humanScore > 0) {
    result.confidence = Math.max(0, result.confidence - (humanScore / 3));
  }

  // Boost confidence if menu options were extracted
  if (result.menuOptions.length > 0) {
    result.confidence = Math.min(1, result.confidence + 0.2);
  }

  // Determine expected input type
  if (/press|dial|enter/i.test(normalizedText)) {
    result.expectedInputType = "dtmf";
    result.expectsInput = true;
  } else if (/say|speak|tell/i.test(normalizedText)) {
    result.expectedInputType = "speech";
    result.expectsInput = true;
  } else if (/press.+or\s+say|say.+or\s+press/i.test(normalizedText)) {
    result.expectedInputType = "either";
    result.expectsInput = true;
  }

  return result;
}

/**
 * Update call context based on IVR analysis
 */
export function updateIvrState(callContext: CallContext, analysis: IvrAnalysis): void {
  const threshold = config.ivr.autoDetectThreshold;

  // Update IVR mode based on confidence
  if (analysis.confidence >= threshold) {
    if (!callContext.isIvrMode) {
      console.log(`[IVR] 🤖 Entering IVR mode (confidence: ${(analysis.confidence * 100).toFixed(1)}%)`);
      console.log(`[IVR] Matched patterns: ${analysis.matchedPatterns.join(", ")}`);
    }
    callContext.isIvrMode = true;
    callContext.ivrConfidence = analysis.confidence;

    // Store the IVR prompt for context
    if (analysis.isMenu) {
      callContext.lastIvrPrompt = callContext.lastUserTranscript;
    }

    // Update menu options if detected
    if (analysis.menuOptions.length > 0) {
      callContext.ivrMenuOptions = analysis.menuOptions;
      console.log(`[IVR] 📋 Detected menu options: ${analysis.menuOptions.join(" | ")}`);
    }
  } else if (callContext.isIvrMode && analysis.confidence < threshold * 0.5) {
    // Exit IVR mode if confidence drops significantly
    // Look for strong human indicators
    const hasHumanIndicators = analysis.matchedPatterns.some(p => p.startsWith("human:"));
    if (hasHumanIndicators) {
      console.log(`[IVR] 👤 Exiting IVR mode - human detected (confidence: ${(analysis.confidence * 100).toFixed(1)}%)`);
      callContext.isIvrMode = false;
      callContext.humanDetectedAt = Date.now();
      callContext.ivrConfidence = 0;
    }
  }
}

/**
 * Check if we should use IVR-optimized timing.
 * Returns true if:
 * - Pattern-based IVR detection is active with high confidence, OR
 * - LLM-based party detection determined this is a robotic/IVR system
 */
export function shouldUseIvrTiming(callContext: CallContext): boolean {
  // Check LLM-based party detection first (most authoritative)
  if (callContext.partyDetectionComplete && callContext.detectedPartyType === "robotic") {
    return true;
  }
  // Fall back to pattern-based detection
  return callContext.isIvrMode === true && (callContext.ivrConfidence || 0) >= config.ivr.autoDetectThreshold;
}

/**
 * Get the appropriate debounce time based on IVR mode and per-call settings
 */
export function getDebounceMs(callContext: CallContext): number {
  if (shouldUseIvrTiming(callContext)) {
    return config.ivr.debounceMs;
  }
  // Use per-call setting if provided, otherwise fall back to config default
  return callContext.ttsDebounceMs ?? config.callControl.ttsDebounceMs;
}

/**
 * Get the appropriate utterance flush time based on IVR mode and per-call settings
 */
export function getUtteranceFlushMs(callContext: CallContext): number {
  if (shouldUseIvrTiming(callContext)) {
    return config.ivr.utteranceFlushMs;
  }
  // Use per-call setting if provided, otherwise fall back to config default
  return callContext.callerUtteranceFlushMs ?? config.callControl.callerUtteranceFlushMs;
}

/**
 * Check if DTMF can be sent (respects minimum pause)
 */
export function canSendDtmf(callContext: CallContext): boolean {
  const lastSent = callContext.lastDtmfSentAt || 0;
  const minPause = config.ivr.dtmfMinPauseMs;
  return Date.now() - lastSent >= minPause;
}

/**
 * Record that DTMF was sent
 */
export function recordDtmfSent(callContext: CallContext, digits: string): void {
  callContext.lastDtmfSentAt = Date.now();
  if (!callContext.ivrNavigationHistory) {
    callContext.ivrNavigationHistory = [];
  }
  callContext.ivrNavigationHistory.push(digits);
  console.log(`[IVR] 📱 DTMF recorded: ${digits} (history: ${callContext.ivrNavigationHistory.join(" → ")})`);
}

/**
 * Extract DTMF digits from a string (validates format)
 */
export function extractDtmfDigits(input: string): string | null {
  if (!input) return null;

  // Clean up the input - extract only valid DTMF characters
  // Valid: 0-9, *, #, A-D, w (pause)
  const cleaned = input.toUpperCase().replace(/[^0-9*#ABCDW]/g, "");

  if (cleaned.length === 0) {
    return null;
  }

  // Limit to reasonable length (prevent accidental long strings)
  if (cleaned.length > 20) {
    console.warn(`[IVR] DTMF string too long (${cleaned.length} chars), truncating to 20`);
    return cleaned.substring(0, 20);
  }

  return cleaned;
}

/**
 * Convert word numbers to digits (e.g., "one" -> "1")
 */
export function wordToDigit(word: string): string {
  const mapping: Record<string, string> = {
    "zero": "0",
    "one": "1",
    "two": "2",
    "three": "3",
    "four": "4",
    "five": "5",
    "six": "6",
    "seven": "7",
    "eight": "8",
    "nine": "9",
    "star": "*",
    "asterisk": "*",
    "pound": "#",
    "hash": "#",
  };

  return mapping[word.toLowerCase()] || word;
}

/**
 * Parse natural language DTMF instruction (e.g., "press one" -> "1")
 */
export function parseNaturalDtmf(text: string): string | null {
  if (!text) return null;

  // Try to extract "press X" or "dial X" patterns
  const match = text.match(/(?:press|dial|enter|hit)\s+(\w+)/i);
  if (match) {
    const converted = wordToDigit(match[1]);
    return extractDtmfDigits(converted);
  }

  // Try direct digit extraction if it's just a number
  const directDigit = text.match(/^(\d+)$/);
  if (directDigit) {
    return directDigit[1];
  }

  return null;
}
