'use client';

/**
 * Signup page for new user registration
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const supabase = createClient();

      // Note: In production, you'd need to handle tenant assignment
      // This could be done via:
      // 1. Invite-only signups with tenant_id in invite link
      // 2. Admin creates users and assigns to tenant
      // 3. First user creates tenant, subsequent users join via invite

      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            // tenant_id would be set here if known
          },
        },
      });

      if (error) throw error;

      // Show success message
      alert('Check your email to confirm your account!');
      router.push('/login');
    } catch (err: any) {
      setError(err.message || 'Failed to sign up');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="text-center mb-10">
          <h1 className="text-4xl lg:text-5xl font-bold tracking-tight text-foreground mb-3">
            Get Started
          </h1>
          <p className="text-lg text-foreground-secondary">
            Create your account to access AI Call Dashboard
          </p>
        </div>

        {/* Signup Card */}
        <Card className="shadow-elevated">
          <form onSubmit={handleSignup}>
            <CardContent className="space-y-6 pt-8">
              {error && (
                <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-4 text-base text-destructive">
                  {error}
                </div>
              )}
              <div className="space-y-3">
                <Label htmlFor="fullName">Full Name</Label>
                <Input
                  id="fullName"
                  type="text"
                  placeholder="John Doe"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  disabled={loading}
                />
              </div>
              <div className="space-y-3">
                <Label htmlFor="email">Email Address</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  disabled={loading}
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
                  minLength={6}
                  disabled={loading}
                />
                <p className="text-sm text-foreground-muted">
                  Password must be at least 6 characters
                </p>
              </div>
              <Button type="submit" className="w-full" size="lg" disabled={loading}>
                {loading ? 'Creating account...' : 'Create account'}
              </Button>
            </CardContent>
          </form>
        </Card>

        {/* Sign in link */}
        <p className="text-center text-base text-foreground-secondary mt-8">
          Already have an account?{' '}
          <Link href="/login" className="text-primary hover:text-primary/80 font-medium transition-colors">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
