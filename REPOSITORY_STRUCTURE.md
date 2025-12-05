# Version-2 Repository Structure

**Last Updated:** December 5, 2025

Multi-tenant AI voice CRM platform. Users create outbound calls with an AI agent that listens, responds, and records conversations.

---

## Tech Stack

| Component | Technology |
|-----------|-----------|
| **Frontend** | Next.js 14, React 18, TypeScript, TailwindCSS, shadcn/ui, Recharts |
| **Auth** | NextAuth.js + Supabase Auth (email/password credentials) |
| **Database** | Supabase PostgreSQL with Row Level Security (RLS) |
| **AI Server** | Express.js + Node.js (WebSocket for Telnyx audio streams) |
| **Speech-to-Text** | Deepgram (nova-2, real-time WebSocket) |
| **LLM** | Groq (llama-3.1-8b-instant, OpenAI-compatible API) |
| **Text-to-Speech** | Telnyx (Kokoro TTS, bm_george voice) |
| **Call Control** | Telnyx API (outbound calls, WebRTC, audio streaming) |
| **Storage** | Supabase Storage (stereo WAV recordings, μ-law encoded) |

---

## Directory Structure

```
/src
  /app                    # Next.js App Router pages
    /(auth)              # Login/signup
    /dashboard           # Main dashboard
    /calls/[id]          # Call details
    /api                 # API routes
  /components
    /dashboard           # Dashboard widgets (calls table, real-time calls, transcripts, analytics)
    /ui                  # shadcn/ui component library
  /lib
    /supabase            # Supabase client setup
    /types               # TypeScript types & database schema

/ai-server
  /src
    index.ts             # WebSocket server for Telnyx audio streams
    config.ts            # Environment & configuration
    /pipeline
      stt.ts             # Deepgram integration
      llm.ts             # Groq LLM + rolling summaries
      tts.ts             # Telnyx TTS
      audio.ts           # Audio processing (downsampling, PCM encoding)
      recording.ts       # Stereo WAV recording
    callContextManager.ts # In-memory call state & transcripts
    /routes
      outbound-call.ts   # Express route to initiate calls
    /utils
      supabase.ts        # Database operations

/supabase
  /migrations            # SQL migrations
    001_initial_schema.sql              # Core tables
    002_ai_assistant_features.sql       # Assistants & transcripts
    003_add_call_control_id.sql         # Telnyx integration
```

---

## Database Schema

**Core Tables:**
- `tenants` - Organization data
- `profiles` - User profiles (email, role: admin/member, custom_assistant_name)
- `calls` - Call records (direction, status, goal, transcript, recording_url, cost)
- `assistants` - AI assistant configs (voice_id, prompt_template, model)
- `call_events` - Granular call event logging
- `notifications` - Alert config (webhook, Slack, email, SMS)
- `billing_summary` - Call cost aggregation

**Multi-tenancy:** Row Level Security (RLS) policies enforce `tenant_id` isolation.

---

## Key API Routes

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/calls` | GET | Fetch calls with filters & pagination |
| `/api/calls/[id]/events` | GET | Call event history |
| `/api/calls/[id]/feedback` | POST | Submit feedback |
| `/api/calls/hangup` | POST | End active call |
| `/api/telnyx/token` | POST | WebRTC token for browser listening |
| `/api/assistants` | GET/POST | Manage assistants |
| `/api/analytics/*` | GET | Goals, performance, billing metrics |
| `/api/stats` | GET | Dashboard statistics |

---

## Call Flow

1. **User initiates call** → Next.js API route triggers `/ai-server/routes/outbound-call.ts`
2. **Telnyx creates call** → Initiates WebRTC connection, streams audio to AI server
3. **AI Server receives audio** → WebSocket connection from Telnyx
4. **Real-time loop:**
   - Deepgram transcribes audio
   - Groq generates LLM response
   - Telnyx synthesizes & speaks response (via Kokoro TTS)
   - Stereo recording captures caller + assistant
5. **Call ends** → Recording saved to Supabase Storage, metrics logged to database

---

## Environment Variables

```
# Supabase
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY

# Telnyx
TELNYX_API_KEY
TELNYX_SIP_CONNECTION_ID
TELNYX_FROM_NUMBER
TELNYX_STREAM_URL
TELNYX_TTS_VOICE_ID

# Deepgram
DEEPGRAM_API_KEY
DEEPGRAM_MODEL

# Groq
GROQ_API_KEY
GROQ_MODEL

# NextAuth
NEXTAUTH_URL
NEXTAUTH_SECRET (min 32 chars)

# App Config
NEXT_PUBLIC_APP_URL
LLM_SYSTEM_PROMPT
CALL_RATE_PER_MINUTE
```

---

## Features

- ✅ Outbound AI voice calls with live transcription
- ✅ Custom AI assistants (voices, prompts, models)
- ✅ Real-time call monitoring & live transcripts
- ✅ Stereo WAV recording (caller + agent)
- ✅ Call analytics (goals, performance, billing)
- ✅ Multi-tenant architecture with RLS
- ✅ Browser listening via Telnyx WebRTC
- ✅ Custom assistant naming per user
