# Supabase Realtime Setup Guide

This document explains how to verify and enable Supabase Realtime for the calls table.

## Prerequisites

- Supabase project created
- `public.calls` table exists
- Row Level Security (RLS) configured

## Step 1: Enable Realtime Replication

Run this SQL in your Supabase SQL Editor to add the `calls` table to the realtime publication:

```sql
-- Enable Realtime for the calls table
ALTER PUBLICATION supabase_realtime ADD TABLE public.calls;
```

### Verify Realtime is Enabled

Check if the table is in the publication:

```sql
-- Check if calls table is in the realtime publication
SELECT schemaname, tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime';
```

You should see `public.calls` in the results.

## Step 2: Verify Row Level Security (RLS)

Ensure authenticated users can read calls based on their tenant:

```sql
-- Check existing RLS policies for calls table
SELECT * FROM pg_policies WHERE tablename = 'calls';

-- Example policy (adjust to your tenant model)
CREATE POLICY "Users can read their tenant's calls"
ON public.calls
FOR SELECT
USING (
  tenant_id = (
    SELECT tenant_id
    FROM public.profiles
    WHERE user_id = auth.uid()
  )
);
```

## Step 3: Test Realtime Subscriptions

### From Browser Console

Open your dashboard and run in the browser console:

```javascript
// Test Realtime subscription
const { createClient } = window.supabase;
const supabase = createClient(
  'YOUR_SUPABASE_URL',
  'YOUR_ANON_KEY'
);

const channel = supabase
  .channel('test-calls')
  .on('postgres_changes', {
    event: '*',
    schema: 'public',
    table: 'calls'
  }, (payload) => {
    console.log('Realtime event:', payload);
  })
  .subscribe((status) => {
    console.log('Status:', status);
  });

// You should see: Status: SUBSCRIBED
```

### Insert Test Data

In another Supabase SQL Editor tab, insert a test call:

```sql
INSERT INTO public.calls (
  tenant_id,
  direction,
  from_e164,
  to_e164,
  status,
  goal
) VALUES (
  'your-tenant-id',
  'outbound',
  '+1234567890',
  '+0987654321',
  'initiated',
  'general'
);
```

You should see the realtime event appear in your browser console immediately!

## Step 4: Verify Application Integration

### Check Connection Status

In your dashboard UI, you should see one of these indicators:

- 🟢 **Realtime Connected** - Everything working!
- 🟡 **Connecting...** - Establishing connection
- 🔴 **Connection Error** - Check your setup

### Debug Connection Issues

1. **Check Environment Variables**:
   ```bash
   # In your .env.local
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   ```

2. **Check Browser Console**:
   - Look for: `"Setting up Supabase Realtime subscription..."`
   - Look for: `"Realtime subscription status: SUBSCRIBED"`

3. **Check Supabase Dashboard**:
   - Go to Database → Replication
   - Ensure `calls` table is checked under "Source"

## Step 5: Monitor Realtime Events

### Expected Event Flow

When a call is created or updated:

```
Telnyx Webhook → Cloudflare Worker → Supabase Insert/Update
    ↓
Supabase Realtime broadcasts postgres_changes event
    ↓
Browser receives event via WebSocket
    ↓
UI updates instantly (no reload!)
```

### Event Types

- **INSERT**: New call created → appears at top of list
- **UPDATE**: Call status/transcript updated → row updates in place
- **DELETE**: Call deleted → removed from list

## Troubleshooting

### Issue: "Connection Error" in UI

**Solution**:
1. Check RLS policies allow SELECT for authenticated users
2. Verify the table is in `supabase_realtime` publication
3. Check browser console for detailed errors

### Issue: Events not appearing

**Solution**:
1. Verify your tenant_id filter isn't blocking events
2. Check RLS policies
3. Ensure the Cloudflare worker is successfully writing to Supabase

### Issue: "404 on /api/calls"

**Solution**:
- This should be fixed by upgrading to `@supabase/ssr`
- Restart your Next.js dev server after the upgrade
- Verify environment variables are set

## Production Checklist

- [ ] `ALTER PUBLICATION supabase_realtime ADD TABLE public.calls;` executed
- [ ] RLS policies configured for tenant isolation
- [ ] Environment variables set in production
- [ ] Cloudflare worker successfully writing to Supabase
- [ ] Realtime connection status shows "Connected" in UI
- [ ] Test call appears instantly without page reload

## Additional Resources

- [Supabase Realtime Docs](https://supabase.com/docs/guides/realtime)
- [Postgres Changes Documentation](https://supabase.com/docs/guides/realtime/postgres-changes)
- [Row Level Security Guide](https://supabase.com/docs/guides/auth/row-level-security)
