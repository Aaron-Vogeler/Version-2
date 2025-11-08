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
          created_at: string;
          updated_at: string;
        };
        Insert: Omit<Database['public']['Tables']['calls']['Row'], 'created_at' | 'updated_at'>;
        Update: Partial<Database['public']['Tables']['calls']['Insert']>;
      };
      call_events: {
        Row: {
          id: string;
          call_id: string;
          tenant_id: string;
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
