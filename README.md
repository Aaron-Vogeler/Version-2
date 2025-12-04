# Telnyx AI Call CRM Dashboard

A production-ready, multi-tenant AI Call CRM Dashboard with live Telnyx call metrics, AI-powered conversations, and analytics. Built with Next.js, Supabase, and Fly.io for optimal performance.

## Features

- **AI Voice Agent**: Deepgram STT + Groq LLM + Telnyx TTS for intelligent phone conversations
- **Multi-tenant Architecture**: Secure tenant isolation with Row Level Security (RLS)
- **Real-time Updates**: Live call metrics and transcripts via Supabase Realtime
- **Polished UI**: Modern, responsive dashboard with shadcn/ui and TailwindCSS
- **Live Transcripts**: Real-time conversation logging with speaker identification
- **Analytics**: KPIs, trends, call history, and goal tracking

## Tech Stack

### Frontend
- **Next.js 14** (App Router)
- **TypeScript**
- **TailwindCSS**
- **shadcn/ui**
- **Recharts**

### Backend & AI
- **Supabase** (Auth, Postgres, Realtime)
- **Fly.io** (AI Server hosting)
- **Deepgram** (Speech-to-Text)
- **Groq** (LLM - llama-3.1-8b-instant)
- **Telnyx** (VoIP, Call Control, TTS)

### Infrastructure
- **Fly.io** for AI server with WebSocket support
- **PostgreSQL** with RLS for multi-tenant security

## Architecture

```
Call Initiation (Telnyx Call Control API)
    |
WebSocket Audio Stream (Telnyx -> AI Server on Fly.io)
    |
Speech-to-Text (Deepgram WebSocket, mulaw 8kHz)
    |
LLM Processing (Groq llama-3.1-8b-instant)
    |
Text-to-Speech (Telnyx Speak API)
    |
Call Logging -> Supabase (Calls, Transcripts, Events)
    |
Realtime Updates -> Next.js Dashboard
```

## Project Structure

```
.
├── ai-server/                   # AI Voice Server (Fly.io)
│   ├── src/
│   │   ├── index.ts            # Main server entry
│   │   ├── config.ts           # Configuration
│   │   ├── callContextManager.ts # Call state management
│   │   ├── pipeline/           # AI pipeline components
│   │   │   ├── stt.ts          # Deepgram STT
│   │   │   ├── llm.ts          # Groq LLM
│   │   │   └── tts.ts          # Telnyx TTS
│   │   ├── routes/             # API routes
│   │   └── utils/              # Utilities (Supabase, etc.)
│   ├── fly.toml                # Fly.io configuration
│   └── package.json
│
├── src/                         # Next.js application
│   ├── app/
│   │   ├── (auth)/             # Auth pages (login, signup)
│   │   ├── dashboard/          # Dashboard page
│   │   └── api/                # API routes
│   ├── components/
│   │   ├── ui/                 # shadcn/ui components
│   │   └── dashboard/          # Dashboard components
│   └── lib/
│       ├── supabase/           # Supabase clients
│       ├── types/              # TypeScript types
│       └── utils.ts            # Utilities
│
├── supabase/
│   ├── migrations/             # SQL migrations
│   └── seed.sql                # Seed data
│
├── scripts/
│   ├── run-migrations.js       # Migration runner
│   └── seed-database.js        # Seed runner
│
└── postman/                     # API tests
```

## Setup Instructions

### Prerequisites

- Node.js 18+ and pnpm
- Supabase account
- Fly.io account
- Telnyx account with API access
- Deepgram account
- Groq account

### 1. Clone and Install

```bash
git clone <repository-url>
cd Version-2
pnpm install
cd ai-server && pnpm install && cd ..
```

### 2. Supabase Setup

#### Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Wait for the database to be ready
3. Get your project URL and keys from Settings > API

#### Run Migrations

1. Open the Supabase SQL Editor: `https://app.supabase.com/project/<project-id>/sql`
2. Copy the contents of `supabase/migrations/001_initial_schema.sql`
3. Paste and click "Run"
4. Repeat for `002_ai_assistant_features.sql` and `003_add_call_control_id.sql`

#### Seed Database

1. In the same SQL Editor, copy the contents of `supabase/seed.sql`
2. Paste and click "Run"

#### Create Users

1. Go to Authentication > Users
2. Click "Add User"
3. Create test users (e.g., admin@example.com, member@example.com)
4. Note their user IDs

#### Link Users to Profiles

In the SQL Editor, run:

```sql
INSERT INTO public.profiles (user_id, tenant_id, role, full_name)
VALUES
  ('your-admin-user-id', '00000000-0000-0000-0000-000000000001', 'admin', 'Admin User'),
  ('your-member-user-id', '00000000-0000-0000-0000-000000000001', 'member', 'Member User');
```

#### Update User Metadata

To ensure JWT contains tenant_id:

```sql
UPDATE auth.users
SET raw_user_meta_data = raw_user_meta_data || '{"tenant_id": "00000000-0000-0000-0000-000000000001"}'::jsonb
WHERE id = 'your-user-id';
```

### 3. AI Server Setup (Fly.io)

#### Configure Environment

```bash
cd ai-server
cp .env.example .env
```

Edit `.env` with your credentials:

```env
DEEPGRAM_API_KEY=your-deepgram-api-key
GROQ_API_KEY=your-groq-api-key
TELNYX_API_KEY=your-telnyx-api-key
TELNYX_SIP_CONNECTION_ID=your-connection-id
TELNYX_FROM_NUMBER=+1234567890
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

#### Deploy to Fly.io

```bash
fly launch
fly secrets set DEEPGRAM_API_KEY=xxx GROQ_API_KEY=xxx TELNYX_API_KEY=xxx ...
fly deploy
```

### 4. Next.js Configuration

#### Environment Variables

Copy `.env.example` to `.env.local`:

```bash
cp .env.example .env.local
```

Edit `.env.local`:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
TELNYX_API_KEY=your-telnyx-api-key
```

#### Run Development Server

```bash
pnpm dev
```

Visit http://localhost:3000

### 5. Telnyx Configuration

#### Configure Webhook

1. Log in to Telnyx Portal
2. Go to your Call Control App settings
3. Set webhook URL to: `https://your-fly-app.fly.dev/webhooks/telnyx`
4. Enable the call events you need (answered, hangup, speak.started, speak.ended)

#### Configure Media Streaming

Set the stream URL in your Telnyx app to your Fly.io WebSocket endpoint:
`wss://your-fly-app.fly.dev`

## Testing

### Manual Testing

1. **Login**: Visit `/login` and sign in with test credentials
2. **Dashboard**: View KPIs, charts, and call table
3. **Make a call**: Use the AI server endpoint to initiate an outbound call
4. **Realtime**: Watch dashboard update live with transcripts

### API Testing

Import `postman/telnyx-crm-dashboard.json` into Postman and test:

- API endpoints
- Authentication flows
- Call initiation

## Database Schema

### Tables

- **tenants**: Multi-tenant organizations
- **profiles**: User profiles linked to tenants
- **calls**: Call records with metrics and transcripts
- **call_events**: Event timeline for each call
- **assistants**: AI assistant configurations
- **billing_summary**: Usage tracking

### RLS Policies

All tables use Row Level Security to ensure:
- Users only see data from their tenant
- Service role can access all data
- Admin users have elevated permissions within their tenant

## Security

- **RLS Policies**: Tenant isolation at database level
- **Service Keys**: Never exposed to client
- **Input Validation**: Zod schemas for API routes
- **Secure WebSocket**: TLS encryption for audio streams

## Deployment

### Vercel (Next.js)

```bash
vercel --prod
```

### Fly.io (AI Server)

```bash
cd ai-server
fly deploy
```

## Performance Optimizations

- **Indexes**: Optimized for tenant-scoped queries
- **Pagination**: All list endpoints support limit/offset
- **Selective Columns**: Only fetch needed fields
- **Realtime**: Supabase handles pub/sub efficiently
- **Streaming**: Audio processed in real-time with low latency

## Troubleshooting

### Migrations Not Running

Use the Supabase SQL Editor directly:
1. Copy migration contents
2. Paste in SQL Editor
3. Run manually

### RLS Blocks Queries

Ensure user JWT contains tenant_id:
```sql
SELECT raw_user_meta_data FROM auth.users WHERE id = 'your-user-id';
```

### Realtime Not Working

1. Check RLS policies allow SELECT
2. Verify realtime publication includes table
3. Check browser console for errors

### AI Server Issues

1. Check Fly.io logs: `fly logs`
2. Verify all environment variables are set
3. Check Deepgram/Groq API keys are valid
4. Verify Telnyx webhook URL is accessible

## Development Scripts

- `pnpm dev`: Start Next.js dev server
- `pnpm build`: Build for production
- `pnpm lint`: Run ESLint
- `cd ai-server && pnpm dev`: Start AI server locally

## Resources

- [Next.js Docs](https://nextjs.org/docs)
- [Supabase Docs](https://supabase.com/docs)
- [Fly.io Docs](https://fly.io/docs/)
- [Telnyx API Docs](https://developers.telnyx.com/)
- [Deepgram Docs](https://developers.deepgram.com/)
- [Groq Docs](https://console.groq.com/docs)
- [shadcn/ui](https://ui.shadcn.com/)
