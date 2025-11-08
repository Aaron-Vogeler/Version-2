-- Seed script for Telnyx CRM Dashboard
-- Creates sample tenant, users, calls, and events for testing

-- ============================================================================
-- CREATE SAMPLE TENANT
-- ============================================================================
INSERT INTO public.tenants (id, name, created_at)
VALUES
  ('00000000-0000-0000-0000-000000000001', 'Acme Corporation', NOW())
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- CREATE SAMPLE USERS (requires manual auth.users creation via Supabase Auth)
-- After creating users via Supabase Auth UI or API, link them to profiles
-- ============================================================================

-- Note: To create actual users, use the Supabase dashboard or API:
-- 1. Go to Authentication > Users > Add User
-- 2. Create user with email/password
-- 3. Get the user UUID
-- 4. Insert into profiles table below

-- Sample profiles (update user_id with actual UUIDs from auth.users)
-- Example usage after creating users:
/*
INSERT INTO public.profiles (user_id, tenant_id, role, full_name)
VALUES
  ('your-admin-user-uuid-here', '00000000-0000-0000-0000-000000000001', 'admin', 'Admin User'),
  ('your-member-user-uuid-here', '00000000-0000-0000-0000-000000000001', 'member', 'Member User')
ON CONFLICT (user_id) DO NOTHING;
*/

-- ============================================================================
-- CREATE SAMPLE CALLS
-- ============================================================================
INSERT INTO public.calls (
  id, tenant_id, direction, from_e164, to_e164, status,
  started_at, answered_at, ended_at,
  duration_sec, billable_sec, cost_usd,
  goal, goal_status, recording_url, transcript_status,
  created_at
)
VALUES
  -- Completed outbound sales call
  (
    'call_00001',
    '00000000-0000-0000-0000-000000000001',
    'outbound',
    '+14155551234',
    '+14155555678',
    'completed',
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '2 hours' + INTERVAL '5 seconds',
    NOW() - INTERVAL '2 hours' + INTERVAL '5 minutes',
    300,
    295,
    0.0150,
    'sales',
    'achieved',
    'https://example.com/recordings/call_00001.mp3',
    'completed',
    NOW() - INTERVAL '2 hours'
  ),
  -- Completed inbound support call
  (
    'call_00002',
    '00000000-0000-0000-0000-000000000001',
    'inbound',
    '+14155559999',
    '+14155551234',
    'completed',
    NOW() - INTERVAL '1 hour',
    NOW() - INTERVAL '1 hour' + INTERVAL '3 seconds',
    NOW() - INTERVAL '1 hour' + INTERVAL '8 minutes',
    480,
    477,
    0.0240,
    'support',
    'achieved',
    'https://example.com/recordings/call_00002.mp3',
    'completed',
    NOW() - INTERVAL '1 hour'
  ),
  -- Failed outbound call (no answer)
  (
    'call_00003',
    '00000000-0000-0000-0000-000000000001',
    'outbound',
    '+14155551234',
    '+14155552222',
    'no-answer',
    NOW() - INTERVAL '30 minutes',
    NULL,
    NOW() - INTERVAL '30 minutes' + INTERVAL '30 seconds',
    30,
    0,
    0.0000,
    'sales',
    'failed',
    NULL,
    'none',
    NOW() - INTERVAL '30 minutes'
  ),
  -- Active call (ringing)
  (
    'call_00004',
    '00000000-0000-0000-0000-000000000001',
    'outbound',
    '+14155551234',
    '+14155553333',
    'ringing',
    NOW() - INTERVAL '10 seconds',
    NULL,
    NULL,
    0,
    0,
    0.0000,
    'survey',
    'pending',
    NULL,
    'none',
    NOW() - INTERVAL '10 seconds'
  ),
  -- Completed call with failed goal
  (
    'call_00005',
    '00000000-0000-0000-0000-000000000001',
    'outbound',
    '+14155551234',
    '+14155554444',
    'completed',
    NOW() - INTERVAL '3 hours',
    NOW() - INTERVAL '3 hours' + INTERVAL '2 seconds',
    NOW() - INTERVAL '3 hours' + INTERVAL '1 minute',
    60,
    58,
    0.0030,
    'sales',
    'failed',
    'https://example.com/recordings/call_00005.mp3',
    'completed',
    NOW() - INTERVAL '3 hours'
  ),
  -- Another completed support call
  (
    'call_00006',
    '00000000-0000-0000-0000-000000000001',
    'inbound',
    '+14155558888',
    '+14155551234',
    'completed',
    NOW() - INTERVAL '4 hours',
    NOW() - INTERVAL '4 hours' + INTERVAL '4 seconds',
    NOW() - INTERVAL '4 hours' + INTERVAL '12 minutes',
    720,
    716,
    0.0360,
    'support',
    'achieved',
    'https://example.com/recordings/call_00006.mp3',
    'completed',
    NOW() - INTERVAL '4 hours'
  ),
  -- Busy call
  (
    'call_00007',
    '00000000-0000-0000-0000-000000000001',
    'outbound',
    '+14155551234',
    '+14155557777',
    'busy',
    NOW() - INTERVAL '5 hours',
    NULL,
    NOW() - INTERVAL '5 hours' + INTERVAL '5 seconds',
    5,
    0,
    0.0000,
    'sales',
    'failed',
    NULL,
    'none',
    NOW() - INTERVAL '5 hours'
  )
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- CREATE SAMPLE CALL EVENTS
-- ============================================================================
INSERT INTO public.call_events (id, call_id, tenant_id, type, occurred_at, payload)
VALUES
  -- Events for call_00001
  (
    'evt_00001_initiated',
    'call_00001',
    '00000000-0000-0000-0000-000000000001',
    'call.initiated',
    NOW() - INTERVAL '2 hours',
    '{"call_control_id": "call_00001", "direction": "outbound"}'::JSONB
  ),
  (
    'evt_00001_ringing',
    'call_00001',
    '00000000-0000-0000-0000-000000000001',
    'call.ringing',
    NOW() - INTERVAL '2 hours' + INTERVAL '2 seconds',
    '{"call_control_id": "call_00001"}'::JSONB
  ),
  (
    'evt_00001_answered',
    'call_00001',
    '00000000-0000-0000-0000-000000000001',
    'call.answered',
    NOW() - INTERVAL '2 hours' + INTERVAL '5 seconds',
    '{"call_control_id": "call_00001"}'::JSONB
  ),
  (
    'evt_00001_hangup',
    'call_00001',
    '00000000-0000-0000-0000-000000000001',
    'call.hangup',
    NOW() - INTERVAL '2 hours' + INTERVAL '5 minutes',
    '{"call_control_id": "call_00001", "hangup_cause": "normal_clearing", "hangup_source": "caller"}'::JSONB
  ),
  -- Events for call_00002
  (
    'evt_00002_initiated',
    'call_00002',
    '00000000-0000-0000-0000-000000000001',
    'call.initiated',
    NOW() - INTERVAL '1 hour',
    '{"call_control_id": "call_00002", "direction": "inbound"}'::JSONB
  ),
  (
    'evt_00002_answered',
    'call_00002',
    '00000000-0000-0000-0000-000000000001',
    'call.answered',
    NOW() - INTERVAL '1 hour' + INTERVAL '3 seconds',
    '{"call_control_id": "call_00002"}'::JSONB
  ),
  (
    'evt_00002_hangup',
    'call_00002',
    '00000000-0000-0000-0000-000000000001',
    'call.hangup',
    NOW() - INTERVAL '1 hour' + INTERVAL '8 minutes',
    '{"call_control_id": "call_00002", "hangup_cause": "normal_clearing", "hangup_source": "callee"}'::JSONB
  ),
  -- Events for call_00003 (no answer)
  (
    'evt_00003_initiated',
    'call_00003',
    '00000000-0000-0000-0000-000000000001',
    'call.initiated',
    NOW() - INTERVAL '30 minutes',
    '{"call_control_id": "call_00003", "direction": "outbound"}'::JSONB
  ),
  (
    'evt_00003_ringing',
    'call_00003',
    '00000000-0000-0000-0000-000000000001',
    'call.ringing',
    NOW() - INTERVAL '30 minutes' + INTERVAL '2 seconds',
    '{"call_control_id": "call_00003"}'::JSONB
  ),
  (
    'evt_00003_hangup',
    'call_00003',
    '00000000-0000-0000-0000-000000000001',
    'call.hangup',
    NOW() - INTERVAL '30 minutes' + INTERVAL '30 seconds',
    '{"call_control_id": "call_00003", "hangup_cause": "no_answer", "hangup_source": "timeout"}'::JSONB
  ),
  -- Events for call_00004 (active)
  (
    'evt_00004_initiated',
    'call_00004',
    '00000000-0000-0000-0000-000000000001',
    'call.initiated',
    NOW() - INTERVAL '10 seconds',
    '{"call_control_id": "call_00004", "direction": "outbound"}'::JSONB
  ),
  (
    'evt_00004_ringing',
    'call_00004',
    '00000000-0000-0000-0000-000000000001',
    'call.ringing',
    NOW() - INTERVAL '8 seconds',
    '{"call_control_id": "call_00004"}'::JSONB
  )
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Uncomment to verify seed data:
-- SELECT COUNT(*) as tenant_count FROM public.tenants;
-- SELECT COUNT(*) as call_count FROM public.calls;
-- SELECT COUNT(*) as event_count FROM public.call_events;
-- SELECT status, COUNT(*) FROM public.calls GROUP BY status;
