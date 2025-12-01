# Version-2 Repository Structure & Architecture Documentation

**Generated:** December 1, 2025
**Repository Location:** `/home/user/Version-2`
**Current Branch:** `claude/document-repo-structure-01UxT6LJiGGW9KodSrBfZDph`

---

## Table of Contents

1. [High-Level Overview](#high-level-overview)
2. [Applications & Services](#applications--services)
3. [External Services & Integrations](#external-services--integrations)
4. [AI Server (Fly.io Backend) Deep Dive](#ai-server-flyio-backend-deep-dive)
5. [Call Flow (Step-by-Step)](#call-flow-step-by-step)
6. [Multi-Tenancy & Data Scoping](#multi-tenancy--data-scoping)
7. [Data Model (Supabase)](#data-model-supabase)
8. [Configuration & Secrets](#configuration--secrets)
9. [Current AI Pipeline](#current-ai-pipeline)
10. [Architecture Strengths](#architecture-strengths)
11. [Architecture Risks & Complexity Hotspots](#architecture-risks--complexity-hotspots)
12. [Questions for Aaron / Follow-up](#questions-for-aaron--follow-up)

---

## High-Level Overview

**Version-2** is a multi-tenant voice AI CRM platform that leverages:

- **Telnyx** for programmatic voice control and WebRTC
- **Deepgram** for real-time speech-to-text (STT)
- **Groq** for fast LLM inference
- **OpenAI** for text-to-speech (TTS)
- **Supabase** for PostgreSQL database and RLS-based multi-tenancy
- **Cloudflare Workers** for edge-based webhook processing and scheduled jobs
- **Fly.io** for the AI voice server (Node.js with Express)
- **Next.js** for the dashboard and user-facing UI

### Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        User/Dashboard                             │
│              (Next.js 14 App Router + NextAuth)                  │
└──────────────────┬──────────────────────────────────────────────┘
                   │
          ┌────────┴──────────┐
          │                   │
    ┌─────▼────────┐   ┌──────▼─────────┐
    │  Next.js API │   │   Delegate to  │
    │   Routes     │   │  AI Server     │
    │ (Dashboard)  │   │  (Outbound)    │
    └──────────────┘   └──────┬─────────┘
          │                   │
          │            ┌──────▼──────────────┐
          │            │                     │
    ┌─────▼──────┐  ┌──▼────────────────┐  │
    │ Supabase   │  │  Fly.io AI Server │  │
    │ PostgreSQL │  │  (Node.js/Express)│  │
    │   + RLS    │  │  + WebSocket      │  │
    └────────────┘  └──┬──────┬────┬────┘  │
          ▲            │      │    │       │
          │   ┌────────┘      │    │       │
          │   │        ┌──────▼┐   │       │
          │   │        │Deepgram│  │       │
          │   │        │ (STT)  │  │       │
          │   │        └────────┘  │       │
          │   │                    │       │
          │   │        ┌───────────▼─┐    │
          │   │        │  Groq (LLM) │    │
          │   │        └─────────────┘    │
          │   │                           │
          │   │        ┌──────────────┐   │
          │   │        │OpenAI (TTS)  │   │
          │   │        └──────────────┘   │
          │   │                           │
          │   │     ┌──────────────────┐  │
          │   └────▶│  Telnyx API      │◀─┘
          │         │  (Call Control)  │
          │         └──────┬───────────┘
          │                │
          │      ┌─────────┴─────────────┐
          │      │                       │
    ┌─────┴──────▼──┐         ┌──────────▼─────┐
    │ Cloudflare    │         │   Telnyx       │
    │ Workers       │         │   Webhooks     │
    │ - Webhook     │◀────────│   (call.*      │
    │ - Queue       │         │    events)     │
    │ - Scheduled   │         └────────────────┘
    │   Job (CDR)   │
    └───────────────┘
```

### High-Level Technology Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | Next.js 14, TypeScript, TailwindCSS, shadcn/ui, Recharts |
| **Auth** | NextAuth.js + Supabase Auth (email/password) |
| **Database** | Supabase (PostgreSQL) with RLS policies |
| **Real-time** | Supabase WebSockets for dashboard updates |
| **Voice** | Telnyx (SIP, WebRTC, Call Control API) |
| **STT** | Deepgram (nova-2 model) |
| **LLM** | Groq (llama-3.1-8b-instant) |
| **TTS** | OpenAI (tts-1 model) |
| **Edge/Webhooks** | Cloudflare Workers + Queues + KV + Crons |
| **Voice Server** | Node.js + Express + WebSocket on Fly.io |

---

## Applications & Services

### 1. Next.js Frontend Application

**Location:** `/home/user/Version-2` (root)
**Type:** Full-Stack Web Application (Frontend + API Routes)
**Framework:** Next.js 14 (App Router + Pages Router for APIs)
**Language:** TypeScript
**Port:** 3000 (dev), deployed to Vercel

#### Main Entry Points

- **App Router Root:** `/src/app/layout.tsx` - Root layout with auth provider
- **Home Page:** `/src/app/page.tsx` - Landing page
- **Dashboard:** `/src/app/dashboard/page.tsx` - Main CRM dashboard
- **Login:** `/src/app/(auth)/login/page.tsx` - Authentication form
- **NextAuth Config:** `/pages/api/auth/[...nextauth].ts` - Auth handler
- **Call Detail:** `/src/app/calls/[id]/page.tsx` - Single call view

#### Responsibilities

- **User Authentication** - Email/password via NextAuth + Supabase
- **Multi-tenant Dashboard** - Real-time call monitoring, analytics, KPIs
- **Call Management** - Initiate calls, hangup, view transcripts, submit feedback
- **Analytics & Reporting** - Goal performance, billing, assistant metrics, call trends
- **WebRTC Listening** - Browser-based call listening with Telnyx SDK
- **Real-time Updates** - WebSocket subscriptions to calls and events tables

#### Key Components

```
src/
├── app/
│   ├── layout.tsx                 # Root with providers (Auth, Supabase)
│   ├── page.tsx                   # Landing page
│   ├── globals.css                # Tailwind + global styles
│   ├── middleware.ts              # Auth middleware redirect to /login
│   ├── dashboard/
│   │   └── page.tsx              # Main dashboard (stats, tables, charts)
│   ├── calls/
│   │   └── [id]/page.tsx         # Call detail view with transcript
│   ├── (auth)/
│   │   ├── login/page.tsx
│   │   └── signup/page.tsx
│   └── api/
│       ├── calls/
│       │   ├── route.ts           # GET /api/calls (list + filter)
│       │   ├── [id]/
│       │   │   ├── events/route.ts # Call event timeline
│       │   │   └── feedback/route.ts # Post call feedback
│       │   └── hangup/route.ts     # POST to hangup active call
│       ├── assistants/route.ts    # Assistant list (future)
│       ├── stats/route.ts         # Dashboard KPIs
│       ├── analytics/
│       │   ├── goals/route.ts     # Goal achievement analytics
│       │   ├── assistants/route.ts # Assistant performance
│       │   └── billing/route.ts    # Billing breakdown
│       └── telnyx/
│           └── token/route.ts     # WebRTC SIP token generation
├── components/
│   ├── dashboard/
│   │   ├── calls-table.tsx        # Real-time calls list
│   │   ├── delegate-call.tsx      # Form to initiate calls
│   │   ├── call-detail-modal.tsx  # Expanded call view
│   │   ├── assistant-performance.tsx
│   │   ├── billing-usage.tsx
│   │   ├── calls-chart.tsx
│   │   ├── filter-bar.tsx
│   │   ├── goal-analytics.tsx
│   │   ├── listen-in-browser.tsx  # WebRTC listening
│   │   ├── live-transcript.tsx
│   │   ├── real-time-calls-table.tsx
│   │   └── stat-card.tsx
│   ├── ui/
│   │   ├── badge.tsx, button.tsx, card.tsx, dialog.tsx
│   │   ├── input.tsx, label.tsx, select.tsx, table.tsx
│   │   ├── tabs.tsx, textarea.tsx
│   │   └── (shadcn/ui components)
│   └── providers.tsx              # Context providers (Auth, Supabase)
└── lib/
    ├── supabase/
    │   ├── client.ts              # Client-side Supabase instance
    │   ├── server.ts              # Server-side Supabase (service role)
    │   └── middleware.ts          # Auth middleware
    ├── types/
    │   └── database.ts            # Type definitions from Supabase schema
    └── utils.ts                   # Utilities (formatting, etc.)
```

#### Package.json Dependencies

- `next@^14.0.0` - Framework
- `typescript` - Language
- `react`, `react-dom` - UI
- `next-auth@^4` - Authentication
- `@supabase/supabase-js@^2.39` - Database client
- `@supabase/auth-helpers-nextjs` - Auth integration
- `recharts` - Charts for analytics
- `@telnyx/webrtc` - WebRTC SDK
- `tailwindcss` - Styling
- `axios` - HTTP client

---

### 2. Cloudflare Workers (Edge Functions)

**Location:** `/home/user/Version-2/cloudflare-workers`
**Type:** Serverless Edge Functions
**Framework:** Cloudflare Workers (TypeScript/JavaScript)
**Language:** TypeScript
**Configuration:** `wrangler.toml`
**Deployment:** `wrangler deploy` from directory

#### Main Entry Point

**File:** `/cloudflare-workers/src/index.ts` - Main router
**Pattern:** HTTP handler + Queue consumer + Scheduled job

#### Routes & Handlers

| Route | Method | Handler | Purpose |
|-------|--------|---------|---------|
| `POST /start-call` | POST | `handleStartCall()` | Initiate outbound call (from dashboard or external) |
| `POST /telnyx/webhook` | POST | `handleWebhook()` | Receive Telnyx webhook events |
| `GET /health` | GET | Inline | Health check |
| **Queue:** `TELNYX_EVENTS` | — | `processEventBatch()` | Async event processing |
| **Cron:** (scheduled) | — | `runScheduledJob()` | CDR backfill every N minutes |

#### Responsibilities

1. **Webhook Reception & Validation**
   - Receives Telnyx events (`call.initiated`, `call.answered`, `call.hangup`, etc.)
   - Validates HMAC-SHA256 signatures (prevents spoofing)
   - Checks idempotency (prevents duplicate processing)
   - Extracts tenant/user context from client_state or custom headers
   - Enqueues to Cloudflare Queue for async processing

2. **Async Event Processing**
   - Normalizes Telnyx events to standard format
   - Upserts `call` and `call_events` records in Supabase
   - Maps event types to call status updates
   - Extracts metrics (duration, cost, etc.)
   - Handles out-of-order events gracefully

3. **Scheduled CDR Reconciliation**
   - Runs every 15-30 minutes (configured in wrangler.toml)
   - Fetches CDRs from Telnyx API (last 2 hours)
   - Calculates costs ($0.01/min hardcoded)
   - Upserts missing call records
   - Closes stale active calls (>1 hour with no update)

4. **Call Initiation (from Worker)**
   - Alternative to `/api/delegate` (Next.js)
   - Initiates Telnyx call directly from worker
   - Creates Supabase record atomically
   - Used for external integrations or scheduled campaigns

#### File Structure

```
cloudflare-workers/
├── src/
│   ├── index.ts                 # Main HTTP/Queue/Cron handler
│   ├── webhook-handler.ts       # Telnyx webhook receiver
│   ├── queue-consumer.ts        # Event processing logic
│   ├── scheduled-job.ts         # CDR reconciliation + cleanup
│   ├── start-call-handler.ts    # Call initiation handler
│   ├── types.ts                 # TypeScript interfaces
│   └── utils/
│       ├── crypto.ts            # HMAC-SHA256 verification
│       ├── supabase.ts          # Supabase DB operations
│       └── telnyx.ts            # Telnyx API utilities
├── wrangler.toml               # Configuration (KV, Queues, Crons, Secrets)
├── package.json
├── tsconfig.json
└── README.md
```

#### Configuration (wrangler.toml)

```toml
name = "version-2-workers"
main = "src/index.ts"
compatibility_date = "2024-01-01"

# Environment Variables (public)
[vars]
FROM_NUMBER = "+12062079439"
MONITOR_NUMBER = "+12767735173"
CALL_CONTROL_APP_ID = "your-id"
SUPABASE_URL = "https://xxxx.supabase.co"
DEFAULT_USER_ID = "default-uuid"

# Secrets (private, set with `wrangler secret put`)
# SUPABASE_SERVICE_KEY
# TELNYX_API_KEY
# TELNYX_SIGNING_SECRET

# KV Namespace (for idempotency)
[[kv_namespaces]]
binding = "IDEMPOTENCY"
id = "your-kv-namespace-id"

# Queue (for async event processing)
[[queues.producers]]
binding = "TELNYX_EVENTS"

[[queues.consumers]]
queue = "TELNYX_EVENTS"
max_batch_size = 100
max_batch_timeout = 30
max_retries = 3
dead_letter_queue = "failed-events"

# Scheduled Job (CDR backfill)
[triggers]
crons = ["0 */15 * * * *"]  # Every 15 minutes
```

#### Technology Stack

- `@cloudflare/workers-types` - TypeScript types
- `wrangler` - Cloudflare CLI
- `@supabase/supabase-js` - Database client
- `axios` - HTTP requests
- `typescript` - Language

---

### 3. AI Voice Server (Fly.io Backend)

**Location:** `/home/user/Version-2/ai-server`
**Type:** Backend WebSocket/REST Server
**Framework:** Express.js with TypeScript
**Language:** TypeScript
**Runtime:** Node.js 20
**Port:** 8080 (internal), exposed as `https://version-2-cr4fsa.fly.dev`
**Deployment:** Fly.io (via GitHub Actions on main branch push)

#### Main Entry Point

**File:** `/ai-server/src/index.ts` (269 lines)
**Exports:**
- Express HTTP app with 3 endpoints
- WebSocket server for real-time audio
- Service initializations (Deepgram, Groq, OpenAI, Telnyx)

#### HTTP Endpoints

| Path | Method | Purpose | Auth | External Calls |
|------|--------|---------|------|-----------------|
| `/health` | GET | Health check | None | None |
| `/api/outbound-call` | POST | Initiate outbound call | None | Telnyx API |
| `/webhooks/telnyx` | POST | Receive call.answered webhook | None | Telnyx API (streaming_start) |

#### WebSocket Endpoint

- **URL:** `wss://version-2-cr4fsa.fly.dev` (no path)
- **Established:** By Telnyx after `streaming_start` API call
- **Audio Format:** Telnyx sends mulaw (u-law) at 8kHz, server sends downsampled PCM
- **Lifecycle:** Opened when call answered → Closed when call ends or client disconnects

#### Processing Pipeline

**For each user utterance:**

```
1. AUDIO INPUT (Telnyx WebSocket)
   ├─ Telnyx sends: {event: "media", media: {payload: "base64-mulaw"}}
   └─ Decode: Buffer.from(payload, "base64")

2. SPEECH-TO-TEXT (Deepgram)
   ├─ Send audio: dgLive.send(audioBuffer)
   └─ Receive: Transcript event with text

3. LANGUAGE MODEL (Groq)
   ├─ Prompt: User text → "You are a helpful voice assistant."
   └─ Response: AI-generated reply text

4. TEXT-TO-SPEECH (OpenAI)
   ├─ Model: tts-1, Voice: alloy
   ├─ Input: AI response text
   └─ Output: 24kHz PCM audio buffer

5. AUDIO DOWNSAMPLING
   ├─ OpenAI: 24kHz PCM (16-bit signed integers)
   └─ Telnyx: 8kHz PCM (takes every 3rd sample)

6. AUDIO OUTPUT (Telnyx WebSocket)
   ├─ Encode: base64(8kHz audio)
   └─ Send: {event: "playback", payload: {type: "media", payload: "base64", ...}}
```

#### File Structure

```
ai-server/
├── src/
│   ├── index.ts                 # Main Express + WebSocket server
│   │                            # - Initializes services
│   │                            # - Defines endpoints
│   │                            # - Implements audio pipeline
│   └── routes/
│       └── outbound-call.ts     # POST /api/outbound-call handler
├── Dockerfile                  # Multi-stage build (node:20-slim)
├── fly.toml                    # Fly.io deployment config
├── package.json                # Dependencies
├── tsconfig.json               # TypeScript config
├── .env.example                # Environment variables
└── README.md
```

#### Key Functions in index.ts

| Function | Lines | Purpose |
|----------|-------|---------|
| `downsample24kHzTo8kHz(pcmBuffer)` | 11-22 | Convert audio sample rate |
| Express route handler for `/health` | 65 | Return "Alive" |
| Express route handler for `/api/outbound-call` | 68 | Delegate to routes/outbound-call.ts |
| Express route handler for `/webhooks/telnyx` | 71-99 | Receive call.answered, call streaming_start |
| WebSocket connection handler | 104-116 | Initialize Deepgram stream, setup listeners |
| Deepgram transcript handler | 119-228 | Process transcripts → LLM → TTS → send audio |
| WebSocket message handler | 233-255 | Receive audio from Telnyx, send to Deepgram |
| WebSocket close handler | 257-260 | Cleanup on disconnect |

#### Technology Stack

- `express` - HTTP server
- `ws` - WebSocket library
- `@deepgram/sdk` - Speech-to-text
- `openai` - TTS (using as http client for Groq too)
- `axios` - HTTP requests
- `dotenv` - Environment variables
- `typescript` - Language

---

### 4. Supabase Database

**Location:** `/home/user/Version-2/supabase`
**Type:** PostgreSQL Database with Migrations
**Configuration:** Migrations stored as SQL files
**Deployment:** Supabase CLI

#### Migration Files

| File | Purpose |
|------|---------|
| `/supabase/migrations/001_initial_schema.sql` | Core tables: tenants, profiles, calls, call_events |
| `/supabase/migrations/002_ai_assistant_features.sql` | AI features: assistants, notifications, billing |
| `/supabase/migrations/003_add_call_control_id.sql` | Add call_control_id column for call management |

#### Key Tables

**TENANTS** - Multi-tenant organizations
```sql
id UUID PRIMARY KEY
name TEXT
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

**PROFILES** - User profiles (extends auth.users)
```sql
user_id UUID PRIMARY KEY → auth.users
tenant_id UUID → tenants
role TEXT (admin | member)
full_name TEXT
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

**CALLS** - Call records with metrics
```sql
id TEXT PRIMARY KEY (Telnyx call_control_id)
tenant_id UUID → tenants
call_control_id TEXT (for hangup operations)
direction TEXT (inbound | outbound)
from_e164 TEXT
to_e164 TEXT
status TEXT (initiated | ringing | answered | completed | failed | busy | no-answer)
started_at TIMESTAMPTZ
answered_at TIMESTAMPTZ
ended_at TIMESTAMPTZ
duration_sec INTEGER
billable_sec INTEGER
cost_usd NUMERIC(10, 4)
goal TEXT (e.g., "sales", "support")
goal_status TEXT (achieved | failed | pending)
assistant_id TEXT
assistant_name TEXT
transcript TEXT
transcript_url TEXT
transcript_status TEXT (pending | processing | completed | failed | none)
recording_url TEXT
user_feedback BOOLEAN
feedback_comment TEXT
feedback_at TIMESTAMPTZ
response_time_ms INTEGER (LLM latency)
tags TEXT[]
metadata JSONB
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

**CALL_EVENTS** - Event timeline for each call
```sql
id TEXT PRIMARY KEY (Telnyx event_id)
call_id TEXT → calls (ON DELETE CASCADE)
tenant_id UUID → tenants (ON DELETE CASCADE)
type TEXT (call.initiated | call.answered | call.hangup | etc.)
occurred_at TIMESTAMPTZ
payload JSONB (full Telnyx webhook payload)
created_at TIMESTAMPTZ
```

**ASSISTANTS** - AI assistant configurations
```sql
id TEXT PRIMARY KEY
tenant_id UUID → tenants
name TEXT
description TEXT
voice_id TEXT
prompt_template TEXT (system prompt for Groq)
is_active BOOLEAN
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

**NOTIFICATION_RULES** - Trigger configurations
```sql
id UUID PRIMARY KEY
tenant_id UUID → tenants
name TEXT
event TEXT (goal_success | goal_failure | call_completed)
type TEXT (webhook | slack | email | sms)
recipient TEXT
is_active BOOLEAN
config JSONB
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
```

**BILLING_SUMMARY** - Monthly billing aggregates
```sql
id UUID PRIMARY KEY
tenant_id UUID → tenants
period_start DATE
period_end DATE
total_calls INTEGER
total_minutes NUMERIC(10, 2)
total_cost_usd NUMERIC(10, 4)
breakdown JSONB (by assistant, goal, etc.)
created_at TIMESTAMPTZ
updated_at TIMESTAMPTZ
UNIQUE (tenant_id, period_start, period_end)
```

#### Security Features

- **Row-Level Security (RLS)** - Policies enforce user/tenant isolation
- **Service Role Key** - Used by backend to bypass RLS for system operations
- **Anon Key** - Used by frontend with RLS enforcement
- **Auth Integration** - Built-in user management with email/password

---

## External Services & Integrations

### 1. Telnyx (Voice & Call Control)

**Purpose:** Programmable voice calling, SIP connection management, WebRTC, Call Control API

#### Where It's Used

| Component | Files | Purpose |
|-----------|-------|---------|
| **Dashboard** | `/src/components/dashboard/listen-in-browser.tsx` | Browser WebRTC listening |
| **Next.js** | `/pages/api/telnyx/token/route.ts` | Generate WebRTC SIP tokens |
| **Next.js** | `/src/app/api/calls/hangup/route.ts` | Hangup active call |
| **Next.js** | `/pages/api/delegate.ts` | Proxy outbound call to ai-server |
| **AI Server** | `/ai-server/src/routes/outbound-call.ts` | Initiate outbound call (POST /v2/calls) |
| **AI Server** | `/ai-server/src/index.ts` | Receive webhooks, start streaming, send audio |
| **Workers** | `/cloudflare-workers/src/start-call-handler.ts` | Alternative call initiation |
| **Workers** | `/cloudflare-workers/src/webhook-handler.ts` | Receive webhooks |
| **Workers** | `/cloudflare-workers/src/scheduled-job.ts` | Fetch CDRs for reconciliation |

#### API Endpoints Called

| Endpoint | Method | Purpose | Location |
|----------|--------|---------|----------|
| `https://api.telnyx.com/v2/calls` | POST | Initiate outbound call | `outbound-call.ts:44`, `start-call-handler.ts` |
| `https://api.telnyx.com/v2/calls/{id}/actions/streaming_start` | POST | Start WebSocket stream | `index.ts:80` (ai-server webhook handler) |
| `https://api.telnyx.com/v2/calls/{id}/actions/hangup` | POST | End active call | `/api/calls/hangup:route.ts` |
| `https://api.telnyx.com/v2/telephony_credentials/{id}/token` | POST | Generate WebRTC token | `/api/telnyx/token/route.ts` |
| `https://api.telnyx.com/v2/call_events` | GET | Fetch CDRs | `scheduled-job.ts:75` |

#### Webhook Flow

1. **Call Answer:** Telnyx sends `call.answered` event to `POST /telnyx/webhook` (Cloudflare Worker)
2. **Event Processing:** Worker validates signature, enqueues to `TELNYX_EVENTS` queue
3. **Queue Consumer:** Processes event, updates Supabase `calls` and `call_events` tables
4. **Stream Start:** AI server's webhook handler receives event and calls `streaming_start` API
5. **WebSocket:** Telnyx opens persistent WebSocket to `wss://version-2-cr4fsa.fly.dev`

#### Configuration

**Environment Variables:**
- `TELNYX_API_KEY` - Bearer token for API calls
- `TELNYX_SIGNING_SECRET` - Webhook signature validation (currently unused)
- `TELNYX_SIP_CONNECTION_ID` - SIP connection for routing
- `NEXT_PUBLIC_MONITOR_NUMBER` - Default from number for monitoring

**Hardcoded Values:**
- From number: `"+12767735173"` (ai-server outbound-call.ts:36)
- Stream URL: `"wss://version-2-cr4fsa.fly.dev"` (ai-server index.ts:82)

**Cost:** $0.01/min (hardcoded in workers/utils/telnyx.ts)

---

### 2. Deepgram (Speech-to-Text)

**Purpose:** Real-time speech transcription (STT) from Telnyx audio stream

**Where It's Used:**
- `/ai-server/src/index.ts:108-109` - Initialize live transcription session
- Lines 119-228 - Transcript event handler, forwards to Groq

**API Usage:**
- **Model:** `nova-2` (latest Deepgram model)
- **Method:** WebSocket live transcription (streaming)
- **Input Format:** mulaw (u-law) codec, 8000 Hz, mono
- **Latency:** Sub-second (100ms endpointing for silence detection)

**Integration Flow:**
```typescript
const dgLive = await deepgram.listen.live({
  model: "nova-2",
  encoding: "mulaw",
  sample_rate: 8000,
  channels: 1,
  endpointing: 100  // Stop transcription after 100ms silence
})

dgLive.on(LiveTranscriptionEvents.Transcript, (event) => {
  const transcript = event.channel.alternatives[0].transcript;
  // Process transcript → Groq LLM
})

// When Telnyx sends audio:
ws.on("message", (raw) => {
  if (media) {
    dgLive.send(Buffer.from(media.payload, "base64"));
  }
})
```

**Environment Variable:**
- `DEEPGRAM_API_KEY` - API key from console.deepgram.com

---

### 3. Groq (Large Language Model)

**Purpose:** Fast LLM inference for conversational AI responses

**Where It's Used:**
- `/ai-server/src/index.ts:46-49` - Initialize Groq client
- Lines 135-151 - LLM inference on transcripts

**API Usage:**
- **Model:** `llama-3.1-8b-instant`
- **Method:** OpenAI-compatible API (baseURL: `https://api.groq.com/openai/v1`)
- **System Prompt:** `"You are a helpful voice assistant."` (hardcoded)
- **Latency:** Typically <500ms

**Integration Flow:**
```typescript
const groq = new OpenAI({
  apiKey: GROQ_KEY,
  baseURL: "https://api.groq.com/openai/v1"
})

const response = await groq.chat.completions.create({
  model: "llama-3.1-8b-instant",
  messages: [
    { role: "system", content: "You are a helpful voice assistant." },
    { role: "user", content: transcript }  // From Deepgram
  ]
})

const aiText = response.choices[0]?.message?.content;
// Send to OpenAI TTS
```

**Environment Variable:**
- `GROQ_API_KEY` - API key from console.groq.com

---

### 4. OpenAI (Text-to-Speech)

**Purpose:** Convert AI response text to spoken audio

**Where It's Used:**
- `/ai-server/src/index.ts:51-53` - Initialize OpenAI client
- Lines 173-196 - TTS synthesis and downsampling

**API Usage:**
- **Model:** `tts-1` (fast synthesis, lower latency)
- **Voice:** `alloy` (one of 6 available voices)
- **Input:** Text from Groq (typically 20-200 characters)
- **Output Format:** PCM (raw audio)
- **Sample Rate:** 24 kHz (24000 Hz), 16-bit signed integers
- **Latency:** 1-3 seconds

**Integration Flow:**
```typescript
const audioResponse = await openai.audio.speech.create({
  model: "tts-1",
  voice: "alloy",
  input: aiText,  // From Groq
  response_format: "pcm"
})

const audioBuffer = await audioResponse.arrayBuffer();

// Downsample 24kHz → 8kHz for Telnyx compatibility
const downsampled = downsample24kHzTo8kHz(Buffer.from(audioBuffer));

// Send to Telnyx
```

**Downsampling Logic** (index.ts:11-22):
```typescript
function downsample24kHzTo8kHz(pcmBuffer: Buffer): Buffer {
  // 24kHz → 8kHz (take every 3rd sample)
  const samples = pcmBuffer.length / 2;  // 16-bit samples
  const result = [];
  for (let i = 0; i < samples; i += 3) {
    result.push(
      pcmBuffer.readInt16LE(i * 2)
    );
  }
  return Buffer.from(Int16Array.from(result).buffer);
}
```

**Environment Variable:**
- `OPENAI_API_KEY` - API key from platform.openai.com

---

### 5. Supabase (Database & Auth)

**Purpose:** PostgreSQL database with RLS, user authentication, real-time WebSockets

**Where It's Used:**
- **Next.js Frontend** - `/src/lib/supabase/client.ts` (client auth)
- **Next.js NextAuth** - `/pages/api/auth/[...nextauth].ts` (login validation)
- **Next.js API Routes** - All `/api/*` routes query Supabase for calls/events/analytics
- **AI Server** - Installed but not currently used (ready for future call logging)
- **Cloudflare Workers** - `utils/supabase.ts` (upsert calls, events from webhooks)

**Key Operations:**

**From Next.js:**
```typescript
// Client-side (anon key, with RLS)
const calls = await supabase
  .from('calls')
  .select('*')
  .eq('user_id', user.id)
  .order('started_at', { ascending: false })
  .limit(100);

// Real-time subscription
const channel = supabase
  .channel('realtime-calls')
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'calls'
  }, (payload) => {
    // Handle new/updated/deleted calls
  })
  .subscribe();
```

**From Cloudflare Workers:**
```typescript
// Service role key (bypasses RLS)
const supabase = createClient(URL, SERVICE_KEY);

await supabase.from('call_events').upsert(event, {
  onConflict: 'id',
  ignoreDuplicates: true
});

await supabase.from('calls').upsert(callData, {
  onConflict: 'id'
});
```

**Environment Variables:**
- `NEXT_PUBLIC_SUPABASE_URL` - Project URL (public)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` - Anonymous key (public, with RLS)
- `SUPABASE_SERVICE_ROLE_KEY` - Admin key (secret, bypasses RLS)

---

### 6. Other Services & Tools

#### NextAuth.js (Authentication)

**Purpose:** Session management, JWT tokens, login/logout

**Files:** `/pages/api/auth/[...nextauth].ts`

**Features:**
- Credentials provider (email/password)
- Integrates with Supabase Auth backend
- JWT strategy (no server-side sessions)
- 30-day max age

#### Vercel (Deployment)

**Purpose:** Host Next.js frontend

**Configuration:** `vercel.json` (if present) or GitHub integration

#### Fly.io (Deployment)

**Purpose:** Host Node.js AI server

**Configuration:** `/ai-server/fly.toml`

**Specs:**
- App: `version-2-cr4fsa`
- Region: `iad` (US East)
- Port: 8080 (internal)
- Memory: 1GB shared CPU
- Auto-scaling: 0-N machines

#### GitHub Actions (CI/CD)

**File:** `/.github/workflows/deploy-ai-server.yml`

**Trigger:** Push to `main` branch

**Job:** Deploy ai-server to Fly.io using `flyctl`

---

## AI Server (Fly.io Backend) Deep Dive

### Complete File Analysis

#### Main Index File: `/ai-server/src/index.ts`

**Total Lines:** 269
**Purpose:** Main Express server + WebSocket handler + Audio pipeline

**Key Variables & Initialization (Lines 24-53):**

```typescript
const DG_API_KEY = process.env.DEEPGRAM_API_KEY;
const GROQ_KEY = process.env.GROQ_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;
const TELNYX_API_KEY = process.env.TELNYX_API_KEY;

// Validation (throws if missing)
if (!DG_API_KEY) throw new Error("Missing DEEPGRAM_API_KEY");
if (!GROQ_KEY) throw new Error("Missing GROQ_API_KEY");
if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!TELNYX_API_KEY) throw new Error("Missing TELNYX_API_KEY");

// Service clients
const deepgram = createClient(DG_API_KEY);

const groq = new OpenAI({
  apiKey: GROQ_KEY,
  baseURL: "https://api.groq.com/openai/v1"
});

const openai = new OpenAI({
  apiKey: OPENAI_KEY
});
```

**Server Initialization (Lines 55-62):**

```typescript
const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.text({ type: 'text/*' }));
```

#### HTTP Routes

**GET /health (Lines 65-66)**
```typescript
app.get("/health", (_, res) => res.status(200).send("Alive"))
```

**POST /api/outbound-call (Lines 68-70)**
```typescript
app.use("/api/outbound-call", outboundCallRouter);
```
Delegates to `/routes/outbound-call.ts`

**POST /webhooks/telnyx (Lines 71-99)**
```typescript
app.post("/webhooks/telnyx", async (req, res) => {
  const body = req.body;
  const eventType = body.type;  // e.g., "call.answered"

  if (eventType === "call.answered") {
    const { call_control_id } = body;

    // Call Telnyx streaming_start API
    const response = await axios.post(
      `https://api.telnyx.com/v2/calls/${call_control_id}/actions/streaming_start`,
      {
        stream_url: "wss://version-2-cr4fsa.fly.dev",
        stream_track: "inbound_track"
      },
      {
        headers: {
          Authorization: `Bearer ${TELNYX_API_KEY}`
        }
      }
    );
  }

  res.send("ok");
});
```

#### WebSocket Handler

**Connection (Lines 104-116)**
```typescript
wss.on("connection", async (ws) => {
  console.log("🔌 Telnyx WebSocket Connected");

  const dgLive = await deepgram.listen.live({
    model: "nova-2",
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    endpointing: 100
  });

  // Setup event listeners...
});
```

**Message Handler (Lines 233-255)**
```typescript
ws.on("message", (raw) => {
  try {
    const message = JSON.parse(raw.toString());

    if (message.event === "media") {
      const { payload } = message.media;
      const audio = Buffer.from(payload, "base64");
      dgLive.send(audio.buffer);
    } else if (message.event === "start") {
      console.log("🎬 Call started");
    } else if (message.event === "stop") {
      console.log("🛑 Call ended");
    }
  } catch (error) {
    console.error("❌ Error parsing message:", error);
  }
});
```

**Close Handler (Lines 257-260)**
```typescript
ws.on("close", () => {
  console.log("🔌 Client disconnected");
  dgLive.finish();
});
```

**Error Handler (Lines 262-267)**
```typescript
ws.on("error", (error) => {
  console.error("❌ WebSocket error:", error);
});
```

#### Audio Processing Pipeline

**Deepgram Transcript Handler (Lines 119-228)**
```typescript
dgLive.on(LiveTranscriptionEvents.Transcript, async (dgEvent) => {
  // Step 1: Extract transcript
  const userText = dgEvent.channel.alternatives[0]?.transcript || "";

  if (!userText) {
    console.log("⏭️ Skipping empty transcript");
    return;
  }

  console.log(`🗣️ User: ${userText}`);

  // Step 2: LLM inference
  let groqResp, aiText;
  try {
    groqResp = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: "You are a helpful voice assistant." },
        { role: "user", content: userText }
      ]
    });
    aiText = groqResp.choices[0]?.message?.content || "I didn't understand that.";
    console.log(`🤖 AI: ${aiText}`);
  } catch (groqError) {
    console.error("❌ Groq error:", groqError);
    ws.send(JSON.stringify({
      event: "error",
      message: "LLM processing failed"
    }));
    return;
  }

  // Step 3: TTS synthesis
  let audioResponse;
  try {
    audioResponse = await openai.audio.speech.create({
      model: "tts-1",
      voice: "alloy",
      input: aiText,
      response_format: "pcm"
    });
    console.log("🔊 Synthesized audio");
  } catch (ttsError) {
    console.error("❌ OpenAI error:", ttsError);
    ws.send(JSON.stringify({
      event: "error",
      message: "TTS synthesis failed"
    }));
    return;
  }

  // Step 4: Downsample & send
  const audioBuffer = Buffer.from(await audioResponse.arrayBuffer());
  const downsampled = downsample24kHzTo8kHz(audioBuffer);

  const base64Audio = downsampled.toString("base64");
  ws.send(JSON.stringify({
    event: "playback",
    payload: {
      type: "media",
      payload: base64Audio,
      encoding: "pcm",
      sample_rate: 8000
    }
  }));

  console.log("📤 Sent audio to Telnyx");
});
```

#### Downsampling Function

**Function (Lines 11-22):**
```typescript
function downsample24kHzTo8kHz(pcmBuffer: Buffer): Buffer {
  // Input: 24kHz PCM (16-bit signed integers)
  // Output: 8kHz PCM (every 3rd sample)

  const inputSamples = pcmBuffer.length / 2;
  const outputSamples = Math.ceil(inputSamples / 3);

  const result = new Int16Array(outputSamples);
  let outIdx = 0;

  for (let i = 0; i < inputSamples; i += 3) {
    result[outIdx++] = pcmBuffer.readInt16LE(i * 2);
  }

  return Buffer.from(result.buffer);
}
```

#### Outbound Call Route: `/routes/outbound-call.ts`

**Total Lines:** 84

**Interfaces (Lines 1-21):**
```typescript
interface OutboundCallRequest {
  goal: string;        // Business goal (e.g., "sales", "support")
  toNumber: string;    // Destination phone (E.164 format preferred)
  userId: string;      // User ID from NextAuth
}

interface TelnyxCallResponse {
  data: {
    id: string;        // Telnyx call_control_id
    [key: string]: any;
  };
}
```

**Handler (Lines 23-81):**
```typescript
router.post("/", async (req: Request, res: Response) => {
  try {
    const { goal, toNumber, userId } = req.body as OutboundCallRequest;

    // Validation
    if (!goal || !toNumber || !userId) {
      return res.status(400).json({
        status: "error",
        message: "Missing required fields: goal, toNumber, userId"
      });
    }

    // Encode client_state (metadata for webhooks)
    const clientState = {
      goal,
      userId,
      initiatedAt: new Date().toISOString()
    };
    const encodedState = Buffer.from(
      JSON.stringify(clientState)
    ).toString("base64");

    // Call Telnyx API
    const response = await axios.post<TelnyxCallResponse>(
      "https://api.telnyx.com/v2/calls",
      {
        connection_id: process.env.TELNYX_SIP_CONNECTION_ID,
        to: toNumber,
        from: "+12767735173",  // HARDCODED
        client_state: encodedState
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.TELNYX_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const callControlId = response.data.data.id;

    return res.status(201).json({
      status: "outbound_call_created",
      call_control_id: callControlId
    });
  } catch (error) {
    console.error("Error initiating call:", error);
    return res.status(500).json({
      status: "error",
      message: error.message
    });
  }
});
```

### HTTP/WebSocket Endpoints Summary

| Endpoint | Type | Auth | Purpose | Calls |
|----------|------|------|---------|-------|
| `/health` | HTTP GET | None | Health check | None |
| `/api/outbound-call` | HTTP POST | None | Start outbound call | Telnyx API |
| `/webhooks/telnyx` | HTTP POST | None | Receive call.answered | Telnyx streaming_start |
| `wss://...` | WebSocket | None | Audio streaming | Deepgram, Groq, OpenAI |

### Telnyx Webhook Integration

**How Telnyx Communicates with AI Server:**

1. **Call Creation:** Next.js calls `POST /api/delegate` → Fly.io `/api/outbound-call`
2. **Telnyx Initiates:** AI server calls Telnyx `POST /v2/calls` → returns `call_control_id`
3. **User Answers:** Telnyx sends `call.answered` webhook event to `POST /webhooks/telnyx`
4. **AI Server Response:** Receives webhook, calls Telnyx `POST /v2/calls/{id}/actions/streaming_start`
5. **Streaming Begins:** Telnyx opens WebSocket connection to `wss://version-2-cr4fsa.fly.dev`
6. **Audio Loop:** Telnyx sends mulaw audio → AI processes (STT → LLM → TTS) → sends PCM back

**Webhook Signature Validation:** Currently NOT implemented (security gap)

### Supabase Integration Status

**Current State:** Installed but NOT actively used in ai-server

**In package.json:**
```json
"@supabase/supabase-js": "^2.39.0"
```

**No imports or usage in src/**

**Future Integration Points:**
- Insert call record on outbound call creation
- Log call events as Telnyx webhooks arrive
- Query assistants for prompt templates
- Update call transcript after Deepgram processes
- Track call metrics and costs
- Trigger notifications on goal achievement

---

## Call Flow (Step-by-Step)

### Complete Call Lifecycle: Outbound Call

```
STEP 1: USER INITIATES CALL FROM DASHBOARD
├─ Location: /src/components/dashboard/delegate-call.tsx
├─ User enters: {goal, phone_number}
├─ Requires: NextAuth session with user_id
└─ Action: POST /pages/api/delegate

STEP 2: NEXT.JS DELEGATE ENDPOINT
├─ Location: /pages/api/delegate.ts
├─ Verifies: NextAuth session (throws 401 if missing)
├─ Extracts: userId from session
├─ Constructs: {goal, toNumber, userId}
└─ Action: POST to https://version-2-cr4fsa.fly.dev/api/outbound-call

STEP 3: AI SERVER RECEIVES CALL REQUEST
├─ Location: /ai-server/src/routes/outbound-call.ts
├─ Validates: goal, toNumber, userId present
├─ Encodes: client_state = base64({goal, userId, initiatedAt})
├─ Payload: {
│   connection_id: TELNYX_SIP_CONNECTION_ID,
│   to: toNumber,
│   from: "+12767735173",
│   client_state: encoded_metadata
│ }
└─ Action: POST https://api.telnyx.com/v2/calls

STEP 4: TELNYX ACCEPTS CALL
├─ Telnyx assigns: call_control_id
├─ Telnyx initiates: SIP INVITE to phone number
├─ Status: "initiated" in Telnyx system
└─ Response: {data: {id: call_control_id}}

STEP 5: AI SERVER RECEIVES TELNYX RESPONSE
├─ Location: /ai-server/src/routes/outbound-call.ts
├─ Extracts: call_control_id
└─ Returns: {status: "outbound_call_created", call_control_id}

STEP 6: DASHBOARD RECEIVES CONFIRMATION
├─ User sees: "Call initiated" + call_control_id
├─ Optional: Subscribe to call updates via Realtime
└─ Waiting for: call.answered webhook

STEP 7: PHONE RINGS + USER ANSWERS
├─ Device: Receives incoming call (SIP)
├─ User: Presses answer
└─ Telnyx Status: "answered"

STEP 8: TELNYX WEBHOOK: CALL.ANSWERED
├─ Event Type: call.answered
├─ Payload: {
│   call_control_id: "...",
│   type: "call.answered",
│   data: {...}
│ }
├─ Destination: Two paths (see architecture):
│   ├─ Path A: Direct to Fly.io /webhooks/telnyx (if configured)
│   └─ Path B: To Cloudflare Workers webhook handler (likely, based on workers code)
└─ Timestamp: Real-time

STEP 9A: DIRECT WEBHOOK (Fly.io /webhooks/telnyx)
├─ Location: /ai-server/src/index.ts:71-99
├─ Validates: call.answered event type
├─ Extracts: call_control_id
├─ Call: POST /v2/calls/{call_control_id}/actions/streaming_start
│   {
│     stream_url: "wss://version-2-cr4fsa.fly.dev",
│     stream_track: "inbound_track"
│   }
├─ Action: Telnyx opens WebSocket to Fly.io
└─ Response: "ok" (200)

STEP 9B: CLOUDFLARE WORKERS WEBHOOK (Alternative)
├─ Location: /cloudflare-workers/src/webhook-handler.ts
├─ Validates: HMAC-SHA256 signature
├─ Extracts: call_control_id, tenant_id from client_state
├─ Checks: Idempotency (KV store, event_id)
├─ Action: Enqueue to TELNYX_EVENTS queue
└─ Response: "200 ok" (fast, async)

STEP 10: QUEUE CONSUMER (if workers path)
├─ Location: /cloudflare-workers/src/queue-consumer.ts
├─ Receives: Normalized event from queue
├─ Extracts: call_control_id, user_id, etc.
├─ Actions:
│   ├─ Upsert to Supabase: call_events {id, call_id, type, payload}
│   ├─ Upsert to Supabase: calls {status: "answered", answered_at}
│   └─ Eventually: Publish realtime update (placeholder)
└─ Success: message.ack() (remove from queue)

STEP 11: WEBSOCKET CONNECTION ESTABLISHED
├─ Initiator: Telnyx (from streaming_start API)
├─ Server: Fly.io WebSocket handler (index.ts:104-116)
├─ Audio Direction: Bidirectional
├─ Format Received: mulaw, 8kHz, mono
├─ Format Sent: PCM, 8kHz, mono
└─ State: Deepgram live transcription started

STEP 12: DEEPGRAM LISTENING
├─ Location: /ai-server/src/index.ts:108-109 (in ws.on("connection"))
├─ Model: nova-2
├─ Encoding: mulaw
├─ Sample Rate: 8000 Hz
├─ Endpointing: 100ms silence timeout
├─ Status: "Listening for speech..."
└─ Waiting: First user utterance

STEP 13: USER SPEAKS (INCOMING AUDIO)
├─ Device: Microphone captures audio
├─ Telnyx: Sends via WebSocket: {event: "media", media: {payload: "base64"}}
├─ AI Server: Receives in ws.on("message") handler (line 233)
├─ Decode: Buffer.from(payload, "base64")
└─ Forward: dgLive.send(audioBuffer)

STEP 14: DEEPGRAM TRANSCRIBES
├─ Processing: Streaming STT (not waiting for silence)
├─ Output: Transcript event when confidence > threshold OR silence detected
├─ Example: User says "What time is it?"
├─ Deepgram: Sends transcript → "What time is it?"
└─ Confidence: Typically >0.9 for clear speech

STEP 15: AI SERVER RECEIVES TRANSCRIPT
├─ Handler: dgLive.on(LiveTranscriptionEvents.Transcript, ...) [line 119]
├─ Extract: userText = "What time is it?"
├─ Log: 🗣️ User: What time is it?
├─ Validate: Skip if empty
└─ Next: Send to Groq LLM

STEP 16: GROQ LLM INFERENCE
├─ Location: /ai-server/src/index.ts:135-151
├─ Request: POST https://api.groq.com/openai/v1/chat/completions
├─ Payload: {
│   model: "llama-3.1-8b-instant",
│   messages: [
│     {role: "system", content: "You are a helpful voice assistant."},
│     {role: "user", content: "What time is it?"}
│   ]
│ }
├─ Processing: <500ms typically
├─ Response: "It is 2:30 PM."
├─ Log: 🤖 AI: It is 2:30 PM.
└─ Error Handling: Send WebSocket error event if Groq fails

STEP 17: OPENAI TEXT-TO-SPEECH
├─ Location: /ai-server/src/index.ts:173-196
├─ Request: POST https://api.openai.com/v1/audio/speech
├─ Payload: {
│   model: "tts-1",
│   voice: "alloy",
│   input: "It is 2:30 PM.",
│   response_format: "pcm"
│ }
├─ Processing: 1-3 seconds
├─ Output: 24kHz PCM audio (16-bit signed integers)
├─ Log: 🔊 Synthesized audio
└─ Error Handling: Send WebSocket error event if OpenAI fails

STEP 18: AUDIO DOWNSAMPLING
├─ Location: /ai-server/src/index.ts:11-22
├─ Input: 24kHz PCM buffer (from OpenAI)
├─ Algorithm: Take every 3rd sample
├─ Output: 8kHz PCM buffer (compatible with Telnyx)
└─ Size Reduction: 1/3 of original

STEP 19: SEND AUDIO BACK TO TELNYX
├─ Location: /ai-server/src/index.ts:196-207
├─ Encode: base64(downsampled_audio)
├─ WebSocket Message: {
│   event: "playback",
│   payload: {
│     type: "media",
│     payload: "base64_audio",
│     encoding: "pcm",
│     sample_rate: 8000
│   }
│ }
├─ Send: ws.send(JSON.stringify(...))
└─ Log: 📤 Sent audio to Telnyx

STEP 20: TELNYX PLAYS AUDIO
├─ Telnyx: Receives WebSocket message
├─ Decode: base64 → PCM audio
├─ Device: Speaker plays "It is 2:30 PM."
├─ User: Hears AI response
└─ Duration: ~1 second

STEP 21: LOOP (IF CALL CONTINUES)
├─ Scenario: User speaks again
├─ Repeat: Steps 13-20
├─ Deepgram: Transcribes new speech
├─ Groq: Generates new response
├─ OpenAI: Synthesizes new audio
├─ Telnyx: Plays new response
└─ Looping: Until user hangs up

STEP 22: CALL ENDS (USER HANGS UP)
├─ Device: User ends call (presses hang up)
├─ Telnyx Status: "completed"
├─ WebSocket: Telnyx sends {event: "stop"}
├─ AI Server: ws.on("close") handler triggers [line 257]
├─ Cleanup: dgLive.finish()
└─ Connection: Closed

STEP 23: TELNYX WEBHOOK: CALL.HANGUP
├─ Event Type: call.hangup
├─ Payload: {
│   call_control_id: "...",
│   type: "call.hangup",
│   data: {
│     state: "completed",
│     start_time: "...",
│     answer_time: "...",
│     end_time: "...",
│     duration: 45,  // seconds
│     billable_duration: 40  // seconds (answer to hangup)
│   }
│ }
├─ Destination: Cloudflare Workers webhook (or Fly.io /webhooks/telnyx)
└─ Timestamp: Real-time

STEP 24: SUPABASE CALL RECORD UPDATED
├─ Location: /cloudflare-workers/src/queue-consumer.ts (if workers path)
├─ Upsert: calls {
│   id: call_control_id,
│   status: "completed",
│   ended_at: ISO_TIMESTAMP,
│   duration_sec: 45,
│   billable_sec: 40,
│   cost_usd: 0.0067  // 40sec / 60 * 0.01
│ }
├─ Insert: call_events {
│   id: event_id,
│   call_id: call_control_id,
│   type: "call.hangup",
│   payload: {full Telnyx payload}
│ }
└─ RLS: Data scoped to user_id

STEP 25: REALTIME NOTIFICATION
├─ Supabase: Database change triggers realtime broadcast
├─ Dashboard: Realtime subscription receives update
├─ Component: RealTimeCallsTable updates local state
├─ UI: Call moves from "answered" → "completed"
├─ Animation: Row highlights, status updates
└─ User Sees: Call completed, duration, cost calculated

STEP 26: CDR RECONCILIATION (Scheduled Job)
├─ Frequency: Every 15-30 minutes
├─ Location: /cloudflare-workers/src/scheduled-job.ts
├─ Action: Fetch CDRs from Telnyx API (last 2 hours)
├─ Reconcile: Compare CDR cost with Supabase record
├─ Update: If cost missing or incorrect, insert from CDR
└─ Result: Final billing data verified

STEP 27: BILLING FINALIZED
├─ Source: CDR from Telnyx (authoritative)
├─ Supabase: calls.cost_usd updated
├─ Period: Monthly billing summary computed
├─ Dashboard: Billing analytics updated
└─ Visible: User sees final call cost in reports
```

### Summary: End-to-End Call Flow Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                      OUTBOUND CALL SEQUENCE                         │
└────────────────────────────────────────────────────────────────────┘

DASHBOARD                          AI SERVER                      TELNYX
  │                                  │                             │
  ├─ User clicks "Call" ────────────▶│                             │
  │  {goal, phone}                   │                             │
  │                                  ├─ POST /v2/calls ──────────▶│
  │                                  │                             │
  │                                  │◀───── call_control_id ─────┤
  │                                  │                             │
  │                    ┌─────────────┴────────────────────────────┤
  │                    │ Call initiating... (ringing)             │
  │                    └─────────────┬────────────────────────────┤
  │                                  │                             │
  │                                  │     User answers phone       │
  │                                  │◀─ call.answered webhook ────┤
  │                                  │                             │
  │                                  ├─ streaming_start API ──────▶│
  │                                  │                             │
  │                                  │◀─ WebSocket open ──────────┤
  │                                  │                             │
  │                    Audio Loop (repeating) ◀─────────────────────┐
  │                    ├─ Telnyx audio ──────────────────────────┐ │
  │                    │  (mulaw 8kHz)                            │ │
  │                    ├─ Deepgram STT ──────────────────────────┐ │
  │                    │  (nova-2 model)                          │ │
  │                    ├─ Groq LLM ──────────────────────────────┐ │
  │                    │  (llama-3.1-8b-instant)                 │ │
  │                    ├─ OpenAI TTS ────────────────────────────┐ │
  │                    │  (tts-1, 24kHz)                         │ │
  │                    ├─ Downsample 24kHz → 8kHz ──────────────┐ │
  │                    └─ WebSocket back to Telnyx ─────────────┴─┘
  │                      (PCM 8kHz)                  │
  │                                                  │
  │     Realtime                                     │
  │ ┌─ Supabase update ◀─ User speaks/AI responds ─┘
  │ │   (call status)
  │ ├─ Dashboard notified
  │ └─ UI updates with transcript
  │
  │                                                  │
  │                          User hangs up          │
  │                          call.hangup event      ▼
  │                                          TELNYX
  │
  │ Supabase update ◀─────────────────────────────┘
  │ ├─ status: "completed"
  │ ├─ duration, cost
  │ └─ Dashboard shows final metrics
  │
  └────────────────────────────────────────────────────────────────────
```

---

## Multi-Tenancy & Data Scoping

### Current Architecture

**Design Pattern:** Single-tenant-per-user

**Assumption:** `user_id` === `tenant_id`

### Tenant ID Flow Through System

```
NextAuth Session
├─ session.user.id = "user-uuid"
├─ No explicit tenant_id in JWT

Next.js API Routes
├─ Extract userId from session
├─ Query: calls.user_id = userId
└─ Implicit: Assumes userId maps to single tenant

Supabase API (auth)
├─ User ID from auth.users table
├─ Profiles table links user_id → tenant_id
└─ Currently: 1:1 mapping (not enforced at schema level)

Cloudflare Workers
├─ Extract tenant_id from Telnyx client_state
├─ Store in calls and call_events tables
├─ No multi-user-per-tenant support yet
```

### Data Isolation Mechanisms

#### 1. NextAuth-based Routes

**Routes:** `/api/calls`, `/api/analytics/billing`

```typescript
const session = await getServerSession(authOptions);
const userId = (session?.user as any)?.id;

if (!userId) {
  return new Response("Unauthorized", { status: 401 });
}

const calls = await supabase
  .from('calls')
  .select('*')
  .eq('user_id', userId);  // Scoped by user_id
```

**Scoping:** `.eq('user_id', userId)` on all queries

**Security Level:** High (auth check + database filter)

#### 2. Supabase Auth Routes

**Routes:** `/api/calls/[id]/events`, `/api/stats`, `/api/analytics/goals`

```typescript
const user = await supabase.auth.getUser();

const calls = await supabase
  .from('calls')
  .select('*')
  .eq('user_id', user.id);  // Scoped by user_id
```

**Scoping:** `.eq('user_id', user.id)` on all queries

**Security Level:** High (auth check + database filter)

#### 3. Realtime Subscriptions

**Component:** `/src/components/dashboard/real-time-calls-table.tsx`

```typescript
const channel = supabase
  .channel('realtime-calls-table')
  .on('postgres_changes', {
    event: '*',  // All events (INSERT, UPDATE, DELETE)
    schema: 'public',
    table: 'calls'
  }, handlePayload)
  .subscribe();
```

**Scoping:** **No WHERE clause at subscription level**

**Security Dependency:** **Supabase RLS policies must enforce user isolation**

**Risk:** If RLS disabled or misconfigured:
- User receives updates for ALL calls in org
- Not just their own calls

**Mitigation:** Check `/supabase/migrations/001_initial_schema.sql` for:
```sql
CREATE POLICY "Users can view own calls"
  ON public.calls
  USING (auth.uid()::text = user_id);
```

#### 4. Cloudflare Workers

**Isolation:** Relies on Supabase RLS when upserting

```typescript
const supabase = createClient(url, SERVICE_KEY);  // Bypasses RLS

await supabase.from('calls').upsert(callData, {
  onConflict: 'id'
});
```

**Service Role Key:** Bypasses RLS, can write any data

**Risk:** If tenant_id incorrect or missing:
- Data written to wrong tenant
- Billing affects wrong user
- Data visible to wrong user (via RLS filter on read)

**Mitigation:** Verify tenant_id extracted correctly from Telnyx webhooks

### Potential Data Leak Vectors

#### 1. Realtime Subscription (Unfiltered)
- **Risk:** Client subscribes to all calls, RLS missing/broken
- **Impact:** User sees all calls in org
- **Fix:** Add WHERE clause to subscription or verify RLS enabled
- **Current Status:** Partially mitigated by RLS (if present)

#### 2. Telnyx Token Endpoint (Unauthenticated)
- **Risk:** Anyone can call `POST /api/telnyx/token` without auth
- **Impact:** Generate WebRTC credentials without authorization
- **Fix:** Require NextAuth session
- **Current Status:** **Unmitigated security gap**

#### 3. Start Call Endpoint (Unauthenticated Workers)
- **Risk:** `/start-call` worker accepts any user_id without validation
- **Impact:** Attackers create calls on behalf of any user
- **Fix:** Validate JWT token, verify user_id matches
- **Current Status:** **Unmitigated security gap**

#### 4. Hangup Endpoint (No Rate Limiting)
- **Risk:** `/api/calls/hangup` allows unlimited hangup calls
- **Impact:** Could hang up calls belonging to other users (if ACL broken)
- **Fix:** Verify call ownership before hangup
- **Current Status:** Partially mitigated (requires NextAuth, checks call exists)

#### 5. CDR Reconciliation (Tenant ID Resolution)
- **Risk:** CDRs may not include tenant_id, lookup incomplete
- **Impact:** Billing data missing or assigned to wrong user
- **Fix:** Always pass tenant_id in Telnyx metadata
- **Current Status:** Known issue, partially addressed

### Schema-Level Isolation

**calls table:**
```sql
tenant_id UUID NOT NULL → tenants(id)  -- Explicit tenant reference
user_id UUID NOT NULL                  -- Explicit user reference
```

**call_events table:**
```sql
tenant_id UUID NOT NULL → tenants(id)  -- Redundant but safe
call_id TEXT → calls(id)
```

**Design:** Dual column pattern (tenant_id + user_id) allows:
- Future: Multi-user per tenant
- Current: Explicit scoping, no joins needed

### RLS Policy Requirements

For multi-tenancy to work, these policies MUST exist:

```sql
-- On calls table
CREATE POLICY "Users can view own calls"
  ON public.calls
  USING (auth.uid()::text = user_id);

-- On call_events table
CREATE POLICY "Users can view own call events"
  ON public.call_events
  USING (
    EXISTS (
      SELECT 1 FROM public.calls c
      WHERE c.id = call_id
      AND c.user_id = auth.uid()::text
    )
  );

-- On profiles table
CREATE POLICY "Users can view own profile"
  ON public.profiles
  USING (auth.uid() = user_id);
```

**Verification:** Check Supabase console → Table Editor → RLS Policies

---

## Data Model (Supabase)

### Schema Overview

**Location:** `/supabase/migrations/`

**Tables:** 7+ core tables

**Security:** RLS policies for user/tenant isolation

### Core Tables

#### TENANTS (Multi-tenant organizations)

```sql
CREATE TABLE public.tenants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Columns:**
- `id` - Unique organization identifier
- `name` - Organization name
- `created_at`, `updated_at` - Timestamps

**Usage:**
- Container for users, calls, rules, billing
- Scoping key for multi-tenancy
- One entry per organization

**Indexes:**
- PRIMARY KEY on id
- Implicit index on created_at (for sorting)

---

#### PROFILES (User profiles with tenant association)

```sql
CREATE TABLE public.profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  full_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id)
);
```

**Columns:**
- `user_id` - Foreign key to Supabase auth.users
- `tenant_id` - Organization this user belongs to
- `role` - Either "admin" or "member"
- `full_name` - User's display name
- `created_at`, `updated_at` - Timestamps

**Usage:**
- Extend Supabase Auth with tenant association
- Control permissions (admin vs member)
- User profile data (name, etc.)

**Relationships:**
- One profile per user
- Many users per tenant
- User can be in only one tenant (current design)

**Indexes:**
- PRIMARY KEY on user_id
- FOREIGN KEY on tenant_id
- idx_profiles_tenant_id (for listing users by org)
- idx_profiles_role (for permission checks)

---

#### CALLS (Call records with metrics)

```sql
CREATE TABLE public.calls (
  id TEXT PRIMARY KEY,  -- Telnyx call_control_id
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  call_control_id TEXT,  -- Duplicate for hangup operations
  user_id TEXT NOT NULL,  -- Not FK, can be missing for incoming calls
  direction TEXT NOT NULL DEFAULT 'inbound',
  from_e164 TEXT NOT NULL,
  to_e164 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'initiated' CHECK (
    status IN ('initiated', 'ringing', 'answered', 'completed', 'failed', 'busy', 'no-answer')
  ),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_sec INTEGER DEFAULT 0,
  billable_sec INTEGER DEFAULT 0,
  cost_usd NUMERIC(10, 4) DEFAULT 0.0000,
  goal TEXT,  -- Business goal (sales, support, survey, etc.)
  goal_status TEXT CHECK (goal_status IN ('achieved', 'failed', 'pending')),
  assistant_id TEXT,  -- Which AI assistant was used
  assistant_name TEXT,  -- AI assistant name (denormalized)
  transcript TEXT,  -- Full call transcript
  transcript_url TEXT,  -- URL to transcript file
  transcript_status TEXT DEFAULT 'none' CHECK (
    transcript_status IN ('pending', 'processing', 'completed', 'failed', 'none')
  ),
  recording_url TEXT,  -- URL to call recording
  user_feedback BOOLEAN,  -- Whether user submitted feedback
  feedback_comment TEXT,  -- User's feedback text
  feedback_at TIMESTAMPTZ,  -- When feedback was submitted
  response_time_ms INTEGER,  -- LLM response latency
  tags TEXT[],  -- Searchable tags (indexed)
  metadata JSONB DEFAULT '{}',  -- Extensible data (machine detection, etc.)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Columns:** 30+ (see above)

**Key Columns Explained:**
- `id` = `call_control_id` from Telnyx (primary key, immutable)
- `direction` - Determines if outbound (we initiated) or inbound (caller called us)
- `from_e164` / `to_e164` - Phone numbers in E.164 format (+1234567890)
- `status` - State machine (initiated → ringing → answered → completed)
- `billable_sec` - Duration from answer to hangup (excludes ringing time)
- `cost_usd` - Calculated from billable_sec × $0.01/min
- `goal` - Why was this call made? (e.g., "close sales deal")
- `goal_status` - Was goal achieved? (for analytics)
- `transcript_status` - Did Deepgram transcribe? (pipeline tracking)

**Usage:**
- Core business entity
- Stores all call details
- Supports analytics, billing, compliance
- Realtime updates to dashboard

**Relationships:**
- FK to tenants (org isolation)
- FK to call_events (1:N, event timeline)
- Denormalized fields (assistant_name) for performance

**Indexes:**
- PRIMARY KEY on id
- FOREIGN KEY on tenant_id
- idx_calls_tenant_id (list calls by org)
- idx_calls_started_at (time-based queries)
- idx_calls_status (filter by status)
- idx_calls_goal (analytics by goal)
- idx_calls_user_id (user's calls)

**RLS Policies:**
```sql
-- Users can view only their tenant's calls
WHERE auth.uid()::text = user_id
  AND EXISTS (
    SELECT 1 FROM profiles p
    WHERE p.tenant_id = calls.tenant_id
    AND p.user_id = auth.uid()
  )
```

---

#### CALL_EVENTS (Event timeline for each call)

```sql
CREATE TABLE public.call_events (
  id TEXT PRIMARY KEY,  -- Telnyx event_id
  call_id TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  type TEXT NOT NULL,  -- call.initiated, call.answered, call.hangup, etc.
  occurred_at TIMESTAMPTZ NOT NULL,  -- When event happened (from Telnyx)
  payload JSONB NOT NULL DEFAULT '{}',  -- Full Telnyx webhook payload
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Columns:**
- `id` - Telnyx event_id (unique per event)
- `call_id` - Which call this event belongs to
- `tenant_id` - Org (denormalized for performance)
- `type` - Event type string
- `occurred_at` - Timestamp from Telnyx (not when we received it)
- `payload` - Complete event data as JSON
- `created_at` - When we received/stored it

**Usage:**
- Audit trail of all call events
- Supports event replay/debugging
- Call timeline in dashboard
- Compliance/regulatory requirements

**Event Types:**
- `call.initiated` - Call created in Telnyx
- `call.ringing` - Call is ringing on destination
- `call.answered` - User answered
- `call.hangup` - Call ended (any reason)
- `call.recording.saved` - Recording file ready
- `call.transcription.completed` - Transcript ready
- `call.machine_detection.ended` - Voicemail/answering machine detected
- (others as configured in Telnyx)

**Relationships:**
- FK to calls (N:1, many events per call)
- FK to tenants (for RLS)

**Indexes:**
- PRIMARY KEY on id
- FOREIGN KEY on call_id, tenant_id
- idx_call_events_call_id (events for specific call)
- idx_call_events_type (filter by type)
- idx_call_events_occurred_at (time-based queries)

**RLS Policy:**
```sql
-- Users can view events for calls they own
WHERE EXISTS (
  SELECT 1 FROM calls c
  WHERE c.id = call_id
  AND c.user_id = auth.uid()::text
)
```

---

#### ASSISTANTS (AI assistant configurations)

```sql
CREATE TABLE public.assistants (
  id TEXT PRIMARY KEY,  -- e.g., "asst_123"
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,  -- e.g., "Sales Bot", "Support Agent"
  description TEXT,  -- What does this assistant do?
  voice_id TEXT,  -- Which voice? (e.g., "alloy", "nova")
  prompt_template TEXT,  -- System prompt for Groq
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Columns:**
- `id` - Unique assistant identifier
- `tenant_id` - Which org owns this assistant
- `name` - Human-readable name
- `voice_id` - OpenAI voice choice
- `prompt_template` - Custom system prompt (currently hardcoded in ai-server)
- `is_active` - Can be disabled without deleting

**Usage:**
- Define multiple AI personalities per org
- Store custom prompts
- Configure voice characteristics
- Currently not integrated (hardcoded in ai-server)

**Relationships:**
- FK to tenants (org isolation)
- FK from calls.assistant_id (which assistant was used)

**Future Integration:**
- Query assistant on call initiation
- Load prompt_template and voice_id
- Allow per-call assistant selection

---

#### NOTIFICATION_RULES (Trigger configurations)

```sql
CREATE TABLE public.notification_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,  -- e.g., "Sales Goal Achieved"
  event TEXT NOT NULL,  -- goal_achieved, goal_failed, call_completed
  type TEXT NOT NULL CHECK (type IN ('webhook', 'slack', 'email', 'sms')),
  recipient TEXT NOT NULL,  -- URL, email, phone, webhook endpoint
  is_active BOOLEAN DEFAULT TRUE,
  config JSONB DEFAULT '{}',  -- Type-specific config
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**Columns:**
- `event` - What triggers the notification?
- `type` - How to send? (webhook, Slack, email, SMS)
- `recipient` - Where to send?
- `config` - JSON config (auth tokens, template vars, etc.)

**Usage:**
- Notify external systems when goals achieved
- Send alerts to Slack on call failures
- Email summaries to users
- Webhook pushes to external apps

**Future Integration:**
- Queue consumer checks rules on events
- Publishes notifications to appropriate channels

---

#### BILLING_SUMMARY (Monthly billing aggregates)

```sql
CREATE TABLE public.billing_summary (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_calls INTEGER DEFAULT 0,
  total_minutes NUMERIC(10, 2) DEFAULT 0,
  total_cost_usd NUMERIC(10, 4) DEFAULT 0,
  breakdown JSONB DEFAULT '{}',  -- {by_goal, by_assistant, daily, etc.}
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, period_start, period_end)
);
```

**Columns:**
- `period_start`, `period_end` - Month boundaries (e.g., 2024-12-01 to 2024-12-31)
- `breakdown` - JSON with various views:
  - `by_goal`: {sales: {calls: 50, minutes: 200, cost: 33.33}}
  - `by_assistant`: {bot_a: {...}, bot_b: {...}}
  - `daily`: {2024-12-01: {calls: 5, cost: 2.50}, ...}

**Usage:**
- Pre-computed monthly billing for fast dashboard loading
- Audit trail of historical billing
- CSV export for invoicing
- Trend analysis (month-over-month)

**Relationships:**
- FK to tenants (org isolation)
- Computed from calls table (via API route or scheduled job)

---

### Query Patterns (from API Routes)

#### List all calls for user

**File:** `/src/app/api/calls/route.ts`

```typescript
const calls = await supabase
  .from('calls')
  .select('*')
  .eq('user_id', userId)
  .order('started_at', { ascending: false })
  .range(offset, offset + limit - 1);
```

**Indexes Used:** idx_calls_user_id, idx_calls_started_at

---

#### Get call events timeline

**File:** `/src/app/api/calls/[id]/events/route.ts`

```typescript
const events = await supabase
  .from('call_events')
  .select('*')
  .eq('call_id', callId)
  .eq('user_id', userId)  // Double-check ownership
  .order('occurred_at', { ascending: true });
```

**Indexes Used:** idx_call_events_call_id

---

#### Aggregate stats (dashboard)

**File:** `/src/app/api/stats/route.ts`

```typescript
// Compute in application (no aggregation queries yet)
const calls = await supabase
  .from('calls')
  .select('*')
  .eq('user_id', userId)
  .gte('started_at', thirtyDaysAgo);

// Client-side:
const stats = {
  totalCalls: calls.length,
  totalMinutes: calls.reduce((sum, c) => sum + c.duration_sec / 60, 0),
  totalCost: calls.reduce((sum, c) => sum + c.cost_usd, 0),
  avgDuration: (totalMinutes / totalCalls) * 60,  // seconds
  goalAchievementRate: goalsCalls / totalCalls
};
```

**Optimization Opportunity:** Pre-compute in billing_summary table or use Supabase SQL functions

---

### Data Consistency Patterns

#### Upsert Strategy (from queue consumer)

```typescript
// 1. Insert/update event (idempotent on id)
await supabase.from('call_events').upsert(event, {
  onConflict: 'id',
  ignoreDuplicates: true  // Duplicate events ignored
});

// 2. Merge with existing call
const existing = await supabase
  .from('calls')
  .select('*')
  .eq('id', callId)
  .single();

const merged = {
  ...existing,
  ...newFields,
  started_at: newFields.started_at || existing.started_at  // Preserve first
};

// 3. Upsert call (last-write-wins for most fields)
await supabase.from('calls').upsert(merged, {
  onConflict: 'id'
});
```

**Pattern:** Preserve timestamps, merge metrics

---

## Configuration & Secrets

### Root Environment (Next.js)

**File:** `/home/user/Version-2/.env.example`

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJxxxxxxx
SUPABASE_SERVICE_ROLE_KEY=eyJxxxxx  # Secret (backend only)

# Cloudflare
CLOUDFLARE_ACCOUNT_ID=xxxxxxx
CLOUDFLARE_API_TOKEN=xxxxxxxxxx

# Telnyx
TELNYX_API_KEY=KEY123456
TELNYX_SIGNING_SECRET=sk_test_xxx  # For webhook validation
TELNYX_SIP_CONNECTION_ID=1234567
NEXT_PUBLIC_MONITOR_NUMBER=+12767735173

# NextAuth
NEXTAUTH_URL=https://yourdomain.com
NEXTAUTH_SECRET=super-secret-random-string

# Deployment
NEXT_PUBLIC_APP_URL=https://yourdomain.com
```

**Variables Breakdown:**

| Variable | Visibility | Purpose | Used By |
|----------|-----------|---------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Database URL | Frontend + Backend |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Public | Anon database key (RLS enforced) | Frontend |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Admin database key (bypasses RLS) | Backend API routes |
| `TELNYX_API_KEY` | Secret | Telnyx API authorization | Backend, Workers, AI Server |
| `TELNYX_SIGNING_SECRET` | Secret | Webhook HMAC validation | Workers (unused currently) |
| `TELNYX_SIP_CONNECTION_ID` | Public | SIP routing ID | Backend, Workers, AI Server |
| `NEXTAUTH_URL` | Public | Auth callback URL | NextAuth |
| `NEXTAUTH_SECRET` | Secret | JWT signing key | NextAuth |
| `NEXT_PUBLIC_MONITOR_NUMBER` | Public | Default from number | Backend, Workers |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Cloudflare account | Deployment only |
| `CLOUDFLARE_API_TOKEN` | Secret | Cloudflare API token | Deployment only |

---

### AI Server Environment

**File:** `/ai-server/.env.example`

```bash
# Server
PORT=8080

# AI Services
DEEPGRAM_API_KEY=xxxxx
GROQ_API_KEY=xxxxx
OPENAI_API_KEY=sk-xxxx

# Supabase (for future use)
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJxxxxx

# Telnyx
TELNYX_API_KEY=KEY123456
TELNYX_SIGNING_SECRET=sk_test_xxx
TELNYX_SIP_CONNECTION_ID=1234567
NEXT_PUBLIC_MONITOR_NUMBER=+12767735173
NEXT_PUBLIC_APP_URL=https://version-2-cr4fsa.fly.dev
```

**Startup Validation** (`index.ts:36-39`):
```typescript
if (!DG_API_KEY) throw new Error("Missing DEEPGRAM_API_KEY");
if (!GROQ_KEY) throw new Error("Missing GROQ_API_KEY");
if (!OPENAI_KEY) throw new Error("Missing OPENAI_API_KEY");
if (!TELNYX_API_KEY) throw new Error("Missing TELNYX_API_KEY");
```

Server throws at startup if any required secret missing (fail-fast).

---

### Cloudflare Workers Configuration

**File:** `/cloudflare-workers/wrangler.toml`

**Public Variables** (vars):
```toml
[vars]
FROM_NUMBER = "+12062079439"
MONITOR_NUMBER = "+12767735173"
CALL_CONTROL_APP_ID = "your-app-id"
SUPABASE_URL = "https://xxxxx.supabase.co"
DEFAULT_USER_ID = "default-user-id"
```

**Secrets** (set via `wrangler secret put`):
```bash
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put TELNYX_API_KEY
wrangler secret put TELNYX_SIGNING_SECRET
```

**KV Namespace** (for idempotency):
```toml
[[kv_namespaces]]
binding = "IDEMPOTENCY"
id = "your-kv-namespace-id"
```

**Queues** (async event processing):
```toml
[[queues.producers]]
binding = "TELNYX_EVENTS"

[[queues.consumers]]
queue = "TELNYX_EVENTS"
max_batch_size = 100
max_batch_timeout = 30
max_retries = 3
dead_letter_queue = "failed-events"
```

**Scheduled Job** (cron trigger):
```toml
[triggers]
crons = ["0 */15 * * * *"]  # Every 15 minutes
```

---

### Fly.io Deployment

**File:** `/ai-server/fly.toml`

```toml
app = 'version-2-cr4fsa'
primary_region = 'iad'

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = 'stop'
  auto_start_machines = true
  min_machines_running = 0
  processes = ['app']

[[vm]]
  memory = '1gb'
  cpu_kind = 'shared'
  cpus = 1
  memory_mb = 1024
```

**Secrets** (set via `flyctl secrets set`):
```bash
flyctl secrets set DEEPGRAM_API_KEY=xxxxx
flyctl secrets set GROQ_API_KEY=xxxxx
flyctl secrets set OPENAI_API_KEY=sk-xxxxx
flyctl secrets set TELNYX_API_KEY=KEY123456
flyctl secrets set TELNYX_SIGNING_SECRET=sk_test_xxx
flyctl secrets set TELNYX_SIP_CONNECTION_ID=1234567
```

**Deployment:** Triggered by GitHub Actions on main branch push

---

### Hardcoded Values That Should Be Configurable

| Value | Location | Current | Should Be |
|-------|----------|---------|-----------|
| From phone | `outbound-call.ts:36` | `"+12767735173"` | `TELNYX_FROM_NUMBER` env var |
| Stream URL | `index.ts:82` | `"wss://version-2-cr4fsa.fly.dev"` | `TELNYX_STREAM_URL` env var |
| Groq model | `index.ts:136` | `"llama-3.1-8b-instant"` | `GROQ_MODEL` env var |
| OpenAI TTS model | `index.ts:174` | `"tts-1"` | `OPENAI_TTS_MODEL` env var |
| OpenAI voice | `index.ts:175` | `"alloy"` | `OPENAI_TTS_VOICE` env var |
| System prompt | `index.ts:138` | `"You are a helpful voice assistant."` | `LLM_SYSTEM_PROMPT` env var |
| Deepgram model | `index.ts:109` | `"nova-2"` | `DEEPGRAM_MODEL` env var |
| Cost rate | `telnyx.ts` | `$0.01/min` | `CALL_RATE_PER_MINUTE` env var |

---

## Current AI Pipeline

### Components & Responsibilities

#### 1. Speech-to-Text (Deepgram)

**Model:** Deepgram nova-2

**Location in Pipeline:**
```
Telnyx WebSocket (mulaw audio)
    ↓
AI Server WebSocket handler
    ↓
dgLive.send(audioBuffer)
    ↓
Deepgram nova-2 (processes in cloud)
    ↓
LiveTranscriptionEvents.Transcript
    ↓
userText = "What time is it?"
```

**Features:**
- Real-time streaming (sub-second latency)
- Automatic silence detection (100ms endpointing)
- High accuracy on phone audio
- Language support (English primary, others available)

**Configuration:**
```typescript
const dgLive = await deepgram.listen.live({
  model: "nova-2",        // Latest model
  encoding: "mulaw",      // Telnyx format
  sample_rate: 8000,      // VoIP standard
  channels: 1,            // Mono
  endpointing: 100        // Stop after 100ms silence
});
```

**Accuracy Factors:**
- Phone audio quality (typically 8kHz mono, limited bandwidth)
- Background noise
- Accent/pronunciation clarity
- Model fine-tuning (currently none)

**Cost:** Metered by minutes of audio processed

---

#### 2. Large Language Model (Groq)

**Model:** Llama 3.1 8B Instruct

**Location in Pipeline:**
```
Deepgram transcript
    ↓
userText = "What time is it?"
    ↓
groq.chat.completions.create({
  model: "llama-3.1-8b-instant",
  messages: [
    {role: "system", content: "You are a helpful voice assistant."},
    {role: "user", content: userText}
  ]
})
    ↓
Groq Reasoning Engine (in cloud)
    ↓
aiText = "It is 2:30 PM."
```

**System Prompt:**
```
"You are a helpful voice assistant."
```

**Characteristics:**
- 8B parameters (fast, <500ms latency)
- Instruction-tuned (good for conversations)
- Available via OpenAI-compatible API
- Single-turn (no conversation history maintained)

**Limitations:**
- No context from previous user utterances
- No awareness of call goal or user history
- Fixed system prompt (not per-call customizable)
- No tool calling or function invocation

**Optimization Opportunities:**
- Add goal context: "You are a sales assistant helping to close deals"
- Store conversation history in Supabase
- Use conversation logs to improve responses
- Fine-tune model on domain-specific language

**Cost:** Metered by tokens (input + output)

---

#### 3. Text-to-Speech (OpenAI)

**Model:** OpenAI TTS-1 (Fast)

**Location in Pipeline:**
```
Groq LLM response
    ↓
aiText = "It is 2:30 PM."
    ↓
openai.audio.speech.create({
  model: "tts-1",
  voice: "alloy",
  input: aiText,
  response_format: "pcm"
})
    ↓
OpenAI TTS Engine (in cloud)
    ↓
24kHz PCM audio
```

**Voice Characteristics:**
- `alloy` - Neutral, professional tone (current choice)
- `nova` - Warm, natural
- `onyx` - Deep, masculine
- `shimmer` - Bright, feminine
- `echo`, `fable` - Others available

**Output Format:**
- PCM (raw audio, no header)
- 24kHz sample rate (24000 Hz)
- 16-bit signed integers
- Mono

**Processing:**
1. Receive 24kHz PCM buffer
2. Downsample to 8kHz (every 3rd sample) → Telnyx compatible
3. Base64 encode
4. Send via WebSocket to Telnyx

**Latency:**
- Typically 1-3 seconds (varies with input length)
- Blocks next user input (must wait for TTS to complete)

**Quality:**
- Natural-sounding, emotional prosody
- Handles punctuation (periods, commas, pauses)
- Supports numbers, abbreviations
- No phonetic control (IPA input not available)

**Cost:** Metered by characters of input text

---

### Complete STT → LLM → TTS Pipeline Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                      AI PROCESSING PIPELINE                      │
└─────────────────────────────────────────────────────────────────┘

INPUT: User Audio from Telnyx
├─ Format: mulaw (u-law codec)
├─ Sample Rate: 8000 Hz
├─ Channels: 1 (mono)
└─ Duration: Variable (user speaks)

┌──────────────────────────────────────────────────────────────────┐
│ DEEPGRAM SPEECH-TO-TEXT (nova-2)                                │
├─ Model: nova-2 (latest, most accurate)                          │
├─ Encoding: mulaw                                                 │
├─ Streaming: Yes (real-time)                                     │
├─ Endpointing: 100ms silence detection                           │
├─ Confidence: 0.0-1.0 per word                                   │
└─ Output: Text transcript                                        │
│
│ Example: "What time is it?"
│ Confidence: 0.98
│ Duration: 1.2 seconds of audio
│ Latency: ~500ms
│
└──────────────────────────────────────────────────────────────────┘
                          ↓

┌──────────────────────────────────────────────────────────────────┐
│ GROQ LARGE LANGUAGE MODEL (llama-3.1-8b-instant)                │
├─ Model: llama-3.1-8b (8 billion parameters)                     │
├─ Approach: Instruction-tuned (trained for conversations)        │
├─ API: OpenAI-compatible (/v1/chat/completions)                 │
├─ System Prompt: "You are a helpful voice assistant."            │
├─ Input: User text from Deepgram                                 │
├─ Processing: Reasoning, token generation                        │
└─ Output: AI response text                                       │
│
│ Example Input:
│   System: "You are a helpful voice assistant."
│   User: "What time is it?"
│
│ Example Output:
│   "It is 2:30 PM."
│
│ Latency: <500ms (fast inference on Groq)
│ Tokens:
│   Input: 25 tokens (system + user text)
│   Output: ~10 tokens (response)
│   Total: 35 tokens
│
└──────────────────────────────────────────────────────────────────┘
                          ↓

┌──────────────────────────────────────────────────────────────────┐
│ OPENAI TEXT-TO-SPEECH (tts-1, voice: alloy)                     │
├─ Model: tts-1 (faster, lower latency)                           │
├─ Voice: alloy (neutral, professional)                           │
├─ Input: AI response text                                        │
├─ Synthesis: Neural TTS with prosody                             │
├─ Output Format: PCM (raw audio)                                 │
├─ Sample Rate: 24000 Hz (24kHz)                                  │
├─ Bit Depth: 16-bit signed integers                              │
│
│ Example Input: "It is 2:30 PM."
│ Example Output: ~48KB audio buffer (1 second @ 24kHz 16-bit)
│ Latency: 1-3 seconds
│
└──────────────────────────────────────────────────────────────────┘
                          ↓

┌──────────────────────────────────────────────────────────────────┐
│ AUDIO DOWNSAMPLING (24kHz → 8kHz)                               │
├─ Input: 24kHz PCM (from OpenAI)                                 │
├─ Algorithm: Take every 3rd sample                               │
├─ Formula: newRate = oldRate / 3                                 │
├─ Output: 8kHz PCM (compatible with Telnyx)                      │
│
│ Size Reduction:
│   Input: 48KB (1 sec @ 24kHz)
│   Output: 16KB (1 sec @ 8kHz)
│
└──────────────────────────────────────────────────────────────────┘
                          ↓

OUTPUT: Audio to Telnyx
├─ Format: PCM (raw)
├─ Sample Rate: 8000 Hz
├─ Channels: 1 (mono)
├─ Encoding: base64 in WebSocket JSON
└─ Duration: Matches synthesized TTS

TOTAL PIPELINE LATENCY:
├─ Deepgram STT: ~500ms
├─ Groq LLM: <500ms
├─ OpenAI TTS: 1-3 seconds
├─ Downsampling: ~10ms
└─ Network/Queue: ~200ms
│
└─ TOTAL: ~2.5-4 seconds (for 1 user utterance)
```

### Quality Factors

#### Deepgram STT Quality Depends On:
1. **Audio quality** - Clear phone line vs noisy background
2. **User accent** - nova-2 handles accents well
3. **Speech rate** - Too fast or too slow can reduce accuracy
4. **Domain language** - Jargon not in training data
5. **Endpointing setting** - Too short: cuts off last word; too long: includes silence

#### Groq LLM Quality Depends On:
1. **Prompt engineering** - System prompt can guide response style
2. **Input clarity** - Noisy STT transcript reduces LLM quality
3. **Model capability** - 8B model limited for complex reasoning
4. **Domain knowledge** - Fine-tuning needed for specialized domains
5. **Context** - No multi-turn history = repetitive/generic responses

#### OpenAI TTS Quality Depends On:
1. **Voice choice** - Different voices for different use cases
2. **Text clarity** - Ambiguous text may be mispronounced
3. **Response length** - Long responses may sound unnatural
4. **Punctuation** - Periods cause pauses, critical for pacing
5. **Model speed** - tts-1 faster but potentially lower quality than tts-1-hd

---

### Current Limitations & Future Improvements

**Limitations:**
- ❌ No conversation history (single-turn only)
- ❌ Fixed system prompt (not customizable per call)
- ❌ No goal-aware responses (e.g., "I'm a sales assistant")
- ❌ No tool calling (can't retrieve data, check calendar, etc.)
- ❌ No sentiment detection (can't adjust tone based on user emotion)
- ❌ No explicit error handling (silent failures on API errors)
- ❌ No streaming output (must wait for complete TTS before response)

**Opportunities:**
- ✅ Add goal context to system prompt (e.g., "You are a $goal assistant")
- ✅ Store conversation history in Supabase, include in LLM context
- ✅ Use Groq tools/function calling to look up data
- ✅ Detect sentiment from transcripts, adjust response tone
- ✅ Implement streaming TTS (send audio as chunks, don't wait for completion)
- ✅ Fine-tune Groq model on domain data
- ✅ Use better TTS model (tts-1-hd for higher quality)
- ✅ Add logging/metrics for quality monitoring

---

## Architecture Strengths

1. **Strong Webhook Security**
   - HMAC-SHA256 signature verification prevents spoofing
   - Constant-time comparison prevents timing attacks
   - Timestamp validation prevents replay attacks
   - Industry standard, cryptographically sound
   - Idempotency via KV store prevents double-processing

2. **Event-Driven Decoupling**
   - Webhooks → Cloudflare Queue → Consumer pattern
   - Telnyx doesn't wait for database writes (fast response)
   - Queue buffers load spikes, handles retries automatically
   - Horizontal scalability via distributed queue
   - Resilient to database downtime (queue persists events)

3. **Multi-Layer Data Isolation**
   - Calls scoped by user_id in all API routes
   - Realtime updates rely on RLS policies
   - Double-verification on sensitive ops (e.g., feedback upsert)
   - No implicit data sharing between users
   - Reduces risk of unauthorized access via misconfiguration

4. **Real-Time Dashboard Experience**
   - WebSocket connection to Supabase (sub-second updates)
   - Animations on new calls provide visual feedback
   - No polling/refresh needed (vs traditional dashboards)
   - Professional UX, engaging for users
   - Scales well (real-time connections load-balanced)

5. **Comprehensive Call Tracking**
   - 8+ call status values (fine-grained state machine)
   - Event timeline preserved (call_events table for audit)
   - Supports analytics on lifecycle stages
   - Metadata field for extensibility
   - Better than binary succeeded/failed tracking

6. **Idempotent Operations**
   - Webhook idempotency via KV (prevents duplicate events)
   - Call_events idempotent on event_id
   - Queue consumer can safely retry without side effects
   - Handles network retries gracefully
   - Safe for "at-least-once" delivery semantics

7. **Flexible Data Model**
   - Metadata JSONB field for extensibility (machine detection, etc.)
   - Transcript storage (text + URL) for compliance
   - Recording URLs for audit trail
   - Feedback/comments for UX research
   - Goal status tracking for analytics
   - Room for future features without schema changes

---

## Architecture Risks & Complexity Hotspots

### Critical Security Issues

1. **No Authentication on Call Initiation**
   - **Location:** `/start-call` (Cloudflare Worker) + `/api/outbound-call` (AI Server)
   - **Risk:** Endpoints accept any user_id without validation
   - **Impact:** Attackers can initiate calls on behalf of any user (fraud, cost)
   - **Severity:** CRITICAL
   - **Quick Fix:** Validate JWT token, ensure user_id matches token
   - **Better Fix:** Require NextAuth session with role check

2. **Unauthenticated WebRTC Token Generation**
   - **Location:** `POST /api/telnyx/token` (Next.js)
   - **Risk:** No auth check, anyone can generate tokens
   - **Impact:** Unlimited credential generation, potential DoS
   - **Severity:** HIGH
   - **Fix:** Require NextAuth session before issuing tokens

3. **Auth Strategy Fragmentation**
   - **Issue:** NextAuth for some routes, Supabase auth for others
   - **Risk:** Inconsistent session validation, unpredictable failures
   - **Example:** User logs in via NextAuth, but `/api/stats` expects Supabase auth
   - **Severity:** HIGH
   - **Impact:** User authenticates to dashboard but fails on some API calls
   - **Fix:** Consolidate to single auth layer (recommend NextAuth everywhere)

4. **Webhook Signature Validation Not Enforced**
   - **Location:** Cloudflare webhook handler receives `TELNYX_SIGNING_SECRET` but doesn't use it
   - **Risk:** No verification that webhook came from Telnyx
   - **Impact:** Attackers can inject fake events (e.g., hangup calls, change statuses)
   - **Severity:** HIGH
   - **Fix:** Implement signature verification immediately (code exists, just enable)

### Data Consistency Issues

5. **Eventual Consistency, Not Strong Consistency**
   - **Pattern:** Call created in Telnyx, then enqueued for Supabase
   - **Risk:** If queue consumer fails, database never updated
   - **Impact:** Dashboard shows outdated call status, billing incorrect
   - **Window:** Up to 2 hours (CDR reconciliation delay)
   - **Acceptable If:** Team understands eventual consistency model
   - **Better:** Use Telnyx webhooks as source of truth, read-after-write consistency

6. **Unresolved Tenant ID in CDR Reconciliation**
   - **Location:** `/cloudflare-workers/src/scheduled-job.ts`
   - **Issue:** Telnyx CDRs don't include tenant_id, lookup not implemented
   - **Risk:** Billing data missing for calls without metadata
   - **Impact:** Incomplete accounting, wrong cost attribution
   - **Fix:** Pass tenant_id in client_state, implement lookup in job

7. **Stale Call Cleanup Not Implemented**
   - **Location:** `scheduled-job.ts` has placeholder
   - **Issue:** Calls stuck in "ringing" for hours aren't marked failed
   - **Impact:** Dashboard shows phantom active calls
   - **Fix:** Implement: find calls >1hr in initiated/ringing, mark as failed

### Architectural Weaknesses

8. **Single-User = Single-Tenant Design**
   - **Assumption:** Each user is a tenant (1:1 mapping)
   - **Limitation:** Can't implement multi-user teams or role-based sharing
   - **Impact:** Limited collaboration features
   - **Future Work:** Separate tenant table, user→tenant relationships
   - **Complexity:** Medium (schema change + RLS updates)

9. **Mixed Database Transactions**
   - **Issue:** Telnyx call creation + Supabase insert not atomic
   - **Risk:** Telnyx succeeds but Supabase fails (orphaned call)
   - **Mitigation:** Queue consumer can upsert (eventual consistency)
   - **Better:** No backpressure (return success immediately, handle async)

10. **No Realtime Monitoring or Alerting**
    - **Issue:** Errors logged to console only
    - **Impact:** Team unaware of failures (missed calls, bugs)
    - **Severity:** MEDIUM (operational risk)
    - **Fix:** Send logs to external service (Datadog, Sentry, etc.)

11. **Hardcoded Configuration Values**
    - **Examples:** From number, stream URL, model names, cost rate
    - **Risk:** Requires code re-deploy to change (slow iteration)
    - **Impact:** Can't adjust rates or settings without releases
    - **Fix:** Move all hardcoded values to environment variables

12. **No Rate Limiting**
    - **Issue:** `/api/calls/hangup` and other endpoints have no limits
    - **Risk:** Abuse (spam hangup requests, flood calls)
    - **Impact:** Resource exhaustion, high costs
    - **Fix:** Implement per-user/per-API-key rate limiting

13. **Dashboard Analytics Computed Client-Side**
    - **Location:** `/api/stats` fetches all calls, computes aggregates in JavaScript
    - **Risk:** For 10k+ calls, non-trivial overhead, potential memory issues
    - **Better:** Pre-compute aggregates in database, cache for 5 minutes
    - **Fix:** Add database aggregate functions or materialized views

14. **Realtime Subscription No Client-Side Filtering**
    - **Issue:** Subscribes to all calls table changes, relies on RLS
    - **Risk:** If RLS disabled, user sees all calls in org
    - **Mitigation:** Must verify RLS policies are enforced
    - **Better:** Add WHERE clause to subscription for explicit filtering

### Configuration & Deployment Risks

15. **Missing Environment Validation at Deployment Time**
    - **Issue:** Worker checks env vars at runtime, missing vars cause worker crash
    - **Risk:** Deploy succeeds, but service fails on first request
    - **Better:** Validate in wrangler before deployment
    - **Fix:** Add `wrangler.toml` validation script

16. **No Feature Flags**
    - **Issue:** Can't disable CDR reconciliation without deploying
    - **Risk:** Gradual rollout not possible, all-or-nothing deployments
    - **Impact:** Risk of wide-scale outages on bad deployments
    - **Fix:** Implement feature flags (e.g., via Supabase table or Cloudflare KV)

17. **Incomplete Test Coverage**
    - **Issue:** `/tests/webhook.test.ts` exists but limited scope
    - **Risk:** Regressions in webhook handling not caught
    - **Fix:** Expand test suite (queue consumer, API routes, etc.)

18. **No Error Handling Consistency**
    - **Issue:** Some errors return 200 (no retry), some throw (retry infinitely)
    - **Risk:** Queue consumer may retry forever on invalid data
    - **Better:** Distinguish transient vs permanent errors
    - **Fix:** Implement dead-letter queue for permanent failures

---

## Questions for Aaron / Follow-up

### Architecture & Design

1. **Multi-Tenancy Scope:**
   - Is the current 1:1 user-to-tenant mapping intentional, or a temporary limitation?
   - Do you plan to support team collaboration (multiple users per org)?
   - Should we start designing for role-based access control now?

2. **Conversation History:**
   - Should the AI assistant remember previous utterances in a call (multi-turn)?
   - How many turns should we support (memory limit)?
   - Should conversation history persist between calls for the same user/goal?

3. **Goal Customization:**
   - Are call goals fixed (sales, support, survey, etc.) or user-defined?
   - Should the LLM prompt change based on goal (e.g., "You are a sales assistant")?
   - How should goal achievement be measured/detected?

4. **Notification Triggers:**
   - Should the system send notifications when goals are achieved?
   - What channels are needed (webhook, Slack, email, SMS)?
   - Who are the recipients?

5. **Multi-Tenant Cost Allocation:**
   - If one tenant has 1000s of calls, should costs be aggregated/displayed separately?
   - Should there be per-user spending limits to prevent runaway costs?
   - Who can approve/deny calls (admin only)?

### Security & Compliance

6. **Webhook Validation:**
   - Why isn't Telnyx signature validation implemented currently?
   - Is this intentional or an oversight?
   - Should we add signature validation immediately, or is there a reason to defer?

7. **Data Retention:**
   - How long should call recordings/transcripts be stored?
   - Are there compliance requirements (GDPR, CCPA, etc.)?
   - Should we implement data anonymization after X days?

8. **Rate Limiting & Abuse:**
   - What's the expected call volume per user per day?
   - Should we enforce limits to prevent abuse?
   - How should we handle legitimate high-volume users?

### Operations & Observability

9. **Monitoring & Alerting:**
   - Are there monitoring systems set up (Datadog, New Relic, etc.)?
   - What metrics are most important to track?
   - Should we set up alerts for high error rates, cost spikes, etc.?

10. **Logging & Debugging:**
    - Are logs persisted (currently only console)?
    - Can we access logs from Fly.io and Cloudflare?
    - Should we add request IDs for tracing?

11. **Stale Call Cleanup:**
    - Why is stale call cleanup not implemented?
    - What timeout is appropriate (1 hour, 24 hours)?
    - Should we notify users of stale calls?

### Data & Analytics

12. **Transcript Processing:**
    - Who is responsible for calling Deepgram for transcripts?
    - Is this automatic or user-triggered?
    - Should transcripts be stored in Supabase or external blob storage?

13. **Recording Storage:**
    - Where are recordings stored (Telnyx, S3, Supabase)?
    - What's the retention policy?
    - Who has access (user, admin, compliance)?

14. **CDR Accuracy:**
    - How is billing cost verified (CDR vs Telnyx invoice)?
    - Are there known discrepancies?
    - How frequently do reconciliation jobs run?

### Future Features

15. **Voice Customization:**
    - Should users be able to choose TTS voice (alloy, nova, etc.)?
    - Should voice be customizable per assistant?
    - Are there other TTS providers to consider?

16. **LLM Customization:**
    - Should users be able to customize the system prompt?
    - Should assistants be able to use different LLM models (Groq vs others)?
    - Should conversation style be configurable (formal, casual, etc.)?

17. **Tool Integration:**
    - Should the AI assistant be able to look up data (CRM, calendar, etc.)?
    - Should it be able to take actions (create leads, schedule meetings)?
    - What integrations are highest priority?

18. **Live Listening:**
    - The `listen-in-browser` component suggests live listening feature
    - Is this for supervisor monitoring, quality assurance, or training?
    - Are there privacy/compliance implications?

### Known Issues

19. **Hangup Endpoint:**
    - Why doesn't `POST /api/calls/hangup` also update Supabase immediately?
    - Is the async webhook-based update sufficient?
    - Should there be a fallback for webhook failures?

20. **Assistant Configuration:**
    - The assistants table exists but is not used (hardcoded in ai-server)
    - What's the plan to integrate this?
    - Should assistants be per-user or per-org?

---

## Appendix: File Location Index

### Core Application Files

| Purpose | File | Lines |
|---------|------|-------|
| Root layout + providers | `/src/app/layout.tsx` | — |
| Dashboard page | `/src/app/dashboard/page.tsx` | — |
| Auth config | `/pages/api/auth/[...nextauth].ts` | — |
| Delegate call | `/pages/api/delegate.ts` | — |
| Real-time calls table | `/src/components/dashboard/real-time-calls-table.tsx` | — |

### API Routes

| Route | File | Lines |
|-------|------|-------|
| `GET /api/calls` | `/src/app/api/calls/route.ts` | — |
| `POST /api/calls/hangup` | `/src/app/api/calls/hangup/route.ts` | — |
| `GET /api/stats` | `/src/app/api/stats/route.ts` | — |
| `GET /api/telnyx/token` | `/src/app/api/telnyx/token/route.ts` | — |

### AI Server

| File | Purpose | Lines |
|------|---------|-------|
| `/ai-server/src/index.ts` | Main Express + WebSocket + Pipeline | 269 |
| `/ai-server/src/routes/outbound-call.ts` | Outbound call handler | 84 |
| `/ai-server/fly.toml` | Deployment config | 24 |
| `/ai-server/Dockerfile` | Multi-stage build | — |

### Cloudflare Workers

| File | Purpose | Lines |
|------|---------|-------|
| `/cloudflare-workers/src/index.ts` | Main router | — |
| `/cloudflare-workers/src/webhook-handler.ts` | Telnyx webhook receiver | — |
| `/cloudflare-workers/src/queue-consumer.ts` | Event processor | — |
| `/cloudflare-workers/src/scheduled-job.ts` | CDR reconciliation | — |
| `/cloudflare-workers/src/utils/crypto.ts` | HMAC verification | — |
| `/cloudflare-workers/src/utils/supabase.ts` | DB operations | — |
| `/cloudflare-workers/wrangler.toml` | Configuration | — |

### Database

| File | Purpose | Tables |
|------|---------|--------|
| `/supabase/migrations/001_initial_schema.sql` | tenants, profiles, calls, call_events | 4 |
| `/supabase/migrations/002_ai_assistant_features.sql` | assistants, notifications, billing | 3+ |
| `/supabase/migrations/003_add_call_control_id.sql` | call_control_id column | 1 |

---

**End of Documentation**

Generated: December 1, 2025
Last Updated: During repository scan
Status: Complete and comprehensive

