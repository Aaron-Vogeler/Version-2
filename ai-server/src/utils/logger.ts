/**
 * Simple logger utility that respects verbose config
 *
 * When VERBOSE_LOGS=true: All logs are shown
 * When VERBOSE_LOGS=false: Only LLM-related logs are shown
 */

import config from "../config";

// Categories that are always shown (LLM-related)
const ALWAYS_SHOW = ["LLM", "STREAM", "GeminiCache"];

// Categories that are only shown in verbose mode
const VERBOSE_CATEGORIES = [
  "TRANSCRIPT",
  "DEBOUNCE",
  "HUMAN-DETECT",
  "MUSIC-DETECT",
  "VAD",
  "IVR",
  "LATENCY",
  "Supabase",
  "TURN",
  "DIARIZATION",
];

/**
 * Log a message - respects verbose config
 */
export function log(category: string, message: string, ...args: any[]) {
  // Always show LLM-related categories
  if (ALWAYS_SHOW.some(c => category.includes(c))) {
    console.log(`[${category}] ${message}`, ...args);
    return;
  }

  // Only show verbose categories if verbose mode is enabled
  if (config.logging.verbose) {
    console.log(`[${category}] ${message}`, ...args);
  }
}

/**
 * Log a warning - always shown
 */
export function warn(category: string, message: string, ...args: any[]) {
  console.warn(`[${category}] ${message}`, ...args);
}

/**
 * Log an error - always shown
 */
export function error(category: string, message: string, ...args: any[]) {
  console.error(`[${category}] ${message}`, ...args);
}

/**
 * Check if verbose logging is enabled
 */
export function isVerbose(): boolean {
  return config.logging.verbose;
}
