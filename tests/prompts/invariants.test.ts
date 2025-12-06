/**
 * Prompt Invariants Tests
 * ========================
 * Tests for prompt structure, message ordering, and core invariants.
 */

import { describe, it, expect } from '@jest/globals';

import {
  createPromptConfig,
  renderPromptBundle,
  buildMessages,
  validateMessageOrdering,
  validateSystemPromptContainsRoleRules,
  validateOwnerInstructionsConfigOnly,
  validatePromptBundle,
  validateMessagesPreFlight,
  SYSTEM_PROMPT_TEMPLATE,
  OWNER_INSTRUCTIONS_TEMPLATE,
  ChatMessage,
} from '../../ai-server/src/prompts';

describe('Prompt Invariants', () => {
  describe('Message Ordering', () => {
    it('should require system message first', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
      ];

      const result = validateMessageOrdering(messages);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('First message must be system role, got: user');
    });

    it('should reject empty message array', () => {
      const result = validateMessageOrdering([]);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Message array is empty - must have at least system message');
    });

    it('should reject multiple system messages', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'System 1' },
        { role: 'user', content: 'User' },
        { role: 'system', content: 'System 2' },
      ];

      const result = validateMessageOrdering(messages);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('only 1 allowed'))).toBe(true);
    });

    it('should accept valid message ordering', () => {
      const config = createPromptConfig({ goalText: 'Test goal' });
      const bundle = renderPromptBundle(config);
      const messages = buildMessages({
        bundle,
        transcriptTurns: [],
      });

      const result = validateMessageOrdering(messages);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should warn if first user message lacks owner markers', () => {
      const messages: ChatMessage[] = [
        { role: 'system', content: 'You are an AI' },
        { role: 'user', content: 'Just some random text without markers' },
      ];

      const result = validateMessageOrdering(messages);

      expect(result.valid).toBe(true); // Valid but with warning
      expect(result.warnings.some((w) => w.includes('OWNER/CONFIG/GOAL markers'))).toBe(true);
    });
  });

  describe('System Prompt Rules', () => {
    it('should contain required sections', () => {
      const result = validateSystemPromptContainsRoleRules(SYSTEM_PROMPT_TEMPLATE);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail if ROLE section is missing', () => {
      const badPrompt = 'You are an AI. Be helpful.';

      const result = validateSystemPromptContainsRoleRules(badPrompt);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('ROLE'))).toBe(true);
    });

    it('should fail if GOAL FOCUS is missing', () => {
      const badPrompt = 'ROLE\nYou are an AI.\nOUTPUT FORMAT\nSpoken words only.';

      const result = validateSystemPromptContainsRoleRules(badPrompt);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('GOAL FOCUS'))).toBe(true);
    });

    it('should fail if OUTPUT FORMAT is missing', () => {
      const badPrompt = 'ROLE\nYou are an AI.\nGOAL FOCUS\nStay on topic.';

      const result = validateSystemPromptContainsRoleRules(badPrompt);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('OUTPUT FORMAT'))).toBe(true);
    });

    it('should fail if DATE/TIME POLICY is missing', () => {
      const badPrompt = 'ROLE\nYou are an AI.\nGOAL FOCUS\nStay on topic.\nOUTPUT FORMAT\nWords only.';

      const result = validateSystemPromptContainsRoleRules(badPrompt);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('DATE/TIME POLICY'))).toBe(true);
    });
  });

  describe('Owner Instructions Config', () => {
    it('should contain required markers', () => {
      const result = validateOwnerInstructionsConfigOnly(OWNER_INSTRUCTIONS_TEMPLATE);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail if no config markers present', () => {
      const badInstructions = 'Hello, please help me with something.';

      const result = validateOwnerInstructionsConfigOnly(badInstructions);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('config markers'))).toBe(true);
    });

    it('should fail if instructions are too short', () => {
      const shortInstructions = 'GOAL: test';

      const result = validateOwnerInstructionsConfigOnly(shortInstructions);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes('too short'))).toBe(true);
    });
  });

  describe('Prompt Bundle Validation', () => {
    it('should validate complete rendered bundle', () => {
      const config = createPromptConfig({
        goalText: 'Get store hours for next Monday',
        assistantName: 'TestBot',
        ownerName: 'TestOwner',
      });
      const bundle = renderPromptBundle(config);

      const result = validatePromptBundle(bundle);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should include assistant name in rendered bundle', () => {
      const config = createPromptConfig({
        goalText: 'Test',
        assistantName: 'CustomBot',
      });
      const bundle = renderPromptBundle(config);

      expect(bundle.system).toContain('CustomBot');
      expect(bundle.system).not.toContain('{{assistant_name}}');
    });

    it('should include owner name in rendered bundle', () => {
      const config = createPromptConfig({
        goalText: 'Test',
        ownerName: 'CustomOwner',
      });
      const bundle = renderPromptBundle(config);

      expect(bundle.system).toContain('CustomOwner');
      expect(bundle.system).not.toContain('{{owner_name}}');
    });

    it('should include goal in owner instructions', () => {
      const goalText = 'Get the store hours for next Monday';
      const config = createPromptConfig({ goalText });
      const bundle = renderPromptBundle(config);

      expect(bundle.ownerInstructions).toContain(goalText);
      expect(bundle.ownerInstructions).not.toContain('{{goal_text}}');
    });
  });

  describe('Pre-flight Message Validation', () => {
    it('should pass for valid message array', () => {
      const config = createPromptConfig({ goalText: 'Test goal' });
      const bundle = renderPromptBundle(config);
      const messages = buildMessages({
        bundle,
        transcriptTurns: [
          { speaker: 'caller', text: 'Hello', timestamp: new Date().toISOString() },
        ],
      });

      const result = validateMessagesPreFlight(messages, 'Test goal');

      expect(result.valid).toBe(true);
    });

    it('should fail for malformed message array', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'Starting with user' },
      ];

      const result = validateMessagesPreFlight(messages, 'Test');

      expect(result.valid).toBe(false);
    });
  });
});

describe('Three-Party Model Enforcement', () => {
  it('should build messages with correct structure', () => {
    const config = createPromptConfig({ goalText: 'Test goal' });
    const bundle = renderPromptBundle(config);
    const messages = buildMessages({
      bundle,
      transcriptTurns: [],
    });

    // First message is system (PARTY 1 - OWNER defines agent)
    expect(messages[0].role).toBe('system');

    // Second message is user (PARTY 1 - OWNER instructions)
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('OWNER');
    expect(messages[1].content).toContain('GOAL');
  });

  it('should add transcript turns after owner instructions', () => {
    const config = createPromptConfig({ goalText: 'Test goal' });
    const bundle = renderPromptBundle(config);
    const messages = buildMessages({
      bundle,
      transcriptTurns: [
        { speaker: 'caller', text: 'Hello', timestamp: new Date().toISOString() },
        { speaker: 'assistant', text: 'Hi there', timestamp: new Date().toISOString() },
      ],
    });

    // Should have: system, owner, caller turn, assistant turn
    expect(messages.length).toBe(4);
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toContain('Hello');
    expect(messages[3].role).toBe('assistant');
    expect(messages[3].content).toContain('Hi there');
  });

  it('should add rolling summary in correct position', () => {
    const config = createPromptConfig({ goalText: 'Test goal' });
    const bundle = renderPromptBundle(config);
    const messages = buildMessages({
      bundle,
      rollingSummary: 'This is a summary of the call so far',
      transcriptTurns: [],
    });

    // Should have: system, owner, summary
    expect(messages.length).toBe(3);
    expect(messages[2].role).toBe('user');
    expect(messages[2].content).toContain('CALL CONTEXT SUMMARY');
    expect(messages[2].content).toContain('This is a summary');
  });

  it('should add current utterance at the end', () => {
    const config = createPromptConfig({ goalText: 'Test goal' });
    const bundle = renderPromptBundle(config);
    const messages = buildMessages({
      bundle,
      transcriptTurns: [],
      currentUtterance: 'What are your hours?',
    });

    const lastMessage = messages[messages.length - 1];
    expect(lastMessage.role).toBe('user');
    expect(lastMessage.content).toBe('What are your hours?');
  });
});
