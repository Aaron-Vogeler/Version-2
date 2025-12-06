'use client';

import { useState, useEffect } from 'react';
import {
  Scenario,
  ScenarioResult,
  ChatMessage,
  createPromptConfig,
  renderPromptBundle,
  buildMessages,
  SYSTEM_PROMPT_TEMPLATE,
  OWNER_INSTRUCTIONS_TEMPLATE,
} from '@/lib/prompts';
import { SCENARIOS, getAllTags } from '@/lib/prompts/scenarios';

export default function PromptLabPage() {
  const [selectedScenario, setSelectedScenario] = useState<Scenario | null>(null);
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [activeTab, setActiveTab] = useState<'scenarios' | 'editor' | 'messages'>('scenarios');
  const [filterTag, setFilterTag] = useState<string>('all');
  const [customGoal, setCustomGoal] = useState('');
  const [customTranscript, setCustomTranscript] = useState('');

  const tags = getAllTags();
  const filteredScenarios = filterTag === 'all'
    ? SCENARIOS
    : SCENARIOS.filter((s) => s.tags.includes(filterTag));

  const runScenario = async (scenario: Scenario) => {
    setLoading(true);
    setResult(null);

    try {
      const res = await fetch('/api/prompt-lab/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario, liveMode }),
      });
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setResult({
        scenarioId: scenario.id,
        passed: false,
        errors: [`Request failed: ${err}`],
        warnings: [],
        messages: [],
        durationMs: 0,
      });
    }

    setLoading(false);
  };

  const runCustomScenario = async () => {
    if (!customGoal.trim()) return;

    const customScenario: Scenario = {
      id: 'custom',
      name: 'Custom Scenario',
      description: 'User-defined scenario',
      tags: ['custom'],
      goal: customGoal,
      transcript: customTranscript
        ? customTranscript.split('\n').filter(Boolean).map((line) => {
            const match = line.match(/^(caller|assistant|ivr):\s*(.+)$/i);
            if (match) {
              return { speaker: match[1].toLowerCase() as 'caller' | 'assistant' | 'ivr', text: match[2] };
            }
            return { speaker: 'caller' as const, text: line };
          })
        : [],
      expectations: {
        mustPreserveRelativeDates: /next|tomorrow|this/i.test(customGoal),
      },
    };

    setSelectedScenario(customScenario);
    await runScenario(customScenario);
  };

  const previewMessages = () => {
    if (!selectedScenario) return [];

    const config = createPromptConfig({
      goalText: selectedScenario.goal,
      assistantName: selectedScenario.assistantName || 'Pigeon',
      ownerName: selectedScenario.ownerName || 'the owner',
    });

    const bundle = renderPromptBundle(config);

    return buildMessages({
      bundle,
      transcriptTurns: selectedScenario.transcript.map((t) => ({
        speaker: t.speaker as 'caller' | 'assistant' | 'ivr',
        text: t.text,
        timestamp: new Date().toISOString(),
      })),
    });
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Prompt Lab</h1>
          <p className="text-gray-600 dark:text-gray-400 mt-2">
            Test and iterate on AI phone agent prompts
          </p>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 mb-6">
          {(['scenarios', 'editor', 'messages'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                activeTab === tab
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
              }`}
            >
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
            </button>
          ))}

          <div className="ml-auto flex items-center gap-4">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={liveMode}
                onChange={(e) => setLiveMode(e.target.checked)}
                className="w-4 h-4 rounded"
              />
              <span className={liveMode ? 'text-green-600 font-medium' : 'text-gray-600'}>
                LIVE Mode {liveMode && '(calls LLM)'}
              </span>
            </label>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Panel */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
            {activeTab === 'scenarios' && (
              <>
                <div className="flex items-center gap-2 mb-4">
                  <span className="text-sm text-gray-600 dark:text-gray-400">Filter:</span>
                  <select
                    value={filterTag}
                    onChange={(e) => setFilterTag(e.target.value)}
                    className="px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm"
                  >
                    <option value="all">All Tags</option>
                    {tags.map((tag) => (
                      <option key={tag} value={tag}>{tag}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-3 max-h-[500px] overflow-y-auto">
                  {filteredScenarios.map((scenario) => (
                    <div
                      key={scenario.id}
                      onClick={() => setSelectedScenario(scenario)}
                      className={`p-4 rounded-lg border cursor-pointer transition-all ${
                        selectedScenario?.id === scenario.id
                          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                          : 'border-gray-200 dark:border-gray-600 hover:border-gray-300 dark:hover:border-gray-500'
                      }`}
                    >
                      <div className="flex items-start justify-between">
                        <div>
                          <h3 className="font-medium text-gray-900 dark:text-white">{scenario.name}</h3>
                          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{scenario.description}</p>
                          <div className="flex gap-1 mt-2">
                            {scenario.tags.map((tag) => (
                              <span
                                key={tag}
                                className={`px-2 py-0.5 text-xs rounded-full ${
                                  tag === 'critical'
                                    ? 'bg-red-100 text-red-700'
                                    : tag === 'date-policy'
                                    ? 'bg-purple-100 text-purple-700'
                                    : 'bg-gray-100 text-gray-600'
                                }`}
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedScenario(scenario);
                            runScenario(scenario);
                          }}
                          disabled={loading}
                          className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50"
                        >
                          {loading && selectedScenario?.id === scenario.id ? 'Running...' : 'Run'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}

            {activeTab === 'editor' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Custom Goal
                  </label>
                  <input
                    type="text"
                    value={customGoal}
                    onChange={(e) => setCustomGoal(e.target.value)}
                    placeholder="e.g., Get the store hours for next Monday"
                    className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                    Transcript (one per line: caller: Hello)
                  </label>
                  <textarea
                    value={customTranscript}
                    onChange={(e) => setCustomTranscript(e.target.value)}
                    placeholder="caller: Hello, how can I help you?"
                    rows={6}
                    className="w-full px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 font-mono text-sm"
                  />
                </div>

                <button
                  onClick={runCustomScenario}
                  disabled={loading || !customGoal.trim()}
                  className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
                >
                  {loading ? 'Running...' : 'Run Custom Scenario'}
                </button>

                <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                  <h3 className="font-medium text-gray-900 dark:text-white mb-2">System Prompt Preview</h3>
                  <pre className="text-xs bg-gray-50 dark:bg-gray-900 p-3 rounded-lg overflow-auto max-h-64 whitespace-pre-wrap">
                    {SYSTEM_PROMPT_TEMPLATE.substring(0, 500)}...
                  </pre>
                </div>
              </div>
            )}

            {activeTab === 'messages' && selectedScenario && (
              <div className="space-y-3">
                <h3 className="font-medium text-gray-900 dark:text-white">
                  Message Array for: {selectedScenario.name}
                </h3>
                <div className="space-y-2 max-h-[500px] overflow-y-auto">
                  {previewMessages().map((msg, i) => (
                    <div
                      key={i}
                      className={`p-3 rounded-lg text-sm ${
                        msg.role === 'system'
                          ? 'bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800'
                          : msg.role === 'assistant'
                          ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
                          : 'bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800'
                      }`}
                    >
                      <div className="font-medium text-xs uppercase mb-1 opacity-70">
                        [{i}] {msg.role}
                      </div>
                      <pre className="whitespace-pre-wrap text-xs font-mono">
                        {msg.content.length > 300 ? msg.content.substring(0, 300) + '...' : msg.content}
                      </pre>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right Panel - Results */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-200 dark:border-gray-700 p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Results</h2>

            {!result && !loading && (
              <div className="text-center text-gray-500 py-12">
                Select a scenario and click Run to see results
              </div>
            )}

            {loading && (
              <div className="text-center py-12">
                <div className="animate-spin w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full mx-auto mb-4"></div>
                <p className="text-gray-600">Running scenario...</p>
              </div>
            )}

            {result && !loading && (
              <div className="space-y-4">
                {/* Status */}
                <div className={`p-4 rounded-lg ${
                  result.passed
                    ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800'
                    : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
                }`}>
                  <div className="flex items-center gap-2">
                    <span className={`text-2xl ${result.passed ? 'text-green-600' : 'text-red-600'}`}>
                      {result.passed ? '✓' : '✗'}
                    </span>
                    <div>
                      <div className={`font-semibold ${result.passed ? 'text-green-700' : 'text-red-700'}`}>
                        {result.passed ? 'PASSED' : 'FAILED'}
                      </div>
                      <div className="text-sm opacity-70">{result.durationMs}ms</div>
                    </div>
                  </div>
                </div>

                {/* Errors */}
                {result.errors.length > 0 && (
                  <div>
                    <h3 className="font-medium text-red-700 dark:text-red-400 mb-2">
                      Errors ({result.errors.length})
                    </h3>
                    <ul className="space-y-1">
                      {result.errors.map((err, i) => (
                        <li key={i} className="text-sm text-red-600 dark:text-red-400 flex gap-2">
                          <span>•</span>
                          <span>{err}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Warnings */}
                {result.warnings.length > 0 && (
                  <div>
                    <h3 className="font-medium text-yellow-700 dark:text-yellow-400 mb-2">
                      Warnings ({result.warnings.length})
                    </h3>
                    <ul className="space-y-1">
                      {result.warnings.map((warn, i) => (
                        <li key={i} className="text-sm text-yellow-600 dark:text-yellow-400 flex gap-2">
                          <span>•</span>
                          <span>{warn}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Response */}
                {result.response && (
                  <div>
                    <h3 className="font-medium text-gray-900 dark:text-white mb-2">
                      LLM Response
                    </h3>
                    <div className="bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">
                      <p className="text-sm font-mono whitespace-pre-wrap">{result.response}</p>
                    </div>
                  </div>
                )}

                {/* Goal */}
                {selectedScenario && (
                  <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                    <h3 className="font-medium text-gray-900 dark:text-white mb-2">Goal</h3>
                    <p className="text-sm text-gray-600 dark:text-gray-400 italic">
                      "{selectedScenario.goal}"
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
