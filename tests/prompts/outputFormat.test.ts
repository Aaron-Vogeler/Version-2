/**
 * Output Format Tests
 * ====================
 * Ensures assistant output is "spoken words only" with
 * no JSON, markdown, tags, or stage directions.
 */

import { describe, it, expect } from '@jest/globals';

import {
  validateAssistantUtteranceFormat,
  SYSTEM_PROMPT_TEMPLATE,
  createPromptConfig,
  renderPromptBundle,
} from '../../ai-server/src/prompts';

describe('Output Format - Prompt Contains Rules', () => {
  it('should include OUTPUT FORMAT section', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('OUTPUT FORMAT');
  });

  it('should say CRITICAL', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('OUTPUT FORMAT (CRITICAL)');
  });

  it('should specify spoken words only', () => {
    expect(SYSTEM_PROMPT_TEMPLATE.toLowerCase()).toContain('spoken');
  });

  it('should forbid JSON', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('NO JSON');
  });

  it('should forbid markdown', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('NO markdown');
  });

  it('should forbid tags', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('NO tags');
  });

  it('should forbid internal thoughts', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('NO internal thoughts');
  });

  it('should forbid annotations', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('NO annotations');
  });

  it('should forbid stage directions', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('stage directions');
  });

  it('should explain TTS requirement', () => {
    expect(SYSTEM_PROMPT_TEMPLATE).toContain('spoken aloud via TTS');
  });
});

describe('Output Format - Validator', () => {
  describe('Valid outputs (spoken words only)', () => {
    const validOutputs = [
      "Hi, I'm Pigeon, an AI assistant. I'm calling about your store hours.",
      'What time do you open on Monday?',
      'Thank you for that information. Have a great day.',
      "Just to confirm, you're open from 9 to 6. Is that correct?",
      'I understand. Let me note that down.',
      "I'm sorry, I didn't catch that. Could you repeat?",
    ];

    for (const output of validOutputs) {
      it(`should accept: "${output.substring(0, 40)}..."`, () => {
        const result = validateAssistantUtteranceFormat(output);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });
    }
  });

  describe('Invalid outputs - JSON', () => {
    it('should reject JSON object', () => {
      const output = '{"status": "confirmed", "hours": "9-6"}';
      const result = validateAssistantUtteranceFormat(output);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('JSON'))).toBe(true);
    });

    it('should reject JSON array', () => {
      const output = '["9am", "10am", "11am"]';
      const result = validateAssistantUtteranceFormat(output);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('JSON'))).toBe(true);
    });
  });

  describe('Invalid outputs - Markdown', () => {
    it('should reject markdown headers', () => {
      const output = '## Store Hours\nMonday: 9-6';
      const result = validateAssistantUtteranceFormat(output);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('markdown'))).toBe(true);
    });

    it('should warn about markdown bold', () => {
      const output = 'The store is **open** on Monday.';
      const result = validateAssistantUtteranceFormat(output);

      expect(result.warnings.some((w) => w.includes('markdown'))).toBe(true);
    });

    it('should warn about markdown lists', () => {
      const output = 'Hours:\n- Monday: 9-6\n- Tuesday: 9-6';
      const result = validateAssistantUtteranceFormat(output);

      expect(result.warnings.some((w) => w.includes('list'))).toBe(true);
    });

    it('should reject code blocks', () => {
      const output = '```\ncode here\n```';
      const result = validateAssistantUtteranceFormat(output);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('code blocks'))).toBe(true);
    });
  });

  describe('Invalid outputs - Stage directions', () => {
    it('should reject [pause] stage direction', () => {
      const output = 'Let me check that for you. [pause] Yes, we have availability.';
      const result = validateAssistantUtteranceFormat(output);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('stage directions'))).toBe(true);
    });

    it('should reject (thinking) stage direction', () => {
      const output = "(thinking about the question) I believe we're open at 9.";
      const result = validateAssistantUtteranceFormat(output);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('stage directions'))).toBe(true);
    });

    it('should reject (pause) stage direction', () => {
      const output = 'Let me see... (pause) ...yes, we can do that.';
      const result = validateAssistantUtteranceFormat(output);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('stage directions'))).toBe(true);
    });

    it('should not reject normal parentheses', () => {
      const output = "We're open 9 to 6 (Monday through Friday).";
      const result = validateAssistantUtteranceFormat(output);

      expect(result.valid).toBe(true);
    });

    it('should not reject normal brackets with numbers', () => {
      const output = 'Per our policy [1], we require 24 hours notice.';
      const result = validateAssistantUtteranceFormat(output);

      expect(result.valid).toBe(true);
    });
  });

  describe('Invalid outputs - HTML/XML tags', () => {
    it('should reject HTML tags', () => {
      const output = 'The store is <b>open</b> on Monday.';
      const result = validateAssistantUtteranceFormat(output);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('HTML/XML'))).toBe(true);
    });

    it('should reject XML-style tags', () => {
      const output = '<response>Yes, we are open.</response>';
      const result = validateAssistantUtteranceFormat(output);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('HTML/XML'))).toBe(true);
    });
  });

  describe('Invalid outputs - Internal thoughts', () => {
    const thoughtMarkers = ['THINKING:', 'THOUGHT:', 'INTERNAL:', 'NOTE:'];

    for (const marker of thoughtMarkers) {
      it(`should reject ${marker} marker`, () => {
        const output = `${marker} I should ask about hours. Hi, what are your hours?`;
        const result = validateAssistantUtteranceFormat(output);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => e.includes('internal thought'))).toBe(true);
      });
    }
  });
});

describe('Output Format - Integration', () => {
  it('should be enforceable on rendered prompts', () => {
    const config = createPromptConfig({
      goalText: 'Get store hours',
      assistantName: 'TestBot',
    });
    const bundle = renderPromptBundle(config);

    // System prompt should contain the format rules
    expect(bundle.system).toContain('OUTPUT FORMAT');
    expect(bundle.system).toContain('NO JSON');

    // A proper response should pass validation
    const goodResponse = "Hi, I'm TestBot. What are your store hours?";
    const result = validateAssistantUtteranceFormat(goodResponse);
    expect(result.valid).toBe(true);
  });

  it('should work with various assistant names', () => {
    const names = ['Pigeon', 'Ferguson', 'CustomBot', 'AI Assistant'];

    for (const name of names) {
      const response = `Hi, I'm ${name}. How can I help you today?`;
      const result = validateAssistantUtteranceFormat(response);
      expect(result.valid).toBe(true);
    }
  });
});
