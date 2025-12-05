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

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loginSuccess, setLoginSuccess] = useState(false);
  const [birdPosition, setBirdPosition] = useState<{ top: number; left: number } | null>(null);
  const birdRef = useRef<HTMLImageElement>(null);

  // Handle redirect after animation completes
  useEffect(() => {
    if (loginSuccess) {
      // Redirect after bird flies off (3 seconds)
      const redirectTimer = setTimeout(() => {
        router.push('/dashboard');
        router.refresh();
      }, 3000);

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
        // Get the bird's current position before starting animation
        if (birdRef.current) {
          const rect = birdRef.current.getBoundingClientRect();
          setBirdPosition({
            top: rect.top,
            left: rect.left,
          });
        }
        // Trigger the login success animation
        setLoginSuccess(true);
      }
    } catch (err: any) {
      setError(err.message || 'Failed to login');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      {/* Animated bird overlay - appears on successful login */}
      {loginSuccess && birdPosition && (
        <div className="login-bird-overlay" aria-hidden="true">
          <div
            className="login-bird-flight"
            style={{
              top: birdPosition.top,
              left: birdPosition.left,
            }}
          >
            <div className="login-bird">
              <div className="bird-wings-up"></div>
              <div className="bird-wings-down"></div>
            </div>
          </div>
        </div>
      )}

      <div className={`w-full max-w-lg ${loginSuccess ? 'login-content-fade-out' : ''}`}>
        {/* Header */}
        <div className="text-center mb-10">
          <div className="flex justify-center mb-4">
            <img
              ref={birdRef}
              src="/assets/bird/Wings Up.png"
              alt="Pidgeon"
              className={`h-32 w-32 transition-opacity duration-0 ${loginSuccess ? 'login-bird-hidden' : ''}`}
            />
          </div>
          <h1 className={`${greatVibes.className} text-5xl lg:text-6xl tracking-tight text-foreground mb-3`}>
            Pidgeon
          </h1>
          <p className="text-lg text-foreground-secondary italic">
            More time and sanity awaits you...
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
  );
}
