/**
 * Role Switch Tests
 * ==================
 * Ensures the AI never treats OWNER_INSTRUCTIONS as dialogue.
 * The first user message is CONFIG - the AI's first output should be
 * its opening greeting to the CALLEE, not a response to config.
 */

import { describe, it, expect } from '@jest/globals';

import {
  createPromptConfig,
  renderPromptBundle,
  buildMessages,
  looksLikeConfigResponse,
  getMessageMode,
  getCalleeConversationStartIndex,
} from '../../ai-server/src/prompts';

describe('Role Switch - Config vs Dialogue', () => {
  describe('looksLikeConfigResponse', () => {
    it('should detect "understood" as config response', () => {
      expect(looksLikeConfigResponse('Understood. I will get the store hours.')).toBe(true);
    });

    it('should detect "got it" as config response', () => {
      expect(looksLikeConfigResponse('Got it. Let me help with that.')).toBe(true);
    });

    it('should detect "I understand" as config response', () => {
      expect(looksLikeConfigResponse('I understand. I will call about the store hours.')).toBe(true);
    });

    it('should detect "I will" at start as config response', () => {
      expect(looksLikeConfigResponse('I will now call to get the store hours.')).toBe(true);
    });

    it('should detect "Okay, I" as config response', () => {
      expect(looksLikeConfigResponse("Okay, I'll help you with that goal.")).toBe(true);
    });

    it('should detect "acknowledged" as config response', () => {
      expect(looksLikeConfigResponse('Acknowledged. Proceeding with the call.')).toBe(true);
    });

    it('should NOT detect proper greeting as config response', () => {
      expect(
        looksLikeConfigResponse(
          "Hi, I'm Pigeon, an AI assistant calling on behalf of the owner. I'm calling about your store hours."
        )
      ).toBe(false);
    });

    it('should NOT detect question as config response', () => {
      expect(
        looksLikeConfigResponse('What are your store hours for next Monday?')
      ).toBe(false);
    });

    it('should NOT detect statement as config response', () => {
      expect(
        looksLikeConfigResponse('Thank you for that information. Have a great day.')
      ).toBe(false);
    });
  });

  describe('Message Mode Detection', () => {
    it('should identify SYSTEM mode for first message', () => {
      const config = createPromptConfig({ goalText: 'Test' });
      const bundle = renderPromptBundle(config);
      const messages = buildMessages({ bundle, transcriptTurns: [] });

      expect(getMessageMode(0, messages)).toBe('SYSTEM');
    });

    it('should identify OWNER_CONFIG mode for second message', () => {
      const config = createPromptConfig({ goalText: 'Test' });
      const bundle = renderPromptBundle(config);
      const messages = buildMessages({ bundle, transcriptTurns: [] });

      expect(getMessageMode(1, messages)).toBe('OWNER_CONFIG');
    });

    it('should identify CONTEXT_SUMMARY mode correctly', () => {
      const config = createPromptConfig({ goalText: 'Test' });
      const bundle = renderPromptBundle(config);
      const messages = buildMessages({
        bundle,
        rollingSummary: 'Summary text',
        transcriptTurns: [],
      });

      expect(getMessageMode(2, messages)).toBe('CONTEXT_SUMMARY');
    });

    it('should identify CALLEE_CONVERSATION mode for transcript', () => {
      const config = createPromptConfig({ goalText: 'Test' });
      const bundle = renderPromptBundle(config);
      const messages = buildMessages({
        bundle,
        transcriptTurns: [
          { speaker: 'caller', text: 'Hello', timestamp: new Date().toISOString() },
        ],
      });

      expect(getMessageMode(2, messages)).toBe('CALLEE_CONVERSATION');
    });

    it('should identify CALLEE_CONVERSATION after summary', () => {
      const config = createPromptConfig({ goalText: 'Test' });
      const bundle = renderPromptBundle(config);
      const messages = buildMessages({
        bundle,
        rollingSummary: 'Summary',
        transcriptTurns: [
          { speaker: 'caller', text: 'Hello', timestamp: new Date().toISOString() },
        ],
      });

      expect(getMessageMode(2, messages)).toBe('CONTEXT_SUMMARY');
      expect(getMessageMode(3, messages)).toBe('CALLEE_CONVERSATION');
    });
  });

  describe('Callee Conversation Start Index', () => {
    it('should return 2 when no summary present', () => {
      const config = createPromptConfig({ goalText: 'Test' });
      const bundle = renderPromptBundle(config);
      const messages = buildMessages({
        bundle,
        transcriptTurns: [
          { speaker: 'caller', text: 'Hello', timestamp: new Date().toISOString() },
        ],
      });

      expect(getCalleeConversationStartIndex(messages)).toBe(2);
    });

    it('should return 3 when summary is present', () => {
      const config = createPromptConfig({ goalText: 'Test' });
      const bundle = renderPromptBundle(config);
      const messages = buildMessages({
        bundle,
        rollingSummary: 'Call summary here',
        transcriptTurns: [
          { speaker: 'caller', text: 'Hello', timestamp: new Date().toISOString() },
        ],
      });

      expect(getCalleeConversationStartIndex(messages)).toBe(3);
    });
  });

  describe('Owner Instructions Are Config Only', () => {
    it('should include DO NOT RESPOND marker', () => {
      const config = createPromptConfig({ goalText: 'Test goal' });
      const bundle = renderPromptBundle(config);

      expect(bundle.ownerInstructions).toContain('DO NOT RESPOND');
    });

    it('should include OWNER marker', () => {
      const config = createPromptConfig({ goalText: 'Test goal' });
      const bundle = renderPromptBundle(config);

      expect(bundle.ownerInstructions).toContain('OWNER');
    });

    it('should include CONFIG marker', () => {
      const config = createPromptConfig({ goalText: 'Test goal' });
      const bundle = renderPromptBundle(config);

      expect(bundle.ownerInstructions).toContain('CONFIG');
    });

    it('should include mode transition instruction', () => {
      const config = createPromptConfig({ goalText: 'Test goal' });
      const bundle = renderPromptBundle(config);

      expect(bundle.ownerInstructions).toContain('CALLEE_CONVERSATION_MODE');
    });

    it('should explain that next message is from callee', () => {
      const config = createPromptConfig({ goalText: 'Test goal' });
      const bundle = renderPromptBundle(config);

      expect(bundle.ownerInstructions).toContain('next');
      expect(bundle.ownerInstructions.toLowerCase()).toContain('callee');
    });
  });
});

describe('Three-Party Distinction', () => {
  it('should clearly separate system (agent definition) from owner instructions', () => {
    const config = createPromptConfig({ goalText: 'Test goal' });
    const bundle = renderPromptBundle(config);

    // System prompt defines WHO the agent is
    expect(bundle.system).toContain('ROLE');
    expect(bundle.system).toContain('AI');

    // Owner instructions define WHAT to do this call
    expect(bundle.ownerInstructions).toContain('GOAL');
    expect(bundle.ownerInstructions).toContain('Test goal');
  });

  it('should not include goal in system prompt', () => {
    const goalText = 'Very specific unique goal text here';
    const config = createPromptConfig({ goalText });
    const bundle = renderPromptBundle(config);

    // Goal should be in owner instructions, not system
    expect(bundle.system).not.toContain(goalText);
    expect(bundle.ownerInstructions).toContain(goalText);
  });

  it('should label transcript turns by speaker', () => {
    const config = createPromptConfig({ goalText: 'Test' });
    const bundle = renderPromptBundle(config);
    const messages = buildMessages({
      bundle,
      transcriptTurns: [
        { speaker: 'caller', text: 'Hello there', timestamp: new Date().toISOString() },
        { speaker: 'ivr', text: 'Press 1 for sales', timestamp: new Date().toISOString() },
      ],
    });

    // Find the caller turn
    const callerMessage = messages.find(
      (m) => m.role === 'user' && m.content.includes('[CALLER]')
    );
    expect(callerMessage).toBeDefined();
    expect(callerMessage?.content).toContain('Hello there');

    // Find the IVR turn
    const ivrMessage = messages.find(
      (m) => m.role === 'user' && m.content.includes('[IVR]')
    );
    expect(ivrMessage).toBeDefined();
    expect(ivrMessage?.content).toContain('Press 1');
  });

  it('should not label assistant turns (they are just assistant role)', () => {
    const config = createPromptConfig({ goalText: 'Test' });
    const bundle = renderPromptBundle(config);
    const messages = buildMessages({
      bundle,
      transcriptTurns: [
        { speaker: 'assistant', text: 'Hi there', timestamp: new Date().toISOString() },
      ],
    });

    const assistantMessage = messages.find(
      (m) => m.role === 'assistant'
    );
    expect(assistantMessage).toBeDefined();
    expect(assistantMessage?.content).toBe('Hi there');
    expect(assistantMessage?.content).not.toContain('[ASSISTANT]');
  });
});
