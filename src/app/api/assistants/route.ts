/**
 * API route for listing assistants
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// This tells Next.js that this route is always dynamic
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const supabase = createClient();

    // Get current user
    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch assistants for this user
    const { data: assistants, error } = await supabase
      .from('assistants')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Assistants query error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch assistants' },
        { status: 500 }
      );
    }

    return NextResponse.json({ assistants });
  } catch (error) {
    console.error('API /assistants error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
