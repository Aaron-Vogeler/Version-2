import { NextRequest, NextResponse } from 'next/server';
import {
  Scenario,
  ScenarioResult,
  ConversationTurn,
  createPromptConfig,
  renderPromptBundle,
  buildMessages,
  validateMessageOrdering,
  validateSystemPromptContainsRoleRules,
  validateAssistantUtteranceFormat,
  validateNoCalendarDateGenerated,
  looksLikeConfigResponse,
} from '@/lib/prompts';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { scenario, liveMode = false } = body as { scenario: Scenario; liveMode?: boolean };

    const startTime = Date.now();
    const errors: string[] = [];
    const warnings: string[] = [];

    // Build prompt config
    const config = createPromptConfig({
      goalText: scenario.goal,
      assistantName: scenario.assistantName || 'Pigeon',
      ownerName: scenario.ownerName || 'the owner',
      recordingNotice: scenario.recordingNotice || false,
    });

    // Render bundle
    const bundle = renderPromptBundle(config);

    // Convert transcript
    const transcriptTurns: ConversationTurn[] = scenario.transcript.map((t) => ({
      speaker: t.speaker as 'caller' | 'assistant' | 'ivr',
      text: t.text,
      timestamp: new Date().toISOString(),
    }));

    // Build messages
    const messages = buildMessages({
      bundle,
      transcriptTurns,
    });

    // Run validators
    const orderingResult = validateMessageOrdering(messages);
    errors.push(...orderingResult.errors);
    warnings.push(...orderingResult.warnings);

    const systemResult = validateSystemPromptContainsRoleRules(bundle.system);
    errors.push(...systemResult.errors);
    warnings.push(...systemResult.warnings);

    // Validate assistant turns in transcript
    for (const turn of scenario.transcript.filter((t) => t.speaker === 'assistant')) {
      const formatResult = validateAssistantUtteranceFormat(turn.text);
      errors.push(...formatResult.errors);
      warnings.push(...formatResult.warnings);

      if (scenario.expectations.mustPreserveRelativeDates) {
        const dateResult = validateNoCalendarDateGenerated(turn.text, scenario.goal);
        errors.push(...dateResult.errors);
        warnings.push(...dateResult.warnings);
      }
    }

    let response: string | undefined;

    // LIVE mode - call actual LLM
    if (liveMode) {
      const groqApiKey = process.env.GROQ_API_KEY;
      if (!groqApiKey) {
        errors.push('GROQ_API_KEY not configured - cannot run in LIVE mode');
      } else {
        try {
          const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${groqApiKey}`,
            },
            body: JSON.stringify({
              model: process.env.GROQ_MODEL || 'llama-3.1-8b-instant',
              messages,
              temperature: 0.2,
            }),
          });

          if (!groqResponse.ok) {
            const errorText = await groqResponse.text();
            errors.push(`LLM API error: ${groqResponse.status} - ${errorText}`);
          } else {
            const data = await groqResponse.json();
            const llmResponse = (data.choices?.[0]?.message?.content || '') as string;
            response = llmResponse;

            // Validate response
            const formatResult = validateAssistantUtteranceFormat(llmResponse);
            errors.push(...formatResult.errors);
            warnings.push(...formatResult.warnings);

            if (scenario.expectations.mustPreserveRelativeDates) {
              const dateResult = validateNoCalendarDateGenerated(llmResponse, scenario.goal);
              errors.push(...dateResult.errors);
              warnings.push(...dateResult.warnings);
            }

            if (looksLikeConfigResponse(llmResponse)) {
              errors.push('Response looks like config acknowledgment instead of greeting');
            }

            // Check expectations
            if (scenario.expectations.shouldContain) {
              for (const pattern of scenario.expectations.shouldContain) {
                if (!llmResponse.toLowerCase().includes(pattern.toLowerCase())) {
                  errors.push(`Response should contain: "${pattern}"`);
                }
              }
            }

            if (scenario.expectations.shouldNotContain) {
              for (const pattern of scenario.expectations.shouldNotContain) {
                if (llmResponse.toLowerCase().includes(pattern.toLowerCase())) {
                  errors.push(`Response should NOT contain: "${pattern}"`);
                }
              }
            }
          }
        } catch (err) {
          errors.push(`LLM call failed: ${err}`);
        }
      }
    }

    const result: ScenarioResult = {
      scenarioId: scenario.id,
      passed: errors.length === 0,
      errors,
      warnings,
      messages,
      response,
      durationMs: Date.now() - startTime,
    };

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: `Failed to run scenario: ${error}` },
      { status: 500 }
    );
  }
}
