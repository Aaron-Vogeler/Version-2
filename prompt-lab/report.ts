/**
 * Prompt Lab Reporter
 * ====================
 * Generates pass/fail summaries and detailed reports.
 */

import { SuiteResult, ScenarioResult } from './types';

/**
 * Generate a detailed JSON report from suite results.
 */
export function generateReport(result: SuiteResult): object {
  return {
    summary: {
      total: result.total,
      passed: result.passed,
      failed: result.failed,
      skipped: result.skipped,
      passRate: result.total > 0 ? ((result.passed / result.total) * 100).toFixed(1) + '%' : 'N/A',
      durationMs: result.totalDurationMs,
      mode: result.isLiveMode ? 'LIVE' : 'MOCK',
      timestamp: new Date().toISOString(),
    },
    results: result.results.map((r) => ({
      id: r.scenario.id,
      name: r.scenario.name,
      passed: r.passed,
      errors: r.errors,
      warnings: r.warnings,
      durationMs: r.durationMs,
      response: r.response,
    })),
    failures: result.results
      .filter((r) => !r.passed)
      .map((r) => ({
        id: r.scenario.id,
        name: r.scenario.name,
        errors: r.errors,
        goal: r.scenario.goal,
      })),
  };
}

/**
 * Print a summary to the console.
 */
export function printSummary(result: SuiteResult): void {
  console.log('\n' + '='.repeat(60));
  console.log('PROMPT LAB RESULTS');
  console.log('='.repeat(60));
  console.log(`Mode: ${result.isLiveMode ? 'LIVE' : 'MOCK'}`);
  console.log(`Duration: ${result.totalDurationMs}ms`);
  console.log('');
  console.log(`  Total:   ${result.total}`);
  console.log(`  Passed:  ${result.passed}`);
  console.log(`  Failed:  ${result.failed}`);
  console.log(`  Skipped: ${result.skipped}`);
  console.log('');

  if (result.failed > 0) {
    console.log('FAILURES:');
    console.log('-'.repeat(60));

    for (const r of result.results.filter((r) => !r.passed)) {
      console.log(`\n  ${r.scenario.id}`);
      console.log(`  Goal: "${r.scenario.goal}"`);
      for (const error of r.errors) {
        console.log(`    ERROR: ${error}`);
      }
    }

    console.log('');
  }

  const passRate = result.total > 0 ? ((result.passed / result.total) * 100).toFixed(1) : 'N/A';
  console.log(`Pass Rate: ${passRate}%`);
  console.log('='.repeat(60));

  if (result.failed === 0) {
    console.log('\nAll scenarios passed!');
  } else {
    console.log(`\n${result.failed} scenario(s) failed.`);
  }
}

/**
 * Print a single scenario result in detail.
 */
export function printScenarioDetail(result: ScenarioResult): void {
  console.log(`\nScenario: ${result.scenario.id}`);
  console.log(`Name: ${result.scenario.name}`);
  console.log(`Goal: "${result.scenario.goal}"`);
  console.log(`Status: ${result.passed ? 'PASSED' : 'FAILED'}`);
  console.log(`Duration: ${result.durationMs}ms`);

  if (result.errors.length > 0) {
    console.log('\nErrors:');
    for (const error of result.errors) {
      console.log(`  - ${error}`);
    }
  }

  if (result.warnings.length > 0) {
    console.log('\nWarnings:');
    for (const warning of result.warnings) {
      console.log(`  - ${warning}`);
    }
  }

  if (result.response) {
    console.log('\nAssistant Response:');
    console.log(`  "${result.response}"`);
  }

  console.log('\nMessages sent to LLM:');
  for (let i = 0; i < result.messages.length; i++) {
    const msg = result.messages[i];
    const preview =
      msg.content.length > 100
        ? msg.content.substring(0, 100) + '...'
        : msg.content;
    console.log(`  [${i}] ${msg.role}: ${preview.replace(/\n/g, ' ')}`);
  }
}

/**
 * Generate a markdown report.
 */
export function generateMarkdownReport(result: SuiteResult): string {
  const lines: string[] = [];

  lines.push('# Prompt Lab Report');
  lines.push('');
  lines.push(`**Mode:** ${result.isLiveMode ? 'LIVE' : 'MOCK'}`);
  lines.push(`**Date:** ${new Date().toISOString()}`);
  lines.push(`**Duration:** ${result.totalDurationMs}ms`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Total | ${result.total} |`);
  lines.push(`| Passed | ${result.passed} |`);
  lines.push(`| Failed | ${result.failed} |`);
  lines.push(`| Skipped | ${result.skipped} |`);
  lines.push(
    `| Pass Rate | ${result.total > 0 ? ((result.passed / result.total) * 100).toFixed(1) : 'N/A'}% |`
  );
  lines.push('');

  if (result.failed > 0) {
    lines.push('## Failures');
    lines.push('');

    for (const r of result.results.filter((r) => !r.passed)) {
      lines.push(`### ${r.scenario.id}`);
      lines.push('');
      lines.push(`**Goal:** ${r.scenario.goal}`);
      lines.push('');
      lines.push('**Errors:**');
      for (const error of r.errors) {
        lines.push(`- ${error}`);
      }
      lines.push('');
    }
  }

  lines.push('## All Results');
  lines.push('');
  lines.push('| Scenario | Status | Duration |');
  lines.push('|----------|--------|----------|');

  for (const r of result.results) {
    const status = r.passed ? 'PASS' : 'FAIL';
    lines.push(`| ${r.scenario.id} | ${status} | ${r.durationMs}ms |`);
  }

  return lines.join('\n');
}
