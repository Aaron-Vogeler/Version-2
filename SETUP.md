# Quick Setup Guide

## Step-by-Step Setup

### 1. Install Dependencies

```bash
pnpm install
cd cloudflare-workers && pnpm install && cd ..
```

### 2. Supabase Setup

1. Create project at [supabase.com](https://supabase.com)
2. Open SQL Editor
3. Run `supabase/migrations/001_initial_schema.sql`
4. Run `supabase/seed.sql`
5. Create users in Authentication > Users
6. Link users to profiles (see README)

### 3. Environment Variables

```bash
cp .env.example .env.local
```

Edit `.env.local` with your Supabase credentials.

### 4. Cloudflare Workers

```bash
cd cloudflare-workers
wrangler login
wrangler kv:namespace create "IDEMPOTENCY"
wrangler queues create telnyx-events-queue
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put TELNYX_SIGNING_SECRET
wrangler secret put TELNYX_API_KEY
pnpm deploy
cd ..
```

### 5. Run Development Server

```bash
pnpm dev
```

Visit http://localhost:3000

### 6. Configure Telnyx Webhook

1. Go to Telnyx Portal > Webhooks
2. Add webhook URL: `https://your-worker.workers.dev/telnyx/webhook`
3. Enable signature verification
4. Copy signing secret to worker

## Testing

1. Login with test user credentials
2. Send test webhook via Postman
3. Watch dashboard update in realtime

## Production Deployment

```bash
# Deploy Next.js
vercel --prod

# Deploy Workers
cd cloudflare-workers && pnpm deploy
```

---

For detailed documentation, see [README.md](README.md)
