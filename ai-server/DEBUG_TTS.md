# TTS Audio Quality Debugging Guide

This guide will help you debug audio quality issues with the AI phone agent's Text-to-Speech (TTS) system.

## Overview

The TTS audio pipeline processes speech through several stages:

1. **TTS Synthesis** - OpenAI generates 24kHz PCM audio
2. **Downsampling** - 24kHz → 8kHz with anti-aliasing filter
3. **μ-law Encoding** - 16-bit PCM → 8-bit μ-law (G.711)
4. **Chunking** - Split into 20ms packets
5. **Streaming** - Send to Telnyx WebSocket

## Debug Endpoint

### Test Audio Quality

You can test the TTS audio quality by accessing the debug endpoint:

```bash
# Basic test with default text
curl "http://localhost:3000/debug/tts-8k-wav" > test.wav

# Custom text
curl "http://localhost:3000/debug/tts-8k-wav?text=Hello%20world%20this%20is%20a%20test" > test.wav

# Then play the file
# On macOS:
afplay test.wav

# On Linux:
aplay test.wav

# On Windows:
start test.wav
```

### What the Endpoint Returns

- **Format**: WAV file (RIFF header + PCM data)
- **Sample Rate**: 8000 Hz
- **Channels**: 1 (mono)
- **Bit Depth**: 16-bit PCM
- **Processing**: Full pipeline EXCEPT μ-law encoding (so you hear higher quality)

This lets you hear the audio after downsampling but before μ-law compression, which helps isolate whether the issue is in:
- TTS generation
- Downsampling/filtering
- μ-law encoding
- Streaming/transmission

## Console Debugging Logs

When the AI agent speaks, you'll now see comprehensive debugging logs in the console:

### 1. TTS Synthesis Logs

```
🎤 ========== TTS SYNTHESIS START ==========
📝 Text to synthesize: Hello, how can I help you?
🔧 TTS Model: tts-1
🗣️ TTS Voice: alloy
📤 Calling OpenAI TTS API...
✅ OpenAI API responded in 847 ms
✅ Audio buffer parsed in 12 ms

🔍 ========== TTS PCM ANALYSIS ==========
📊 Buffer Info:
   • Buffer length: 122880 bytes
   • Sample count: 61440
   • Expected duration: 2560.00 ms
   • Sample rate: 24000 Hz (expected)

📈 Amplitude Stats:
   • Min sample: -8234
   • Max sample: 7891
   • Peak range: 16125
   • RMS amplitude: 1245.67
   • Avg amplitude: 876.32
   • Clipped samples: 0 (0.00%)

📊 Distribution Histogram:
   • Near zero (-100 to 100): 12456 (20.3%)
   • Low (-5k to 5k): 45678 (74.4%)
   • Mid (-15k to 15k): 3234 (5.3%)
   • High (±15k+): 72 (0.1%)

⏱️ Total TTS synthesis time: 859 ms
==========================================
```

**What to look for:**
- **RMS amplitude** should be ~1000-3000 (if too low, audio might be quiet)
- **Clipped samples** should be 0% (if high, audio is distorted)
- **High samples** should be <5% (if too many, might indicate noise)

### 2. Downsampling Logs

```
📉 ========== DOWNSAMPLING 24kHz → 8kHz ==========
📊 Input (24kHz):
   • Buffer length: 122880 bytes
   • Sample count: 61440
   • Duration: 2560.00 ms
   • RMS amplitude: 1245.67
   • Peak range: -8234 to 7891
   • First 5 samples: [0, -123, 456, -789, 234]

🔧 Filter Configuration:
   • Filter type: FIR low-pass (Hann-windowed sinc)
   • Number of taps: 63
   • Decimation factor: 3
   • Expected cutoff: 3400 Hz

📊 Output (8kHz):
   • Sample count: 20480
   • Duration: 2560.00 ms
   • RMS amplitude: 1238.45
   • Peak range: -8156 to 7823
   • Clamped samples: 0 (0.00%)
   • First 5 samples: [0, -119, 447, -775, 229]
   • RMS change: 99.4% (should be ~100% if filter preserves level)

✅ Downsampling complete in 23 ms
   • Output buffer length: 40960 bytes
================================================
```

**What to look for:**
- **RMS change** should be ~95-105% (if much lower, losing audio energy)
- **Clamped samples** should be 0% (if high, filter is clipping)
- **Duration** should match input (verifies correct sample rate)

### 3. μ-law Encoding Logs

```
🔄 ========== PCM → μ-LAW ENCODING ==========
📊 Input (16-bit PCM @ 8kHz):
   • Buffer length: 40960 bytes
   • Sample count: 20480
   • Duration: 2560.00 ms
   • RMS amplitude: 1238.45
   • Peak range: -8156 to 7823
   • First 5 samples: [0, -119, 447, -775, 229]

📊 Output (8-bit μ-law):
   • Encoded bytes: 20480
   • Compression ratio: 2.0:1 (16-bit → 8-bit)
   • First 5 encoded bytes: [255, 239, 213, 207, 245]
   • Encoding standard: ITU-T G.711 μ-law

✅ μ-law encoding complete in 5 ms
   • Output buffer length: 20480 bytes
===========================================
```

**What to look for:**
- **Compression ratio** should always be 2.0:1
- **Encoded bytes** should equal PCM sample count

### 4. Chunking Logs

```
🔀 ========== AUDIO CHUNKING ==========
📊 Chunking Configuration:
   • Sample rate: 8000 Hz
   • Chunk duration: 20 ms
   • Chunk size: 160 bytes

📊 Chunking Results:
   • Input buffer size: 20480 bytes
   • Total duration: 2560.00 ms
   • Total chunks: 128
   • Full chunks: 127
   • Last chunk size: 160 bytes (full)
   • Streaming time: 2560 ms (128 × 20ms)
======================================
```

**What to look for:**
- **Chunk size** should always be 160 bytes
- **Streaming time** should match total duration

### 5. Streaming Logs

```
📡 ========== STREAMING TO TELNYX ==========
📊 Streaming Info:
   • Total chunks to send: 128
   • Packet interval: 20 ms
   • Expected streaming duration: 2560 ms
   • WebSocket state: OPEN

📤 Sent 25/128 chunks (19.5%)
📤 Sent 50/128 chunks (39.1%)
📤 Sent 75/128 chunks (58.6%)
📤 Sent 100/128 chunks (78.1%)
📤 Sent 125/128 chunks (97.7%)

✅ Streaming complete!
   • Chunks sent: 128 of 128
   • Actual streaming time: 2567 ms
   • Expected streaming time: 2560 ms
   • Timing accuracy: 100.3%
===========================================
```

**What to look for:**
- **Timing accuracy** should be 95-105% (if much higher, streaming is too slow)
- **WebSocket state** should be OPEN
- **Chunks sent** should equal total chunks

### 6. Overall Pipeline Summary

```
⏱️  ========== PIPELINE TIMING SUMMARY ==========
   • TTS Synthesis: 859 ms
   • Downsampling: 23 ms
   • μ-law Encoding: 5 ms
   • Chunking: 2 ms
   • Streaming: 2567 ms
   • TOTAL PIPELINE: 3456 ms
===============================================
```

**What to look for:**
- **TTS Synthesis** is usually the slowest (500-2000ms)
- **Streaming** time should match audio duration
- **Processing** (downsample + encode + chunk) should be <100ms

## Common Audio Quality Issues

### Issue: Audio sounds "warbly" or distorted

**Possible Causes:**
1. **Aliasing during downsampling** - Check downsampling logs for high RMS change
2. **μ-law quantization** - Use debug endpoint to hear pre-μ-law audio
3. **Clipping** - Check for high percentage of clipped samples

**Debug Steps:**
1. Check TTS PCM analysis for clipped samples
2. Check downsampling RMS change (should be ~100%)
3. Use debug endpoint to isolate pre-μ-law audio quality
4. Compare OpenAI's original quality by testing different models/voices

### Issue: Audio is too quiet

**Possible Causes:**
1. **Low TTS output** - Check RMS amplitude in TTS analysis
2. **Filter attenuation** - Check RMS change in downsampling

**Debug Steps:**
1. Check RMS amplitude in TTS synthesis (should be >1000)
2. Check RMS preservation in downsampling (should be ~100%)
3. Try different OpenAI TTS voices or models

### Issue: Audio has dropouts or gaps

**Possible Causes:**
1. **Streaming timing issues** - Check timing accuracy
2. **WebSocket disconnections** - Check for "Call ended while sending" messages
3. **Network issues** - Check for failed chunk sends

**Debug Steps:**
1. Check streaming timing accuracy (should be close to 100%)
2. Look for warning messages during streaming
3. Monitor WebSocket state throughout streaming

### Issue: Audio has background noise or artifacts

**Possible Causes:**
1. **TTS generation quality** - OpenAI's model may have artifacts
2. **Filter ringing** - FIR filter overshoot
3. **μ-law quantization noise**

**Debug Steps:**
1. Use debug endpoint to isolate whether noise is pre or post μ-law
2. Check histogram distribution in TTS analysis
3. Try different TTS models (tts-1 vs tts-1-hd)

## Advanced Debugging

### Compare Different TTS Models

Edit `/home/user/Version-2/ai-server/src/config.ts` to change:

```typescript
ttsModel: process.env.OPENAI_TTS_MODEL || "tts-1-hd", // Change to tts-1-hd
```

Or set environment variable:
```bash
export OPENAI_TTS_MODEL=tts-1-hd
```

### Adjust Filter Settings

The downsampling filter can be adjusted in `/home/user/Version-2/ai-server/src/pipeline/audio.ts`:

```typescript
const LOWPASS_TAPS = createLowpassTaps({
  cutoffHz: 3400,      // Adjust cutoff frequency (try 3200-3600)
  sampleRate: 24000,
  numTaps: 63,         // Adjust filter length (try 31, 63, 127)
});
```

**Note:** Changing these values requires understanding of DSP. Higher `numTaps` = better quality but slower processing.

### Disable μ-law Encoding (for testing only)

This is NOT recommended for production but can help debug if μ-law is the issue:

In `/home/user/Version-2/ai-server/src/index.ts`, you could temporarily skip μ-law and send 16-bit PCM directly, but Telnyx expects μ-law, so this will likely fail.

## Getting Help

If you're still experiencing audio quality issues after reviewing the logs:

1. **Save the debug logs** - Copy the full console output during a call
2. **Test with debug endpoint** - Save the WAV file from `/debug/tts-8k-wav`
3. **Note specific issues** - Describe exactly what sounds wrong (warble, quiet, distorted, etc.)
4. **Check configuration** - Verify your TTS model, voice, and filter settings

## Configuration Reference

### Environment Variables

```bash
# TTS Configuration
OPENAI_TTS_MODEL=tts-1        # or tts-1-hd for higher quality
OPENAI_TTS_VOICE=alloy        # alloy, echo, fable, onyx, nova, shimmer
OPENAI_API_KEY=sk-...         # Your OpenAI API key

# Server Configuration
PORT=3000                      # Server port
```

### Audio Pipeline Constants

- **Input Sample Rate**: 24000 Hz (from OpenAI)
- **Output Sample Rate**: 8000 Hz (for Telnyx)
- **Decimation Factor**: 3 (24000 / 8000)
- **Filter Type**: 63-tap FIR low-pass, Hann window
- **Cutoff Frequency**: 3400 Hz
- **Encoding**: μ-law (G.711)
- **Packet Size**: 160 bytes (20ms)
- **Bit Depth**: 16-bit PCM → 8-bit μ-law

## Additional Resources

- [OpenAI TTS API Docs](https://platform.openai.com/docs/guides/text-to-speech)
- [G.711 μ-law Specification](https://en.wikipedia.org/wiki/G.711)
- [FIR Filter Design](https://en.wikipedia.org/wiki/Finite_impulse_response)
- [Telnyx Media Streaming](https://developers.telnyx.com/docs/api/v2/call-control/Media-Streaming)
