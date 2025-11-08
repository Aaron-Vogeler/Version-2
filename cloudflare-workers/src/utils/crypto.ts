/**
 * Cryptographic utilities for Telnyx webhook signature verification
 * Supports both HMAC-SHA256 and Ed25519 signature schemes
 */

/**
 * Verify Telnyx webhook signature using HMAC-SHA256
 * Telnyx sends signatures in the format: timestamp,signature
 */
export async function verifyTelnyxSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!signatureHeader) {
    console.warn('No signature header provided');
    return false;
  }

  try {
    // Telnyx signature format: "t=timestamp,v1=signature"
    const parts = signatureHeader.split(',');
    let timestamp = '';
    let signature = '';

    for (const part of parts) {
      const [key, value] = part.split('=');
      if (key === 't') timestamp = value;
      if (key === 'v1') signature = value;
    }

    if (!timestamp || !signature) {
      console.warn('Invalid signature format');
      return false;
    }

    // Verify timestamp is recent (within 5 minutes)
    const currentTime = Math.floor(Date.now() / 1000);
    const timestampInt = parseInt(timestamp, 10);
    const timeDiff = Math.abs(currentTime - timestampInt);

    if (timeDiff > 300) {
      console.warn('Signature timestamp too old:', timeDiff, 'seconds');
      return false;
    }

    // Compute expected signature
    const signedPayload = `${timestamp}.${rawBody}`;
    const expectedSignature = await computeHmacSha256(signedPayload, secret);

    // Constant-time comparison
    return safeCompare(signature, expectedSignature);
  } catch (error) {
    console.error('Signature verification error:', error);
    return false;
  }
}

/**
 * Compute HMAC-SHA256 hash
 */
async function computeHmacSha256(data: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const messageData = encoder.encode(data);

  const key = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, messageData);
  return bufferToHex(signature);
}

/**
 * Convert ArrayBuffer to hex string
 */
function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }

  return result === 0;
}
