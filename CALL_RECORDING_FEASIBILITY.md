# Call Recording Feasibility Analysis
## Self-Hosted Recording vs. Telnyx Call Recording

**Date:** 2025-12-04
**Current Status:** Telnyx call recording is implemented (MP3, dual-channel)
**Proposed Alternative:** Record from Telnyx stream + upload to Supabase Storage

---

## Executive Summary

**Feasibility: HIGH ✅**

Self-hosted call recording from the Telnyx stream is technically feasible and would likely reduce costs. The infrastructure is already in place:
- ✅ Both inbound/outbound audio tracks available via WebSocket
- ✅ Audio codec known (μ-law/PCMU 8kHz)
- ✅ Decoding capability exists
- ✅ Supabase client configured (@supabase/supabase-js installed)
- ✅ Buffering patterns already implemented for transcripts

**Estimated Implementation Time:** 2-3 days
**Cost Savings:** Potentially significant (eliminate per-minute recording fees)

---

## Current Implementation

### Telnyx Call Recording (Active)
**Location:** `ai-server/src/index.ts:572-586`

```typescript
// Start recording on call.answered
await axios.post(
  `https://api.telnyx.com/v2/calls/${callControlId}/actions/record_start`,
  {
    format: "mp3",
    channels: "dual",  // Inbound + outbound
  }
);
```

**Storage:** Recording URL saved via `call.recording.saved` webhook → `calls.recording_url` field

**Telnyx Recording Costs:**
- Per-minute charge for recording
- Dual-channel MP3 format
- Hosted on Telnyx CDN

---

## Proposed Solution: Stream-Based Recording

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Call Flow with Self-Hosted Recording                        │
└─────────────────────────────────────────────────────────────┘

1. Call Answered
   ↓
2. Start Streaming (both_tracks, RTP)
   ↓
3. WebSocket Connection Established
   ↓
4. Audio Packets Arrive
   ├─ INBOUND track (caller)
   │  ├─ Decode base64 → μ-law PCM
   │  ├─ Send to Deepgram (STT) ✅ Already happening
   │  └─ Write to recording buffer 🆕 NEW
   │
   └─ OUTBOUND track (AI assistant)
      ├─ Decode base64 → μ-law PCM
      └─ Write to recording buffer 🆕 NEW

5. During Call
   ├─ Stream audio chunks to recording buffers (in-memory or disk)
   ├─ Continue normal STT/LLM/TTS pipeline
   └─ Optional: write chunks incrementally to temp file

6. Call Ends (hangup)
   ├─ Finalize audio buffers
   ├─ Merge inbound + outbound tracks
   ├─ Encode to WAV/MP3 🆕 NEW
   ├─ Upload to Supabase Storage 🆕 NEW
   └─ Save public URL to calls.recording_url
```

---

## Technical Implementation Details

### 1. Audio Capture

**Current WebSocket Handler:** `ai-server/src/index.ts:1038-1058`

**Modifications Needed:**

```typescript
// Currently only processes inbound
if (msg.event === "media" && msg.media?.payload) {
  const track = msg.media?.track;  // "inbound" or "outbound"
  const audio = Buffer.from(msg.media.payload, "base64");

  // EXISTING: Send inbound to Deepgram
  if (track === "inbound") {
    dgLive.send(audio.buffer.slice(...));
  }

  // NEW: Also buffer both tracks for recording
  if (callContext.recordingBuffers) {
    if (track === "inbound") {
      callContext.recordingBuffers.inbound.push(audio);
    } else if (track === "outbound") {
      callContext.recordingBuffers.outbound.push(audio);
    }
  }
}
```

### 2. Buffer Management

**Add to CallContext:** `ai-server/src/callContextManager.ts`

```typescript
export interface CallContext {
  // Existing fields...

  // NEW: Recording buffers
  recordingBuffers?: {
    inbound: Buffer[];   // Caller audio chunks
    outbound: Buffer[];  // AI audio chunks
    startTime: Date;     // For sync/duration tracking
  };
}
```

**Memory Considerations:**
- 8 kHz μ-law = ~8 KB/second per track
- 10-minute call = ~4.8 MB (both tracks)
- Manageable in-memory for typical call durations

**Alternative: Stream to Disk**
For longer calls, write chunks incrementally to temp files:
```typescript
const inboundFile = fs.createWriteStream(`/tmp/${callId}_inbound.raw`);
const outboundFile = fs.createWriteStream(`/tmp/${callId}_outbound.raw`);
```

### 3. Audio Format Conversion

**Input Format:**
- Codec: μ-law (G.711)
- Sample rate: 8 kHz
- Bit depth: 8-bit compressed
- Channels: Mono (separate inbound/outbound tracks)

**Output Format Options:**

| Format | Pros | Cons | File Size (10 min) |
|--------|------|------|-------------------|
| **WAV (PCM)** | Lossless, simple | Large | ~9.6 MB |
| **WAV (μ-law)** | Simple, no re-encoding | No compression | ~4.8 MB |
| **MP3** | Small, widely supported | Requires encoder | ~1-2 MB |
| **Opus** | Best compression, modern | Less support | ~0.5-1 MB |

**Recommended: WAV (μ-law)** for simplicity
- No transcoding needed (already μ-law)
- Industry-standard format
- ~4.8 MB for 10-minute call

**Implementation:**

```typescript
// Concatenate buffers
const inboundAudio = Buffer.concat(callContext.recordingBuffers.inbound);
const outboundAudio = Buffer.concat(callContext.recordingBuffers.outbound);

// Create dual-channel WAV
const wavFile = createDualChannelWav({
  leftChannel: inboundAudio,   // Caller
  rightChannel: outboundAudio, // AI
  sampleRate: 8000,
  format: 'mulaw',
});
```

**Library Options:**
- `wavefile` (npm) - Simple WAV creation
- `node-wav` - Another option
- Manual WAV header creation (only 44 bytes)

### 4. Supabase Storage Upload

**Storage Setup Needed:**

1. **Create Storage Bucket** (Supabase Dashboard)
   - Bucket name: `call-recordings`
   - Public access: Yes (for playback URLs)
   - File size limit: 100 MB
   - Allowed MIME types: `audio/wav`, `audio/mpeg`

2. **Add Storage SDK Usage**

**Implementation:** `ai-server/src/utils/supabase.ts` (add new function)

```typescript
/**
 * Upload call recording to Supabase Storage
 * @param callId - Call control ID
 * @param audioBuffer - Audio file buffer (WAV/MP3)
 * @param mimeType - MIME type (audio/wav or audio/mpeg)
 * @returns Public URL or error
 */
export async function uploadCallRecording(
  callId: string,
  audioBuffer: Buffer,
  mimeType: string = 'audio/wav'
): Promise<{ success: boolean; url?: string; error?: string }> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return { success: false, error: 'Supabase not configured' };
  }

  const fileName = `${callId}.wav`;
  const filePath = `recordings/${fileName}`;

  try {
    // Upload to storage
    const { data, error } = await supabase.storage
      .from('call-recordings')
      .upload(filePath, audioBuffer, {
        contentType: mimeType,
        upsert: true,  // Overwrite if exists
      });

    if (error) {
      console.error('[Supabase Storage] Upload error:', error);
      return { success: false, error: error.message };
    }

    // Get public URL
    const { data: publicUrlData } = supabase.storage
      .from('call-recordings')
      .getPublicUrl(filePath);

    const publicUrl = publicUrlData.publicUrl;
    console.log(`[Supabase Storage] Recording uploaded: ${publicUrl}`);

    return { success: true, url: publicUrl };
  } catch (error) {
    console.error('[Supabase Storage] Upload exception:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
```

3. **Call on Hangup**

**Location:** `ai-server/src/index.ts` (in `call.hangup` webhook handler)

```typescript
// NEW: Finalize and upload recording
if (callContext.recordingBuffers) {
  const inbound = Buffer.concat(callContext.recordingBuffers.inbound);
  const outbound = Buffer.concat(callContext.recordingBuffers.outbound);

  const wavFile = createDualChannelWav({
    leftChannel: inbound,
    rightChannel: outbound,
    sampleRate: 8000,
    format: 'mulaw',
  });

  const { success, url, error } = await uploadCallRecording(
    callControlId,
    wavFile,
    'audio/wav'
  );

  if (success && url) {
    await updateCall(callControlId, { recording_url: url });
  } else {
    console.error(`[Recording] Upload failed: ${error}`);
  }
}
```

### 5. Track Synchronization

**Challenge:** Inbound and outbound tracks may not be perfectly synchronized

**Solutions:**

1. **Simple Approach:** Assume tracks are aligned
   - Telnyx RTP streams should maintain sync
   - Works well for most use cases

2. **Timestamp-Based Sync (Advanced):**
   ```typescript
   interface AudioChunk {
     buffer: Buffer;
     timestamp: number;  // milliseconds since call start
     track: 'inbound' | 'outbound';
   }
   ```
   - Store timestamps with each chunk
   - Align tracks during finalization
   - More complex, but better sync

**Recommendation:** Start with simple approach; add timestamps if sync issues arise

---

## Cost Comparison

### Telnyx Call Recording (Current)

**Pricing (as of 2024):**
- Call recording: ~$0.005/minute (dual-channel MP3)
- Storage: Included (CDN hosting)

**Example costs:**
- 1,000 calls × 10 minutes = 10,000 minutes
- Cost: 10,000 × $0.005 = **$50/month**

### Self-Hosted Recording (Proposed)

**Costs:**
- Telnyx streaming: Already using for STT (no additional cost)
- Compute: Minimal (buffering + encoding ~1% CPU overhead)
- Supabase Storage: $0.021/GB stored + $0.09/GB bandwidth

**Storage calculation:**
- 1,000 calls × 10 minutes × 4.8 MB/call = 4.8 GB
- Storage: 4.8 GB × $0.021 = **$0.10/month**
- Bandwidth (1 playback per recording): 4.8 GB × $0.09 = **$0.43/month**
- **Total: ~$0.53/month**

**Savings:** $50 - $0.53 = **$49.47/month** (99% cost reduction)

**Break-even point:** Immediate (for any volume)

---

## Implementation Checklist

### Phase 1: Basic Recording (2-3 days)

- [ ] **Add recording buffers to CallContext**
  - `recordingBuffers: { inbound: Buffer[], outbound: Buffer[] }`

- [ ] **Modify WebSocket handler to capture both tracks**
  - Update `msg.event === "media"` handler
  - Buffer both inbound and outbound audio

- [ ] **Implement WAV file creation**
  - Install `wavefile` or similar library
  - Create dual-channel μ-law WAV on call end

- [ ] **Create Supabase Storage bucket**
  - Bucket name: `call-recordings`
  - Enable public access

- [ ] **Implement storage upload function**
  - Add `uploadCallRecording()` to supabase.ts
  - Test upload functionality

- [ ] **Integrate with hangup handler**
  - Finalize recording on call end
  - Upload to Supabase Storage
  - Update `calls.recording_url`

- [ ] **Disable Telnyx recording** (once self-hosted is working)
  - Comment out `record_start` API call
  - Remove `call.recording.saved` webhook handler (optional)

### Phase 2: Optimization (Optional)

- [ ] **Add streaming to disk for long calls**
  - Prevent memory issues for 30+ minute calls

- [ ] **Implement MP3 encoding**
  - Use `fluent-ffmpeg` or `lame` encoder
  - Reduce storage costs further

- [ ] **Add timestamp-based track sync**
  - Improve audio alignment

- [ ] **Add error handling & retry logic**
  - Handle upload failures gracefully
  - Retry failed uploads

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|-----------|
| **Memory usage for long calls** | Medium | Stream to disk instead of buffering |
| **Track synchronization issues** | Low | Add timestamps if needed |
| **Upload failures** | Medium | Implement retry logic + fallback to Telnyx |
| **Storage costs at scale** | Low | Monitor usage; optimize encoding |
| **WAV header complexity** | Low | Use well-tested library (wavefile) |

---

## Recommendation

**Proceed with self-hosted recording** ✅

**Reasoning:**
1. **High feasibility** - All infrastructure exists
2. **Significant cost savings** - 99% reduction at scale
3. **Low risk** - Can keep Telnyx recording as fallback during testing
4. **Simple implementation** - Mostly straightforward buffer management
5. **Already paying for streaming** - No additional Telnyx fees

**Suggested Approach:**
1. Implement self-hosted recording in parallel with Telnyx recording
2. Test thoroughly with various call scenarios
3. Compare audio quality and sync
4. Once confident, disable Telnyx recording
5. Monitor storage costs and optimize encoding if needed

---

## Alternative: Hybrid Approach

**Option:** Keep Telnyx recording as fallback

```typescript
// Try self-hosted first, fall back to Telnyx if upload fails
const { success, url } = await uploadCallRecording(callId, wavFile);

if (success) {
  await updateCall(callId, { recording_url: url, recording_source: 'self-hosted' });
} else {
  // Fallback: Telnyx recording URL will be saved via webhook
  console.warn('[Recording] Self-hosted upload failed, using Telnyx recording');
}
```

**Benefits:**
- Safety net during transition
- Handles edge cases (very long calls, upload failures)
- Minimal additional cost (only for failed cases)

---

## Next Steps

1. **Decide on approach:**
   - Pure self-hosted (recommended)
   - Hybrid with Telnyx fallback

2. **Set up Supabase Storage bucket**

3. **Implement Phase 1 checklist**

4. **Test with various call scenarios:**
   - Short calls (< 1 minute)
   - Normal calls (5-10 minutes)
   - Long calls (20+ minutes)
   - Barge-in scenarios
   - Network interruptions

5. **Monitor & optimize:**
   - Storage costs
   - Upload reliability
   - Audio quality/sync

---

## Appendix: Code References

**Key Files to Modify:**

1. **`ai-server/src/index.ts`**
   - Line 1038-1058: WebSocket media handler (add buffering)
   - Line 590-595: Stream start (already configured for both_tracks)
   - Call hangup handler: Add recording finalization

2. **`ai-server/src/callContextManager.ts`**
   - Add `recordingBuffers` field to CallContext interface

3. **`ai-server/src/utils/supabase.ts`**
   - Add `uploadCallRecording()` function

4. **`ai-server/package.json`**
   - Add dependency: `"wavefile": "^11.0.0"` (or similar)

**Existing Capabilities to Leverage:**

- μ-law decoding: `decodeMulawG711()` at line 468 (if needed)
- Buffer management pattern: Transcript buffering (line 916-960)
- Supabase client: Already configured and tested
- Audio utilities: `ai-server/src/pipeline/audio.ts` (if needed)
