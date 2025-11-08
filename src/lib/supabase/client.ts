/**
 * Supabase client for browser/client-side usage
 */

import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';

export function createClient() {
  return createClientComponentClient();
}
