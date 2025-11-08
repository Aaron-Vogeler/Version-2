# Vercel Environment Variables Setup

## Required Environment Variables

Your app is failing because these environment variables are not set in Vercel. Follow these steps to fix it:

### 1. Go to Vercel Project Settings
- Visit https://vercel.com/dashboard
- Select your project
- Go to **Settings** → **Environment Variables**

### 2. Add These Required Variables

#### Supabase Configuration
```
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

**Where to find these:**
1. Go to your Supabase project dashboard
2. Click **Settings** → **API**
3. Copy **Project URL** → Use for `NEXT_PUBLIC_SUPABASE_URL`
4. Copy **anon public** key → Use for `NEXT_PUBLIC_SUPABASE_ANON_KEY`
5. Copy **service_role** key → Use for `SUPABASE_SERVICE_ROLE_KEY`

#### NextAuth Configuration
```
NEXTAUTH_URL=https://your-app.vercel.app
NEXTAUTH_SECRET=your-secret-key-here
```

**How to generate NEXTAUTH_SECRET:**
```bash
openssl rand -base64 32
```
Copy the output and use it as your `NEXTAUTH_SECRET`.

**NEXTAUTH_URL:**
- Use your full Vercel deployment URL
- Example: `https://version-2-mu.vercel.app`
- Do NOT include trailing slash

### 3. Redeploy
After adding all environment variables:
1. Go to **Deployments** tab
2. Click the three dots on the latest deployment
3. Select **Redeploy**
4. Check "Use existing Build Cache" OFF

### 4. Verify Setup
Once redeployed, visit your app and try to log in. Check these:
- [ ] No 500 error on `/api/auth/session`
- [ ] Login form accepts email/password
- [ ] Successful login redirects to dashboard
- [ ] "Delegate A Call" button works

## Common Issues

### Issue: "NEXTAUTH_SECRET must be set" error
**Solution:** Make sure you've added `NEXTAUTH_SECRET` in Vercel environment variables and redeployed.

### Issue: "NEXT_PUBLIC_SUPABASE_URL must be set" error
**Solution:** Make sure you've added all three Supabase variables and redeployed.

### Issue: Login form just refreshes
**Solution:**
1. Check Vercel deployment logs for errors
2. Verify user exists in Supabase (Authentication → Users)
3. Check that email/password match exactly

### Issue: Still seeing 500 errors
**Solution:**
1. Check Vercel **Functions** logs to see detailed error messages
2. Make sure all environment variables are spelled correctly
3. Try redeploying with build cache cleared

## Quick Checklist

Copy this checklist to verify your setup:

```
Vercel Environment Variables:
[ ] NEXT_PUBLIC_SUPABASE_URL - Set and correct
[ ] NEXT_PUBLIC_SUPABASE_ANON_KEY - Set and correct
[ ] SUPABASE_SERVICE_ROLE_KEY - Set and correct
[ ] NEXTAUTH_URL - Set to https://your-app.vercel.app
[ ] NEXTAUTH_SECRET - Generated with openssl and set
[ ] Redeployed after setting variables
[ ] Build cache cleared during redeploy

Supabase Setup:
[ ] Email authentication provider enabled
[ ] At least one test user created
[ ] User email confirmed (if required)

Testing:
[ ] Can access /login page
[ ] Can submit login form
[ ] No 500 errors in browser console
[ ] Successful login redirects to /dashboard
```

## Need Help?

If you're still having issues:
1. Check Vercel deployment logs (Functions tab)
2. Check browser console for detailed error messages
3. Verify environment variables are in the correct format (no extra spaces, quotes, etc.)
