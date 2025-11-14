/**
 * NextAuth configuration
 * Handles email/password authentication with Supabase
 */

import type { NextAuthOptions } from 'next-auth';
import NextAuth from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { createClient } from '@supabase/supabase-js';

// ---- Environment validation ----
if (!process.env.NEXTAUTH_SECRET) {
  throw new Error('NEXTAUTH_SECRET must be set');
}

if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL must be set');
}

if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY must be set');
}

// A tiny helper so we always create Supabase correctly on the server
function createSupabaseServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL as string,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string,
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    }
  );
}

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      id: 'credentials',
      name: 'Credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          console.error('[NextAuth] Missing email or password in credentials');
          throw new Error('Email and password are required');
        }

        const supabase = createSupabaseServerClient();

        // Try to sign in with Supabase
        const { data, error } = await supabase.auth.signInWithPassword({
          email: credentials.email,
          password: credentials.password,
        });

        if (error) {
          // This will show up in your Vercel logs
          console.error('[NextAuth] Supabase signInWithPassword error:', {
            message: error.message,
            status: error.status,
          });
          // Tell NextAuth that credentials are invalid
          throw new Error('Invalid email or password');
        }

        if (!data.user) {
          console.error('[NextAuth] No user returned from Supabase');
          throw new Error('Invalid email or password');
        }

        // ✅ Successful login – return a plain object with user info
        return {
          id: data.user.id,
          email: data.user.email ?? credentials.email,
          name: data.user.user_metadata?.name || data.user.email || credentials.email,
        };
      },
    }),
  ],

  secret: process.env.NEXTAUTH_SECRET,
  debug: process.env.NODE_ENV === 'development',

  session: {
    strategy: 'jwt',
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },

  pages: {
    signIn: '/login',
    signOut: '/login',
    error: '/login',
  },

  callbacks: {
    async jwt({ token, user }) {
      // When the user just signed in, attach their info to the token
      if (user) {
        token.id = user.id;
        token.email = user.email;
        token.name = user.name;
      }
      return token;
    },

    async session({ session, token }) {
      // Expose the user id/email/name on the session object
      if (session.user && token) {
        (session.user as any).id = token.id;
        session.user.email = token.email as string;
        session.user.name = token.name as string;
      }
      return session;
    },
  },
};

export default NextAuth(authOptions);
