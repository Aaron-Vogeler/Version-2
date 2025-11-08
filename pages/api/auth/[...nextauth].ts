/**
 * NextAuth configuration
 * Handles GitHub OAuth authentication
 */

import NextAuth, { NextAuthOptions } from 'next-auth';
import GitHubProvider from 'next-auth/providers/github';

export const authOptions: NextAuthOptions = {
  providers: [
    GitHubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
  secret: process.env.NEXTAUTH_SECRET,
  session: {
    strategy: 'jwt',
  },
  pages: {
    signIn: '/api/auth/signin',
    signOut: '/api/auth/signout',
    error: '/api/auth/error',
  },
  callbacks: {
    async jwt({ token, account, profile }) {
      // Persist the OAuth access_token to the token right after signin
      if (account) {
        token.accessToken = account.access_token;
      }
      if (profile) {
        token.login = (profile as any).login;
      }
      return token;
    },
    async session({ session, token }) {
      // Send properties to the client
      if (token && session.user) {
        (session.user as any).login = token.login;
      }
      return session;
    },
  },
};

export default NextAuth(authOptions);
