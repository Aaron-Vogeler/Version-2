# NextAuth Setup Guide

This application uses NextAuth with email/password authentication via Supabase for secure authentication.

## Quick Start

### 1. Install Dependencies

```bash
npm install
# or
pnpm install
```

### 2. Setup Supabase Authentication

Your Supabase project should already be configured with email/password authentication enabled. If not:

1. Go to your Supabase project dashboard
2. Navigate to Authentication → Providers
3. Enable "Email" provider if not already enabled
4. Users can be created via Supabase dashboard or the signup page

### 3. Generate NextAuth Secret

Generate a random secret for NextAuth:

```bash
openssl rand -base64 32
```

Copy the output - this will be your `NEXTAUTH_SECRET`.

### 4. Configure Environment Variables

Create a `.env.local` file in the root directory:

```bash
cp .env.example .env.local
```

Edit `.env.local` and add your values:

```env
# Supabase Configuration
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# NextAuth Configuration
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<your-generated-secret-from-step-3>
```

### 5. Run the Application

```bash
npm run dev
```

Visit http://localhost:3000

## Testing Authentication

### Test 1: Session Check

Visit http://localhost:3000/api/me

**Expected Results:**
- **Not logged in**: 401 response with `{ "error": "Unauthorized" }`
- **Logged in**: 200 response with `{ "ok": true, "user": { "name": "...", "email": "...", "image": "..." } }`

### Test 2: Sign In

1. Visit http://localhost:3000/login
2. Enter your email and password (create a user in Supabase first if needed)
3. Click "Sign in"
4. You should be redirected to the dashboard

### Test 3: Protected API Route

Try calling the delegate API:

```bash
curl -X POST http://localhost:3000/api/delegate \
  -H "Content-Type: application/json" \
  -d '{"goal": "sales", "to_number": "+14155551234"}'
```

**Expected Results:**
- **Not logged in**: 401 response with `{ "error": "Unauthorized" }`
- **Logged in** (must test via browser with session cookie): Forwards request to Cloudflare Worker

### Test 4: Dashboard Access

1. Visit http://localhost:3000/dashboard
2. If not logged in, you'll be redirected to /api/auth/signin
3. After signing in, you'll be back at the dashboard
4. Try delegating a call - it should work

### Test 5: Sign Out

1. Click the "Logout" button in the dashboard
2. You should be signed out
3. Trying to access /api/me should return 401

## Production Deployment (Vercel)

### 1. Set Environment Variables in Vercel

Go to your Vercel project → Settings → Environment Variables

Add these variables:

```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
NEXTAUTH_URL=https://your-app.vercel.app
NEXTAUTH_SECRET=<same-secret-from-local>
```

**Important:** Use the same NEXTAUTH_SECRET for all environments to maintain session compatibility.

### 3. Deploy

```bash
vercel --prod
```

Or push to your connected Git repository for automatic deployment.

### 2. Test Production

Visit your production URL and verify:
- Email/password login works
- Dashboard requires authentication
- Delegate calls work when authenticated
- Sign out works

## API Routes

### `/api/auth/[...nextauth]`
- Handles all NextAuth routes (signin, signout, callback, session, etc.)
- Automatically configured by NextAuth

### `/api/me`
- **Method**: GET
- **Auth**: Required
- **Returns**: Current user session
- **Use case**: Check if user is logged in

### `/api/delegate`
- **Method**: POST
- **Auth**: Required
- **Body**: `{ "goal": "sales", "to_number": "+14155551234" }`
- **Returns**: Response from Cloudflare Worker
- **Use case**: Delegate a call (proxied to avoid CORS)

## Optional: Secure Worker with Bearer Token

If you want to add an extra layer of security between your Next.js app and the Cloudflare Worker:

### 1. Generate a Worker Token

```bash
openssl rand -hex 32
```

### 2. Add to Environment Variables

```env
WORKER_TOKEN=<your-generated-token>
```

### 3. Update Cloudflare Worker

Modify your worker to check for the Authorization header:

```typescript
// In your Cloudflare Worker
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Check authorization
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${env.WORKER_TOKEN}`) {
      return new Response('Unauthorized', { status: 401 });
    }

    // ... rest of your worker code
  }
}
```

### 4. Set Worker Environment Variable

In Cloudflare Dashboard → Workers → Your Worker → Settings → Variables:

```
WORKER_TOKEN=<your-generated-token>
```

The Next.js API route (`/api/delegate.ts`) already includes logic to send this token if `WORKER_TOKEN` is set.

## Troubleshooting

### Issue: "Invalid email or password"

**Solution**:
- Make sure the user exists in Supabase (check Authentication → Users)
- Verify email and password are correct
- Check that Supabase email provider is enabled

### Issue: "NEXTAUTH_SECRET not set"

**Solution**: Make sure you've set `NEXTAUTH_SECRET` in your `.env.local` file and it's at least 32 characters.

### Issue: "User keeps getting redirected to signin"

**Solution**:
- Clear browser cookies
- Regenerate NEXTAUTH_SECRET
- Make sure NEXTAUTH_URL matches your current domain
- Check browser console for errors

### Issue: "401 Unauthorized on /api/delegate"

**Solution**:
- Make sure you're logged in (check /api/me)
- Session cookies must be enabled in browser
- Try signing out and back in

### Issue: "CORS errors"

**Solution**: You shouldn't see CORS errors because we're using server-side proxy. If you do:
- Make sure you're calling /api/delegate (not the worker directly)
- Check that fetch is using relative URL `/api/delegate` not absolute URL

## Security Notes

- ✅ All API routes use server-side session checking
- ✅ No CORS issues - worker is called server-to-server
- ✅ Email/password authentication via Supabase with secure session management
- ✅ Session uses secure JWT tokens with NextAuth
- ✅ Optional worker authentication with bearer token
- ✅ NEXTAUTH_SECRET should be kept secret and rotated periodically
- ✅ Passwords are securely hashed and managed by Supabase

## Architecture

```
User Browser
    ↓
  Dashboard (Client-side React)
    ↓
  /api/delegate (Server-side Next.js API - checks auth)
    ↓
  Cloudflare Worker (telnyx-webhook.aaronmvogeler.workers.dev)
    ↓
  Telnyx API
```

**Benefits:**
- No CORS issues (server-to-server)
- Secure authentication required
- Worker can be protected with bearer token
- Clean separation of concerns

## File Structure

```
pages/
  api/
    auth/
      [...nextauth].ts    # NextAuth configuration
    delegate.ts            # Protected proxy to worker
    me.ts                  # Session test endpoint

src/
  components/
    dashboard/
      delegate-call.tsx    # Form that calls /api/delegate
  app/
    dashboard/
      page.tsx             # Dashboard with login/logout
```

## Environment Variables Summary

| Variable | Required | Description | Example |
|----------|----------|-------------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Your Supabase project URL | `https://xxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Yes | Supabase anonymous key | `eyJhb...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key | `eyJhb...` |
| `NEXTAUTH_URL` | Yes | Your app URL | `http://localhost:3000` |
| `NEXTAUTH_SECRET` | Yes | Random secret (32+ chars) | `generated-with-openssl` |
| `WORKER_TOKEN` | No | Optional worker auth token | `generated-with-openssl` |

## Quick Checklist

- [ ] Supabase project created with email authentication enabled
- [ ] At least one test user created in Supabase
- [ ] NEXTAUTH_SECRET generated
- [ ] .env.local created and populated with Supabase credentials
- [ ] `npm install` completed
- [ ] `npm run dev` running
- [ ] Can sign in with email/password at /login
- [ ] /api/me returns user data when logged in
- [ ] Dashboard redirects to /login when not authenticated
- [ ] Delegate call works when authenticated
- [ ] Sign out works
- [ ] Production environment variables set in Vercel
- [ ] Production deployment successful
- [ ] Production authentication works

---

Need help? Check the [Next Auth documentation](https://next-auth.js.org/) or open an issue.
