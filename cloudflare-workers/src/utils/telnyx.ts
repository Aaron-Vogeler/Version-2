/**
 * Telnyx API client utilities
 */

import type { Env } from '../types';

export interface TelnyxCDR {
  id: string;
  call_control_id: string;
  direction: 'incoming' | 'outgoing';
  from: string;
  to: string;
  state: string;
  start_time: string;
  answer_time?: string;
  end_time?: string;
  duration: number;
  billable_duration: number;
  cost?: number;
  recording_urls?: string[];
}

/**
 * Fetch CDRs from Telnyx API with retry logic
 */
export async function fetchTelnyxCDRs(
  env: Env,
  options: {
    startDate: string;
    endDate: string;
    pageSize?: number;
  }
): Promise<TelnyxCDR[]> {
  const { startDate, endDate, pageSize = 100 } = options;

  const url = new URL('https://api.telnyx.com/v2/call_events');
  url.searchParams.set('filter[start_time][gte]', startDate);
  url.searchParams.set('filter[start_time][lte]', endDate);
  url.searchParams.set('page[size]', pageSize.toString());

  const cdrs: TelnyxCDR[] = [];
  let nextPageUrl: string | null = url.toString();

  while (nextPageUrl) {
    const response = await fetchWithRetry(nextPageUrl, {
      headers: {
        'Authorization': `Bearer ${env.TELNYX_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Telnyx API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    cdrs.push(...(data.data || []));

    // Check for next page
    nextPageUrl = data.meta?.next_page_url || null;

    // Limit to prevent infinite loops
    if (cdrs.length >= 1000) {
      console.warn('CDR fetch limit reached (1000)');
      break;
    }
  }

  return cdrs;
}

/**
 * Fetch with exponential backoff retry
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);

      // Don't retry on client errors (4xx), only server errors (5xx) and network errors
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        return response;
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error as Error;
    }

    if (attempt < maxRetries) {
      const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      console.log(`Retry attempt ${attempt + 1} after ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Fetch failed after retries');
}

/**
 * Calculate call cost based on duration and rate
 * This is a simplified calculation - adjust based on your Telnyx pricing
 */
export function calculateCallCost(billableSec: number): number {
  const RATE_PER_MINUTE = 0.01; // $0.01 per minute
  const billableMin = billableSec / 60;
  return Number((billableMin * RATE_PER_MINUTE).toFixed(4));
}
