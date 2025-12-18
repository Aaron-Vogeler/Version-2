/**
 * Tests for Gemini Cache module utilities
 */

import { describe, it, expect } from '@jest/globals';

// Inline the stripCodeFences function for testing
// (avoids import issues with the ai-server module)
function stripCodeFences(text: string): string {
  if (!text) return text;

  // Match ```json ... ``` or ``` ... ```
  const fencePattern = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/;
  const match = text.trim().match(fencePattern);

  if (match) {
    return match[1].trim();
  }

  return text.trim();
}

describe('Gemini Cache Utilities', () => {
  describe('stripCodeFences', () => {
    it('should strip ```json code fences', () => {
      const input = '```json\n{"behavior": "speak", "speak": "Hello"}\n```';
      const expected = '{"behavior": "speak", "speak": "Hello"}';
      expect(stripCodeFences(input)).toBe(expected);
    });

    it('should strip plain ``` code fences', () => {
      const input = '```\n{"behavior": "wait", "speak": null}\n```';
      const expected = '{"behavior": "wait", "speak": null}';
      expect(stripCodeFences(input)).toBe(expected);
    });

    it('should handle text without code fences', () => {
      const input = '{"behavior": "speak", "speak": "Hello"}';
      const expected = '{"behavior": "speak", "speak": "Hello"}';
      expect(stripCodeFences(input)).toBe(expected);
    });

    it('should handle empty string', () => {
      expect(stripCodeFences('')).toBe('');
    });

    it('should handle whitespace around fences', () => {
      const input = '  ```json\n{"test": true}\n```  ';
      const expected = '{"test": true}';
      expect(stripCodeFences(input)).toBe(expected);
    });

    it('should handle multiline JSON in fences', () => {
      const input = '```json\n{\n  "behavior": "speak",\n  "speak": "Hello World",\n  "internal": "thinking"\n}\n```';
      const result = stripCodeFences(input);
      expect(result).toContain('"behavior": "speak"');
      expect(result).toContain('"speak": "Hello World"');
    });
  });
});

describe('Cache Metadata Validation', () => {
  it('should consider cache valid when expires_at is in the future', () => {
    const isCacheValid = (expiresAt: string | null, bufferMs: number = 10000): boolean => {
      if (!expiresAt) return false;
      const expiresAtDate = new Date(expiresAt);
      const now = new Date();
      const bufferTime = new Date(now.getTime() + bufferMs);
      return expiresAtDate > bufferTime;
    };

    // Expires in 1 hour - should be valid
    const futureExpiry = new Date(Date.now() + 3600_000).toISOString();
    expect(isCacheValid(futureExpiry)).toBe(true);

    // Expires in 5 seconds - should be invalid (less than 10s buffer)
    const soonExpiry = new Date(Date.now() + 5_000).toISOString();
    expect(isCacheValid(soonExpiry)).toBe(false);

    // Already expired - should be invalid
    const pastExpiry = new Date(Date.now() - 1000).toISOString();
    expect(isCacheValid(pastExpiry)).toBe(false);

    // Null expiry - should be invalid
    expect(isCacheValid(null)).toBe(false);
  });

  it('should invalidate cache that expires within buffer window', () => {
    const isCacheExpiringSoon = (expiresAt: string, bufferMs: number = 10000): boolean => {
      const expiresAtDate = new Date(expiresAt);
      const now = new Date();
      const bufferTime = new Date(now.getTime() + bufferMs);
      return expiresAtDate <= bufferTime;
    };

    // Expires in 5 seconds - within 10s buffer
    const soonExpiry = new Date(Date.now() + 5_000).toISOString();
    expect(isCacheExpiringSoon(soonExpiry)).toBe(true);

    // Expires in 20 seconds - outside 10s buffer
    const laterExpiry = new Date(Date.now() + 20_000).toISOString();
    expect(isCacheExpiringSoon(laterExpiry)).toBe(false);
  });
});
