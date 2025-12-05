# Quick Setup Guide

**Authentication:** This app uses individual user login with email/password via NextAuth + Supabase Auth. Data is secured with Row Level Security (RLS).

## Step-by-Step Setup

### 1. Install Dependencies

```bash
pnpm install
cd ai-server && pnpm install && cd ..
```

### 2. Supabase Setup

1. Create project at [supabase.com](https://supabase.com)
2. Open SQL Editor
3. Run `supabase/migrations/001_initial_schema.sql`
4. Run `supabase/migrations/002_ai_assistant_features.sql`
5. Run `supabase/migrations/003_add_call_control_id.sql`
6. Run `supabase/seed.sql`
7. Create users in Authentication > Users
8. Link users to profiles (see README)

### 3. Environment Variables

```bash
cp .env.example .env.local
```

Edit `.env.local` with your Supabase and Telnyx credentials.

### 4. AI Server Setup (Fly.io)

```bash
cd ai-server
cp .env.example .env
# Edit .env with your Deepgram, Groq, Telnyx, and Supabase credentials

# Deploy to Fly.io
fly launch
fly secrets set DEEPGRAM_API_KEY=xxx GROQ_API_KEY=xxx TELNYX_API_KEY=xxx TELNYX_SIP_CONNECTION_ID=xxx NEXT_PUBLIC_SUPABASE_URL=xxx SUPABASE_SERVICE_ROLE_KEY=xxx
fly deploy
cd ..
```

### 5. Run Development Server

```bash
pnpm dev
```

Visit http://localhost:3000

### 6. Configure Telnyx Webhook

1. Go to Telnyx Portal > Call Control Apps
2. Add webhook URL: `https://your-fly-app.fly.dev/webhooks/telnyx`
3. Configure media streaming URL: `wss://your-fly-app.fly.dev`

## Testing

1. Login with test user credentials
2. Initiate a call via the AI server API
3. Watch dashboard update in realtime with live transcripts

## Production Deployment

```bash
# Deploy Next.js
vercel --prod

# Deploy AI Server
cd ai-server && fly deploy
```

---

For detailed documentation, see [README.md](README.md)
