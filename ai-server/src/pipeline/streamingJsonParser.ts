/**
 * Streaming JSON Parser
 *
 * Incrementally parses JSON fields as they arrive from LLM streaming responses.
 * Designed to extract fields early to enable fast TTS start times.
 *
 * Expected JSON format (fields in this order for optimal performance):
 * {
 *   "thought_process": "Brief analysis of the situation",
 *   "speak": "text to speak to the caller" | null,
 *   "dtmf": "digit to press" | null,
 *   "behavior": "listen|wait|hangup|transfer_request",
 *   "goal_status": "in_progress|completed|blocked"
 * }
 */

export interface ParsedStreamFields {
  thought_process?: string;
  speak?: string;
  dtmf?: string;
  behavior?: string;
  goal_status?: string;
}

export class StreamingJsonParser {
  private buffer = '';
  private extractedFields: ParsedStreamFields = {};
  private speakFieldComplete = false;
  private behaviorFieldComplete = false;
  private thoughtProcessComplete = false;

  /**
   * Add a new chunk of text from the streaming LLM response
   */
  addChunk(chunk: string): void {
    this.buffer += chunk;

    // Try to extract thought_process field first (for logging)
    if (!this.thoughtProcessComplete) {
      const thoughtMatch = this.buffer.match(/"thought_process"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (thoughtMatch) {
        this.extractedFields.thought_process = this.unescapeJsonString(thoughtMatch[1]);
        this.thoughtProcessComplete = true;
        console.log(`[STREAM] 🧠 Thought process complete`);
      }
    }

    // Try to extract speak field (for early TTS)
    if (!this.speakFieldComplete) {
      // Match complete speak field: "speak": "text goes here" or "speak": null
      const speakMatch = this.buffer.match(/"speak"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const speakNullMatch = this.buffer.match(/"speak"\s*:\s*null/);
      if (speakMatch) {
        this.extractedFields.speak = this.unescapeJsonString(speakMatch[1]);
        this.speakFieldComplete = true;
        console.log(`[STREAM] ✅ Speak field complete (${this.extractedFields.speak?.length || 0} chars)`);
      } else if (speakNullMatch) {
        this.extractedFields.speak = undefined;
        this.speakFieldComplete = true;
        console.log(`[STREAM] ⏸️ Speak field is null`);
      }
    }

    // Try to extract dtmf field
    if (!this.extractedFields.dtmf) {
      const dtmfMatch = this.buffer.match(/"dtmf"\s*:\s*"([^"]+)"/);
      if (dtmfMatch) {
        this.extractedFields.dtmf = dtmfMatch[1];
        console.log(`[STREAM] 📱 DTMF field detected: ${dtmfMatch[1]}`);
      }
    }

    // Try to extract behavior field
    if (!this.behaviorFieldComplete) {
      const behaviorMatch = this.buffer.match(/"behavior"\s*:\s*"([^"]+)"/);
      if (behaviorMatch) {
        this.extractedFields.behavior = behaviorMatch[1];
        this.behaviorFieldComplete = true;
        console.log(`[STREAM] 🎯 Behavior detected: ${behaviorMatch[1]}`);
      }
    }

    // Try to extract goal_status field
    if (!this.extractedFields.goal_status) {
      const goalStatusMatch = this.buffer.match(/"goal_status"\s*:\s*"([^"]+)"/);
      if (goalStatusMatch) {
        this.extractedFields.goal_status = goalStatusMatch[1];
        console.log(`[STREAM] 📊 Goal status: ${goalStatusMatch[1]}`);
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
   * Can we start TTS? (speak field has content)
   */
  canStartTts(): boolean {
    return this.speakFieldComplete && !!this.extractedFields.speak;
  }

  /**
   * Should we skip TTS entirely? (speak is null or behavior is wait)
   */
  shouldSkipTts(): boolean {
    // Skip if speak is null/empty or behavior is wait
    if (this.speakFieldComplete && !this.extractedFields.speak) {
      return true;
    }
    return this.extractedFields.behavior === 'wait';
  }

  /**
   * Should we handle DTMF? (dtmf field has content)
   */
  shouldHandleDtmf(): boolean {
    return !!this.extractedFields.dtmf;
  }

  /**
   * Should we end the call? (behavior=hangup or goal_status=completed/blocked)
   */
  shouldEndCall(): boolean {
    return this.extractedFields.behavior === 'hangup' ||
           this.extractedFields.goal_status === 'completed' ||
           this.extractedFields.goal_status === 'blocked';
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
    return this.extractedFields.behavior || 'listen';
  }

  /**
   * Get the goal status
   */
  getGoalStatus(): string {
    return this.extractedFields.goal_status || 'in_progress';
  }

  /**
   * Get all extracted fields
   */
  getResult(): ParsedStreamFields {
    return {
      thought_process: this.extractedFields.thought_process,
      speak: this.extractedFields.speak,
      dtmf: this.extractedFields.dtmf,
      behavior: this.extractedFields.behavior || 'listen',
      goal_status: this.extractedFields.goal_status || 'in_progress',
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
