-- Migration 002: Add AI Assistant features and feedback
-- Adds assistant tracking, feedback, notifications, and enhanced analytics

-- ============================================================================
-- UPDATE CALLS TABLE - Add AI Assistant fields
-- ============================================================================
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS assistant_id TEXT;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS assistant_name TEXT;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS transcript TEXT;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS transcript_url TEXT;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS user_feedback BOOLEAN;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS feedback_comment TEXT;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS feedback_at TIMESTAMPTZ;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS response_time_ms INTEGER;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS tags TEXT[];

-- Add indexes for new fields
CREATE INDEX IF NOT EXISTS idx_calls_assistant_id ON public.calls(tenant_id, assistant_id) WHERE assistant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_user_feedback ON public.calls(tenant_id, user_feedback) WHERE user_feedback IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_response_time ON public.calls(response_time_ms) WHERE response_time_ms IS NOT NULL;

-- ============================================================================
-- ASSISTANTS TABLE - Track AI assistant configurations
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.assistants (
  id TEXT PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  voice_id TEXT,
  prompt_template TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_assistants_tenant_id ON public.assistants(tenant_id);
CREATE INDEX idx_assistants_is_active ON public.assistants(tenant_id, is_active);

-- Enable RLS
ALTER TABLE public.assistants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view assistants from their tenant"
  ON public.assistants
  FOR SELECT
  USING (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::UUID);

CREATE POLICY "Service role can manage all assistants"
  ON public.assistants
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- NOTIFICATIONS TABLE - Track sent notifications
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  call_id TEXT REFERENCES public.calls(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('webhook', 'slack', 'email', 'sms')),
  event TEXT NOT NULL, -- 'goal_success', 'goal_failure', 'call_failed', etc.
  recipient TEXT NOT NULL,
  payload JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notifications_tenant_id ON public.notifications(tenant_id, created_at DESC);
CREATE INDEX idx_notifications_call_id ON public.notifications(call_id);
CREATE INDEX idx_notifications_status ON public.notifications(status) WHERE status = 'pending';

-- Enable RLS
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view notifications from their tenant"
  ON public.notifications
  FOR SELECT
  USING (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::UUID);

CREATE POLICY "Service role can manage all notifications"
  ON public.notifications
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ============================================================================
-- NOTIFICATION_RULES TABLE - Configure when to send notifications
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.notification_rules (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  event TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('webhook', 'slack', 'email', 'sms')),
  recipient TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  config JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_notification_rules_tenant_id ON public.notification_rules(tenant_id);
CREATE INDEX idx_notification_rules_active ON public.notification_rules(tenant_id, is_active) WHERE is_active = true;

-- Enable RLS
ALTER TABLE public.notification_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view notification rules from their tenant"
  ON public.notification_rules
  FOR SELECT
  USING (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::UUID);

CREATE POLICY "Admins can manage notification rules"
  ON public.notification_rules
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles
      WHERE user_id = auth.uid()
      AND tenant_id = notification_rules.tenant_id
      AND role = 'admin'
    )
  );

-- ============================================================================
-- BILLING_SUMMARY TABLE - Track usage and costs
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.billing_summary (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_calls INTEGER DEFAULT 0,
  total_minutes NUMERIC(10, 2) DEFAULT 0,
  total_cost_usd NUMERIC(10, 4) DEFAULT 0,
  breakdown JSONB DEFAULT '{}'::JSONB, -- By assistant, goal, etc.
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, period_start, period_end)
);

CREATE INDEX idx_billing_summary_tenant_period ON public.billing_summary(tenant_id, period_start DESC);

-- Enable RLS
ALTER TABLE public.billing_summary ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view billing from their tenant"
  ON public.billing_summary
  FOR SELECT
  USING (tenant_id = (auth.jwt() -> 'user_metadata' ->> 'tenant_id')::UUID);

-- ============================================================================
-- FUNCTIONS
-- ============================================================================

-- Function to calculate response time (time from initiated to answered)
CREATE OR REPLACE FUNCTION public.calculate_response_time()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.answered_at IS NOT NULL AND NEW.started_at IS NOT NULL THEN
    NEW.response_time_ms := EXTRACT(EPOCH FROM (NEW.answered_at - NEW.started_at)) * 1000;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_calculate_response_time
  BEFORE INSERT OR UPDATE ON public.calls
  FOR EACH ROW
  EXECUTE FUNCTION public.calculate_response_time();

-- Function to auto-create notification on goal events
CREATE OR REPLACE FUNCTION public.trigger_goal_notifications()
RETURNS TRIGGER AS $$
BEGIN
  -- Only trigger on status change to achieved or failed
  IF NEW.goal_status IS DISTINCT FROM OLD.goal_status AND
     NEW.goal_status IN ('achieved', 'failed') THEN

    -- Find active notification rules for this event
    INSERT INTO public.notifications (tenant_id, call_id, type, event, recipient, status)
    SELECT
      NEW.tenant_id,
      NEW.id,
      nr.type,
      CASE
        WHEN NEW.goal_status = 'achieved' THEN 'goal_success'
        ELSE 'goal_failure'
      END,
      nr.recipient,
      'pending'
    FROM public.notification_rules nr
    WHERE nr.tenant_id = NEW.tenant_id
      AND nr.is_active = true
      AND nr.event IN ('goal_success', 'goal_failure', 'all');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_goal_notifications_on_update
  AFTER UPDATE ON public.calls
  FOR EACH ROW
  WHEN (NEW.goal_status IS DISTINCT FROM OLD.goal_status)
  EXECUTE FUNCTION public.trigger_goal_notifications();

-- Apply update_updated_at trigger to new tables
CREATE TRIGGER update_assistants_updated_at
  BEFORE UPDATE ON public.assistants
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_notification_rules_updated_at
  BEFORE UPDATE ON public.notification_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_billing_summary_updated_at
  BEFORE UPDATE ON public.billing_summary
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- Grant permissions
GRANT ALL ON public.assistants TO anon, authenticated, service_role;
GRANT ALL ON public.notifications TO anon, authenticated, service_role;
GRANT ALL ON public.notification_rules TO anon, authenticated, service_role;
GRANT ALL ON public.billing_summary TO anon, authenticated, service_role;

-- Add to realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
