# Live Transcript Setup & Testing Guide

This guide covers the complete setup for displaying live call transcripts with Supabase Realtime.

## ✅ What Was Implemented

### 1. Database Types Updated
**File:** `/src/lib/types/database.ts`
- Added `live_transcript: string | null` field to `calls` table
- Added `transcription_url: string | null` field to `calls` table

### 2. LiveTranscript Component Created
**File:** `/src/components/dashboard/live-transcript.tsx`
- Real-time Supabase subscription for `live_transcript` updates
- Auto-scrolling transcript display
- Live indicator badge with pulse animation
- Handles both live updates and completed transcripts
- Fallback UI for empty/pending states

**Key Features:**
```typescript
- Subscribes to: postgres_changes → table: 'calls', filter: `id=eq.{callId}`
- Updates on: live_transcript, status fields
- Auto-scrolls: As new transcript text arrives
- Live badge: Shows when call is in progress
```

### 3. CallDetailModal Updated
**File:** `/src/components/dashboard/call-detail-modal.tsx`
- Replaced static transcript display with `<LiveTranscript />` component
- Maintains audio playback, feedback, and timeline features
- Added support for both `transcript_url` and `transcription_url`

### 4. Standalone Call Detail Page
**File:** `/src/app/calls/[id]/page.tsx`
- Full-page view for individual calls
- Two-column layout: Stats (left) + Live Transcript (right)
- Audio player for recordings
- Goal status and timestamps
- Direct URL access: `/calls/{call-id}`

---

## 🔧 Environment Setup

### Required Environment Variables (Already Configured)

Your `.env.local` or Vercel environment variables must include:

```env
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

**Verify in Vercel:**
1. Go to Vercel Dashboard → Your Project → Settings → Environment Variables
2. Confirm all three variables are set
3. Redeploy if you just added them

---

## 📊 Supabase Realtime Configuration

### 1. Enable Realtime on `calls` Table

In your Supabase Dashboard:

1. Go to **Database** → **Replication**
2. Find the `calls` table
3. Enable the following columns for replication:
   - ✅ `id` (required for filtering)
   - ✅ `live_transcript`
   - ✅ `status`
   - ✅ `transcript`

**OR** run this SQL:

```sql
-- Enable realtime for calls table
ALTER PUBLICATION supabase_realtime ADD TABLE calls;

-- Verify it's enabled
SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
```

### 2. Verify RLS Policies Allow Reads

Ensure your Row Level Security (RLS) policies allow authenticated users to read calls:

```sql
-- Check existing policies
SELECT * FROM pg_policies WHERE tablename = 'calls';

-- If needed, add a read policy
CREATE POLICY "Users can read their tenant's calls"
  ON calls
  FOR SELECT
  USING (
    tenant_id IN (
      SELECT tenant_id FROM profiles WHERE user_id = auth.uid()
    )
  );
```

---

## 🧪 Testing Live Transcripts

### Test 1: Verify Supabase Realtime Connection

1. **Open your app** in the browser
2. **Open Developer Tools** → Console
3. **Navigate to** Dashboard → All Calls tab
4. **Click on a call** to open the detail modal
5. **Check console logs** for:
   ```
   Realtime subscription status: SUBSCRIBED
   ```

If you see connection errors, verify:
- Supabase URL/Keys are correct
- Realtime is enabled on `calls` table
- RLS policies allow reads

### Test 2: Simulate Live Transcript Update

**Manual Database Update:**

1. Find an active call ID in your Supabase dashboard
2. Go to **Table Editor** → `calls` table
3. Open a call detail modal in your app for that call
4. In Supabase, edit the `live_transcript` field and add text
5. **Expected Result:** Transcript should update in real-time in the UI

**Using SQL:**

```sql
-- Update live_transcript for testing
UPDATE calls
SET
  live_transcript = 'Speaker: Hello, this is a test transcript update at ' || NOW(),
  updated_at = NOW()
WHERE id = 'your-call-id-here';
```

**Expected Behavior:**
- ✅ Transcript appears in UI within 1-2 seconds
- ✅ Auto-scrolls to bottom
- ✅ "LIVE" badge shows if call is in progress
- ✅ Last update timestamp displays

### Test 3: End-to-End with Telnyx Call

**Prerequisites:**
- AI Server is deployed to Fly.io and receiving Telnyx webhooks
- AI Server is writing to Supabase `calls` table

**Steps:**

1. **Trigger a call** via "Delegate A Call" form in dashboard
2. **Immediately navigate** to Dashboard → All Calls
3. **Click on the new call** to open detail modal
4. **Go to Transcript tab**
5. **Watch for updates** as Cloudflare Worker writes live_transcript

**What Should Happen:**
1. Call appears in table with status "initiated" or "ringing"
2. Modal opens showing "Waiting for transcript..." with LIVE badge
3. As call progresses → AI Server updates `live_transcript` in real-time
4. UI updates automatically every few seconds via Supabase Realtime
5. When call ends, status changes to "completed" and LIVE badge disappears
6. Final transcript is retained

---

## 🔍 Troubleshooting

### Issue: "Realtime subscription status: CHANNEL_ERROR"

**Solutions:**
- Check Supabase project is not paused
- Verify realtime is enabled on `calls` table (Database → Replication)
- Check anon key has correct permissions

### Issue: Transcript not updating in real-time

**Solutions:**
1. **Check console logs** for subscription status
2. **Verify RLS policies** allow reads:
   ```sql
   SELECT * FROM pg_policies WHERE tablename = 'calls';
   ```
3. **Test manual update** in Supabase Table Editor
4. **Check AI Server** is actually writing to `live_transcript` field
5. **Verify Supabase URL** matches between AI Server and Frontend

### Issue: "No transcript available"

**Solutions:**
- Verify AI Server is writing to `live_transcript` OR `transcript` column
- Check AI Server logs with `fly logs` for errors
- Ensure Deepgram is successfully transcribing audio
- Verify call status is correct (`answered`, not `failed`)

### Issue: Multiple subscriptions causing lag

**Solution:** The component automatically cleans up subscriptions on unmount. If you suspect issues:
```typescript
// Check active channels in console:
supabase.getChannels()
```

---

## 🚀 Deployment Checklist

Before deploying to production:

### Vercel
- [ ] All environment variables set (NEXT_PUBLIC_SUPABASE_URL, ANON_KEY, SERVICE_ROLE_KEY)
- [ ] Build succeeds without TypeScript errors
- [ ] No console errors on production URL

### Supabase
- [ ] Realtime enabled on `calls` table
- [ ] RLS policies allow tenant-scoped reads
- [ ] Columns `live_transcript`, `transcript`, `transcription_url` exist
- [ ] Test database update shows in UI within 2 seconds

### AI Server (Fly.io)
- [ ] AI Server is writing to `live_transcript` field
- [ ] AI Server has correct Supabase credentials
- [ ] Telnyx webhooks and WebSocket streams reach AI Server
- [ ] AI Server logs show successful database inserts

### End-to-End
- [ ] Make a test call through Telnyx
- [ ] Verify call appears in dashboard
- [ ] Open call detail modal
- [ ] Confirm transcript updates live
- [ ] Check recording plays if available
- [ ] Verify final transcript persists after call ends

---

## 📁 File Reference

### New Files Created
```
/src/components/dashboard/live-transcript.tsx   - Realtime transcript component
/src/app/calls/[id]/page.tsx                    - Standalone call detail page
/LIVE_TRANSCRIPT_SETUP.md                        - This documentation
```

### Files Modified
```
/src/lib/types/database.ts                       - Added live_transcript field
/src/components/dashboard/call-detail-modal.tsx - Uses LiveTranscript component
```

---

## 🎯 Quick Test Command

To quickly verify everything works:

1. **Start dev server:**
   ```bash
   npm run dev
   ```

2. **Open browser console and run:**
   ```javascript
   // Test Supabase connection
   fetch('/api/calls').then(r => r.json()).then(console.log)
   ```

3. **Open a call detail modal** and check console for:
   ```
   Realtime subscription status: SUBSCRIBED
   ```

4. **In another browser tab,** open Supabase Table Editor and update `live_transcript`

5. **Watch the UI update** automatically

---

## 🔗 Useful Links

- **Supabase Realtime Docs:** https://supabase.com/docs/guides/realtime
- **Next.js App Router:** https://nextjs.org/docs/app
- **Telnyx Webhooks:** https://developers.telnyx.com/docs/api/v2/call-control/Webhooks

---

## ✨ Success Criteria

Your implementation is working correctly if:

1. ✅ Console shows "Realtime subscription status: SUBSCRIBED"
2. ✅ Manual database updates appear in UI within 2 seconds
3. ✅ Transcript auto-scrolls to bottom on updates
4. ✅ LIVE badge appears during active calls
5. ✅ Completed calls show final transcript
6. ✅ No CORS or authentication errors in console
7. ✅ Multiple users can view same call simultaneously
8. ✅ Subscription cleans up when modal closes

---

**Need Help?**
- Check Vercel deployment logs
- Review Supabase Realtime logs (Dashboard → Logs)
- Inspect Network tab for failed WebSocket connections
- Verify AI Server is running on Fly.io: `fly logs`
