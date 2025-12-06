/**
 * Owner Instructions Template
 * ============================
 * This template defines the FIRST user message in the conversation.
 * It contains the owner's instructions to the AI agent for this specific call.
 *
 * THREE-PARTY MODEL:
 * - This message is from the OWNER (party 1), not the CALLEE (party 3).
 * - After this message, the AI enters CALLEE_CONVERSATION_MODE.
 * - All subsequent "user" messages are from the CALLEE on the phone.
 *
 * IMPORTANT: The AI should NEVER respond to this message as if it's dialogue.
 * This is configuration, not conversation. The AI's first spoken output
 * should be its opening greeting to the CALLEE.
 */

/**
 * The owner instructions template with goal placeholder.
 * Variable: {{goal_text}}
 */
export const OWNER_INSTRUCTIONS_TEMPLATE = `OWNER INSTRUCTIONS (CONFIG — DO NOT RESPOND TO THIS AS DIALOGUE)

This message is from the OWNER/DEVELOPER configuring your call. You are about to enter CALLEE_CONVERSATION_MODE where all subsequent "user" messages will be from the person on the phone (the CALLEE).

CALL GOAL (YOUR ONLY MISSION):
"{{goal_text}}"

EXECUTION RULES FOR THIS CALL:
- Ask ONLY questions necessary to achieve the goal above
- Preserve the EXACT specificity of the goal (dates, times, details)
- Do NOT reinterpret dates/times (e.g., if goal says "next Monday", ask about "next Monday", not a specific calendar date)
- Do NOT ask for names, store info, account details, or anything else unless directly needed
- Example: If goal is "get store hours for next Monday", ask ONLY about next Monday's hours—not tomorrow, not "the next day", not today
- When you have what you need: confirm it back ("Just to confirm, [info]. Is that correct?")
- After confirmation: end with "Thank you. Goodbye."
- Do NOT deviate from this goal

MODE TRANSITION:
After processing this configuration, you are now in CALLEE_CONVERSATION_MODE.
The next "user" message will be from the CALLEE (the person answering the phone).
Your first output should be your opening greeting as defined in your system prompt.

Remember: You are an AI phone agent. Strict scope control is mandatory.`;

/**
 * Abbreviated owner instructions for scenarios where token budget is tight.
 */
export const OWNER_INSTRUCTIONS_COMPACT_TEMPLATE = `[OWNER CONFIG - NOT DIALOGUE]
GOAL: "{{goal_text}}"
RULES: Goal-only questions, preserve exact dates/times, confirm before close.
MODE: CALLEE_CONVERSATION_MODE active. Next user message = phone callee.`;

/**
 * Get the owner instructions template.
 * @param compact - If true, returns the compact version for token-constrained scenarios
 */
export function getOwnerInstructionsTemplate(compact: boolean = false): string {
  return compact ? OWNER_INSTRUCTIONS_COMPACT_TEMPLATE : OWNER_INSTRUCTIONS_TEMPLATE;
}
