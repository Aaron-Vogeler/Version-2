/**
 * Database type definitions
 */

export interface Database {
  public: {
    Tables: {
      tenants: {
        Row: {
          id: string;
          name: string;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['tenants']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['tenants']['Insert']>;
      };
      profiles: {
        Row: {
          user_id: string;
          tenant_id: string;
          role: 'admin' | 'member';
          full_name: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['profiles']['Row'], 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['profiles']['Insert']>;
      };
      calls: {
        Row: {
          id: string;
          tenant_id: string;
          user_id: string;  // Direct link to auth.users
          direction: 'inbound' | 'outbound';
          from_e164: string;
          to_e164: string;
          status: 'initiated' | 'ringing' | 'answered' | 'completed' | 'failed' | 'busy' | 'no-answer';
          started_at: string | null;
          answered_at: string | null;
          ended_at: string | null;
          duration_sec: number | null;
          billable_sec: number | null;
          cost_usd: number | null;
          goal: string | null;
          goal_status: string | null;
          recording_url: string | null;
          transcript_status: 'pending' | 'processing' | 'completed' | 'failed' | 'none' | null;
          metadata: any;
          assistant_id: string | null;
          assistant_name: string | null;
          transcript: string | null;
          transcript_url: string | null;
          live_transcript: string | null;
          transcription_url: string | null;
          user_feedback: boolean | null;
          feedback_comment: string | null;
          feedback_at: string | null;
          response_time_ms: number | null;
          tags: string[] | null;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['calls']['Row'], 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['calls']['Insert']>;
      };
      assistants: {
        Row: {
          id: string;
          tenant_id: string;
          user_id: string;  // Direct link to auth.users
          name: string;
          description: string | null;
          voice_id: string | null;
          prompt_template: string | null;
          is_active: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['assistants']['Row'], 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['assistants']['Insert']>;
      };
      notifications: {
        Row: {
          id: string;
          tenant_id: string;
          call_id: string | null;
          type: 'webhook' | 'slack' | 'email' | 'sms';
          event: string;
          recipient: string;
          payload: any;
          status: 'pending' | 'sent' | 'failed';
          sent_at: string | null;
          error_message: string | null;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['notifications']['Row'], 'id' | 'created_at'>;
        Update: Partial<Database['public']['Tables']['notifications']['Insert']>;
      };
      notification_rules: {
        Row: {
          id: string;
          tenant_id: string;
          name: string;
          event: string;
          type: 'webhook' | 'slack' | 'email' | 'sms';
          recipient: string;
          is_active: boolean;
          config: any;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['notification_rules']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['notification_rules']['Insert']>;
      };
      billing_summary: {
        Row: {
          id: string;
          tenant_id: string;
          period_start: string;
          period_end: string;
          total_calls: number;
          total_minutes: number;
          total_cost_usd: number;
          breakdown: any;
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['billing_summary']['Row'], 'id' | 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['billing_summary']['Insert']>;
      };
      call_events: {
        Row: {
          id: string;
          call_id: string;
          tenant_id: string;
          user_id: string;  // Direct link to auth.users
          type: string;
          occurred_at: string;
          payload: any;
          created_at: string;
        };
        Insert: Omit<Database['public']['Tables']['call_events']['Row'], 'created_at'>;
        Update: Partial<Database['public']['Tables']['call_events']['Insert']>;
      };
    };
  };
}

export type Call = Database['public']['Tables']['calls']['Row'];
export type CallEvent = Database['public']['Tables']['call_events']['Row'];
export type Profile = Database['public']['Tables']['profiles']['Row'];
export type Tenant = Database['public']['Tables']['tenants']['Row'];
export type Assistant = Database['public']['Tables']['assistants']['Row'];
export type Notification = Database['public']['Tables']['notifications']['Row'];
export type NotificationRule = Database['public']['Tables']['notification_rules']['Row'];
export type BillingSummary = Database['public']['Tables']['billing_summary']['Row'];
