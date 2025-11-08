# Telnyx Call CRM Dashboard

A production-ready, multi-tenant Call CRM Dashboard with live Telnyx call metrics, drill-downs, and analytics. Built with Next.js, Supabase, and Cloudflare Workers for optimal performance and cost efficiency.

## 🚀 Features

- **Multi-tenant Architecture**: Secure tenant isolation with Row Level Security (RLS)
- **Real-time Updates**: Live call metrics via Supabase Realtime
- **Polished UI**: Modern, responsive dashboard with shadcn/ui and TailwindCSS
- **Scalable Ingestion**: Cloudflare Workers for webhook handling and queue processing
- **Cost-Optimized**: Edge-friendly design with efficient queries and minimal infrastructure
- **Analytics**: KPIs, trends, call history, and goal tracking

## 📋 Tech Stack

### Frontend
- **Next.js 14** (App Router)
- **TypeScript**
- **TailwindCSS**
- **shadcn/ui**
- **Recharts**

### Backend
- **Supabase** (Auth, Postgres, Realtime)
- **Cloudflare Workers** (Webhooks, Queue Processing, Scheduled Jobs)

### Infrastructure
- **Cloudflare Queues** for event processing
- **PostgreSQL** with RLS for multi-tenant security

## 🏗️ Architecture

```
Telnyx Webhooks
    ↓
Cloudflare Worker (Webhook Receiver)
    ↓
Cloudflare Queue
    ↓
Queue Consumer → Supabase (Calls & Events)
    ↓
Realtime Updates → Next.js Dashboard
```

**Scheduled Job**: Runs every 30 minutes to backfill CDRs and reconcile call data.

## 📦 Project Structure

```
.
├── cloudflare-workers/          # Cloudflare Workers
│   ├── src/
│   │   ├── index.ts            # Main worker entry
│   │   ├── webhook-handler.ts  # Webhook receiver
│   │   ├── queue-consumer.ts   # Event processor
│   │   ├── scheduled-job.ts    # CDR backfill
│   │   └── utils/              # Crypto, Supabase, Telnyx utils
│   ├── wrangler.toml           # Worker configuration
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

## 🛠️ Setup Instructions

### Prerequisites

- Node.js 18+ and pnpm
- Supabase account
- Cloudflare account with Workers/Queues enabled
- Telnyx account with API access

### 1. Clone and Install

```bash
git clone <repository-url>
cd Version-2
pnpm install
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

### 3. Cloudflare Workers Setup

#### Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

#### Configure Workers

1. Update `cloudflare-workers/wrangler.toml` with your account ID and routes
2. Create KV namespace:

```bash
wrangler kv:namespace create "IDEMPOTENCY"
wrangler kv:namespace create "IDEMPOTENCY" --preview
```

3. Update wrangler.toml with the namespace IDs

#### Create Queue

```bash
wrangler queues create telnyx-events-queue
wrangler queues create telnyx-events-dlq
```

#### Set Secrets

```bash
cd cloudflare-workers
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put TELNYX_SIGNING_SECRET
wrangler secret put TELNYX_API_KEY
```

#### Deploy Workers

```bash
pnpm deploy
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
```

#### Run Development Server

```bash
pnpm dev
```

Visit http://localhost:3000

### 5. Telnyx Configuration

#### Configure Webhook

1. Log in to Telnyx Portal
2. Go to Webhooks > Add New Webhook
3. Set URL to: `https://your-worker.workers.dev/telnyx/webhook`
4. Enable signature verification
5. Copy the signing secret to your worker secrets

#### Tag Outbound Calls

When creating calls via Telnyx API, include tenant_id:

```bash
curl -X POST https://api.telnyx.com/v2/calls \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "connection_id": "your-connection-id",
    "to": "+15555551234",
    "from": "+15555556789",
    "custom_headers": [
      {
        "name": "X-Tenant",
        "value": "00000000-0000-0000-0000-000000000001"
      }
    ],
    "client_state": "{\"tenant_id\":\"00000000-0000-0000-0000-000000000001\",\"goal\":\"sales\"}"
  }'
```

## 🧪 Testing

### Run Postman Tests

Import `postman/telnyx-crm-dashboard.json` into Postman and test:

- Webhook ingestion
- API endpoints
- Authentication flows

### Manual Testing

1. **Login**: Visit `/login` and sign in with test credentials
2. **Dashboard**: View KPIs, charts, and call table
3. **Webhook**: Send test webhook via Postman
4. **Realtime**: Watch dashboard update live

## 📊 Database Schema

### Tables

- **tenants**: Multi-tenant organizations
- **profiles**: User profiles linked to tenants
- **calls**: Call records with metrics
- **call_events**: Event timeline for each call

### RLS Policies

All tables use Row Level Security to ensure:
- Users only see data from their tenant
- Service role can access all data
- Admin users have elevated permissions within their tenant

## 🔒 Security

- **Webhook Signature Verification**: HMAC-SHA256 validation
- **RLS Policies**: Tenant isolation at database level
- **Service Keys**: Never exposed to client
- **Input Validation**: Zod schemas for API routes

## 🚀 Deployment

### Vercel (Next.js)

```bash
vercel --prod
```

### Cloudflare Workers

```bash
cd cloudflare-workers
pnpm deploy
```

## 📈 Performance Optimizations

- **Indexes**: Optimized for tenant-scoped queries
- **Pagination**: All list endpoints support limit/offset
- **Selective Columns**: Only fetch needed fields
- **Edge Runtime**: API routes use Edge where possible
- **Realtime**: Supabase handles pub/sub efficiently

## 💰 Cost Optimization

- **Cloudflare Workers**: Pay-per-request pricing
- **Supabase Free Tier**: Generous limits for development
- **Edge Functions**: Minimal latency, low cost
- **Efficient Queries**: Indexed, paginated, tenant-scoped

## 🐛 Troubleshooting

### Migrations Not Running

Use the Supabase SQL Editor directly:
1. Copy migration contents
2. Paste in SQL Editor
3. Run manually

### Webhook Signature Fails

- Verify TELNYX_SIGNING_SECRET matches Portal
- Check webhook is recent (5-minute window)
- Inspect raw body matches signature

### RLS Blocks Queries

Ensure user JWT contains tenant_id:
```sql
SELECT raw_user_meta_data FROM auth.users WHERE id = 'your-user-id';
```

### Realtime Not Working

1. Check RLS policies allow SELECT
2. Verify realtime publication includes table
3. Check browser console for errors

## 📝 Development Scripts

- `pnpm dev`: Start Next.js dev server
- `pnpm build`: Build for production
- `pnpm lint`: Run ESLint
- `pnpm db:migrate`: Run migrations
- `pnpm db:seed`: Seed database

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🔗 Resources

- [Next.js Docs](https://nextjs.org/docs)
- [Supabase Docs](https://supabase.com/docs)
- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [Telnyx API Docs](https://developers.telnyx.com/)
- [shadcn/ui](https://ui.shadcn.com/)
