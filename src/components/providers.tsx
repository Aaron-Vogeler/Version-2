'use client';

/**
 * Client-side providers wrapper for NextAuth SessionProvider
 */

import { SessionProvider } from 'next-auth/react';

export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>;
}
