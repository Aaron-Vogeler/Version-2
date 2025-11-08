/**
 * API route for listing assistants
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  try {
    const supabase = createClient();

    // Get current user and tenant
    const { data: { user }, error: userError } = await supabase.auth.getUser();

    if (userError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Get user's tenant_id
    const { data: profile } = await supabase
      .from('profiles')
      .select('tenant_id')
      .eq('user_id', user.id)
      .single();

    if (!profile) {
      return NextResponse.json({ error: 'Profile not found' }, { status: 404 });
    }

    const tenantId = profile.tenant_id;

    // Fetch assistants
    const { data: assistants, error } = await supabase
      .from('assistants')
      .select('*')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Assistants query error:', error);
      return NextResponse.json({ error: 'Failed to fetch assistants' }, { status: 500 });
    }

    return NextResponse.json({ assistants });
  } catch (error) {
    console.error('API /assistants error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
