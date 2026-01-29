'use client';

/**
 * Login page with email/password authentication via NextAuth
 * Features animated bird fly-off on successful login
 */

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { signIn } from 'next-auth/react';
import { Great_Vibes } from 'next/font/google';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

const greatVibes = Great_Vibes({ weight: '400', subsets: ['latin'] });

// TODO: Set to false for production
const SKIP_BIRD_ANIMATION = false;
const AUTO_LOGIN_ENABLED = false;
const AUTO_LOGIN_EMAIL = 'aaronmvogeler@gmail.com';
const AUTO_LOGIN_PASSWORD = 'Testing#1';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState(AUTO_LOGIN_ENABLED ? AUTO_LOGIN_EMAIL : '');
  const [password, setPassword] = useState(AUTO_LOGIN_ENABLED ? AUTO_LOGIN_PASSWORD : '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loginSuccess, setLoginSuccess] = useState(false);
  const birdRef = useRef<HTMLDivElement>(null);

  // Auto-login on mount if enabled
  useEffect(() => {
    if (AUTO_LOGIN_ENABLED && email && password && !loading && !loginSuccess) {
      // Small delay to let the page render first
      const timer = setTimeout(() => {
        handleAutoLogin();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleAutoLogin = async () => {
    setLoading(true);
    setError(null);

    try {
      const result = await signIn('credentials', {
        email: AUTO_LOGIN_EMAIL,
        password: AUTO_LOGIN_PASSWORD,
        redirect: false,
      });

      if (result?.error) {
        setError('Auto-login failed: Invalid credentials');
        return;
      }

      if (result?.ok) {
        if (SKIP_BIRD_ANIMATION) {
          router.push('/dashboard');
          router.refresh();
        } else {
          setLoginSuccess(true);
        }
      }
    } catch (err: any) {
      setError(err.message || 'Auto-login failed');
    } finally {
      setLoading(false);
    }
  };

  // Handle redirect after animation completes
  useEffect(() => {
    if (loginSuccess && !SKIP_BIRD_ANIMATION) {
      // Pre-fetch dashboard for instant transition
      router.prefetch('/dashboard');

      // Redirect when bird exits: 5s flight - 0.5s early = 4.5s
      const redirectTimer = setTimeout(() => {
        router.push('/dashboard');
        router.refresh();
      }, 4500);

      return () => clearTimeout(redirectTimer);
    }
  }, [loginSuccess, router]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      // Sign in with NextAuth credentials
      const result = await signIn('credentials', {
        email,
        password,
        redirect: false,
      });

      if (result?.error) {
        setError('Invalid email or password');
        return;
      }

      if (result?.ok) {
        if (SKIP_BIRD_ANIMATION) {
          router.push('/dashboard');
          router.refresh();
        } else {
          // Trigger the login success animation
          setLoginSuccess(true);
        }
      }
    } catch (err: any) {
      setError(err.message || 'Failed to login');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-lg">
        {/* Bird - static until login, then flaps and flies */}
        <div className="flex justify-center mb-4">
          <div
            ref={birdRef}
            className={`login-bird-inline ${loginSuccess ? 'login-bird-flying' : ''}`}
          >
            {/* Flapping class added only after login success */}
            <div className={`bird-wings-up ${loginSuccess ? 'flapping' : ''}`}></div>
            <div className={`bird-wings-down ${loginSuccess ? 'flapping' : ''}`}></div>
          </div>
        </div>

        {/* Content that fades out and moves down */}
        <div className={loginSuccess ? 'login-content-fade-out' : ''}>
          <div className="text-center mb-10">
            <h1 className={`${greatVibes.className} text-5xl lg:text-6xl tracking-tight text-foreground mb-3`}>
              Pigeon
            </h1>
            <p className="text-lg text-foreground-secondary italic">
              More done. Less time. Fewer headaches.
            </p>
          </div>

        {/* Login Card */}
        <Card className="shadow-elevated">
          <form onSubmit={handleLogin}>
            <CardContent className="space-y-6 pt-8">
              {error && (
                <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-4 text-base text-destructive">
                  {error}
                </div>
              )}
              <div className="space-y-3">
                <Label htmlFor="email">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={loading || loginSuccess}
                />
              </div>
              <div className="space-y-3">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  disabled={loading || loginSuccess}
                />
              </div>
              <Button type="submit" className="w-full" size="lg" disabled={loading || loginSuccess}>
                {loading ? 'Signing in...' : loginSuccess ? 'Success!' : 'Sign in'}
              </Button>
            </CardContent>
          </form>
        </Card>

          {/* Sign up link */}
          <p className="text-center text-base text-foreground-secondary mt-8">
            Don&apos;t have an account?{' '}
            <Link href="/signup" className="text-primary hover:text-primary/80 font-medium transition-colors">
              Create an account
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
