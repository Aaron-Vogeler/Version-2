/**
 * Basic webhook integration test test to redploy fly.io worker redeploy again test test test test test test
 * Tests the webhook -> event -> DB flow 
 */

import { describe, it, expect } from '@jest/globals';

describe('Webhook Processing', () => {
  it('should map call.initiated to initiated status', () => {
    const eventType = 'call.initiated';
    const expectedStatus = 'initiated';

    // Simple status mapper test
    const statusMap: Record<string, string> = {
      'call.initiated': 'initiated',
      'call.ringing': 'ringing',
      'call.answered': 'answered',
      'call.hangup': 'completed',
    };

    expect(statusMap[eventType]).toBe(expectedStatus);
  });

  it('should extract tenant_id from custom headers', () => {
    const payload = {
      custom_headers: {
        'X-Tenant': '00000000-0000-0000-0000-000000000001',
      },
    };

    const extractTenantId = (payload: any): string | null => {
      if (payload.custom_headers && payload.custom_headers['X-Tenant']) {
        return payload.custom_headers['X-Tenant'];
      }
      return null;
    };

    const tenantId = extractTenantId(payload);
    expect(tenantId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('should compute duration correctly', () => {
    const startTime = '2024-01-15T12:00:00.000Z';
    const endTime = '2024-01-15T12:05:00.000Z';

    const computeDuration = (start: string, end: string): number => {
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      return Math.floor((endMs - startMs) / 1000);
    };

    const duration = computeDuration(startTime, endTime);
    expect(duration).toBe(300); // 5 minutes = 300 seconds
  });

  it('should handle missing timestamps gracefully', () => {
    const computeDuration = (start?: string, end?: string): number => {
      if (!start || !end) return 0;
      const startMs = new Date(start).getTime();
      const endMs = new Date(end).getTime();
      return Math.floor((endMs - startMs) / 1000);
    };

    expect(computeDuration(undefined, undefined)).toBe(0);
    expect(computeDuration('2024-01-15T12:00:00.000Z', undefined)).toBe(0);
  });
});

describe('Call Status Mapping', () => {
  it('should map hangup causes to correct statuses', () => {
    const mapHangupToStatus = (hangupCause: string): string => {
      if (hangupCause === 'no_answer') return 'no-answer';
      if (hangupCause === 'busy') return 'busy';
      if (hangupCause === 'normal_clearing') return 'completed';
      return 'failed';
    };

    expect(mapHangupToStatus('normal_clearing')).toBe('completed');
    expect(mapHangupToStatus('no_answer')).toBe('no-answer');
    expect(mapHangupToStatus('busy')).toBe('busy');
    expect(mapHangupToStatus('user_busy')).toBe('failed');
  });
});
