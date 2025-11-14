/**
 * NextAuth configuration
 * Handles email/password authentication with Supabase
 */

import NextAuth, { NextAuthOptions } from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';
import { createClient } from '@supabase/supabase-js';

// --- ENV VALIDATION -------------------------------------------------

if (!process.env.NEXTAUTH_SECRET) {
  throw new Error('NEXTAUTH_SECRET must be set');
}

if (!process.env.NEXTAUTH_URL) {
  // Not strictly required in dev, but avoids a lot of weird auth issues in prod
  throw new Error('NEXTAUTH_URL must be set (e.g. https://your-domain.com)');
}

if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL must be set');
}

if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  throw new Error('NEXT_PUBLIC_SUPABASE_ANON_KEY must be set');
}

// --------------------------------------------------------------------

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: 'Email & Password',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, req) {
        // 1) Basic validation of form fields
        if (!credentials?.email || !credentials?.password) {
          console.error('[NextAuth] Missing email or password in credentials');
          // Returning null => 401
          return null;
        }

        try {
          // 2) Supabase client (server-side, anon key is correct here)
          const supabase = createClient(
            process.env.NEXT_PUBLIC_SUPABASE_URL!,
            process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
            {
              auth: {
                persistSession: false, // no browser storage on the server
              },
            }
          );

          // 3) Try logging in with Supabase Auth
          const { data, error } = await supabase.auth.signInWithPassword({
            email: credentials.email,
            password: credentials.password,
          });

          if (error) {
            // This is the *real* reason the login fails
            console.error('[NextAuth] Supabase auth error:', error.message);
            // Tell NextAuth it’s a bad login (401)
            // If you’d rather see the message on the URL, you can throw instead.
            return null;
          }

          if (!data.user) {
            console.error('[NextAuth] No user returned from Supabase');
            return null;
          }

          // 4) Map Supabase user -> NextAuth user object
          const user = {
            id: data.user.id,
            email: data.user.email!,
            name: data.user.user_metadata?.name || data.user.email,
          };

          console.log('[NextAuth] Login OK for user', user.id);
          return user;
        } catch (e: any) {
          console.error('[NextAuth] Unexpected authorize() error:', e);
          // Returning null keeps it as a 401 rather than a 500
          return null;
        }
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
      // On sign-in, attach user data to token
      if (user) {
        token.id = (user as any).id;
        token.email = user.email;
        token.name = user.name;
      }
      return token;
    },
    async session({ session, token }) {
      // Expose those fields to the client via session.user
      if (session.user) {
        (session.user as any).id = token.id;
        session.user.email = token.email as string;
        session.user.name = token.name as string;
      }
      return session;
    },
  },
};

export default NextAuth(authOptions);
