# NextAuth Setup Guide

This application uses NextAuth with GitHub OAuth for secure authentication.

## Quick Start

### 1. Install Dependencies

```bash
npm install
# or
pnpm install
```

### 2. Create GitHub OAuth App

1. Go to GitHub Settings → Developer settings → OAuth Apps
2. Click "New OAuth App"
3. Fill in the details:
   - **Application name**: Telnyx CRM Dashboard
   - **Homepage URL**: `http://localhost:3000` (for development)
   - **Authorization callback URL**: `http://localhost:3000/api/auth/callback/github`
4. Click "Register application"
5. **Copy the Client ID** - you'll need this
6. Click "Generate a new client secret" and **copy the secret** - you'll need this too

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
# NextAuth Configuration
NEXTAUTH_URL=http://localhost:3000
NEXTAUTH_SECRET=<your-generated-secret-from-step-3>
GITHUB_CLIENT_ID=<your-github-client-id-from-step-2>
GITHUB_CLIENT_SECRET=<your-github-client-secret-from-step-2>
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

1. Visit http://localhost:3000/api/auth/signin
2. Click "Sign in with GitHub"
3. Authorize the application (if first time)
4. You should be redirected back to the app

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

### 1. Update GitHub OAuth App

Add your production URLs:
- **Homepage URL**: `https://your-app.vercel.app`
- **Authorization callback URL**: `https://your-app.vercel.app/api/auth/callback/github`

### 2. Set Environment Variables in Vercel

Go to your Vercel project → Settings → Environment Variables

Add these variables:

```
NEXTAUTH_URL=https://your-app.vercel.app
NEXTAUTH_SECRET=<same-secret-from-local>
GITHUB_CLIENT_ID=<same-client-id-from-local>
GITHUB_CLIENT_SECRET=<same-client-secret-from-local>
```

**Important:** Use the same NEXTAUTH_SECRET for all environments to maintain session compatibility.

### 3. Deploy

```bash
vercel --prod
```

Or push to your connected Git repository for automatic deployment.

### 4. Test Production

Visit your production URL and verify:
- Sign in with GitHub works
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

### Issue: "Invalid callback URL"

**Solution**: Make sure your GitHub OAuth app callback URL matches exactly:
- Local: `http://localhost:3000/api/auth/callback/github`
- Production: `https://your-app.vercel.app/api/auth/callback/github`

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
- ✅ GitHub OAuth tokens are never exposed to the client
- ✅ Session uses secure JWT tokens
- ✅ Optional worker authentication with bearer token
- ✅ NEXTAUTH_SECRET should be kept secret and rotated periodically

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
| `NEXTAUTH_URL` | Yes | Your app URL | `http://localhost:3000` |
| `NEXTAUTH_SECRET` | Yes | Random secret (32+ chars) | `generated-with-openssl` |
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth Client ID | `abc123...` |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth Client Secret | `xyz789...` |
| `WORKER_TOKEN` | No | Optional worker auth token | `generated-with-openssl` |

## Quick Checklist

- [ ] GitHub OAuth App created
- [ ] Client ID and Secret copied
- [ ] NEXTAUTH_SECRET generated
- [ ] .env.local created and populated
- [ ] `npm install` completed
- [ ] `npm run dev` running
- [ ] Can sign in with GitHub
- [ ] /api/me returns user data when logged in
- [ ] Dashboard redirects to signin when not logged in
- [ ] Delegate call works when authenticated
- [ ] Sign out works
- [ ] Production environment variables set in Vercel
- [ ] Production deployment successful
- [ ] Production authentication works

---

Need help? Check the [Next Auth documentation](https://next-auth.js.org/) or open an issue.
