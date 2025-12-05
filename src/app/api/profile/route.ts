/**
 * API route for updating user profile (custom_assistant_name)
 * Uses NextAuth for auth + Supabase service-role on the server
 */

export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/../pages/api/auth/[...nextauth]';
import { createClient } from '@supabase/supabase-js';

// --- Supabase admin client (service role, server-only) ---
let supabaseAdmin: ReturnType<typeof createClient> | null = null;

function getSupabaseAdmin() {
  if (supabaseAdmin) {
    return supabaseAdmin;
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars at runtime'
    );
  }

  supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return supabaseAdmin;
}

export async function GET(request: NextRequest) {
  try {
    // 1) Get logged-in user from NextAuth
    const session = await getServerSession(authOptions);

    if (!session?.user || !(session.user as any).id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (session.user as any).id as string;

    // 2) Fetch user's profile
    const { data: profile, error } = await getSupabaseAdmin()
      .from('profiles')
      .select('custom_assistant_name')
      .eq('user_id', userId)
      .single();

    if (error) {
      console.error('Profile query error:', error);
      return NextResponse.json(
        { error: 'Failed to fetch profile' },
        { status: 500 }
      );
    }

    return NextResponse.json(profile);
  } catch (error) {
    console.error('API /profile GET error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest) {
  try {
    // 1) Get logged-in user from NextAuth
    const session = await getServerSession(authOptions);

    if (!session?.user || !(session.user as any).id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (session.user as any).id as string;

    // 2) Parse request body
    const body = await request.json();
    const { custom_assistant_name } = body;

    if (!custom_assistant_name || typeof custom_assistant_name !== 'string') {
      return NextResponse.json(
        { error: 'custom_assistant_name is required and must be a string' },
        { status: 400 }
      );
    }

    if (custom_assistant_name.trim().length === 0) {
      return NextResponse.json(
        { error: 'custom_assistant_name cannot be empty' },
        { status: 400 }
      );
    }

    // 3) Update profile
    const { data: profile, error } = await getSupabaseAdmin()
      .from('profiles')
      .update({
        custom_assistant_name: custom_assistant_name.trim(),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select('custom_assistant_name')
      .single();

    if (error) {
      console.error('Profile update error:', error);
      return NextResponse.json(
        { error: 'Failed to update profile' },
        { status: 500 }
      );
    }

    return NextResponse.json(profile);
  } catch (error) {
    console.error('API /profile PUT error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
