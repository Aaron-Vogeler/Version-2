/**
 * Streaming JSON Parser
 *
 * Incrementally parses JSON fields as they arrive from LLM streaming responses.
 * Designed to extract fields early to enable fast TTS start times.
 *
 * Expected JSON format (fields in this order for optimal performance):
 * {
 *   "behavior": "speak|wait|end|noop|hold|dtmf",
 *   "speak": "text to speak to the caller",
 *   "internal": "internal reasoning notes"
 * }
 */

export interface ParsedStreamFields {
  behavior?: string;
  speak?: string;
  internal?: string;
  dtmf?: string;
}

export class StreamingJsonParser {
  private buffer = '';
  private extractedFields: ParsedStreamFields = {};
  private speakFieldComplete = false;
  private behaviorFieldComplete = false;

  /**
   * Add a new chunk of text from the streaming LLM response
   */
  addChunk(chunk: string): void {
    this.buffer += chunk;

    // Try to extract behavior field first (early decision)
    if (!this.behaviorFieldComplete) {
      const behaviorMatch = this.buffer.match(/"behavior"\s*:\s*"([^"]+)"/);
      if (behaviorMatch) {
        this.extractedFields.behavior = behaviorMatch[1];
        this.behaviorFieldComplete = true;
        console.log(`[STREAM] 🎯 Behavior detected: ${behaviorMatch[1]}`);
      }
    }

    // Try to extract speak field
    if (!this.speakFieldComplete) {
      // Match complete speak field: "speak": "text goes here"
      // This regex handles escaped quotes and newlines within the string
      const speakMatch = this.buffer.match(/"speak"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (speakMatch) {
        this.extractedFields.speak = this.unescapeJsonString(speakMatch[1]);
        this.speakFieldComplete = true;
        console.log(`[STREAM] ✅ Speak field complete (${this.extractedFields.speak?.length || 0} chars)`);
      }
    }

    // Try to extract dtmf field (for dtmf behavior)
    if (!this.extractedFields.dtmf) {
      const dtmfMatch = this.buffer.match(/"dtmf"\s*:\s*"([^"]+)"/);
      if (dtmfMatch) {
        this.extractedFields.dtmf = dtmfMatch[1];
        console.log(`[STREAM] 📱 DTMF field detected: ${dtmfMatch[1]}`);
      }
    }

    // Try to extract internal field (optional, for debugging)
    if (!this.extractedFields.internal) {
      const internalMatch = this.buffer.match(/"internal"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (internalMatch) {
        this.extractedFields.internal = this.unescapeJsonString(internalMatch[1]);
      }
    }
  }

  /**
   * Unescape JSON string values (handle \", \n, \\, etc.)
   */
  private unescapeJsonString(str: string): string {
    return str
      .replace(/\\"/g, '"')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
      .replace(/\\\\/g, '\\');
  }

  /**
   * Can we start TTS? (behavior=speak and speak field is complete)
   */
  canStartTts(): boolean {
    return this.extractedFields.behavior === 'speak' && this.speakFieldComplete;
  }

  /**
   * Should we skip TTS entirely? (behavior is wait/noop/hold)
   */
  shouldSkipTts(): boolean {
    const behavior = this.extractedFields.behavior;
    return behavior === 'wait' || behavior === 'noop' || behavior === 'hold';
  }

  /**
   * Should we handle DTMF? (behavior=dtmf)
   */
  shouldHandleDtmf(): boolean {
    return this.extractedFields.behavior === 'dtmf';
  }

  /**
   * Should we end the call? (behavior=end)
   */
  shouldEndCall(): boolean {
    return this.extractedFields.behavior === 'end';
  }

  /**
   * Get the extracted speak text
   */
  getSpeakText(): string | null {
    return this.extractedFields.speak || null;
  }

  /**
   * Get the extracted DTMF digits
   */
  getDtmfDigits(): string | null {
    return this.extractedFields.dtmf || null;
  }

  /**
   * Get the behavior value
   */
  getBehavior(): string {
    return this.extractedFields.behavior || 'speak';
  }

  /**
   * Get all extracted fields
   */
  getResult(): ParsedStreamFields {
    return {
      behavior: this.extractedFields.behavior || 'speak',
      speak: this.extractedFields.speak,
      internal: this.extractedFields.internal,
      dtmf: this.extractedFields.dtmf,
    };
  }

  /**
   * Get the raw buffer (for fallback parsing)
   */
  getBuffer(): string {
    return this.buffer;
  }

  /**
   * Has behavior been determined? (so we know if we can make early decisions)
   */
  hasBehavior(): boolean {
    return this.behaviorFieldComplete;
  }
}
