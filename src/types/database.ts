export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      _seed_downer_linz_vehicle_log_raw: {
        Row: {
          attachments: string | null
          canonical_vehicle_id: string | null
          created_at: string
          error: string | null
          modified: string | null
          normalized_plate: string | null
          note: string | null
          observation_id: string | null
          processed_at: string | null
          recorded_date: string | null
          rego: string | null
          resolved_zone_id: string | null
          source_id: string
          title: string | null
        }
        Insert: {
          attachments?: string | null
          canonical_vehicle_id?: string | null
          created_at?: string
          error?: string | null
          modified?: string | null
          normalized_plate?: string | null
          note?: string | null
          observation_id?: string | null
          processed_at?: string | null
          recorded_date?: string | null
          rego?: string | null
          resolved_zone_id?: string | null
          source_id: string
          title?: string | null
        }
        Update: {
          attachments?: string | null
          canonical_vehicle_id?: string | null
          created_at?: string
          error?: string | null
          modified?: string | null
          normalized_plate?: string | null
          note?: string | null
          observation_id?: string | null
          processed_at?: string | null
          recorded_date?: string | null
          rego?: string | null
          resolved_zone_id?: string | null
          source_id?: string
          title?: string | null
        }
        Relationships: []
      }
      _seed_fs_nelson_clients_raw: {
        Row: {
          bureau_id: string | null
          bureau_name: string | null
          client_address: string | null
          client_id: string | null
          client_name: string | null
          client_postcode: string | null
          client_state: string | null
          client_suburb: string | null
          comments: string | null
          despatch_datetime: string | null
          despatch_zone: string | null
          internal_clientid: string | null
          internal_despatchid: string | null
          is_incident_report: string | null
          offsite_datetime: string | null
          onsite_datetime: string | null
          onsite_distance_from_site: string | null
          patrol_complete_status: string | null
          patrol_type: string | null
          subcontractor: string | null
          time_onsite_variation_mins: string | null
          visit_charge_ex_gst: string | null
        }
        Insert: {
          bureau_id?: string | null
          bureau_name?: string | null
          client_address?: string | null
          client_id?: string | null
          client_name?: string | null
          client_postcode?: string | null
          client_state?: string | null
          client_suburb?: string | null
          comments?: string | null
          despatch_datetime?: string | null
          despatch_zone?: string | null
          internal_clientid?: string | null
          internal_despatchid?: string | null
          is_incident_report?: string | null
          offsite_datetime?: string | null
          onsite_datetime?: string | null
          onsite_distance_from_site?: string | null
          patrol_complete_status?: string | null
          patrol_type?: string | null
          subcontractor?: string | null
          time_onsite_variation_mins?: string | null
          visit_charge_ex_gst?: string | null
        }
        Update: {
          bureau_id?: string | null
          bureau_name?: string | null
          client_address?: string | null
          client_id?: string | null
          client_name?: string | null
          client_postcode?: string | null
          client_state?: string | null
          client_suburb?: string | null
          comments?: string | null
          despatch_datetime?: string | null
          despatch_zone?: string | null
          internal_clientid?: string | null
          internal_despatchid?: string | null
          is_incident_report?: string | null
          offsite_datetime?: string | null
          onsite_datetime?: string | null
          onsite_distance_from_site?: string | null
          patrol_complete_status?: string | null
          patrol_type?: string | null
          subcontractor?: string | null
          time_onsite_variation_mins?: string | null
          visit_charge_ex_gst?: string | null
        }
        Relationships: []
      }
      _seed_ncc_noise_history_raw: {
        Row: {
          agreement_id: string | null
          alarm_response_dt: string | null
          arrived_at: string | null
          bureau_id: string | null
          bureau_name: string | null
          charge_total: string | null
          client_address: string | null
          client_id: string | null
          client_name: string | null
          client_postcode: string | null
          client_suburb: string | null
          created_at: string
          departed_at: string | null
          despatch_comments: string | null
          despatch_zone: string | null
          dispatch_id: string
          docket_no: string | null
          error: string | null
          followup_info: string | null
          noise_assessment_id: string | null
          offsite_dt: string | null
          onsite_dt: string | null
          organization_id: string | null
          processed_at: string | null
          received_at: string | null
          shift: string | null
          time_onsite_mins: string | null
          time_to_respond_mins: string | null
        }
        Insert: {
          agreement_id?: string | null
          alarm_response_dt?: string | null
          arrived_at?: string | null
          bureau_id?: string | null
          bureau_name?: string | null
          charge_total?: string | null
          client_address?: string | null
          client_id?: string | null
          client_name?: string | null
          client_postcode?: string | null
          client_suburb?: string | null
          created_at?: string
          departed_at?: string | null
          despatch_comments?: string | null
          despatch_zone?: string | null
          dispatch_id: string
          docket_no?: string | null
          error?: string | null
          followup_info?: string | null
          noise_assessment_id?: string | null
          offsite_dt?: string | null
          onsite_dt?: string | null
          organization_id?: string | null
          processed_at?: string | null
          received_at?: string | null
          shift?: string | null
          time_onsite_mins?: string | null
          time_to_respond_mins?: string | null
        }
        Update: {
          agreement_id?: string | null
          alarm_response_dt?: string | null
          arrived_at?: string | null
          bureau_id?: string | null
          bureau_name?: string | null
          charge_total?: string | null
          client_address?: string | null
          client_id?: string | null
          client_name?: string | null
          client_postcode?: string | null
          client_suburb?: string | null
          created_at?: string
          departed_at?: string | null
          despatch_comments?: string | null
          despatch_zone?: string | null
          dispatch_id?: string
          docket_no?: string | null
          error?: string | null
          followup_info?: string | null
          noise_assessment_id?: string | null
          offsite_dt?: string | null
          onsite_dt?: string | null
          organization_id?: string | null
          processed_at?: string | null
          received_at?: string | null
          shift?: string | null
          time_onsite_mins?: string | null
          time_to_respond_mins?: string | null
        }
        Relationships: []
      }
      access_presets: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          grants: Json
          id: string
          is_system: boolean
          key: string
          module_access: string[]
          name: string
          organization_id: string | null
          permissions: Json
          role: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          grants?: Json
          id?: string
          is_system?: boolean
          key: string
          module_access?: string[]
          name: string
          organization_id?: string | null
          permissions?: Json
          role?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          grants?: Json
          id?: string
          is_system?: boolean
          key?: string
          module_access?: string[]
          name?: string
          organization_id?: string | null
          permissions?: Json
          role?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "access_presets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_presets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "access_presets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "access_presets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      agreement_obligations: {
        Row: {
          active: boolean
          created_at: string
          description: string
          escalation_contact: string | null
          escalation_minutes: number | null
          frequency_rule: Json | null
          id: string
          obligation_code: string | null
          obligation_type: string
          proof_artifact_type: string | null
          requires_proof: boolean
          service_agreement_id: string
          site_id: string | null
          sla_target_minutes: number | null
        }
        Insert: {
          active?: boolean
          created_at?: string
          description: string
          escalation_contact?: string | null
          escalation_minutes?: number | null
          frequency_rule?: Json | null
          id?: string
          obligation_code?: string | null
          obligation_type: string
          proof_artifact_type?: string | null
          requires_proof?: boolean
          service_agreement_id: string
          site_id?: string | null
          sla_target_minutes?: number | null
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string
          escalation_contact?: string | null
          escalation_minutes?: number | null
          frequency_rule?: Json | null
          id?: string
          obligation_code?: string | null
          obligation_type?: string
          proof_artifact_type?: string | null
          requires_proof?: boolean
          service_agreement_id?: string
          site_id?: string | null
          sla_target_minutes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "agreement_obligations_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "agreement_obligations_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      alarm_events: {
        Row: {
          account_number: string | null
          created_at: string
          dispatch_job_id: string | null
          id: string
          location_name: string | null
          notes: string | null
          organization_id: string
          panel_id: string | null
          received_at: string
          signal_type: string
          site_id: string | null
          zone_name: string | null
          zone_number: string | null
        }
        Insert: {
          account_number?: string | null
          created_at?: string
          dispatch_job_id?: string | null
          id?: string
          location_name?: string | null
          notes?: string | null
          organization_id: string
          panel_id?: string | null
          received_at?: string
          signal_type: string
          site_id?: string | null
          zone_name?: string | null
          zone_number?: string | null
        }
        Update: {
          account_number?: string | null
          created_at?: string
          dispatch_job_id?: string | null
          id?: string
          location_name?: string | null
          notes?: string | null
          organization_id?: string
          panel_id?: string | null
          received_at?: string
          signal_type?: string
          site_id?: string | null
          zone_name?: string | null
          zone_number?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "alarm_events_dispatch_job_id_fkey"
            columns: ["dispatch_job_id"]
            isOneToOne: false
            referencedRelation: "dispatch_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alarm_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "alarm_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alarm_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "alarm_events_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      app_map_expectations: {
        Row: {
          assertion_kind: string
          authored_at: string
          authored_by: string | null
          created_at: string
          evidence_class: string
          from_name: string
          from_type: string
          id: string
          rationale: string | null
          signal_weight: number
          spine: string
          status: string
          to_name: string
          to_type: string
          updated_at: string
          via_name: string | null
          via_type: string | null
        }
        Insert: {
          assertion_kind: string
          authored_at?: string
          authored_by?: string | null
          created_at?: string
          evidence_class?: string
          from_name: string
          from_type: string
          id?: string
          rationale?: string | null
          signal_weight?: number
          spine: string
          status?: string
          to_name: string
          to_type: string
          updated_at?: string
          via_name?: string | null
          via_type?: string | null
        }
        Update: {
          assertion_kind?: string
          authored_at?: string
          authored_by?: string | null
          created_at?: string
          evidence_class?: string
          from_name?: string
          from_type?: string
          id?: string
          rationale?: string | null
          signal_weight?: number
          spine?: string
          status?: string
          to_name?: string
          to_type?: string
          updated_at?: string
          via_name?: string | null
          via_type?: string | null
        }
        Relationships: []
      }
      asset_checks: {
        Row: {
          action_required: string | null
          asset_id: string
          check_type: string
          checked_at: string
          checked_by: string | null
          condition: string
          defects_noted: string | null
          fuel_level: string | null
          id: string
          odometer_reading: number | null
          organization_id: string
        }
        Insert: {
          action_required?: string | null
          asset_id: string
          check_type: string
          checked_at?: string
          checked_by?: string | null
          condition: string
          defects_noted?: string | null
          fuel_level?: string | null
          id?: string
          odometer_reading?: number | null
          organization_id: string
        }
        Update: {
          action_required?: string | null
          asset_id?: string
          check_type?: string
          checked_at?: string
          checked_by?: string | null
          condition?: string
          defects_noted?: string | null
          fuel_level?: string | null
          id?: string
          odometer_reading?: number | null
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_checks_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_checks_checked_by_fkey"
            columns: ["checked_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_checks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "asset_checks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_checks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          asset_type: string
          assigned_site_id: string | null
          assigned_to: string | null
          created_at: string
          id: string
          last_inspection_date: string | null
          make: string | null
          model: string | null
          name: string
          next_inspection_date: string | null
          notes: string | null
          organization_id: string
          registration: string | null
          serial_number: string | null
          status: string
          year: number | null
        }
        Insert: {
          asset_type: string
          assigned_site_id?: string | null
          assigned_to?: string | null
          created_at?: string
          id?: string
          last_inspection_date?: string | null
          make?: string | null
          model?: string | null
          name: string
          next_inspection_date?: string | null
          notes?: string | null
          organization_id: string
          registration?: string | null
          serial_number?: string | null
          status?: string
          year?: number | null
        }
        Update: {
          asset_type?: string
          assigned_site_id?: string | null
          assigned_to?: string | null
          created_at?: string
          id?: string
          last_inspection_date?: string | null
          make?: string | null
          model?: string | null
          name?: string
          next_inspection_date?: string | null
          notes?: string | null
          organization_id?: string
          registration?: string | null
          serial_number?: string | null
          status?: string
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "assets_assigned_site_id_fkey"
            columns: ["assigned_site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "assets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_log: {
        Row: {
          action: string
          actor_user_id: string | null
          created_at: string
          id: string
          metadata: Json
          organization_id: string | null
          target_id: string | null
          target_table: string | null
        }
        Insert: {
          action: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          organization_id?: string | null
          target_id?: string | null
          target_table?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string | null
          created_at?: string
          id?: string
          metadata?: Json
          organization_id?: string | null
          target_id?: string | null
          target_table?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_log_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "audit_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      biosecurity_assessments: {
        Row: {
          action: string | null
          action_taken: string | null
          assessed_at: string
          bob_checklist: Json
          bob_confidence: number | null
          bob_recommendation: string | null
          bob_species_confirmed: boolean | null
          bob_species_id: string | null
          created_at: string
          density_estimate: string | null
          dispatch_job_id: string | null
          follow_up_required: boolean
          id: string
          land_use_context: string | null
          location_id: string | null
          location_name: string | null
          mpi_referral_number: string | null
          notes: string | null
          notice_number: string | null
          officer_id: string | null
          officer_name: string | null
          officer_user_id: string | null
          organization_id: string
          photo_url: string | null
          photo_urls: Json | null
          protected_land_address: string | null
          protected_land_site_id: string | null
          scene_description: string | null
          seed_head_present: boolean | null
          site_id: string | null
          species_confirmed: boolean
          species_identified: string | null
          species_name: string | null
          status: string
        }
        Insert: {
          action?: string | null
          action_taken?: string | null
          assessed_at?: string
          bob_checklist?: Json
          bob_confidence?: number | null
          bob_recommendation?: string | null
          bob_species_confirmed?: boolean | null
          bob_species_id?: string | null
          created_at?: string
          density_estimate?: string | null
          dispatch_job_id?: string | null
          follow_up_required?: boolean
          id?: string
          land_use_context?: string | null
          location_id?: string | null
          location_name?: string | null
          mpi_referral_number?: string | null
          notes?: string | null
          notice_number?: string | null
          officer_id?: string | null
          officer_name?: string | null
          officer_user_id?: string | null
          organization_id: string
          photo_url?: string | null
          photo_urls?: Json | null
          protected_land_address?: string | null
          protected_land_site_id?: string | null
          scene_description?: string | null
          seed_head_present?: boolean | null
          site_id?: string | null
          species_confirmed?: boolean
          species_identified?: string | null
          species_name?: string | null
          status?: string
        }
        Update: {
          action?: string | null
          action_taken?: string | null
          assessed_at?: string
          bob_checklist?: Json
          bob_confidence?: number | null
          bob_recommendation?: string | null
          bob_species_confirmed?: boolean | null
          bob_species_id?: string | null
          created_at?: string
          density_estimate?: string | null
          dispatch_job_id?: string | null
          follow_up_required?: boolean
          id?: string
          land_use_context?: string | null
          location_id?: string | null
          location_name?: string | null
          mpi_referral_number?: string | null
          notes?: string | null
          notice_number?: string | null
          officer_id?: string | null
          officer_name?: string | null
          officer_user_id?: string | null
          organization_id?: string
          photo_url?: string | null
          photo_urls?: Json | null
          protected_land_address?: string | null
          protected_land_site_id?: string | null
          scene_description?: string | null
          seed_head_present?: boolean | null
          site_id?: string | null
          species_confirmed?: boolean
          species_identified?: string | null
          species_name?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "biosecurity_assessments_dispatch_job_id_fkey"
            columns: ["dispatch_job_id"]
            isOneToOne: false
            referencedRelation: "dispatch_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "biosecurity_assessments_officer_id_fkey"
            columns: ["officer_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "biosecurity_assessments_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "biosecurity_assessments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "biosecurity_assessments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "biosecurity_assessments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "biosecurity_assessments_protected_land_site_id_fkey"
            columns: ["protected_land_site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "biosecurity_assessments_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_agentic_actions: {
        Row: {
          action_type: string
          amended_at: string | null
          amended_by: string | null
          amended_payload: Json | null
          applied_at: string | null
          approved_at: string | null
          approved_by: string | null
          assigned_approver_id: string | null
          bob_reasoning: string | null
          confidence_score: number | null
          context_page: string | null
          context_record_id: string | null
          context_summary: string | null
          context_table: string | null
          conversation_id: string | null
          created_at: string
          error_message: string | null
          id: string
          idempotency_key: string | null
          organization_id: string
          proposed_payload: Json
          reassigned_at: string | null
          reassigned_by: string | null
          rejection_reason: string | null
          result_record_id: string | null
          result_table: string | null
          status: string
          triggered_by: string | null
          user_id: string
        }
        Insert: {
          action_type: string
          amended_at?: string | null
          amended_by?: string | null
          amended_payload?: Json | null
          applied_at?: string | null
          approved_at?: string | null
          approved_by?: string | null
          assigned_approver_id?: string | null
          bob_reasoning?: string | null
          confidence_score?: number | null
          context_page?: string | null
          context_record_id?: string | null
          context_summary?: string | null
          context_table?: string | null
          conversation_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          organization_id: string
          proposed_payload?: Json
          reassigned_at?: string | null
          reassigned_by?: string | null
          rejection_reason?: string | null
          result_record_id?: string | null
          result_table?: string | null
          status?: string
          triggered_by?: string | null
          user_id: string
        }
        Update: {
          action_type?: string
          amended_at?: string | null
          amended_by?: string | null
          amended_payload?: Json | null
          applied_at?: string | null
          approved_at?: string | null
          approved_by?: string | null
          assigned_approver_id?: string | null
          bob_reasoning?: string | null
          confidence_score?: number | null
          context_page?: string | null
          context_record_id?: string | null
          context_summary?: string | null
          context_table?: string | null
          conversation_id?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          idempotency_key?: string | null
          organization_id?: string
          proposed_payload?: Json
          reassigned_at?: string | null
          reassigned_by?: string | null
          rejection_reason?: string | null
          result_record_id?: string | null
          result_table?: string | null
          status?: string
          triggered_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_agentic_actions_amended_by_fkey"
            columns: ["amended_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_agentic_actions_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_agentic_actions_assigned_approver_id_fkey"
            columns: ["assigned_approver_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_agentic_actions_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "bob_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_agentic_actions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_agentic_actions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_agentic_actions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_agentic_actions_reassigned_by_fkey"
            columns: ["reassigned_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_agentic_actions_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_agentic_actions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_app_map_edges: {
        Row: {
          caller_context: string | null
          created_at: string
          edge_kind: string
          evidence_class: string
          id: string
          last_refreshed_at: string
          migration_name: string | null
          refresh_source: string
          retirement_status: string
          source_file: string
          source_name: string
          source_type: string
          target_name: string
          target_type: string
          updated_at: string
        }
        Insert: {
          caller_context?: string | null
          created_at?: string
          edge_kind: string
          evidence_class: string
          id?: string
          last_refreshed_at?: string
          migration_name?: string | null
          refresh_source?: string
          retirement_status?: string
          source_file?: string
          source_name: string
          source_type: string
          target_name: string
          target_type: string
          updated_at?: string
        }
        Update: {
          caller_context?: string | null
          created_at?: string
          edge_kind?: string
          evidence_class?: string
          id?: string
          last_refreshed_at?: string
          migration_name?: string | null
          refresh_source?: string
          retirement_status?: string
          source_file?: string
          source_name?: string
          source_type?: string
          target_name?: string
          target_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      bob_attachments: {
        Row: {
          confidence: number | null
          conversation_id: string
          created_at: string
          extraction_payload: Json
          extraction_summary: string | null
          file_name: string
          file_size_bytes: number
          file_type: string
          id: string
            metadata: Json
          organization_id: string
          processing_state: string
          purpose: string
          source_type: string
          source_url: string | null
          storage_bucket: string
          storage_path: string
          updated_at: string
          uploaded_by: string
        }
        Insert: {
          confidence?: number | null
          conversation_id: string
          created_at?: string
          extraction_payload?: Json
          extraction_summary?: string | null
          file_name: string
          file_size_bytes: number
          file_type: string
          id?: string
          metadata?: Json
          organization_id: string
          processing_state?: string
          purpose: string
          source_type?: string
          source_url?: string | null
          storage_bucket?: string
          storage_path: string
          updated_at?: string
          uploaded_by: string
        }
        Update: {
          confidence?: number | null
          conversation_id?: string
          created_at?: string
          extraction_payload?: Json
          extraction_summary?: string | null
          file_name?: string
          file_size_bytes?: number
          file_type?: string
          id?: string
          metadata?: Json
          organization_id?: string
          processing_state?: string
          purpose?: string
          source_type?: string
          source_url?: string | null
          storage_bucket?: string
          storage_path?: string
          updated_at?: string
          uploaded_by?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_attachments_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "bob_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_attachments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_attachments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_attachments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_capability_map: {
        Row: {
          caller_summary: string | null
          created_at: string
          entity_name: string
          entity_type: string
          exercised: boolean | null
          id: string
          last_refreshed_at: string
          notes: string | null
          present: boolean
          refresh_source: string | null
          retirement_status: string
          updated_at: string
          wired: boolean
        }
        Insert: {
          caller_summary?: string | null
          created_at?: string
          entity_name: string
          entity_type: string
          exercised?: boolean | null
          id?: string
          last_refreshed_at?: string
          notes?: string | null
          present?: boolean
          refresh_source?: string | null
          retirement_status?: string
          updated_at?: string
          wired?: boolean
        }
        Update: {
          caller_summary?: string | null
          created_at?: string
          entity_name?: string
          entity_type?: string
          exercised?: boolean | null
          id?: string
          last_refreshed_at?: string
          notes?: string | null
          present?: boolean
          refresh_source?: string | null
          retirement_status?: string
          updated_at?: string
          wired?: boolean
        }
        Relationships: []
      }
      bob_conduct_log: {
        Row: {
          area: string
          created_at: string
          id: string
          judged_by: string | null
          method_lesson: string | null
          organization_id: string | null
          reason: string | null
          redo_ref: string | null
          source_kind: string | null
          source_ref: string | null
          status: string
          subject_user_id: string | null
          updated_at: string
          valence: string
          what: string
        }
        Insert: {
          area: string
          created_at?: string
          id?: string
          judged_by?: string | null
          method_lesson?: string | null
          organization_id?: string | null
          reason?: string | null
          redo_ref?: string | null
          source_kind?: string | null
          source_ref?: string | null
          status?: string
          subject_user_id?: string | null
          updated_at?: string
          valence: string
          what: string
        }
        Update: {
          area?: string
          created_at?: string
          id?: string
          judged_by?: string | null
          method_lesson?: string | null
          organization_id?: string | null
          reason?: string | null
          redo_ref?: string | null
          source_kind?: string | null
          source_ref?: string | null
          status?: string
          subject_user_id?: string | null
          updated_at?: string
          valence?: string
          what?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_conduct_log_judged_by_fkey"
            columns: ["judged_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_conduct_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_conduct_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_conduct_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_conduct_log_subject_user_id_fkey"
            columns: ["subject_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_context_memory: {
        Row: {
          context_data: Json
          context_key: string
          created_at: string
          id: string
          last_seen_at: string
          organization_id: string
          user_id: string
        }
        Insert: {
          context_data?: Json
          context_key: string
          created_at?: string
          id?: string
          last_seen_at?: string
          organization_id: string
          user_id: string
        }
        Update: {
          context_data?: Json
          context_key?: string
          created_at?: string
          id?: string
          last_seen_at?: string
          organization_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_context_memory_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_context_memory_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_context_memory_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_context_memory_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_conversation_facts: {
        Row: {
          active_slot: string | null
          conversation_id: string
          created_at: string
          id: string
          organization_id: string
          schema_version: number
          slots: Json
          updated_at: string
        }
        Insert: {
          active_slot?: string | null
          conversation_id: string
          created_at?: string
          id?: string
          organization_id: string
          schema_version?: number
          slots?: Json
          updated_at?: string
        }
        Update: {
          active_slot?: string | null
          conversation_id?: string
          created_at?: string
          id?: string
          organization_id?: string
          schema_version?: number
          slots?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_conversation_facts_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: true
            referencedRelation: "bob_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_conversation_facts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_conversation_facts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_conversation_facts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_conversations: {
        Row: {
          archived_at: string | null
          created_at: string
          id: string
          module_key: string | null
          organization_id: string
          pinned: boolean
          title: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          id?: string
          module_key?: string | null
          organization_id: string
          pinned?: boolean
          title?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          id?: string
          module_key?: string | null
          organization_id?: string
          pinned?: boolean
          title?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_conversations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_conversations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_conversations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_conversations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_event_log: {
        Row: {
          conversation_id: string
          created_at: string
          event_type: string
          id: string
          organization_id: string
          outcome: string | null
          response_id: string | null
          step_index: number
          step_payload: Json
          tool: string | null
          turn_index: number
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          event_type: string
          id?: string
          organization_id: string
          outcome?: string | null
          response_id?: string | null
          step_index: number
          step_payload?: Json
          tool?: string | null
          turn_index: number
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          event_type?: string
          id?: string
          organization_id?: string
          outcome?: string | null
          response_id?: string | null
          step_index?: number
          step_payload?: Json
          tool?: string | null
          turn_index?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_event_log_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "bob_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_event_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_event_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_event_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_event_log_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_friction_packets: {
        Row: {
          basis: Json
          client_packet_key: string
          confidence: number | null
          created_at: string
          disposition: string
          envelope: Json
          id: string
          organization_id: string
          redaction: Json
          retention_cutoff: string | null
          route: string | null
          stop_line_hit: string | null
          triage: string | null
          truth_state: string
          user_id: string
        }
        Insert: {
          basis?: Json
          client_packet_key: string
          confidence?: number | null
          created_at?: string
          disposition?: string
          envelope?: Json
          id?: string
          organization_id: string
          redaction?: Json
          retention_cutoff?: string | null
          route?: string | null
          stop_line_hit?: string | null
          triage?: string | null
          truth_state?: string
          user_id: string
        }
        Update: {
          basis?: Json
          client_packet_key?: string
          confidence?: number | null
          created_at?: string
          disposition?: string
          envelope?: Json
          id?: string
          organization_id?: string
          redaction?: Json
          retention_cutoff?: string | null
          route?: string | null
          stop_line_hit?: string | null
          triage?: string | null
          truth_state?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_friction_packets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_friction_packets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_friction_packets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_friction_packets_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_job_plan_steps: {
        Row: {
          action_type: string
          bob_agentic_action_id: string | null
          created_at: string
          depends_on_step_id: string | null
          error_message: string | null
          id: string
          plan_id: string
          proposed_payload: Json
          sequence: number
          status: string
          updated_at: string
        }
        Insert: {
          action_type: string
          bob_agentic_action_id?: string | null
          created_at?: string
          depends_on_step_id?: string | null
          error_message?: string | null
          id?: string
          plan_id: string
          proposed_payload?: Json
          sequence: number
          status?: string
          updated_at?: string
        }
        Update: {
          action_type?: string
          bob_agentic_action_id?: string | null
          created_at?: string
          depends_on_step_id?: string | null
          error_message?: string | null
          id?: string
          plan_id?: string
          proposed_payload?: Json
          sequence?: number
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_job_plan_steps_bob_agentic_action_id_fkey"
            columns: ["bob_agentic_action_id"]
            isOneToOne: false
            referencedRelation: "bob_agentic_actions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_job_plan_steps_depends_on_step_id_fkey"
            columns: ["depends_on_step_id"]
            isOneToOne: false
            referencedRelation: "bob_job_plan_steps"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_job_plan_steps_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "bob_job_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_job_plans: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          conversation_id: string | null
          created_at: string
          created_by: string | null
          goal: string
          id: string
          organization_id: string
          reasoning: string | null
          status: string
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          goal: string
          id?: string
          organization_id: string
          reasoning?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          conversation_id?: string | null
          created_at?: string
          created_by?: string | null
          goal?: string
          id?: string
          organization_id?: string
          reasoning?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_job_plans_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_job_plans_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "bob_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_job_plans_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_job_plans_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_job_plans_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_job_plans_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_job_rollback_refs: {
        Row: {
          action: string | null
          created_at: string
          id: string
          job_id: string
          reversed: boolean
          reversed_at: string | null
          reversible: boolean
          step_id: string
          target_record_id: string | null
          target_table: string | null
          tool: string
        }
        Insert: {
          action?: string | null
          created_at?: string
          id?: string
          job_id: string
          reversed?: boolean
          reversed_at?: string | null
          reversible?: boolean
          step_id: string
          target_record_id?: string | null
          target_table?: string | null
          tool: string
        }
        Update: {
          action?: string | null
          created_at?: string
          id?: string
          job_id?: string
          reversed?: boolean
          reversed_at?: string | null
          reversible?: boolean
          step_id?: string
          target_record_id?: string | null
          target_table?: string | null
          tool?: string
        }
        Relationships: []
      }
      bob_job_runs: {
        Row: {
          actor_id: string | null
          approval_mode: string
          clarifications: Json
          contains_writes: boolean
          created_at: string
          goal: string
          id: string
          job_id: string
          organization_id: string | null
          parent_agent: string | null
          status: string
          steps: Json
          stopped_reason: string | null
        }
        Insert: {
          actor_id?: string | null
          approval_mode?: string
          clarifications?: Json
          contains_writes?: boolean
          created_at?: string
          goal: string
          id?: string
          job_id: string
          organization_id?: string | null
          parent_agent?: string | null
          status?: string
          steps?: Json
          stopped_reason?: string | null
        }
        Update: {
          actor_id?: string | null
          approval_mode?: string
          clarifications?: Json
          contains_writes?: boolean
          created_at?: string
          goal?: string
          id?: string
          job_id?: string
          organization_id?: string | null
          parent_agent?: string | null
          status?: string
          steps?: Json
          stopped_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bob_job_runs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_job_runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_job_runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_job_runs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_knowledge_cards: {
        Row: {
          category: string
          content: string
          created_at: string
          embedded_at: string | null
          embedding: string | null
          embedding_model: string | null
          id: string
          is_active: boolean
          key: string
          organization_id: string | null
          source: string | null
          tags: string[]
          title: string
          updated_at: string
        }
        Insert: {
          category: string
          content: string
          created_at?: string
          embedded_at?: string | null
          embedding?: string | null
          embedding_model?: string | null
          id?: string
          is_active?: boolean
          key: string
          organization_id?: string | null
          source?: string | null
          tags?: string[]
          title: string
          updated_at?: string
        }
        Update: {
          category?: string
          content?: string
          created_at?: string
          embedded_at?: string | null
          embedding?: string | null
          embedding_model?: string | null
          id?: string
          is_active?: boolean
          key?: string
          organization_id?: string | null
          source?: string | null
          tags?: string[]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_knowledge_cards_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_knowledge_cards_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_knowledge_cards_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_learning_memory: {
        Row: {
          content: string
          created_at: string
          id: string
          memory_kind: string
          organization_id: string
          source: string | null
          user_id: string | null
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          memory_kind: string
          organization_id: string
          source?: string | null
          user_id?: string | null
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          memory_kind?: string
          organization_id?: string
          source?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bob_learning_memory_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_learning_memory_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_learning_memory_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_learning_memory_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_learnings: {
        Row: {
          created_at: string
          id: string
          learning_key: string
          learning_status: string
          learning_text: string
          learning_type: string
          reviewed_at: string | null
          reviewed_by: string | null
          reviewer_note: string | null
          source_date: string
          source_event_ids: string[]
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          learning_key: string
          learning_status?: string
          learning_text: string
          learning_type?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewer_note?: string | null
          source_date?: string
          source_event_ids?: string[]
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          learning_key?: string
          learning_status?: string
          learning_text?: string
          learning_type?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          reviewer_note?: string | null
          source_date?: string
          source_event_ids?: string[]
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_learnings_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_message_feedback: {
        Row: {
          conversation_id: string
          created_at: string
          id: string
          message_id: string
          note: string | null
          organization_id: string
          rating: string
          updated_at: string
          user_id: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          id?: string
          message_id: string
          note?: string | null
          organization_id: string
          rating: string
          updated_at?: string
          user_id: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          id?: string
          message_id?: string
          note?: string | null
          organization_id?: string
          rating?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_message_feedback_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "bob_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_message_feedback_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "bob_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_message_feedback_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_message_feedback_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_message_feedback_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_message_feedback_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_messages: {
        Row: {
          confidence: number | null
          content: string
          conversation_id: string
          created_at: string
          flagged: boolean
          id: string
          metadata: Json
          organization_id: string
          role: string
        }
        Insert: {
          confidence?: number | null
          content: string
          conversation_id: string
          created_at?: string
          flagged?: boolean
          id?: string
          metadata?: Json
          organization_id: string
          role: string
        }
        Update: {
          confidence?: number | null
          content?: string
          conversation_id?: string
          created_at?: string
          flagged?: boolean
          id?: string
          metadata?: Json
          organization_id?: string
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "bob_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_messages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "bob_messages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_messages_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_owner_rulings: {
        Row: {
          authored_by: string
          created_at: string
          domain: string
          id: string
          ruling_key: string
          ruling_status: string
          ruling_text: string
          source: string | null
          superseded_by: string | null
          title: string
          updated_at: string
        }
        Insert: {
          authored_by?: string
          created_at?: string
          domain?: string
          id?: string
          ruling_key: string
          ruling_status?: string
          ruling_text: string
          source?: string | null
          superseded_by?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          authored_by?: string
          created_at?: string
          domain?: string
          id?: string
          ruling_key?: string
          ruling_status?: string
          ruling_text?: string
          source?: string | null
          superseded_by?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_owner_rulings_superseded_by_fkey"
            columns: ["superseded_by"]
            isOneToOne: false
            referencedRelation: "bob_owner_rulings"
            referencedColumns: ["id"]
          },
        ]
      }
      bob_self_memory: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          id: string
          memory_kind: string
          memory_text: string
          owner_note: string | null
          proposed_by: string
          status: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          id?: string
          memory_kind?: string
          memory_text: string
          owner_note?: string | null
          proposed_by?: string
          status?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          id?: string
          memory_kind?: string
          memory_text?: string
          owner_note?: string | null
          proposed_by?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "bob_self_memory_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bob_self_memory_proposed_by_fkey"
            columns: ["proposed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      breach_alerts: {
        Row: {
          action_type: string | null
          actioned_at: string | null
          actioned_by: string | null
          breach_type: string
          client_org_id: string | null
          created_at: string
          id: string
          limit_value: number | null
          nights_count: number | null
          notes: string | null
          observation_id: string | null
          organization_id: string
          overnight_session_id: string | null
          plate_number: string
          status: string
          zone_id: string | null
        }
        Insert: {
          action_type?: string | null
          actioned_at?: string | null
          actioned_by?: string | null
          breach_type?: string
          client_org_id?: string | null
          created_at?: string
          id?: string
          limit_value?: number | null
          nights_count?: number | null
          notes?: string | null
          observation_id?: string | null
          organization_id: string
          overnight_session_id?: string | null
          plate_number: string
          status?: string
          zone_id?: string | null
        }
        Update: {
          action_type?: string | null
          actioned_at?: string | null
          actioned_by?: string | null
          breach_type?: string
          client_org_id?: string | null
          created_at?: string
          id?: string
          limit_value?: number | null
          nights_count?: number | null
          notes?: string | null
          observation_id?: string | null
          organization_id?: string
          overnight_session_id?: string | null
          plate_number?: string
          status?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "breach_alerts_actioned_by_fkey"
            columns: ["actioned_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "breach_alerts_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "breach_alerts_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "breach_alerts_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "breach_alerts_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "breach_alerts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "breach_alerts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "breach_alerts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "breach_alerts_overnight_session_id_fkey"
            columns: ["overnight_session_id"]
            isOneToOne: false
            referencedRelation: "vehicle_overnight_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "breach_alerts_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      breach_records: {
        Row: {
          actioned_at: string | null
          bob_triage_summary: string | null
          breach_type: string
          created_at: string
          detected_at: string
          id: string
          location_id: string | null
          module_key: string
          officer_user_id: string | null
          organization_id: string
          status: string
          vehicle_id: string | null
          vehicle_observation_id: string | null
          zone_id: string | null
        }
        Insert: {
          actioned_at?: string | null
          bob_triage_summary?: string | null
          breach_type: string
          created_at?: string
          detected_at?: string
          id?: string
          location_id?: string | null
          module_key: string
          officer_user_id?: string | null
          organization_id: string
          status?: string
          vehicle_id?: string | null
          vehicle_observation_id?: string | null
          zone_id?: string | null
        }
        Update: {
          actioned_at?: string | null
          bob_triage_summary?: string | null
          breach_type?: string
          created_at?: string
          detected_at?: string
          id?: string
          location_id?: string | null
          module_key?: string
          officer_user_id?: string | null
          organization_id?: string
          status?: string
          vehicle_id?: string | null
          vehicle_observation_id?: string | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "breach_records_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "breach_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "breach_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "breach_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "breach_records_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "breach_records_vehicle_observation_id_fkey"
            columns: ["vehicle_observation_id"]
            isOneToOne: false
            referencedRelation: "vehicle_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "breach_records_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      callout_shifts: {
        Row: {
          after_minimum_rate: number | null
          arrived_at: string | null
          callout_received_at: string | null
          created_at: string
          departed_at: string | null
          dispatch_job_id: string | null
          id: string
          minimum_pay_hours: number
          officer_user_id: string
          on_call_period_id: string
          organization_id: string
          returned_at: string | null
          work_ended_at: string | null
          work_started_at: string | null
        }
        Insert: {
          after_minimum_rate?: number | null
          arrived_at?: string | null
          callout_received_at?: string | null
          created_at?: string
          departed_at?: string | null
          dispatch_job_id?: string | null
          id?: string
          minimum_pay_hours?: number
          officer_user_id: string
          on_call_period_id: string
          organization_id: string
          returned_at?: string | null
          work_ended_at?: string | null
          work_started_at?: string | null
        }
        Update: {
          after_minimum_rate?: number | null
          arrived_at?: string | null
          callout_received_at?: string | null
          created_at?: string
          departed_at?: string | null
          dispatch_job_id?: string | null
          id?: string
          minimum_pay_hours?: number
          officer_user_id?: string
          on_call_period_id?: string
          organization_id?: string
          returned_at?: string | null
          work_ended_at?: string | null
          work_started_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "callout_shifts_dispatch_job_id_fkey"
            columns: ["dispatch_job_id"]
            isOneToOne: false
            referencedRelation: "dispatch_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "callout_shifts_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "callout_shifts_on_call_period_id_fkey"
            columns: ["on_call_period_id"]
            isOneToOne: false
            referencedRelation: "on_call_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "callout_shifts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "callout_shifts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "callout_shifts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      canonical_homeless: {
        Row: {
          created_at: string
          flagged_at: string
          flagged_by_org: string | null
          id: string
          notes: string | null
          plate_number: string
          resolved_at: string | null
          status: string
          support_agency: string | null
          support_contact: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          flagged_at?: string
          flagged_by_org?: string | null
          id?: string
          notes?: string | null
          plate_number: string
          resolved_at?: string | null
          status?: string
          support_agency?: string | null
          support_contact?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          flagged_at?: string
          flagged_by_org?: string | null
          id?: string
          notes?: string | null
          plate_number?: string
          resolved_at?: string | null
          status?: string
          support_agency?: string | null
          support_contact?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "canonical_homeless_flagged_by_org_fkey"
            columns: ["flagged_by_org"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "canonical_homeless_flagged_by_org_fkey"
            columns: ["flagged_by_org"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "canonical_homeless_flagged_by_org_fkey"
            columns: ["flagged_by_org"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      canonical_scv: {
        Row: {
          certificate_number: string | null
          certificate_status: string
          created_at: string
          expiry_date: string | null
          id: string
          import_batch_id: string | null
          imported_at: string | null
          issued_date: string | null
          last_checked_at: string
          nzscv_raw: Json | null
          plate_number: string
          raw_source_row: Json
          source: string
          updated_at: string
          vehicle_make: string | null
          vehicle_model: string | null
          vehicle_year: number | null
        }
        Insert: {
          certificate_number?: string | null
          certificate_status?: string
          created_at?: string
          expiry_date?: string | null
          id?: string
          import_batch_id?: string | null
          imported_at?: string | null
          issued_date?: string | null
          last_checked_at?: string
          nzscv_raw?: Json | null
          plate_number: string
          raw_source_row?: Json
          source?: string
          updated_at?: string
          vehicle_make?: string | null
          vehicle_model?: string | null
          vehicle_year?: number | null
        }
        Update: {
          certificate_number?: string | null
          certificate_status?: string
          created_at?: string
          expiry_date?: string | null
          id?: string
          import_batch_id?: string | null
          imported_at?: string | null
          issued_date?: string | null
          last_checked_at?: string
          nzscv_raw?: Json | null
          plate_number?: string
          raw_source_row?: Json
          source?: string
          updated_at?: string
          vehicle_make?: string | null
          vehicle_model?: string | null
          vehicle_year?: number | null
        }
        Relationships: []
      }
      canonical_ta_names: {
        Row: {
          created_at: string
          id: string
          last_refreshed_at: string
          source: string
          ta_name: string
          ta_name_upper: string
        }
        Insert: {
          created_at?: string
          id?: string
          last_refreshed_at?: string
          source?: string
          ta_name: string
          ta_name_upper?: string
        }
        Update: {
          created_at?: string
          id?: string
          last_refreshed_at?: string
          source?: string
          ta_name?: string
          ta_name_upper?: string
        }
        Relationships: []
      }
      canonical_vehicles: {
        Row: {
          body_type: string | null
          cof_expiry: string | null
          cof_status: string | null
          colour: string | null
          compliance_checked_at: string | null
          compliance_source: string | null
          created_at: string
          embedding_quality: number | null
          fuel_type: string | null
          homeless_notes: string | null
          homeless_status: string
          homeless_verified_at: string | null
          id: string
          last_seen_at: string | null
          make: string | null
          model: string | null
          motorweb_enriched_at: string | null
          plate_number: string
          registered_owner_name: string | null
          rego_expiry: string | null
          rego_status: string | null
          updated_at: string
          wof_expiry: string | null
          wof_status: string | null
          year: number | null
        }
        Insert: {
          body_type?: string | null
          cof_expiry?: string | null
          cof_status?: string | null
          colour?: string | null
          compliance_checked_at?: string | null
          compliance_source?: string | null
          created_at?: string
          embedding_quality?: number | null
          fuel_type?: string | null
          homeless_notes?: string | null
          homeless_status?: string
          homeless_verified_at?: string | null
          id?: string
          last_seen_at?: string | null
          make?: string | null
          model?: string | null
          motorweb_enriched_at?: string | null
          plate_number: string
          registered_owner_name?: string | null
          rego_expiry?: string | null
          rego_status?: string | null
          updated_at?: string
          wof_expiry?: string | null
          wof_status?: string | null
          year?: number | null
        }
        Update: {
          body_type?: string | null
          cof_expiry?: string | null
          cof_status?: string | null
          colour?: string | null
          compliance_checked_at?: string | null
          compliance_source?: string | null
          created_at?: string
          embedding_quality?: number | null
          fuel_type?: string | null
          homeless_notes?: string | null
          homeless_status?: string
          homeless_verified_at?: string | null
          id?: string
          last_seen_at?: string | null
          make?: string | null
          model?: string | null
          motorweb_enriched_at?: string | null
          plate_number?: string
          registered_owner_name?: string | null
          rego_expiry?: string | null
          rego_status?: string | null
          updated_at?: string
          wof_expiry?: string | null
          wof_status?: string | null
          year?: number | null
        }
        Relationships: []
      }
      client_site_patrol_config: {
        Row: {
          active: boolean
          active_days: number[]
          active_months: number[]
          created_at: string
          dwell_minutes: number
          id: string
          min_gap_between_visits_minutes: number
          module_key: string
          officer_instructions: string | null
          organization_id: string
          patrol_route_id: string | null
          preferred_stop_order: number
          required_actions: Json
          site_id: string | null
          sla_arrive_within_minutes: number
          sla_depart_within_minutes: number
          sunrise_offset_minutes: number
          sunset_offset_minutes: number
          time_window_type: string
          updated_at: string
          visits_per_shift: number
          window_end: string | null
          window_start: string | null
          zone_id: string | null
        }
        Insert: {
          active?: boolean
          active_days?: number[]
          active_months?: number[]
          created_at?: string
          dwell_minutes?: number
          id?: string
          min_gap_between_visits_minutes?: number
          module_key: string
          officer_instructions?: string | null
          organization_id: string
          patrol_route_id?: string | null
          preferred_stop_order?: number
          required_actions?: Json
          site_id?: string | null
          sla_arrive_within_minutes?: number
          sla_depart_within_minutes?: number
          sunrise_offset_minutes?: number
          sunset_offset_minutes?: number
          time_window_type?: string
          updated_at?: string
          visits_per_shift?: number
          window_end?: string | null
          window_start?: string | null
          zone_id?: string | null
        }
        Update: {
          active?: boolean
          active_days?: number[]
          active_months?: number[]
          created_at?: string
          dwell_minutes?: number
          id?: string
          min_gap_between_visits_minutes?: number
          module_key?: string
          officer_instructions?: string | null
          organization_id?: string
          patrol_route_id?: string | null
          preferred_stop_order?: number
          required_actions?: Json
          site_id?: string | null
          sla_arrive_within_minutes?: number
          sla_depart_within_minutes?: number
          sunrise_offset_minutes?: number
          sunset_offset_minutes?: number
          time_window_type?: string
          updated_at?: string
          visits_per_shift?: number
          window_end?: string | null
          window_start?: string | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_site_patrol_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "client_site_patrol_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_site_patrol_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_site_patrol_config_patrol_route_id_fkey"
            columns: ["patrol_route_id"]
            isOneToOne: false
            referencedRelation: "patrol_routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_site_patrol_config_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_site_patrol_config_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      client_site_zones: {
        Row: {
          id: string
          jurisdiction_rule_set_id: string | null
          metadata: Json
          module_key: string
          name: string
          organization_id: string
          site_id: string | null
        }
        Insert: {
          id?: string
          jurisdiction_rule_set_id?: string | null
          metadata?: Json
          module_key: string
          name: string
          organization_id: string
          site_id?: string | null
        }
        Update: {
          id?: string
          jurisdiction_rule_set_id?: string | null
          metadata?: Json
          module_key?: string
          name?: string
          organization_id?: string
          site_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_site_zones_jurisdiction_rule_set_id_fkey"
            columns: ["jurisdiction_rule_set_id"]
            isOneToOne: false
            referencedRelation: "jurisdiction_rule_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_site_zones_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "client_site_zones_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_site_zones_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_site_zones_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      client_sites: {
        Row: {
          access_instructions: string | null
          active: boolean
          address: string | null
          address_match_key: string | null
          boundary: unknown
          boundary_status: string
          boundary_verification: string
          boundary_verified_at: string | null
          boundary_verified_by: string | null
          center_point: unknown
          client_organization_id: string
          created_at: string
          external_ref: string | null
          external_refs: Json
          gps_lat: number | null
          gps_lng: number | null
          hs_notes: string | null
          id: string
          internal_client_ref: string | null
          jurisdiction_config_id: string | null
          location_id: string | null
          metadata: Json
          module_title: string | null
          name: string
          onsite_radius_meters: number
          ownership_signals: Json | null
          ownership_status: string
          prompt_radius_meters: number
          risk_level: string | null
          service_agreement_id: string | null
          site_brief: string | null
          site_code: string | null
          site_origin: string
          site_type: string | null
        }
        Insert: {
          access_instructions?: string | null
          active?: boolean
          address?: string | null
          address_match_key?: string | null
          boundary?: unknown
          boundary_status?: string
          boundary_verification?: string
          boundary_verified_at?: string | null
          boundary_verified_by?: string | null
          center_point?: unknown
          client_organization_id: string
          created_at?: string
          external_ref?: string | null
          external_refs?: Json
          gps_lat?: number | null
          gps_lng?: number | null
          hs_notes?: string | null
          id?: string
          internal_client_ref?: string | null
          jurisdiction_config_id?: string | null
          location_id?: string | null
          metadata?: Json
          module_title?: string | null
          name: string
          onsite_radius_meters?: number
          ownership_signals?: Json | null
          ownership_status?: string
          prompt_radius_meters?: number
          risk_level?: string | null
          service_agreement_id?: string | null
          site_brief?: string | null
          site_code?: string | null
          site_origin?: string
          site_type?: string | null
        }
        Update: {
          access_instructions?: string | null
          active?: boolean
          address?: string | null
          address_match_key?: string | null
          boundary?: unknown
          boundary_status?: string
          boundary_verification?: string
          boundary_verified_at?: string | null
          boundary_verified_by?: string | null
          center_point?: unknown
          client_organization_id?: string
          created_at?: string
          external_ref?: string | null
          external_refs?: Json
          gps_lat?: number | null
          gps_lng?: number | null
          hs_notes?: string | null
          id?: string
          internal_client_ref?: string | null
          jurisdiction_config_id?: string | null
          location_id?: string | null
          metadata?: Json
          module_title?: string | null
          name?: string
          onsite_radius_meters?: number
          ownership_signals?: Json | null
          ownership_status?: string
          prompt_radius_meters?: number
          risk_level?: string | null
          service_agreement_id?: string | null
          site_brief?: string | null
          site_code?: string | null
          site_origin?: string
          site_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "client_sites_boundary_verified_by_fkey"
            columns: ["boundary_verified_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sites_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "client_sites_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sites_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sites_jurisdiction_config_id_fkey"
            columns: ["jurisdiction_config_id"]
            isOneToOne: false
            referencedRelation: "crm_jurisdiction_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sites_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "client_sites_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_activity_log: {
        Row: {
          activity_type: string
          actor_id: string | null
          body: string | null
          created_at: string
          follow_up_at: string | null
          id: string
          organization_id: string
          subject: string
        }
        Insert: {
          activity_type?: string
          actor_id?: string | null
          body?: string | null
          created_at?: string
          follow_up_at?: string | null
          id?: string
          organization_id: string
          subject: string
        }
        Update: {
          activity_type?: string
          actor_id?: string | null
          body?: string | null
          created_at?: string
          follow_up_at?: string | null
          id?: string
          organization_id?: string
          subject?: string
        }
        Relationships: [
          {
            foreignKeyName: "crm_activity_log_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_activity_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "crm_activity_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_activity_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_commercial_settings: {
        Row: {
          base_rate_per_hour: number | null
          billing_cycle: string
          callout_minimum_hours: number | null
          callout_rate_per_hour: number | null
          created_at: string
          currency: string
          id: string
          infringement_admin_fee: number | null
          invoice_email: string | null
          notes: string | null
          overtime_rate_per_hour: number | null
          payment_terms_days: number
          purchase_order_number: string | null
          service_agreement_id: string
          travel_rate_per_km: number | null
        }
        Insert: {
          base_rate_per_hour?: number | null
          billing_cycle?: string
          callout_minimum_hours?: number | null
          callout_rate_per_hour?: number | null
          created_at?: string
          currency?: string
          id?: string
          infringement_admin_fee?: number | null
          invoice_email?: string | null
          notes?: string | null
          overtime_rate_per_hour?: number | null
          payment_terms_days?: number
          purchase_order_number?: string | null
          service_agreement_id: string
          travel_rate_per_km?: number | null
        }
        Update: {
          base_rate_per_hour?: number | null
          billing_cycle?: string
          callout_minimum_hours?: number | null
          callout_rate_per_hour?: number | null
          created_at?: string
          currency?: string
          id?: string
          infringement_admin_fee?: number | null
          invoice_email?: string | null
          notes?: string | null
          overtime_rate_per_hour?: number | null
          payment_terms_days?: number
          purchase_order_number?: string | null
          service_agreement_id?: string
          travel_rate_per_km?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "crm_commercial_settings_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_contacts: {
        Row: {
          created_at: string
          email: string | null
          first_name: string
          id: string
          is_emergency: boolean
          is_primary: boolean
          last_name: string
          mobile: string | null
          notes: string | null
          organization_id: string
          phone: string | null
          role_title: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          first_name: string
          id?: string
          is_emergency?: boolean
          is_primary?: boolean
          last_name: string
          mobile?: string | null
          notes?: string | null
          organization_id: string
          phone?: string | null
          role_title?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          first_name?: string
          id?: string
          is_emergency?: boolean
          is_primary?: boolean
          last_name?: string
          mobile?: string | null
          notes?: string | null
          organization_id?: string
          phone?: string | null
          role_title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "crm_contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "crm_contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_contacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      crm_jurisdiction_configs: {
        Row: {
          biosecurity_authority: boolean
          bylaw_name: string | null
          bylaw_url: string | null
          bylaw_year: number | null
          created_at: string
          fca_authority: boolean
          id: string
          infringement_amount: number | null
          jurisdiction_name: string
          jurisdiction_type: string
          legal_contact_email: string | null
          legal_contact_name: string | null
          legal_contact_phone: string | null
          lga_authority: boolean
          notes: string | null
          objections_email: string | null
          organization_id: string
          payment_deadline_days: number | null
          payment_url: string | null
          rma_authority: boolean
          trespass_authority: boolean
        }
        Insert: {
          biosecurity_authority?: boolean
          bylaw_name?: string | null
          bylaw_url?: string | null
          bylaw_year?: number | null
          created_at?: string
          fca_authority?: boolean
          id?: string
          infringement_amount?: number | null
          jurisdiction_name: string
          jurisdiction_type: string
          legal_contact_email?: string | null
          legal_contact_name?: string | null
          legal_contact_phone?: string | null
          lga_authority?: boolean
          notes?: string | null
          objections_email?: string | null
          organization_id: string
          payment_deadline_days?: number | null
          payment_url?: string | null
          rma_authority?: boolean
          trespass_authority?: boolean
        }
        Update: {
          biosecurity_authority?: boolean
          bylaw_name?: string | null
          bylaw_url?: string | null
          bylaw_year?: number | null
          created_at?: string
          fca_authority?: boolean
          id?: string
          infringement_amount?: number | null
          jurisdiction_name?: string
          jurisdiction_type?: string
          legal_contact_email?: string | null
          legal_contact_name?: string | null
          legal_contact_phone?: string | null
          lga_authority?: boolean
          notes?: string | null
          objections_email?: string | null
          organization_id?: string
          payment_deadline_days?: number | null
          payment_url?: string | null
          rma_authority?: boolean
          trespass_authority?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "crm_jurisdiction_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "crm_jurisdiction_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "crm_jurisdiction_configs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      dev_policy_rules: {
        Row: {
          active: boolean
          created_at: string
          description: string | null
          id: string
          rule_key: string
          rule_value: Json
        }
        Insert: {
          active?: boolean
          created_at?: string
          description?: string | null
          id?: string
          rule_key: string
          rule_value: Json
        }
        Update: {
          active?: boolean
          created_at?: string
          description?: string | null
          id?: string
          rule_key?: string
          rule_value?: Json
        }
        Relationships: []
      }
      dev_work_acceptance_criteria: {
        Row: {
          created_at: string
          criterion_text: string
          id: string
          is_required: boolean
          sort_order: number
          work_request_id: string
        }
        Insert: {
          created_at?: string
          criterion_text: string
          id?: string
          is_required?: boolean
          sort_order?: number
          work_request_id: string
        }
        Update: {
          created_at?: string
          criterion_text?: string
          id?: string
          is_required?: boolean
          sort_order?: number
          work_request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dev_work_acceptance_criteria_work_request_id_fkey"
            columns: ["work_request_id"]
            isOneToOne: false
            referencedRelation: "dev_work_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      dev_work_approvals: {
        Row: {
          approval_stage: string
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision: string
          decision_note: string | null
          id: string
          work_request_id: string
        }
        Insert: {
          approval_stage: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision: string
          decision_note?: string | null
          id?: string
          work_request_id: string
        }
        Update: {
          approval_stage?: string
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision?: string
          decision_note?: string | null
          id?: string
          work_request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dev_work_approvals_work_request_id_fkey"
            columns: ["work_request_id"]
            isOneToOne: false
            referencedRelation: "dev_work_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      dev_work_artifacts: {
        Row: {
          artifact_type: string
          content_json: Json | null
          content_text: string | null
          created_at: string
          id: string
          mime_type: string | null
          run_id: string
          storage_path: string | null
        }
        Insert: {
          artifact_type: string
          content_json?: Json | null
          content_text?: string | null
          created_at?: string
          id?: string
          mime_type?: string | null
          run_id: string
          storage_path?: string | null
        }
        Update: {
          artifact_type?: string
          content_json?: Json | null
          content_text?: string | null
          created_at?: string
          id?: string
          mime_type?: string | null
          run_id?: string
          storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dev_work_artifacts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "dev_work_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      dev_work_events: {
        Row: {
          created_at: string
          created_by: string | null
          event_payload: Json
          event_type: string
          id: string
          run_id: string | null
          work_request_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          event_payload?: Json
          event_type: string
          id?: string
          run_id?: string | null
          work_request_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          event_payload?: Json
          event_type?: string
          id?: string
          run_id?: string | null
          work_request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "dev_work_events_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "dev_work_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dev_work_events_work_request_id_fkey"
            columns: ["work_request_id"]
            isOneToOne: false
            referencedRelation: "dev_work_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      dev_work_requests: {
        Row: {
          assigned_runner: string | null
          created_at: string
          description: string | null
          draft_branch: string | null
          execution_host: string
          goal: string
          id: string
          promoted_at: string | null
          ratified_at: string | null
          request_type: string
          requested_by: string | null
          risk_tier: string
          source_repo: string | null
          status: string
          target_area: string | null
          target_branch: string | null
          title: string
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          assigned_runner?: string | null
          created_at?: string
          description?: string | null
          draft_branch?: string | null
          execution_host?: string
          goal: string
          id?: string
          promoted_at?: string | null
          ratified_at?: string | null
          request_type: string
          requested_by?: string | null
          risk_tier: string
          source_repo?: string | null
          status: string
          target_area?: string | null
          target_branch?: string | null
          title: string
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          assigned_runner?: string | null
          created_at?: string
          description?: string | null
          draft_branch?: string | null
          execution_host?: string
          goal?: string
          id?: string
          promoted_at?: string | null
          ratified_at?: string | null
          request_type?: string
          requested_by?: string | null
          risk_tier?: string
          source_repo?: string | null
          status?: string
          target_area?: string | null
          target_branch?: string | null
          title?: string
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      dev_work_runs: {
        Row: {
          branch_name: string | null
          build_summary: Json | null
          commit_ref: string | null
          created_at: string
          exit_summary: string | null
          failure_summary: string | null
          finished_at: string | null
          id: string
          run_number: number
          started_at: string | null
          status: string
          test_summary: Json | null
          work_request_id: string
          worker_host: string | null
          worker_name: string | null
        }
        Insert: {
          branch_name?: string | null
          build_summary?: Json | null
          commit_ref?: string | null
          created_at?: string
          exit_summary?: string | null
          failure_summary?: string | null
          finished_at?: string | null
          id?: string
          run_number: number
          started_at?: string | null
          status: string
          test_summary?: Json | null
          work_request_id: string
          worker_host?: string | null
          worker_name?: string | null
        }
        Update: {
          branch_name?: string | null
          build_summary?: Json | null
          commit_ref?: string | null
          created_at?: string
          exit_summary?: string | null
          failure_summary?: string | null
          finished_at?: string | null
          id?: string
          run_number?: number
          started_at?: string | null
          status?: string
          test_summary?: Json | null
          work_request_id?: string
          worker_host?: string | null
          worker_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dev_work_runs_work_request_id_fkey"
            columns: ["work_request_id"]
            isOneToOne: false
            referencedRelation: "dev_work_requests"
            referencedColumns: ["id"]
          },
        ]
      }
      dispatch_job_pay_lines: {
        Row: {
          created_at: string
          day_category: string | null
          description: string
          distance_km: number | null
          distance_reason: string | null
          id: string
          line_total: number
          multiplier: number
          officer_user_id: string | null
          organization_id: string
          pay_code: string | null
          quantity: number
          rate_rule_id: string | null
          rate_type: string
          region_code: string | null
          role_code: string | null
          service_type: string | null
          source_dispatch_id: string
          unit_rate: number
        }
        Insert: {
          created_at?: string
          day_category?: string | null
          description: string
          distance_km?: number | null
          distance_reason?: string | null
          id?: string
          line_total?: number
          multiplier?: number
          officer_user_id?: string | null
          organization_id: string
          pay_code?: string | null
          quantity?: number
          rate_rule_id?: string | null
          rate_type: string
          region_code?: string | null
          role_code?: string | null
          service_type?: string | null
          source_dispatch_id: string
          unit_rate?: number
        }
        Update: {
          created_at?: string
          day_category?: string | null
          description?: string
          distance_km?: number | null
          distance_reason?: string | null
          id?: string
          line_total?: number
          multiplier?: number
          officer_user_id?: string | null
          organization_id?: string
          pay_code?: string | null
          quantity?: number
          rate_rule_id?: string | null
          rate_type?: string
          region_code?: string | null
          role_code?: string | null
          service_type?: string | null
          source_dispatch_id?: string
          unit_rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "dispatch_job_pay_lines_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_job_pay_lines_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "dispatch_job_pay_lines_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_job_pay_lines_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_job_pay_lines_rate_rule_id_fkey"
            columns: ["rate_rule_id"]
            isOneToOne: false
            referencedRelation: "rate_rules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_job_pay_lines_source_dispatch_id_fkey"
            columns: ["source_dispatch_id"]
            isOneToOne: false
            referencedRelation: "dispatch_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      dispatch_jobs: {
        Row: {
          acknowledged_at: string | null
          adhoc_inserted_at: string | null
          briefing_notes: string | null
          client_site_id: string | null
          completed_at: string | null
          created_at: string
          dispatch_resource_id: string | null
          dispatched_at: string | null
          en_route_at: string | null
          id: string
          insert_gps_lat: number | null
          insert_gps_lng: number | null
          job_type: string
          location_id: string | null
          on_scene_at: string | null
          organization_id: string
          outcome_notes: string | null
          priority: string
          service_agreement_id: string | null
          shift_id: string | null
          shift_stop_id: string | null
          sla_breached: boolean
          sla_impact_report: Json | null
          sla_impact_warning: boolean
          sla_minutes: number | null
          sla_respond_by: string | null
          status: string
        }
        Insert: {
          acknowledged_at?: string | null
          adhoc_inserted_at?: string | null
          briefing_notes?: string | null
          client_site_id?: string | null
          completed_at?: string | null
          created_at?: string
          dispatch_resource_id?: string | null
          dispatched_at?: string | null
          en_route_at?: string | null
          id?: string
          insert_gps_lat?: number | null
          insert_gps_lng?: number | null
          job_type: string
          location_id?: string | null
          on_scene_at?: string | null
          organization_id: string
          outcome_notes?: string | null
          priority?: string
          service_agreement_id?: string | null
          shift_id?: string | null
          shift_stop_id?: string | null
          sla_breached?: boolean
          sla_impact_report?: Json | null
          sla_impact_warning?: boolean
          sla_minutes?: number | null
          sla_respond_by?: string | null
          status?: string
        }
        Update: {
          acknowledged_at?: string | null
          adhoc_inserted_at?: string | null
          briefing_notes?: string | null
          client_site_id?: string | null
          completed_at?: string | null
          created_at?: string
          dispatch_resource_id?: string | null
          dispatched_at?: string | null
          en_route_at?: string | null
          id?: string
          insert_gps_lat?: number | null
          insert_gps_lng?: number | null
          job_type?: string
          location_id?: string | null
          on_scene_at?: string | null
          organization_id?: string
          outcome_notes?: string | null
          priority?: string
          service_agreement_id?: string | null
          shift_id?: string | null
          shift_stop_id?: string | null
          sla_breached?: boolean
          sla_impact_report?: Json | null
          sla_impact_warning?: boolean
          sla_minutes?: number | null
          sla_respond_by?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "dispatch_jobs_client_site_id_fkey"
            columns: ["client_site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_jobs_dispatch_resource_id_fkey"
            columns: ["dispatch_resource_id"]
            isOneToOne: false
            referencedRelation: "dispatch_resources"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "dispatch_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_jobs_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_jobs_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_jobs_shift_stop_id_fkey"
            columns: ["shift_stop_id"]
            isOneToOne: false
            referencedRelation: "shift_stops"
            referencedColumns: ["id"]
          },
        ]
      }
      dispatch_resources: {
        Row: {
          assigned_officer_id: string | null
          callsign: string | null
          created_at: string
          id: string
          location_id: string | null
          name: string
          organization_id: string
          service_type: string
          status: string
        }
        Insert: {
          assigned_officer_id?: string | null
          callsign?: string | null
          created_at?: string
          id?: string
          location_id?: string | null
          name: string
          organization_id: string
          service_type: string
          status?: string
        }
        Update: {
          assigned_officer_id?: string | null
          callsign?: string | null
          created_at?: string
          id?: string
          location_id?: string | null
          name?: string
          organization_id?: string
          service_type?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "dispatch_resources_assigned_officer_id_fkey"
            columns: ["assigned_officer_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_resources_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "dispatch_resources_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_resources_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      disputes: {
        Row: {
          bob_analysis: string | null
          bob_confidence: number | null
          created_at: string
          decided_at: string | null
          decided_by: string | null
          decision_note: string | null
          dispute_type: string | null
          grounds: string | null
          id: string
          notice_date: string | null
          notice_id: string
          notice_number: string | null
          organization_id: string
          plate_number: string | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          scv_number: string | null
          statement: string | null
          status: string
          submitted_at: string
          submitter_email: string | null
          submitter_name: string | null
          submitter_phone: string | null
        }
        Insert: {
          bob_analysis?: string | null
          bob_confidence?: number | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          dispute_type?: string | null
          grounds?: string | null
          id?: string
          notice_date?: string | null
          notice_id: string
          notice_number?: string | null
          organization_id: string
          plate_number?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          scv_number?: string | null
          statement?: string | null
          status?: string
          submitted_at?: string
          submitter_email?: string | null
          submitter_name?: string | null
          submitter_phone?: string | null
        }
        Update: {
          bob_analysis?: string | null
          bob_confidence?: number | null
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          decision_note?: string | null
          dispute_type?: string | null
          grounds?: string | null
          id?: string
          notice_date?: string | null
          notice_id?: string
          notice_number?: string | null
          organization_id?: string
          plate_number?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          scv_number?: string | null
          statement?: string | null
          status?: string
          submitted_at?: string
          submitter_email?: string | null
          submitter_name?: string | null
          submitter_phone?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "disputes_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "notices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "disputes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      document_classifications: {
        Row: {
          classifier_source: string
          confidence: number | null
          contains_financial_data: boolean
          contains_legal_privilege: boolean
          contains_operational_security: boolean
          contains_pii: boolean
          created_at: string
          document_version_id: string
          id: string
          privacy_class: string
          rationale: string | null
          reviewed_at: string | null
          reviewed_by: string | null
        }
        Insert: {
          classifier_source?: string
          confidence?: number | null
          contains_financial_data?: boolean
          contains_legal_privilege?: boolean
          contains_operational_security?: boolean
          contains_pii?: boolean
          created_at?: string
          document_version_id: string
          id?: string
          privacy_class: string
          rationale?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
        }
        Update: {
          classifier_source?: string
          confidence?: number | null
          contains_financial_data?: boolean
          contains_legal_privilege?: boolean
          contains_operational_security?: boolean
          contains_pii?: boolean
          created_at?: string
          document_version_id?: string
          id?: string
          privacy_class?: string
          rationale?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "document_classifications_document_version_id_fkey"
            columns: ["document_version_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_classifications_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      document_reference_sources: {
        Row: {
          approval_status: string
          created_at: string
          default_scope: string
          default_sensitivity: string
          id: string
          is_active: boolean
          label: string
          location_ref: string
          notes: string | null
          organization_id: string | null
          source_kind: string
          trust_level: string
          updated_at: string
        }
        Insert: {
          approval_status?: string
          created_at?: string
          default_scope?: string
          default_sensitivity?: string
          id?: string
          is_active?: boolean
          label: string
          location_ref: string
          notes?: string | null
          organization_id?: string | null
          source_kind?: string
          trust_level?: string
          updated_at?: string
        }
        Update: {
          approval_status?: string
          created_at?: string
          default_scope?: string
          default_sensitivity?: string
          id?: string
          is_active?: boolean
          label?: string
          location_ref?: string
          notes?: string | null
          organization_id?: string | null
          source_kind?: string
          trust_level?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_reference_sources_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "document_reference_sources_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_reference_sources_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      document_upload_events: {
        Row: {
          attachment_id: string | null
          conversation_id: string | null
          created_at: string
          document_id: string | null
          id: string
          mime_type: string | null
          organization_id: string | null
          original_filename: string
          sha256: string
          source_channel: string
          uploaded_by: string | null
          was_deduplicated: boolean
        }
        Insert: {
          attachment_id?: string | null
          conversation_id?: string | null
          created_at?: string
          document_id?: string | null
          id?: string
          mime_type?: string | null
          organization_id?: string | null
          original_filename: string
          sha256: string
          source_channel?: string
          uploaded_by?: string | null
          was_deduplicated?: boolean
        }
        Update: {
          attachment_id?: string | null
          conversation_id?: string | null
          created_at?: string
          document_id?: string | null
          id?: string
          mime_type?: string | null
          organization_id?: string | null
          original_filename?: string
          sha256?: string
          source_channel?: string
          uploaded_by?: string | null
          was_deduplicated?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "document_upload_events_attachment_id_fkey"
            columns: ["attachment_id"]
            isOneToOne: false
            referencedRelation: "bob_attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_upload_events_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "bob_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_upload_events_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_upload_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "document_upload_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_upload_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_upload_events_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      document_versions: {
        Row: {
          created_at: string
          document_id: string
          effective_from: string | null
          effective_to: string | null
          extracted_text: string | null
          extraction_confidence: number | null
          id: string
          metadata_json: Json
          ocr_required: boolean
          supersedes_version_id: string | null
          updated_at: string
          version_label: string
        }
        Insert: {
          created_at?: string
          document_id: string
          effective_from?: string | null
          effective_to?: string | null
          extracted_text?: string | null
          extraction_confidence?: number | null
          id?: string
          metadata_json?: Json
          ocr_required?: boolean
          supersedes_version_id?: string | null
          updated_at?: string
          version_label?: string
        }
        Update: {
          created_at?: string
          document_id?: string
          effective_from?: string | null
          effective_to?: string | null
          extracted_text?: string | null
          extraction_confidence?: number | null
          id?: string
          metadata_json?: Json
          ocr_required?: boolean
          supersedes_version_id?: string | null
          updated_at?: string
          version_label?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_versions_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_versions_supersedes_version_id_fkey"
            columns: ["supersedes_version_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          attachment_id: string | null
          conversation_id: string | null
          created_at: string
          current_scope: string
          id: string
          mime_type: string
          organization_id: string | null
          original_filename: string
          sha256: string | null
          source_channel: string
          storage_bucket: string
          storage_object_ref: string | null
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          attachment_id?: string | null
          conversation_id?: string | null
          created_at?: string
          current_scope?: string
          id?: string
          mime_type: string
          organization_id?: string | null
          original_filename: string
          sha256?: string | null
          source_channel?: string
          storage_bucket?: string
          storage_object_ref?: string | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          attachment_id?: string | null
          conversation_id?: string | null
          created_at?: string
          current_scope?: string
          id?: string
          mime_type?: string
          organization_id?: string | null
          original_filename?: string
          sha256?: string | null
          source_channel?: string
          storage_bucket?: string
          storage_object_ref?: string | null
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_attachment_id_fkey"
            columns: ["attachment_id"]
            isOneToOne: false
            referencedRelation: "bob_attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "bob_conversations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ems_alerts: {
        Row: {
          acknowledged_at: string | null
          alert_type: string
          device_id: string
          id: string
          organization_id: string
          outcome: string | null
          resolved_at: string | null
          responded_by: string | null
          severity: string
          status: string
          triggered_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          alert_type: string
          device_id: string
          id?: string
          organization_id: string
          outcome?: string | null
          resolved_at?: string | null
          responded_by?: string | null
          severity: string
          status?: string
          triggered_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          alert_type?: string
          device_id?: string
          id?: string
          organization_id?: string
          outcome?: string | null
          resolved_at?: string | null
          responded_by?: string | null
          severity?: string
          status?: string
          triggered_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ems_alerts_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "ems_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ems_alerts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "ems_alerts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ems_alerts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ems_alerts_responded_by_fkey"
            columns: ["responded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      ems_device_checks: {
        Row: {
          checked_at: string
          device_id: string
          gps_lat: number | null
          gps_lng: number | null
          id: string
          notes: string | null
          officer_user_id: string | null
          organization_id: string
          participant_present: boolean | null
          physical_condition: string | null
          signal_quality: string | null
          tamper_observed: boolean
        }
        Insert: {
          checked_at?: string
          device_id: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          officer_user_id?: string | null
          organization_id: string
          participant_present?: boolean | null
          physical_condition?: string | null
          signal_quality?: string | null
          tamper_observed?: boolean
        }
        Update: {
          checked_at?: string
          device_id?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          officer_user_id?: string | null
          organization_id?: string
          participant_present?: boolean | null
          physical_condition?: string | null
          signal_quality?: string | null
          tamper_observed?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "ems_device_checks_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "ems_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ems_device_checks_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ems_device_checks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "ems_device_checks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ems_device_checks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ems_devices: {
        Row: {
          agency_reference: string | null
          anchor_address: string | null
          anchor_gps_lat: number | null
          anchor_gps_lng: number | null
          created_at: string
          device_serial: string
          fit_conditions: Json
          fitted_at: string | null
          fitted_by: string | null
          id: string
          organization_id: string
          person_id: string | null
          removal_reason: string | null
          removed_at: string | null
          status: string
        }
        Insert: {
          agency_reference?: string | null
          anchor_address?: string | null
          anchor_gps_lat?: number | null
          anchor_gps_lng?: number | null
          created_at?: string
          device_serial: string
          fit_conditions?: Json
          fitted_at?: string | null
          fitted_by?: string | null
          id?: string
          organization_id: string
          person_id?: string | null
          removal_reason?: string | null
          removed_at?: string | null
          status?: string
        }
        Update: {
          agency_reference?: string | null
          anchor_address?: string | null
          anchor_gps_lat?: number | null
          anchor_gps_lng?: number | null
          created_at?: string
          device_serial?: string
          fit_conditions?: Json
          fitted_at?: string | null
          fitted_by?: string | null
          id?: string
          organization_id?: string
          person_id?: string | null
          removal_reason?: string | null
          removed_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "ems_devices_fitted_by_fkey"
            columns: ["fitted_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ems_devices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "ems_devices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ems_devices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ems_devices_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "persons"
            referencedColumns: ["id"]
          },
        ]
      }
      enforcement_case_events: {
        Row: {
          case_id: string
          created_at: string
          created_by: string
          description: string | null
          event_type: string
          id: string
          infringement_id: string | null
          notice_id: string | null
          observation_id: string | null
          organization_id: string
        }
        Insert: {
          case_id: string
          created_at?: string
          created_by: string
          description?: string | null
          event_type: string
          id?: string
          infringement_id?: string | null
          notice_id?: string | null
          observation_id?: string | null
          organization_id: string
        }
        Update: {
          case_id?: string
          created_at?: string
          created_by?: string
          description?: string | null
          event_type?: string
          id?: string
          infringement_id?: string | null
          notice_id?: string | null
          observation_id?: string | null
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "enforcement_case_events_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "enforcement_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enforcement_case_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enforcement_case_events_infringement_id_fkey"
            columns: ["infringement_id"]
            isOneToOne: false
            referencedRelation: "infringement_notices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enforcement_case_events_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "notices_to_vacate"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enforcement_case_events_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enforcement_case_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "enforcement_case_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enforcement_case_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      enforcement_cases: {
        Row: {
          assigned_to: string | null
          case_reference: string | null
          case_type: string
          created_at: string
          id: string
          organization_id: string
          plate_number: string
          priority: string
          resolution_notes: string | null
          resolved_at: string | null
          status: string
          summary: string | null
          updated_at: string
          zone_id: string | null
        }
        Insert: {
          assigned_to?: string | null
          case_reference?: string | null
          case_type?: string
          created_at?: string
          id?: string
          organization_id: string
          plate_number: string
          priority?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          status?: string
          summary?: string | null
          updated_at?: string
          zone_id?: string | null
        }
        Update: {
          assigned_to?: string | null
          case_reference?: string | null
          case_type?: string
          created_at?: string
          id?: string
          organization_id?: string
          plate_number?: string
          priority?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          status?: string
          summary?: string | null
          updated_at?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "enforcement_cases_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enforcement_cases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "enforcement_cases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enforcement_cases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "enforcement_cases_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      entity_flags: {
        Row: {
          active: boolean
          alert_level: string | null
          created_at: string
          entity_id: string
          entity_type: string
          flag_type: string
          id: string
          organization_id: string
          raised_at: string
          raised_by: string | null
          reason: string | null
          resolved_at: string | null
        }
        Insert: {
          active?: boolean
          alert_level?: string | null
          created_at?: string
          entity_id: string
          entity_type: string
          flag_type: string
          id?: string
          organization_id: string
          raised_at?: string
          raised_by?: string | null
          reason?: string | null
          resolved_at?: string | null
        }
        Update: {
          active?: boolean
          alert_level?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: string
          flag_type?: string
          id?: string
          organization_id?: string
          raised_at?: string
          raised_by?: string | null
          reason?: string | null
          resolved_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "entity_flags_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "entity_flags_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_flags_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_flags_raised_by_fkey"
            columns: ["raised_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      entity_links: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          ends_at: string | null
          evidence: Json
          from_id: string
          from_type: string
          id: string
          organization_id: string
          relationship: string
          starts_at: string | null
          to_id: string
          to_type: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          evidence?: Json
          from_id: string
          from_type: string
          id?: string
          organization_id: string
          relationship: string
          starts_at?: string | null
          to_id: string
          to_type: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          ends_at?: string | null
          evidence?: Json
          from_id?: string
          from_type?: string
          id?: string
          organization_id?: string
          relationship?: string
          starts_at?: string | null
          to_id?: string
          to_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "entity_links_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_links_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "entity_links_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "entity_links_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_items: {
        Row: {
          captured_at: string
          captured_by_user_id: string | null
          evidence_kind: string
          id: string
          metadata: Json
          module_key: string
          organization_id: string
          storage_path: string | null
        }
        Insert: {
          captured_at?: string
          captured_by_user_id?: string | null
          evidence_kind: string
          id?: string
          metadata?: Json
          module_key: string
          organization_id: string
          storage_path?: string | null
        }
        Update: {
          captured_at?: string
          captured_by_user_id?: string | null
          evidence_kind?: string
          id?: string
          metadata?: Json
          module_key?: string
          organization_id?: string
          storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "evidence_items_captured_by_user_id_fkey"
            columns: ["captured_by_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "evidence_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      evidence_summary_approvals: {
        Row: {
          approval_status: string
          approved_by: string | null
          created_at: string
          decided_at: string | null
          evidence_id: string
          generated_at: string | null
          generated_metadata: Json
          generated_mode: string | null
          generated_review_notes: string | null
          generated_review_status: string | null
          generated_reviewed_at: string | null
          generated_reviewed_by: string | null
          generated_summary: string | null
          id: string
          organization_id: string
          reason: string | null
          redacted_labels: string[]
          requested_by: string | null
          requested_mode: string | null
        }
        Insert: {
          approval_status?: string
          approved_by?: string | null
          created_at?: string
          decided_at?: string | null
          evidence_id: string
          generated_at?: string | null
          generated_metadata?: Json
          generated_mode?: string | null
          generated_review_notes?: string | null
          generated_review_status?: string | null
          generated_reviewed_at?: string | null
          generated_reviewed_by?: string | null
          generated_summary?: string | null
          id?: string
          organization_id: string
          reason?: string | null
          redacted_labels?: string[]
          requested_by?: string | null
          requested_mode?: string | null
        }
        Update: {
          approval_status?: string
          approved_by?: string | null
          created_at?: string
          decided_at?: string | null
          evidence_id?: string
          generated_at?: string | null
          generated_metadata?: Json
          generated_mode?: string | null
          generated_review_notes?: string | null
          generated_review_status?: string | null
          generated_reviewed_at?: string | null
          generated_reviewed_by?: string | null
          generated_summary?: string | null
          id?: string
          organization_id?: string
          reason?: string | null
          redacted_labels?: string[]
          requested_by?: string | null
          requested_mode?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "evidence_summary_approvals_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_summary_approvals_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_summary_approvals_generated_reviewed_by_fkey"
            columns: ["generated_reviewed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_summary_approvals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "evidence_summary_approvals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_summary_approvals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "evidence_summary_approvals_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      face_observations: {
        Row: {
          confidence: number | null
          created_at: string
          evidence_item_id: string | null
          id: string
          organization_id: string
          person_record_id: string | null
          purpose: string
          review_state: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          evidence_item_id?: string | null
          id?: string
          organization_id: string
          person_record_id?: string | null
          purpose: string
          review_state?: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          evidence_item_id?: string | null
          id?: string
          organization_id?: string
          person_record_id?: string | null
          purpose?: string
          review_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "face_observations_evidence_item_id_fkey"
            columns: ["evidence_item_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "face_observations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "face_observations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "face_observations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "face_observations_person_record_id_fkey"
            columns: ["person_record_id"]
            isOneToOne: false
            referencedRelation: "person_records"
            referencedColumns: ["id"]
          },
        ]
      }
      formal_decision_approvals: {
        Row: {
          approval_gate: Json
          approval_status: string
          created_at: string
          decided_at: string | null
          decision_type: string
          evidence_id: string
          formal_use: Json
          id: string
          legal_approved_by: string | null
          notes: string | null
          organization_id: string
          requested_by: string | null
          requires_legal_review: boolean
          requires_supervisor_approval: boolean
          summary_approval_id: string | null
          supervisor_approved_by: string | null
        }
        Insert: {
          approval_gate?: Json
          approval_status?: string
          created_at?: string
          decided_at?: string | null
          decision_type: string
          evidence_id: string
          formal_use?: Json
          id?: string
          legal_approved_by?: string | null
          notes?: string | null
          organization_id: string
          requested_by?: string | null
          requires_legal_review?: boolean
          requires_supervisor_approval?: boolean
          summary_approval_id?: string | null
          supervisor_approved_by?: string | null
        }
        Update: {
          approval_gate?: Json
          approval_status?: string
          created_at?: string
          decided_at?: string | null
          decision_type?: string
          evidence_id?: string
          formal_use?: Json
          id?: string
          legal_approved_by?: string | null
          notes?: string | null
          organization_id?: string
          requested_by?: string | null
          requires_legal_review?: boolean
          requires_supervisor_approval?: boolean
          summary_approval_id?: string | null
          supervisor_approved_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "formal_decision_approvals_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formal_decision_approvals_legal_approved_by_fkey"
            columns: ["legal_approved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formal_decision_approvals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "formal_decision_approvals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formal_decision_approvals_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formal_decision_approvals_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formal_decision_approvals_summary_approval_id_fkey"
            columns: ["summary_approval_id"]
            isOneToOne: false
            referencedRelation: "evidence_summary_approvals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formal_decision_approvals_supervisor_approved_by_fkey"
            columns: ["supervisor_approved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      formal_decision_records: {
        Row: {
          approval_id: string | null
          created_at: string
          created_by: string | null
          decision_type: string
          evidence_id: string
          id: string
          issued_at: string | null
          metadata: Json
          organization_id: string
          record_status: string
          rendered_template: string | null
        }
        Insert: {
          approval_id?: string | null
          created_at?: string
          created_by?: string | null
          decision_type: string
          evidence_id: string
          id?: string
          issued_at?: string | null
          metadata?: Json
          organization_id: string
          record_status?: string
          rendered_template?: string | null
        }
        Update: {
          approval_id?: string | null
          created_at?: string
          created_by?: string | null
          decision_type?: string
          evidence_id?: string
          id?: string
          issued_at?: string | null
          metadata?: Json
          organization_id?: string
          record_status?: string
          rendered_template?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "formal_decision_records_approval_id_fkey"
            columns: ["approval_id"]
            isOneToOne: false
            referencedRelation: "formal_decision_approvals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formal_decision_records_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formal_decision_records_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formal_decision_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "formal_decision_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "formal_decision_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      freedom_camping_org_settings: {
        Row: {
          created_at: string
          created_by: string | null
          default_authorising_act: string | null
          default_issuing_authority: string | null
          effective_from: string
          enforcement_ladder_mode: string
          id: string
          is_current: boolean
          movement_similarity_threshold: number | null
          notes: string | null
          organization_id: string
          show_homeless_exempt_kpi: boolean
          verification_mode: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          default_authorising_act?: string | null
          default_issuing_authority?: string | null
          effective_from?: string
          enforcement_ladder_mode?: string
          id?: string
          is_current?: boolean
          movement_similarity_threshold?: number | null
          notes?: string | null
          organization_id: string
          show_homeless_exempt_kpi?: boolean
          verification_mode?: string
          version?: number
        }
        Update: {
          created_at?: string
          created_by?: string | null
          default_authorising_act?: string | null
          default_issuing_authority?: string | null
          effective_from?: string
          enforcement_ladder_mode?: string
          id?: string
          is_current?: boolean
          movement_similarity_threshold?: number | null
          notes?: string | null
          organization_id?: string
          show_homeless_exempt_kpi?: boolean
          verification_mode?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "freedom_camping_org_settings_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freedom_camping_org_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "freedom_camping_org_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "freedom_camping_org_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      fs_nelson_clients_clean: {
        Row: {
          bureau_id: string | null
          bureau_name: string | null
          client_address: string | null
          client_id: string | null
          client_name: string | null
          client_postcode: string | null
          client_state: string | null
          client_suburb: string | null
          comments: string | null
          despatch_datetime: string | null
          despatch_zone: string | null
          internal_clientid: string | null
          internal_despatchid: string | null
          is_incident_report: string | null
          offsite_datetime: string | null
          onsite_datetime: string | null
          onsite_distance_from_site: string | null
          patrol_complete_status: string | null
          patrol_type: string | null
          subcontractor: string | null
          time_onsite_variation_mins: string | null
          visit_charge_ex_gst: string | null
        }
        Insert: {
          bureau_id?: string | null
          bureau_name?: string | null
          client_address?: string | null
          client_id?: string | null
          client_name?: string | null
          client_postcode?: string | null
          client_state?: string | null
          client_suburb?: string | null
          comments?: string | null
          despatch_datetime?: string | null
          despatch_zone?: string | null
          internal_clientid?: string | null
          internal_despatchid?: string | null
          is_incident_report?: string | null
          offsite_datetime?: string | null
          onsite_datetime?: string | null
          onsite_distance_from_site?: string | null
          patrol_complete_status?: string | null
          patrol_type?: string | null
          subcontractor?: string | null
          time_onsite_variation_mins?: string | null
          visit_charge_ex_gst?: string | null
        }
        Update: {
          bureau_id?: string | null
          bureau_name?: string | null
          client_address?: string | null
          client_id?: string | null
          client_name?: string | null
          client_postcode?: string | null
          client_state?: string | null
          client_suburb?: string | null
          comments?: string | null
          despatch_datetime?: string | null
          despatch_zone?: string | null
          internal_clientid?: string | null
          internal_despatchid?: string | null
          is_incident_report?: string | null
          offsite_datetime?: string | null
          onsite_datetime?: string | null
          onsite_distance_from_site?: string | null
          patrol_complete_status?: string | null
          patrol_type?: string | null
          subcontractor?: string | null
          time_onsite_variation_mins?: string | null
          visit_charge_ex_gst?: string | null
        }
        Relationships: []
      }
      geo_source_registry: {
        Row: {
          agency_id: string
          authority_class: string
          base_url: string
          created_at: string
          id: string
          last_tested_at: string | null
          layer_id: number
          notes: string | null
          place_kind: string | null
          search_field: string
          source_class: string
          status: string
          updated_at: string
          verified_by: string | null
        }
        Insert: {
          agency_id: string
          authority_class?: string
          base_url: string
          created_at?: string
          id?: string
          last_tested_at?: string | null
          layer_id?: number
          notes?: string | null
          place_kind?: string | null
          search_field: string
          source_class?: string
          status?: string
          updated_at?: string
          verified_by?: string | null
        }
        Update: {
          agency_id?: string
          authority_class?: string
          base_url?: string
          created_at?: string
          id?: string
          last_tested_at?: string | null
          layer_id?: number
          notes?: string | null
          place_kind?: string | null
          search_field?: string
          source_class?: string
          status?: string
          updated_at?: string
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "geo_source_registry_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      geofence_boundary_history: {
        Row: {
          boundary: unknown
          boundary_source: string | null
          change_reason: string | null
          changed_by: string | null
          changed_via: string
          created_at: string
          entity_id: string
          entity_type: string
          id: string
          verification_state: string | null
          verified_at: string | null
          verified_by: string | null
          version: number
        }
        Insert: {
          boundary?: unknown
          boundary_source?: string | null
          change_reason?: string | null
          changed_by?: string | null
          changed_via: string
          created_at?: string
          entity_id: string
          entity_type: string
          id?: string
          verification_state?: string | null
          verified_at?: string | null
          verified_by?: string | null
          version?: number
        }
        Update: {
          boundary?: unknown
          boundary_source?: string | null
          change_reason?: string | null
          changed_by?: string | null
          changed_via?: string
          created_at?: string
          entity_id?: string
          entity_type?: string
          id?: string
          verification_state?: string | null
          verified_at?: string | null
          verified_by?: string | null
          version?: number
        }
        Relationships: []
      }
      homeless_claims: {
        Row: {
          claim_basis: string | null
          claimed_at: string
          claimed_by_officer_id: string
          created_at: string
          evidence_refs: Json | null
          id: string
          observation_id: string | null
          organization_id: string
          plate_number: string
          referral_notes: string | null
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          support_agency: string | null
          support_contact: string | null
          updated_at: string
        }
        Insert: {
          claim_basis?: string | null
          claimed_at?: string
          claimed_by_officer_id: string
          created_at?: string
          evidence_refs?: Json | null
          id?: string
          observation_id?: string | null
          organization_id: string
          plate_number: string
          referral_notes?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          support_agency?: string | null
          support_contact?: string | null
          updated_at?: string
        }
        Update: {
          claim_basis?: string | null
          claimed_at?: string
          claimed_by_officer_id?: string
          created_at?: string
          evidence_refs?: Json | null
          id?: string
          observation_id?: string | null
          organization_id?: string
          plate_number?: string
          referral_notes?: string | null
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          support_agency?: string | null
          support_contact?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "homeless_claims_claimed_by_officer_id_fkey"
            columns: ["claimed_by_officer_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeless_claims_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeless_claims_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "homeless_claims_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeless_claims_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homeless_claims_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      import_code_reference: {
        Row: {
          code_norm: string
          code_system: string
          code_value: string
          confidence: number | null
          created_at: string
          created_by: string | null
          id: string
          maps_to_domain: string | null
          maps_to_value: string | null
          meaning: string
          notes: string | null
          organization_id: string | null
          source: string | null
          updated_at: string
        }
        Insert: {
          code_norm: string
          code_system: string
          code_value: string
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          id?: string
          maps_to_domain?: string | null
          maps_to_value?: string | null
          meaning: string
          notes?: string | null
          organization_id?: string | null
          source?: string | null
          updated_at?: string
        }
        Update: {
          code_norm?: string
          code_system?: string
          code_value?: string
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          id?: string
          maps_to_domain?: string | null
          maps_to_value?: string | null
          meaning?: string
          notes?: string | null
          organization_id?: string | null
          source?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_code_reference_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_code_reference_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "import_code_reference_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_code_reference_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      import_org_aliases: {
        Row: {
          alias_kind: string
          alias_norm: string
          alias_value: string
          confidence: number | null
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          organization_id: string
          resolution: string
          source: string | null
          updated_at: string
        }
        Insert: {
          alias_kind: string
          alias_norm: string
          alias_value: string
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          organization_id: string
          resolution?: string
          source?: string | null
          updated_at?: string
        }
        Update: {
          alias_kind?: string
          alias_norm?: string
          alias_value?: string
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          organization_id?: string
          resolution?: string
          source?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "import_org_aliases_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_org_aliases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "import_org_aliases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_org_aliases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      import_place_aliases: {
        Row: {
          alias_kind: string
          alias_norm: string
          alias_value: string
          client_site_id: string | null
          confidence: number | null
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          organization_id: string
          place_type: string
          source: string | null
          updated_at: string
          zone_id: string | null
        }
        Insert: {
          alias_kind: string
          alias_norm: string
          alias_value: string
          client_site_id?: string | null
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          organization_id: string
          place_type: string
          source?: string | null
          updated_at?: string
          zone_id?: string | null
        }
        Update: {
          alias_kind?: string
          alias_norm?: string
          alias_value?: string
          client_site_id?: string | null
          confidence?: number | null
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          organization_id?: string
          place_type?: string
          source?: string | null
          updated_at?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "import_place_aliases_client_site_id_fkey"
            columns: ["client_site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_place_aliases_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_place_aliases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "import_place_aliases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_place_aliases_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_place_aliases_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      incident_attachments: {
        Row: {
          attachment_kind: string
          created_at: string
          evidence_item_id: string | null
          id: string
          incident_id: string
          organization_id: string
        }
        Insert: {
          attachment_kind: string
          created_at?: string
          evidence_item_id?: string | null
          id?: string
          incident_id: string
          organization_id: string
        }
        Update: {
          attachment_kind?: string
          created_at?: string
          evidence_item_id?: string | null
          id?: string
          incident_id?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "incident_attachments_evidence_item_id_fkey"
            columns: ["evidence_item_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incident_attachments_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incident_attachments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "incident_attachments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incident_attachments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      incidents: {
        Row: {
          client_site_id: string | null
          created_at: string
          description: string | null
          dispatch_job_id: string | null
          id: string
          incident_type: string
          is_staff_sensitive: boolean
          location_event_id: string | null
          location_id: string | null
          occurred_at: string
          officer_user_id: string | null
          organization_id: string
          patrol_id: string | null
          resolved_at: string | null
          severity: string
          status: string
          zone_id: string | null
        }
        Insert: {
          client_site_id?: string | null
          created_at?: string
          description?: string | null
          dispatch_job_id?: string | null
          id?: string
          incident_type: string
          is_staff_sensitive?: boolean
          location_event_id?: string | null
          location_id?: string | null
          occurred_at?: string
          officer_user_id?: string | null
          organization_id: string
          patrol_id?: string | null
          resolved_at?: string | null
          severity?: string
          status?: string
          zone_id?: string | null
        }
        Update: {
          client_site_id?: string | null
          created_at?: string
          description?: string | null
          dispatch_job_id?: string | null
          id?: string
          incident_type?: string
          is_staff_sensitive?: boolean
          location_event_id?: string | null
          location_id?: string | null
          occurred_at?: string
          officer_user_id?: string | null
          organization_id?: string
          patrol_id?: string | null
          resolved_at?: string | null
          severity?: string
          status?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "incidents_client_site_id_fkey"
            columns: ["client_site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_dispatch_job_id_fkey"
            columns: ["dispatch_job_id"]
            isOneToOne: false
            referencedRelation: "dispatch_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_location_event_id_fkey"
            columns: ["location_event_id"]
            isOneToOne: false
            referencedRelation: "location_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "incidents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_patrol_id_fkey"
            columns: ["patrol_id"]
            isOneToOne: false
            referencedRelation: "patrols"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      inference_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          domain: string
          evidence_item_id: string | null
          id: string
          organization_id: string
          requested_by_user_id: string | null
          status: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          domain: string
          evidence_item_id?: string | null
          id?: string
          organization_id: string
          requested_by_user_id?: string | null
          status?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          domain?: string
          evidence_item_id?: string | null
          id?: string
          organization_id?: string
          requested_by_user_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "inference_jobs_evidence_item_id_fkey"
            columns: ["evidence_item_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inference_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "inference_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inference_jobs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inference_jobs_requested_by_user_id_fkey"
            columns: ["requested_by_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      inference_results: {
        Row: {
          confidence: number | null
          created_at: string
          domain: string
          evidence_item_id: string | null
          id: string
          inference_job_id: string | null
          result: Json
          status: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          domain: string
          evidence_item_id?: string | null
          id?: string
          inference_job_id?: string | null
          result?: Json
          status: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          domain?: string
          evidence_item_id?: string | null
          id?: string
          inference_job_id?: string | null
          result?: Json
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "inference_results_evidence_item_id_fkey"
            columns: ["evidence_item_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inference_results_inference_job_id_fkey"
            columns: ["inference_job_id"]
            isOneToOne: false
            referencedRelation: "inference_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      infringement_notice_counters: {
        Row: {
          id: string
          last_number: number
          organization_id: string
          prefix: string
          updated_at: string
        }
        Insert: {
          id?: string
          last_number?: number
          organization_id: string
          prefix?: string
          updated_at?: string
        }
        Update: {
          id?: string
          last_number?: number
          organization_id?: string
          prefix?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "infringement_notice_counters_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "infringement_notice_counters_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "infringement_notice_counters_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      infringement_notices: {
        Row: {
          amount: number
          authorising_act: string
          authorising_section: string
          breach_alert_id: string | null
          created_at: string
          due_date: string
          id: string
          issued_at: string
          issued_by: string
          notice_number: string
          objections_address: string | null
          objections_deadline: string | null
          objections_email: string | null
          observation_id: string | null
          offence_date: string
          offence_description: string | null
          organization_id: string
          payment_url: string | null
          pdf_generated_at: string | null
          pdf_url: string | null
          plate_number: string
          status: string
          zone_id: string | null
        }
        Insert: {
          amount: number
          authorising_act?: string
          authorising_section?: string
          breach_alert_id?: string | null
          created_at?: string
          due_date: string
          id?: string
          issued_at?: string
          issued_by: string
          notice_number: string
          objections_address?: string | null
          objections_deadline?: string | null
          objections_email?: string | null
          observation_id?: string | null
          offence_date: string
          offence_description?: string | null
          organization_id: string
          payment_url?: string | null
          pdf_generated_at?: string | null
          pdf_url?: string | null
          plate_number: string
          status?: string
          zone_id?: string | null
        }
        Update: {
          amount?: number
          authorising_act?: string
          authorising_section?: string
          breach_alert_id?: string | null
          created_at?: string
          due_date?: string
          id?: string
          issued_at?: string
          issued_by?: string
          notice_number?: string
          objections_address?: string | null
          objections_deadline?: string | null
          objections_email?: string | null
          observation_id?: string | null
          offence_date?: string
          offence_description?: string | null
          organization_id?: string
          payment_url?: string | null
          pdf_generated_at?: string | null
          pdf_url?: string | null
          plate_number?: string
          status?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "infringement_notices_breach_alert_id_fkey"
            columns: ["breach_alert_id"]
            isOneToOne: false
            referencedRelation: "breach_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "infringement_notices_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "infringement_notices_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "infringement_notices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "infringement_notices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "infringement_notices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "infringement_notices_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      invite_rate_log: {
        Row: {
          attempted_at: string
          caller_id: string
          id: string
          target_org_id: string
        }
        Insert: {
          attempted_at?: string
          caller_id: string
          id?: string
          target_org_id: string
        }
        Update: {
          attempted_at?: string
          caller_id?: string
          id?: string
          target_org_id?: string
        }
        Relationships: []
      }
      invoice_line_items: {
        Row: {
          created_at: string
          description: string
          id: string
          invoice_id: string
          line_number: number
          line_total: number
          organization_id: string | null
          quantity: number
          source_dispatch_id: string | null
          unit_price: number
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          invoice_id: string
          line_number: number
          line_total: number
          organization_id?: string | null
          quantity?: number
          source_dispatch_id?: string | null
          unit_price: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          invoice_id?: string
          line_number?: number
          line_total?: number
          organization_id?: string | null
          quantity?: number
          source_dispatch_id?: string | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "invoice_line_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_items_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_line_templates: {
        Row: {
          active: boolean
          created_at: string
          default_quantity: number
          description: string
          id: string
          organization_id: string
          site_id: string | null
          sort_order: number
          unit_label: string
          unit_price: number
        }
        Insert: {
          active?: boolean
          created_at?: string
          default_quantity?: number
          description: string
          id?: string
          organization_id: string
          site_id?: string | null
          sort_order?: number
          unit_label?: string
          unit_price: number
        }
        Update: {
          active?: boolean
          created_at?: string
          default_quantity?: number
          description?: string
          id?: string
          organization_id?: string
          site_id?: string | null
          sort_order?: number
          unit_label?: string
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "invoice_line_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_templates_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          client_organization_id: string
          created_at: string
          created_by: string | null
          currency: string
          due_date: string
          gst_amount: number
          id: string
          invoice_date: string
          invoice_number: string
          notes: string | null
          organization_id: string
          paid_at: string | null
          sent_at: string | null
          service_agreement_id: string | null
          service_period_end: string | null
          service_period_start: string | null
          site_id: string | null
          status: string
          subtotal: number
          total_amount: number
          updated_at: string
        }
        Insert: {
          client_organization_id: string
          created_at?: string
          created_by?: string | null
          currency?: string
          due_date: string
          gst_amount?: number
          id?: string
          invoice_date?: string
          invoice_number: string
          notes?: string | null
          organization_id: string
          paid_at?: string | null
          sent_at?: string | null
          service_agreement_id?: string | null
          service_period_end?: string | null
          service_period_start?: string | null
          site_id?: string | null
          status?: string
          subtotal?: number
          total_amount?: number
          updated_at?: string
        }
        Update: {
          client_organization_id?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          due_date?: string
          gst_amount?: number
          id?: string
          invoice_date?: string
          invoice_number?: string
          notes?: string | null
          organization_id?: string
          paid_at?: string | null
          sent_at?: string | null
          service_agreement_id?: string | null
          service_period_end?: string | null
          service_period_start?: string | null
          site_id?: string | null
          status?: string
          subtotal?: number
          total_amount?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoices_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "invoices_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "invoices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      jurisdiction_rule_sets: {
        Row: {
          created_at: string
          id: string
          jurisdiction_name: string
          module_key: string
          name: string
          organization_id: string
          rules: Json
        }
        Insert: {
          created_at?: string
          id?: string
          jurisdiction_name: string
          module_key: string
          name: string
          organization_id: string
          rules?: Json
        }
        Update: {
          created_at?: string
          id?: string
          jurisdiction_name?: string
          module_key?: string
          name?: string
          organization_id?: string
          rules?: Json
        }
        Relationships: [
          {
            foreignKeyName: "jurisdiction_rule_sets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "jurisdiction_rule_sets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jurisdiction_rule_sets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      jurisdiction_template_overrides: {
        Row: {
          created_at: string
          decision_type: string
          id: string
          is_active: boolean
          jurisdiction_key: string
          organization_id: string
          required_fields: string[] | null
          template_body: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          decision_type: string
          id?: string
          is_active?: boolean
          jurisdiction_key: string
          organization_id: string
          required_fields?: string[] | null
          template_body?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          decision_type?: string
          id?: string
          is_active?: boolean
          jurisdiction_key?: string
          organization_id?: string
          required_fields?: string[] | null
          template_body?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "jurisdiction_template_overrides_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "jurisdiction_template_overrides_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jurisdiction_template_overrides_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      key_audit_settings: {
        Row: {
          audit_frequency_days: number
          created_at: string
          id: string
          is_enabled: boolean
          organization_id: string
          require_shift_handover: boolean
        }
        Insert: {
          audit_frequency_days?: number
          created_at?: string
          id?: string
          is_enabled?: boolean
          organization_id: string
          require_shift_handover?: boolean
        }
        Update: {
          audit_frequency_days?: number
          created_at?: string
          id?: string
          is_enabled?: boolean
          organization_id?: string
          require_shift_handover?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "key_audit_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "key_audit_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "key_audit_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      key_sets: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_active: boolean
          key_count: number
          name: string
          organization_id: string
          patrol_route_id: string | null
          site_id: string | null
          storage_location: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          key_count?: number
          name: string
          organization_id: string
          patrol_route_id?: string | null
          site_id?: string | null
          storage_location?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_active?: boolean
          key_count?: number
          name?: string
          organization_id?: string
          patrol_route_id?: string | null
          site_id?: string | null
          storage_location?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "key_sets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "key_sets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "key_sets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "key_sets_patrol_route_id_fkey"
            columns: ["patrol_route_id"]
            isOneToOne: false
            referencedRelation: "patrol_routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "key_sets_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      leave_requests: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          ends_on: string
          id: string
          leave_type: string
          notes: string | null
          organization_id: string
          reason: string | null
          staff_id: string
          starts_on: string
          status: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          ends_on: string
          id?: string
          leave_type: string
          notes?: string | null
          organization_id: string
          reason?: string | null
          staff_id: string
          starts_on: string
          status?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          ends_on?: string
          id?: string
          leave_type?: string
          notes?: string | null
          organization_id?: string
          reason?: string | null
          staff_id?: string
          starts_on?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "leave_requests_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "leave_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "leave_requests_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      location_events: {
        Row: {
          checkpoint_id: string | null
          client_site_id: string | null
          created_at: string
          created_by: string | null
          event_type: string
          external_ref: string | null
          id: string
          module_key: string | null
          observed_entity_id: string | null
          observed_entity_type: string | null
          occurred_at: string
          organization_id: string
          payload: Json
          source: string | null
          status: string | null
          zone_id: string | null
        }
        Insert: {
          checkpoint_id?: string | null
          client_site_id?: string | null
          created_at?: string
          created_by?: string | null
          event_type: string
          external_ref?: string | null
          id?: string
          module_key?: string | null
          observed_entity_id?: string | null
          observed_entity_type?: string | null
          occurred_at?: string
          organization_id: string
          payload?: Json
          source?: string | null
          status?: string | null
          zone_id?: string | null
        }
        Update: {
          checkpoint_id?: string | null
          client_site_id?: string | null
          created_at?: string
          created_by?: string | null
          event_type?: string
          external_ref?: string | null
          id?: string
          module_key?: string | null
          observed_entity_id?: string | null
          observed_entity_type?: string | null
          occurred_at?: string
          organization_id?: string
          payload?: Json
          source?: string | null
          status?: string | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "location_events_checkpoint_id_fkey"
            columns: ["checkpoint_id"]
            isOneToOne: false
            referencedRelation: "patrol_checkpoints"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_events_client_site_id_fkey"
            columns: ["client_site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_events_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "location_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_events_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_events_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      location_notes: {
        Row: {
          body: string
          created_at: string
          created_by: string | null
          id: string
          organization_id: string
          site_id: string | null
          updated_at: string
          zone_id: string | null
        }
        Insert: {
          body: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id: string
          site_id?: string | null
          updated_at?: string
          zone_id?: string | null
        }
        Update: {
          body?: string
          created_at?: string
          created_by?: string | null
          id?: string
          organization_id?: string
          site_id?: string | null
          updated_at?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "location_notes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_notes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "location_notes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_notes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_notes_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_notes_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      location_zones: {
        Row: {
          active_schedule: Json | null
          address: string | null
          address_match_key: string | null
          boundary: unknown
          boundary_legacy: Json | null
          boundary_status: string
          boundary_verification: string
          boundary_verified_at: string | null
          boundary_verified_by: string | null
          bylaw_clause: string | null
          bylaw_source_url: string | null
          center_point: unknown
          created_at: string
          despatch_zone_code: string | null
          enforcement_workflow_override: string | null
          external_ref: string | null
          id: string
          internal_client_ref: string | null
          is_active: boolean
          is_adhoc: boolean
          jurisdiction_rule_set_id: string | null
          location_id: string | null
          metadata: Json
          module_key: string
          name: string
          nightly_limit_consecutive: number | null
          nightly_limit_monthly: number | null
          onsite_profile: string
          organization_id: string
          parent_zone_id: string | null
          parking_disabled_multiplier: number
          parking_limit_set_at: string | null
          parking_limit_set_by: string | null
          parking_limit_source: string | null
          parking_signage_photo_url: string | null
          parking_time_limit_minutes: number | null
          postcode: string | null
          radius_meters: number | null
          repeat_stay_radius_m: number | null
          repeat_stay_radius_meters: number | null
          repeat_stay_window_nights: number | null
          rule_overrides: Json | null
          rule_type: string
          scv_exempts_restriction: boolean
          scv_required: boolean
          site_id: string | null
          suburb: string | null
          zone_type: string
        }
        Insert: {
          active_schedule?: Json | null
          address?: string | null
          address_match_key?: string | null
          boundary?: unknown
          boundary_legacy?: Json | null
          boundary_status?: string
          boundary_verification?: string
          boundary_verified_at?: string | null
          boundary_verified_by?: string | null
          bylaw_clause?: string | null
          bylaw_source_url?: string | null
          center_point?: unknown
          created_at?: string
          despatch_zone_code?: string | null
          enforcement_workflow_override?: string | null
          external_ref?: string | null
          id?: string
          internal_client_ref?: string | null
          is_active?: boolean
          is_adhoc?: boolean
          jurisdiction_rule_set_id?: string | null
          location_id?: string | null
          metadata?: Json
          module_key?: string
          name: string
          nightly_limit_consecutive?: number | null
          nightly_limit_monthly?: number | null
          onsite_profile?: string
          organization_id: string
          parent_zone_id?: string | null
          parking_disabled_multiplier?: number
          parking_limit_set_at?: string | null
          parking_limit_set_by?: string | null
          parking_limit_source?: string | null
          parking_signage_photo_url?: string | null
          parking_time_limit_minutes?: number | null
          postcode?: string | null
          radius_meters?: number | null
          repeat_stay_radius_m?: number | null
          repeat_stay_radius_meters?: number | null
          repeat_stay_window_nights?: number | null
          rule_overrides?: Json | null
          rule_type?: string
          scv_exempts_restriction?: boolean
          scv_required?: boolean
          site_id?: string | null
          suburb?: string | null
          zone_type?: string
        }
        Update: {
          active_schedule?: Json | null
          address?: string | null
          address_match_key?: string | null
          boundary?: unknown
          boundary_legacy?: Json | null
          boundary_status?: string
          boundary_verification?: string
          boundary_verified_at?: string | null
          boundary_verified_by?: string | null
          bylaw_clause?: string | null
          bylaw_source_url?: string | null
          center_point?: unknown
          created_at?: string
          despatch_zone_code?: string | null
          enforcement_workflow_override?: string | null
          external_ref?: string | null
          id?: string
          internal_client_ref?: string | null
          is_active?: boolean
          is_adhoc?: boolean
          jurisdiction_rule_set_id?: string | null
          location_id?: string | null
          metadata?: Json
          module_key?: string
          name?: string
          nightly_limit_consecutive?: number | null
          nightly_limit_monthly?: number | null
          onsite_profile?: string
          organization_id?: string
          parent_zone_id?: string | null
          parking_disabled_multiplier?: number
          parking_limit_set_at?: string | null
          parking_limit_set_by?: string | null
          parking_limit_source?: string | null
          parking_signage_photo_url?: string | null
          parking_time_limit_minutes?: number | null
          postcode?: string | null
          radius_meters?: number | null
          repeat_stay_radius_m?: number | null
          repeat_stay_radius_meters?: number | null
          repeat_stay_window_nights?: number | null
          rule_overrides?: Json | null
          rule_type?: string
          scv_exempts_restriction?: boolean
          scv_required?: boolean
          site_id?: string | null
          suburb?: string | null
          zone_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "location_zones_boundary_verified_by_fkey"
            columns: ["boundary_verified_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_zones_jurisdiction_rule_set_id_fkey"
            columns: ["jurisdiction_rule_set_id"]
            isOneToOne: false
            referencedRelation: "jurisdiction_rule_sets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_zones_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_zones_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "location_zones_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_zones_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_zones_parent_zone_id_fkey"
            columns: ["parent_zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_zones_parking_limit_set_by_fkey"
            columns: ["parking_limit_set_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "location_zones_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          address: string | null
          address_match_key: string | null
          created_at: string
          created_by: string | null
          id: string
          name: string
          notes: string | null
          organization_id: string
          postcode: string | null
          suburb: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          address_match_key?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name: string
          notes?: string | null
          organization_id: string
          postcode?: string | null
          suburb?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          address_match_key?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          name?: string
          notes?: string | null
          organization_id?: string
          postcode?: string | null
          suburb?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "locations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "locations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "locations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "locations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      module_catalog: {
        Row: {
          active: boolean
          base_price: number
          billing_period: string
          created_at: string
          currency: string
          module_key: string
          per_seat_price: number
          per_site_price: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          base_price?: number
          billing_period?: string
          created_at?: string
          currency?: string
          module_key: string
          per_seat_price?: number
          per_site_price?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          base_price?: number
          billing_period?: string
          created_at?: string
          currency?: string
          module_key?: string
          per_seat_price?: number
          per_site_price?: number
          updated_at?: string
        }
        Relationships: []
      }
      module_rule_sets: {
        Row: {
          approval_policy: Json
          created_at: string
          evidence_requirements: Json
          id: string
          module_key: string
          name: string
          organization_id: string
          report_template_code: string | null
        }
        Insert: {
          approval_policy?: Json
          created_at?: string
          evidence_requirements?: Json
          id?: string
          module_key: string
          name: string
          organization_id: string
          report_template_code?: string | null
        }
        Update: {
          approval_policy?: Json
          created_at?: string
          evidence_requirements?: Json
          id?: string
          module_key?: string
          name?: string
          organization_id?: string
          report_template_code?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "module_rule_sets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "module_rule_sets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "module_rule_sets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      monthly_report_packs: {
        Row: {
          created_at: string
          data: Json | null
          delivery_error: string | null
          generated_at: string | null
          generated_by: string | null
          id: string
          organization_id: string
          pdf_path: string | null
          period_end: string
          period_start: string
          sent_at: string | null
          sent_to: string | null
          service_agreement_id: string
          status: string
          template_code: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          data?: Json | null
          delivery_error?: string | null
          generated_at?: string | null
          generated_by?: string | null
          id?: string
          organization_id: string
          pdf_path?: string | null
          period_end: string
          period_start: string
          sent_at?: string | null
          sent_to?: string | null
          service_agreement_id: string
          status?: string
          template_code: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          data?: Json | null
          delivery_error?: string | null
          generated_at?: string | null
          generated_by?: string | null
          id?: string
          organization_id?: string
          pdf_path?: string | null
          period_end?: string
          period_start?: string
          sent_at?: string | null
          sent_to?: string | null
          service_agreement_id?: string
          status?: string
          template_code?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "monthly_report_packs_generated_by_fkey"
            columns: ["generated_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_report_packs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "monthly_report_packs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_report_packs_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monthly_report_packs_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
        ]
      }
      noise_assessments: {
        Row: {
          action: string | null
          action_taken: string | null
          address_discrepancy_noted: boolean
          address_discrepancy_reason: string | null
          arrival_gps_accuracy: number | null
          arrival_gps_lat: number | null
          arrival_gps_lng: number | null
          arrived_at: string | null
          assessed_at: string
          assessment_gps_accuracy: number | null
          assessment_gps_lat: number | null
          assessment_gps_lng: number | null
          assessment_location: string | null
          bob_classification: string | null
          bob_confidence: number | null
          bob_recommendation: string | null
          complainant_protected: boolean
          complainant_site_id: string | null
          complaint_address: string | null
          created_at: string
          decibel_reading: number | null
          departed_at: string | null
          dispatch_job_id: string | null
          end_number: string | null
          evidence_package_url: string | null
          external_refs: Json
          follow_up_at: string | null
          follow_up_required: boolean
          hs_abort_reason: string | null
          hs_checklist_completed: boolean
          hs_checklist_items: Json | null
          hs_flag_active: boolean
          hs_notes: string | null
          id: string
          incident_report_text: string | null
          is_large_event_or_commercial: boolean | null
          is_problem_address: boolean
          job_number: string | null
          location_id: string | null
          matrix_total: number | null
          noise_source: string | null
          noise_source_address: string | null
          noise_source_gps_lat: number | null
          noise_source_gps_lng: number | null
          notes: string | null
          notice_number: string | null
          occupant_cooperative: boolean | null
          occupant_dob: string | null
          occupant_name: string | null
          officer_id: string | null
          officer_name: string | null
          officer_user_id: string | null
          organization_id: string
          permanent_abatement_active: boolean
          permanent_end_active: boolean
          photo_assessment_point: Json | null
          photo_service_evidence: Json | null
          photo_source_address: Json | null
          photo_urls: Json | null
          police_present: boolean
          police_requested: boolean
          prior_end_within_72hrs: boolean
          prior_notice_count: number
          prior_notice_types: string[] | null
          prior_notices: number
          received_at: string | null
          referred_animal_control: boolean
          scene_description: string | null
          site_id: string | null
          source: string | null
          status: string
          supplementary_scores: Json | null
          time_of_day: string | null
          time_score: number | null
          tone_score: number | null
          visit_number_tonight: number
          volume_score: number | null
        }
        Insert: {
          action?: string | null
          action_taken?: string | null
          address_discrepancy_noted?: boolean
          address_discrepancy_reason?: string | null
          arrival_gps_accuracy?: number | null
          arrival_gps_lat?: number | null
          arrival_gps_lng?: number | null
          arrived_at?: string | null
          assessed_at?: string
          assessment_gps_accuracy?: number | null
          assessment_gps_lat?: number | null
          assessment_gps_lng?: number | null
          assessment_location?: string | null
          bob_classification?: string | null
          bob_confidence?: number | null
          bob_recommendation?: string | null
          complainant_protected?: boolean
          complainant_site_id?: string | null
          complaint_address?: string | null
          created_at?: string
          decibel_reading?: number | null
          departed_at?: string | null
          dispatch_job_id?: string | null
          end_number?: string | null
          evidence_package_url?: string | null
          external_refs?: Json
          follow_up_at?: string | null
          follow_up_required?: boolean
          hs_abort_reason?: string | null
          hs_checklist_completed?: boolean
          hs_checklist_items?: Json | null
          hs_flag_active?: boolean
          hs_notes?: string | null
          id?: string
          incident_report_text?: string | null
          is_large_event_or_commercial?: boolean | null
          is_problem_address?: boolean
          job_number?: string | null
          location_id?: string | null
          matrix_total?: number | null
          noise_source?: string | null
          noise_source_address?: string | null
          noise_source_gps_lat?: number | null
          noise_source_gps_lng?: number | null
          notes?: string | null
          notice_number?: string | null
          occupant_cooperative?: boolean | null
          occupant_dob?: string | null
          occupant_name?: string | null
          officer_id?: string | null
          officer_name?: string | null
          officer_user_id?: string | null
          organization_id: string
          permanent_abatement_active?: boolean
          permanent_end_active?: boolean
          photo_assessment_point?: Json | null
          photo_service_evidence?: Json | null
          photo_source_address?: Json | null
          photo_urls?: Json | null
          police_present?: boolean
          police_requested?: boolean
          prior_end_within_72hrs?: boolean
          prior_notice_count?: number
          prior_notice_types?: string[] | null
          prior_notices?: number
          received_at?: string | null
          referred_animal_control?: boolean
          scene_description?: string | null
          site_id?: string | null
          source?: string | null
          status?: string
          supplementary_scores?: Json | null
          time_of_day?: string | null
          time_score?: number | null
          tone_score?: number | null
          visit_number_tonight?: number
          volume_score?: number | null
        }
        Update: {
          action?: string | null
          action_taken?: string | null
          address_discrepancy_noted?: boolean
          address_discrepancy_reason?: string | null
          arrival_gps_accuracy?: number | null
          arrival_gps_lat?: number | null
          arrival_gps_lng?: number | null
          arrived_at?: string | null
          assessed_at?: string
          assessment_gps_accuracy?: number | null
          assessment_gps_lat?: number | null
          assessment_gps_lng?: number | null
          assessment_location?: string | null
          bob_classification?: string | null
          bob_confidence?: number | null
          bob_recommendation?: string | null
          complainant_protected?: boolean
          complainant_site_id?: string | null
          complaint_address?: string | null
          created_at?: string
          decibel_reading?: number | null
          departed_at?: string | null
          dispatch_job_id?: string | null
          end_number?: string | null
          evidence_package_url?: string | null
          external_refs?: Json
          follow_up_at?: string | null
          follow_up_required?: boolean
          hs_abort_reason?: string | null
          hs_checklist_completed?: boolean
          hs_checklist_items?: Json | null
          hs_flag_active?: boolean
          hs_notes?: string | null
          id?: string
          incident_report_text?: string | null
          is_large_event_or_commercial?: boolean | null
          is_problem_address?: boolean
          job_number?: string | null
          location_id?: string | null
          matrix_total?: number | null
          noise_source?: string | null
          noise_source_address?: string | null
          noise_source_gps_lat?: number | null
          noise_source_gps_lng?: number | null
          notes?: string | null
          notice_number?: string | null
          occupant_cooperative?: boolean | null
          occupant_dob?: string | null
          occupant_name?: string | null
          officer_id?: string | null
          officer_name?: string | null
          officer_user_id?: string | null
          organization_id?: string
          permanent_abatement_active?: boolean
          permanent_end_active?: boolean
          photo_assessment_point?: Json | null
          photo_service_evidence?: Json | null
          photo_source_address?: Json | null
          photo_urls?: Json | null
          police_present?: boolean
          police_requested?: boolean
          prior_end_within_72hrs?: boolean
          prior_notice_count?: number
          prior_notice_types?: string[] | null
          prior_notices?: number
          received_at?: string | null
          referred_animal_control?: boolean
          scene_description?: string | null
          site_id?: string | null
          source?: string | null
          status?: string
          supplementary_scores?: Json | null
          time_of_day?: string | null
          time_score?: number | null
          tone_score?: number | null
          visit_number_tonight?: number
          volume_score?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "noise_assessments_complainant_site_id_fkey"
            columns: ["complainant_site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "noise_assessments_dispatch_job_id_fkey"
            columns: ["dispatch_job_id"]
            isOneToOne: false
            referencedRelation: "dispatch_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "noise_assessments_officer_id_fkey"
            columns: ["officer_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "noise_assessments_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "noise_assessments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "noise_assessments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "noise_assessments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "noise_assessments_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      noise_module_config: {
        Row: {
          created_at: string
          excessive_threshold: number
          id: string
          legislative_text: string | null
          organization_id: string
          permanent_abatement_list: Json | null
          require_large_event_flag: boolean
          require_occupant_dob: boolean
          skip_verbal_warning: boolean
          supplementary_factor_config: Json | null
          supplementary_factors: string[]
          time_bands: Json | null
          tone_bands: Json | null
          updated_at: string
          volume_bands: Json | null
        }
        Insert: {
          created_at?: string
          excessive_threshold?: number
          id?: string
          legislative_text?: string | null
          organization_id: string
          permanent_abatement_list?: Json | null
          require_large_event_flag?: boolean
          require_occupant_dob?: boolean
          skip_verbal_warning?: boolean
          supplementary_factor_config?: Json | null
          supplementary_factors?: string[]
          time_bands?: Json | null
          tone_bands?: Json | null
          updated_at?: string
          volume_bands?: Json | null
        }
        Update: {
          created_at?: string
          excessive_threshold?: number
          id?: string
          legislative_text?: string | null
          organization_id?: string
          permanent_abatement_list?: Json | null
          require_large_event_flag?: boolean
          require_occupant_dob?: boolean
          skip_verbal_warning?: boolean
          supplementary_factor_config?: Json | null
          supplementary_factors?: string[]
          time_bands?: Json | null
          tone_bands?: Json | null
          updated_at?: string
          volume_bands?: Json | null
        }
        Relationships: [
          {
            foreignKeyName: "noise_module_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "noise_module_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "noise_module_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      noise_seizures: {
        Row: {
          evidence_id: string | null
          id: string
          item_description: string
          legal_authority: string | null
          make: string | null
          model: string | null
          noise_assessment_id: string
          notice_id: string | null
          organization_id: string
          photo_urls: Json | null
          police_name: string | null
          police_present: boolean
          returned_at: string | null
          seized_at: string
          seizure_form_number: string | null
          serial_number: string | null
          storage_location: string | null
        }
        Insert: {
          evidence_id?: string | null
          id?: string
          item_description: string
          legal_authority?: string | null
          make?: string | null
          model?: string | null
          noise_assessment_id: string
          notice_id?: string | null
          organization_id: string
          photo_urls?: Json | null
          police_name?: string | null
          police_present?: boolean
          returned_at?: string | null
          seized_at?: string
          seizure_form_number?: string | null
          serial_number?: string | null
          storage_location?: string | null
        }
        Update: {
          evidence_id?: string | null
          id?: string
          item_description?: string
          legal_authority?: string | null
          make?: string | null
          model?: string | null
          noise_assessment_id?: string
          notice_id?: string | null
          organization_id?: string
          photo_urls?: Json | null
          police_name?: string | null
          police_present?: boolean
          returned_at?: string | null
          seized_at?: string
          seizure_form_number?: string | null
          serial_number?: string | null
          storage_location?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "noise_seizures_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "noise_seizures_noise_assessment_id_fkey"
            columns: ["noise_assessment_id"]
            isOneToOne: false
            referencedRelation: "noise_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "noise_seizures_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "notices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "noise_seizures_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "noise_seizures_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "noise_seizures_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notice_counters: {
        Row: {
          id: string
          last_number: number
          notice_type: string
          organization_id: string
          prefix: string
        }
        Insert: {
          id?: string
          last_number?: number
          notice_type: string
          organization_id: string
          prefix: string
        }
        Update: {
          id?: string
          last_number?: number
          notice_type?: string
          organization_id?: string
          prefix?: string
        }
        Relationships: [
          {
            foreignKeyName: "notice_counters_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "notice_counters_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notice_counters_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notice_templates: {
        Row: {
          authorising_act: string
          authorising_section: string | null
          bob_extracted: boolean
          body_html: string
          bylaw_reference: string | null
          created_at: string
          created_by: string | null
          fine_amount: number | null
          footer_text: string | null
          id: string
          is_active: boolean
          issuing_authority: string | null
          logo_url: string | null
          notice_type: string
          objections_address: string | null
          objections_deadline_days: number
          objections_email: string | null
          organization_id: string
          payment_deadline_days: number
          payment_url: string | null
          source_document_url: string | null
          updated_at: string
          vacate_by_hour: number
          vacate_by_minute: number
          version: number
        }
        Insert: {
          authorising_act?: string
          authorising_section?: string | null
          bob_extracted?: boolean
          body_html?: string
          bylaw_reference?: string | null
          created_at?: string
          created_by?: string | null
          fine_amount?: number | null
          footer_text?: string | null
          id?: string
          is_active?: boolean
          issuing_authority?: string | null
          logo_url?: string | null
          notice_type: string
          objections_address?: string | null
          objections_deadline_days?: number
          objections_email?: string | null
          organization_id: string
          payment_deadline_days?: number
          payment_url?: string | null
          source_document_url?: string | null
          updated_at?: string
          vacate_by_hour?: number
          vacate_by_minute?: number
          version?: number
        }
        Update: {
          authorising_act?: string
          authorising_section?: string | null
          bob_extracted?: boolean
          body_html?: string
          bylaw_reference?: string | null
          created_at?: string
          created_by?: string | null
          fine_amount?: number | null
          footer_text?: string | null
          id?: string
          is_active?: boolean
          issuing_authority?: string | null
          logo_url?: string | null
          notice_type?: string
          objections_address?: string | null
          objections_deadline_days?: number
          objections_email?: string | null
          organization_id?: string
          payment_deadline_days?: number
          payment_url?: string | null
          source_document_url?: string | null
          updated_at?: string
          vacate_by_hour?: number
          vacate_by_minute?: number
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "notice_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notice_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "notice_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notice_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      notices: {
        Row: {
          authorized_at: string | null
          authorized_by: string | null
          breach_id: string | null
          comply_by: string | null
          created_at: string
          fine_amount: number | null
          id: string
          issued_at: string | null
          legal_basis: string | null
          location_id: string | null
          notice_number: string | null
          notice_type: string
          officer_user_id: string | null
          organization_id: string
          person_id: string | null
          status: string
          vehicle_id: string | null
        }
        Insert: {
          authorized_at?: string | null
          authorized_by?: string | null
          breach_id?: string | null
          comply_by?: string | null
          created_at?: string
          fine_amount?: number | null
          id?: string
          issued_at?: string | null
          legal_basis?: string | null
          location_id?: string | null
          notice_number?: string | null
          notice_type: string
          officer_user_id?: string | null
          organization_id: string
          person_id?: string | null
          status?: string
          vehicle_id?: string | null
        }
        Update: {
          authorized_at?: string | null
          authorized_by?: string | null
          breach_id?: string | null
          comply_by?: string | null
          created_at?: string
          fine_amount?: number | null
          id?: string
          issued_at?: string | null
          legal_basis?: string | null
          location_id?: string | null
          notice_number?: string | null
          notice_type?: string
          officer_user_id?: string | null
          organization_id?: string
          person_id?: string | null
          status?: string
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notices_breach_id_fkey"
            columns: ["breach_id"]
            isOneToOne: false
            referencedRelation: "breach_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notices_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "notices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notices_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "persons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notices_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      notices_to_vacate: {
        Row: {
          authorising_act: string
          authorising_section: string
          breach_alert_id: string | null
          created_at: string
          id: string
          issued_at: string
          issued_by: string
          observation_id: string | null
          organization_id: string
          pdf_generated_at: string | null
          pdf_url: string | null
          plate_number: string
          reason: string | null
          status: string
          vacate_by: string | null
          zone_id: string | null
        }
        Insert: {
          authorising_act?: string
          authorising_section?: string
          breach_alert_id?: string | null
          created_at?: string
          id?: string
          issued_at?: string
          issued_by: string
          observation_id?: string | null
          organization_id: string
          pdf_generated_at?: string | null
          pdf_url?: string | null
          plate_number: string
          reason?: string | null
          status?: string
          vacate_by?: string | null
          zone_id?: string | null
        }
        Update: {
          authorising_act?: string
          authorising_section?: string
          breach_alert_id?: string | null
          created_at?: string
          id?: string
          issued_at?: string
          issued_by?: string
          observation_id?: string | null
          organization_id?: string
          pdf_generated_at?: string | null
          pdf_url?: string | null
          plate_number?: string
          reason?: string | null
          status?: string
          vacate_by?: string | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notices_to_vacate_breach_alert_id_fkey"
            columns: ["breach_alert_id"]
            isOneToOne: false
            referencedRelation: "breach_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notices_to_vacate_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notices_to_vacate_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notices_to_vacate_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "notices_to_vacate_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notices_to_vacate_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notices_to_vacate_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          category: string
          created_at: string
          dedup_key: string | null
          id: string
          link_page: string | null
          link_payload: Json | null
          organization_id: string
          read_at: string | null
          recipient_role: string | null
          recipient_user_id: string | null
          severity: string
          title: string
        }
        Insert: {
          body?: string | null
          category: string
          created_at?: string
          dedup_key?: string | null
          id?: string
          link_page?: string | null
          link_payload?: Json | null
          organization_id: string
          read_at?: string | null
          recipient_role?: string | null
          recipient_user_id?: string | null
          severity?: string
          title: string
        }
        Update: {
          body?: string | null
          category?: string
          created_at?: string
          dedup_key?: string | null
          id?: string
          link_page?: string | null
          link_payload?: Json | null
          organization_id?: string
          read_at?: string | null
          recipient_role?: string | null
          recipient_user_id?: string | null
          severity?: string
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "notifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_recipient_user_id_fkey"
            columns: ["recipient_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      nzscv_records: {
        Row: {
          certificate_number: string | null
          checked_at: string
          created_at: string
          expiry_date: string | null
          id: string
          organization_id: string
          plate: string
          raw_response: Json
          status: string
          vehicle_class: string | null
          vehicle_id: string | null
        }
        Insert: {
          certificate_number?: string | null
          checked_at?: string
          created_at?: string
          expiry_date?: string | null
          id?: string
          organization_id: string
          plate: string
          raw_response?: Json
          status: string
          vehicle_class?: string | null
          vehicle_id?: string | null
        }
        Update: {
          certificate_number?: string | null
          checked_at?: string
          created_at?: string
          expiry_date?: string | null
          id?: string
          organization_id?: string
          plate?: string
          raw_response?: Json
          status?: string
          vehicle_class?: string | null
          vehicle_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "nzscv_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "nzscv_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nzscv_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "nzscv_records_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      obligation_proof_artifacts: {
        Row: {
          artifact_type: string
          captured_at: string
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          obligation_id: string
          organization_id: string
          source_record_id: string | null
          source_table: string | null
        }
        Insert: {
          artifact_type: string
          captured_at?: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          obligation_id: string
          organization_id: string
          source_record_id?: string | null
          source_table?: string | null
        }
        Update: {
          artifact_type?: string
          captured_at?: string
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          obligation_id?: string
          organization_id?: string
          source_record_id?: string | null
          source_table?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "obligation_proof_artifacts_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "obligation_proof_artifacts_obligation_id_fkey"
            columns: ["obligation_id"]
            isOneToOne: false
            referencedRelation: "agreement_obligations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "obligation_proof_artifacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "obligation_proof_artifacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "obligation_proof_artifacts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      observation_frozen_fields: {
        Row: {
          column_name: string
          id: number
          ratified_at: string
          ratified_by: string
          reason: string
          table_name: string
        }
        Insert: {
          column_name: string
          id?: never
          ratified_at?: string
          ratified_by: string
          reason: string
          table_name: string
        }
        Update: {
          column_name?: string
          id?: never
          ratified_at?: string
          ratified_by?: string
          reason?: string
          table_name?: string
        }
        Relationships: []
      }
      observation_supporting_evidence: {
        Row: {
          captured_at: string
          created_at: string
          created_by: string | null
          evidence_kind: string
          gps_lat: number | null
          gps_lng: number | null
          id: string
          notes: string | null
          observation_id: string | null
          organization_id: string
          overnight_session_id: string | null
          storage_bucket: string
          storage_path: string | null
        }
        Insert: {
          captured_at?: string
          created_at?: string
          created_by?: string | null
          evidence_kind: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          observation_id?: string | null
          organization_id: string
          overnight_session_id?: string | null
          storage_bucket?: string
          storage_path?: string | null
        }
        Update: {
          captured_at?: string
          created_at?: string
          created_by?: string | null
          evidence_kind?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          observation_id?: string | null
          organization_id?: string
          overnight_session_id?: string | null
          storage_bucket?: string
          storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "observation_supporting_evidence_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observation_supporting_evidence_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observation_supporting_evidence_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "observation_supporting_evidence_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observation_supporting_evidence_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observation_supporting_evidence_overnight_session_id_fkey"
            columns: ["overnight_session_id"]
            isOneToOne: false
            referencedRelation: "vehicle_overnight_sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      observations: {
        Row: {
          client_org_id: string | null
          compliance_reason: string | null
          compliance_status: string | null
          created_at: string
          detection_bbox: Json | null
          detection_confidence: number | null
          embedding: Json | null
          embedding_quality: number | null
          enforcement_exempt: boolean
          exemption_reason: string | null
          external_refs: Json
          geofence_context: Json
          gps_lat: number | null
          gps_lng: number | null
          gps_point: unknown
          id: string
          is_compliant: boolean | null
          is_homeless: boolean
          is_scv: boolean | null
          location_id: string | null
          locked_at: string | null
          module_key: string
          movement_decision: string | null
          movement_moved: boolean | null
          movement_similarity: number | null
          nights_this_month: number | null
          nights_this_zone: number | null
          observed_at: string
          officer_id: string
          officer_notes: string | null
          officer_notes_updated_at: string | null
          offline_queued: boolean
          organization_id: string
          original_photo_url: string | null
          photo_captured_at: string | null
          photo_quality: number | null
          photo_url: string | null
          photo_watermark_text: string | null
          plate_confidence: number | null
          plate_number: string
          plate_source: string | null
          previous_observation_id: string | null
          retention_hold: boolean
          retention_hold_days: number | null
          retention_reason: string | null
          retention_until: string | null
          scv_certificate_number: string | null
          site_id: string | null
          sticker_color: string | null
          sticker_detection_confidence: number | null
          sticker_presence: boolean | null
          synced_at: string | null
          vehicle_colour: string | null
          vehicle_make: string | null
          vehicle_model: string | null
          vehicle_year: number | null
          watermarked_photo_url: string | null
          zone_id: string | null
        }
        Insert: {
          client_org_id?: string | null
          compliance_reason?: string | null
          compliance_status?: string | null
          created_at?: string
          detection_bbox?: Json | null
          detection_confidence?: number | null
          embedding?: Json | null
          embedding_quality?: number | null
          enforcement_exempt?: boolean
          exemption_reason?: string | null
          external_refs?: Json
          geofence_context?: Json
          gps_lat?: number | null
          gps_lng?: number | null
          gps_point?: unknown
          id?: string
          is_compliant?: boolean | null
          is_homeless?: boolean
          is_scv?: boolean | null
          location_id?: string | null
          locked_at?: string | null
          module_key?: string
          movement_decision?: string | null
          movement_moved?: boolean | null
          movement_similarity?: number | null
          nights_this_month?: number | null
          nights_this_zone?: number | null
          observed_at?: string
          officer_id: string
          officer_notes?: string | null
          officer_notes_updated_at?: string | null
          offline_queued?: boolean
          organization_id: string
          original_photo_url?: string | null
          photo_captured_at?: string | null
          photo_quality?: number | null
          photo_url?: string | null
          photo_watermark_text?: string | null
          plate_confidence?: number | null
          plate_number: string
          plate_source?: string | null
          previous_observation_id?: string | null
          retention_hold?: boolean
          retention_hold_days?: number | null
          retention_reason?: string | null
          retention_until?: string | null
          scv_certificate_number?: string | null
          site_id?: string | null
          sticker_color?: string | null
          sticker_detection_confidence?: number | null
          sticker_presence?: boolean | null
          synced_at?: string | null
          vehicle_colour?: string | null
          vehicle_make?: string | null
          vehicle_model?: string | null
          vehicle_year?: number | null
          watermarked_photo_url?: string | null
          zone_id?: string | null
        }
        Update: {
          client_org_id?: string | null
          compliance_reason?: string | null
          compliance_status?: string | null
          created_at?: string
          detection_bbox?: Json | null
          detection_confidence?: number | null
          embedding?: Json | null
          embedding_quality?: number | null
          enforcement_exempt?: boolean
          exemption_reason?: string | null
          external_refs?: Json
          geofence_context?: Json
          gps_lat?: number | null
          gps_lng?: number | null
          gps_point?: unknown
          id?: string
          is_compliant?: boolean | null
          is_homeless?: boolean
          is_scv?: boolean | null
          location_id?: string | null
          locked_at?: string | null
          module_key?: string
          movement_decision?: string | null
          movement_moved?: boolean | null
          movement_similarity?: number | null
          nights_this_month?: number | null
          nights_this_zone?: number | null
          observed_at?: string
          officer_id?: string
          officer_notes?: string | null
          officer_notes_updated_at?: string | null
          offline_queued?: boolean
          organization_id?: string
          original_photo_url?: string | null
          photo_captured_at?: string | null
          photo_quality?: number | null
          photo_url?: string | null
          photo_watermark_text?: string | null
          plate_confidence?: number | null
          plate_number?: string
          plate_source?: string | null
          previous_observation_id?: string | null
          retention_hold?: boolean
          retention_hold_days?: number | null
          retention_reason?: string | null
          retention_until?: string | null
          scv_certificate_number?: string | null
          site_id?: string | null
          sticker_color?: string | null
          sticker_detection_confidence?: number | null
          sticker_presence?: boolean | null
          synced_at?: string | null
          vehicle_colour?: string | null
          vehicle_make?: string | null
          vehicle_model?: string | null
          vehicle_year?: number | null
          watermarked_photo_url?: string | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "observations_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "observations_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_officer_id_fkey"
            columns: ["officer_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "observations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_previous_observation_id_fkey"
            columns: ["previous_observation_id"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "observations_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      officer_command_requests: {
        Row: {
          actor_user_id: string | null
          command_status: string
          command_type: string
          created_at: string
          id: string
          organization_id: string
          request_id: string
          response: Json
          shift_id: string | null
          site_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          command_status: string
          command_type: string
          created_at?: string
          id?: string
          organization_id: string
          request_id: string
          response?: Json
          shift_id?: string | null
          site_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          command_status?: string
          command_type?: string
          created_at?: string
          id?: string
          organization_id?: string
          request_id?: string
          response?: Json
          shift_id?: string | null
          site_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "officer_command_requests_actor_user_id_fkey"
            columns: ["actor_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_command_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "officer_command_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_command_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      officer_field_reports: {
        Row: {
          address: string | null
          created_at: string
          description: string
          follow_up_notes: string | null
          follow_up_required: boolean
          gps_lat: number | null
          gps_lng: number | null
          id: string
          immediate_action: string | null
          location_name: string | null
          officer_id: string
          organization_id: string
          persons_involved: Json | null
          photo_urls: string[] | null
          report_type: Database["public"]["Enums"]["report_type"]
          reported_at: string
          review_notes: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          severity: Database["public"]["Enums"]["report_severity"]
          shift_id: string | null
          site_id: string | null
          status: Database["public"]["Enums"]["report_status"]
          title: string
          updated_at: string
          zone_id: string | null
        }
        Insert: {
          address?: string | null
          created_at?: string
          description: string
          follow_up_notes?: string | null
          follow_up_required?: boolean
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          immediate_action?: string | null
          location_name?: string | null
          officer_id: string
          organization_id: string
          persons_involved?: Json | null
          photo_urls?: string[] | null
          report_type: Database["public"]["Enums"]["report_type"]
          reported_at?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: Database["public"]["Enums"]["report_severity"]
          shift_id?: string | null
          site_id?: string | null
          status?: Database["public"]["Enums"]["report_status"]
          title: string
          updated_at?: string
          zone_id?: string | null
        }
        Update: {
          address?: string | null
          created_at?: string
          description?: string
          follow_up_notes?: string | null
          follow_up_required?: boolean
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          immediate_action?: string | null
          location_name?: string | null
          officer_id?: string
          organization_id?: string
          persons_involved?: Json | null
          photo_urls?: string[] | null
          report_type?: Database["public"]["Enums"]["report_type"]
          reported_at?: string
          review_notes?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          severity?: Database["public"]["Enums"]["report_severity"]
          shift_id?: string | null
          site_id?: string | null
          status?: Database["public"]["Enums"]["report_status"]
          title?: string
          updated_at?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "officer_field_reports_officer_id_fkey"
            columns: ["officer_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_field_reports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "officer_field_reports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_field_reports_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_field_reports_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_field_reports_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_field_reports_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_field_reports_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      officer_gps_log: {
        Row: {
          accuracy_meters: number | null
          activity_type: string
          created_at: string
          detected_zone_id: string | null
          gps_lat: number
          gps_lng: number
          gps_point: unknown
          heading: number | null
          id: string
          officer_id: string
          organization_id: string
          speed_kmh: number | null
        }
        Insert: {
          accuracy_meters?: number | null
          activity_type?: string
          created_at?: string
          detected_zone_id?: string | null
          gps_lat: number
          gps_lng: number
          gps_point: unknown
          heading?: number | null
          id?: string
          officer_id: string
          organization_id: string
          speed_kmh?: number | null
        }
        Update: {
          accuracy_meters?: number | null
          activity_type?: string
          created_at?: string
          detected_zone_id?: string | null
          gps_lat?: number
          gps_lng?: number
          gps_point?: unknown
          heading?: number | null
          id?: string
          officer_id?: string
          organization_id?: string
          speed_kmh?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "officer_gps_log_detected_zone_id_fkey"
            columns: ["detected_zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_gps_log_officer_id_fkey"
            columns: ["officer_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_gps_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "officer_gps_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_gps_log_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      officer_welfare_settings: {
        Row: {
          admin_escalation_time: number
          auto_logoff_enabled: boolean
          auto_logoff_time: number
          check_interval_minutes: number
          created_at: string
          critical_escalation_time: number
          gps_inactivity_threshold: number
          id: string
          identity_gate_config: Json
          identity_gate_enabled: boolean
          inactivity_warning_time: number
          investigation_exception_enabled: boolean
          last_checkin_at: string | null
          man_down_enabled: boolean
          man_down_escalation_minutes: number
          man_down_stationary_minutes: number
          officer_user_id: string
          organization_id: string
          updated_at: string
          welfare_check_enabled: boolean
        }
        Insert: {
          admin_escalation_time?: number
          auto_logoff_enabled?: boolean
          auto_logoff_time?: number
          check_interval_minutes?: number
          created_at?: string
          critical_escalation_time?: number
          gps_inactivity_threshold?: number
          id?: string
          identity_gate_config?: Json
          identity_gate_enabled?: boolean
          inactivity_warning_time?: number
          investigation_exception_enabled?: boolean
          last_checkin_at?: string | null
          man_down_enabled?: boolean
          man_down_escalation_minutes?: number
          man_down_stationary_minutes?: number
          officer_user_id: string
          organization_id: string
          updated_at?: string
          welfare_check_enabled?: boolean
        }
        Update: {
          admin_escalation_time?: number
          auto_logoff_enabled?: boolean
          auto_logoff_time?: number
          check_interval_minutes?: number
          created_at?: string
          critical_escalation_time?: number
          gps_inactivity_threshold?: number
          id?: string
          identity_gate_config?: Json
          identity_gate_enabled?: boolean
          inactivity_warning_time?: number
          investigation_exception_enabled?: boolean
          last_checkin_at?: string | null
          man_down_enabled?: boolean
          man_down_escalation_minutes?: number
          man_down_stationary_minutes?: number
          officer_user_id?: string
          organization_id?: string
          updated_at?: string
          welfare_check_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "officer_welfare_settings_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_welfare_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "officer_welfare_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "officer_welfare_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      on_call_periods: {
        Row: {
          created_at: string
          ends_at: string
          flat_rate: number | null
          id: string
          linked_shift_id: string | null
          officer_user_id: string
          organization_id: string
          period_type: string
          starts_at: string
          status: string
        }
        Insert: {
          created_at?: string
          ends_at: string
          flat_rate?: number | null
          id?: string
          linked_shift_id?: string | null
          officer_user_id: string
          organization_id: string
          period_type: string
          starts_at: string
          status?: string
        }
        Update: {
          created_at?: string
          ends_at?: string
          flat_rate?: number | null
          id?: string
          linked_shift_id?: string | null
          officer_user_id?: string
          organization_id?: string
          period_type?: string
          starts_at?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "on_call_periods_linked_shift_id_fkey"
            columns: ["linked_shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "on_call_periods_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "on_call_periods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "on_call_periods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "on_call_periods_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      onboarding_invites: {
        Row: {
          accepted_at: string | null
          created_at: string
          declined_at: string | null
          email: string
          expires_at: string
          id: string
          invited_by: string | null
          service_agreement_id: string | null
          status: string
          target_organization_id: string
          token_hash: string
        }
        Insert: {
          accepted_at?: string | null
          created_at?: string
          declined_at?: string | null
          email: string
          expires_at: string
          id?: string
          invited_by?: string | null
          service_agreement_id?: string | null
          status?: string
          target_organization_id: string
          token_hash: string
        }
        Update: {
          accepted_at?: string | null
          created_at?: string
          declined_at?: string | null
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string | null
          service_agreement_id?: string | null
          status?: string
          target_organization_id?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "onboarding_invites_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_invites_target_organization_id_fkey"
            columns: ["target_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "onboarding_invites_target_organization_id_fkey"
            columns: ["target_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onboarding_invites_target_organization_id_fkey"
            columns: ["target_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_corporate_officers: {
        Row: {
          address_for_service: string | null
          adverse_notice_effective_at: string | null
          adverse_notice_published_at: string | null
          adverse_notice_reference: string | null
          adverse_notice_search_as_of: string | null
          adverse_notice_source_url: string | null
          adverse_notice_status: string | null
          contact_email: string | null
          contact_phone: string | null
          created_at: string
          full_name: string
          id: string
          notes: string | null
          officer_role: string
          organization_id: string
          registry_verified: boolean
          shareholding_percentage: number | null
          source: string
          source_as_of: string | null
          updated_at: string
        }
        Insert: {
          address_for_service?: string | null
          adverse_notice_effective_at?: string | null
          adverse_notice_published_at?: string | null
          adverse_notice_reference?: string | null
          adverse_notice_search_as_of?: string | null
          adverse_notice_source_url?: string | null
          adverse_notice_status?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          full_name: string
          id?: string
          notes?: string | null
          officer_role: string
          organization_id: string
          registry_verified?: boolean
          shareholding_percentage?: number | null
          source?: string
          source_as_of?: string | null
          updated_at?: string
        }
        Update: {
          address_for_service?: string | null
          adverse_notice_effective_at?: string | null
          adverse_notice_published_at?: string | null
          adverse_notice_reference?: string | null
          adverse_notice_search_as_of?: string | null
          adverse_notice_source_url?: string | null
          adverse_notice_status?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          created_at?: string
          full_name?: string
          id?: string
          notes?: string | null
          officer_role?: string
          organization_id?: string
          registry_verified?: boolean
          shareholding_percentage?: number | null
          source?: string
          source_as_of?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_corporate_officers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "org_corporate_officers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_corporate_officers_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_engagements: {
        Row: {
          created_at: string
          ends_on: string | null
          engagement_type: string
          from_org_id: string
          id: string
          notes: string | null
          service_agreement_id: string | null
          starts_on: string | null
          status: string
          to_org_id: string
        }
        Insert: {
          created_at?: string
          ends_on?: string | null
          engagement_type: string
          from_org_id: string
          id?: string
          notes?: string | null
          service_agreement_id?: string | null
          starts_on?: string | null
          status?: string
          to_org_id: string
        }
        Update: {
          created_at?: string
          ends_on?: string | null
          engagement_type?: string
          from_org_id?: string
          id?: string
          notes?: string | null
          service_agreement_id?: string | null
          starts_on?: string | null
          status?: string
          to_org_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_engagements_from_org_id_fkey"
            columns: ["from_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "org_engagements_from_org_id_fkey"
            columns: ["from_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_engagements_from_org_id_fkey"
            columns: ["from_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_engagements_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_engagements_to_org_id_fkey"
            columns: ["to_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "org_engagements_to_org_id_fkey"
            columns: ["to_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_engagements_to_org_id_fkey"
            columns: ["to_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_geofence_config: {
        Row: {
          config_key: string
          config_value: number
          created_at: string
          id: string
          organization_id: string
          updated_at: string
          zone_type: string | null
        }
        Insert: {
          config_key: string
          config_value: number
          created_at?: string
          id?: string
          organization_id: string
          updated_at?: string
          zone_type?: string | null
        }
        Update: {
          config_key?: string
          config_value?: number
          created_at?: string
          id?: string
          organization_id?: string
          updated_at?: string
          zone_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "org_geofence_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "org_geofence_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_geofence_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      org_module_subscriptions: {
        Row: {
          base_price: number | null
          billing_period: string | null
          created_at: string
          created_by: string | null
          currency: string | null
          discount_pct: number
          effective_from: string | null
          effective_to: string | null
          ended_at: string | null
          id: string
          module_key: string
          notes: string | null
          organization_id: string
          per_seat_price: number | null
          per_site_price: number | null
          started_at: string
          status: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          base_price?: number | null
          billing_period?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string | null
          discount_pct?: number
          effective_from?: string | null
          effective_to?: string | null
          ended_at?: string | null
          id?: string
          module_key: string
          notes?: string | null
          organization_id: string
          per_seat_price?: number | null
          per_site_price?: number | null
          started_at?: string
          status?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          base_price?: number | null
          billing_period?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string | null
          discount_pct?: number
          effective_from?: string | null
          effective_to?: string | null
          ended_at?: string | null
          id?: string
          module_key?: string
          notes?: string | null
          organization_id?: string
          per_seat_price?: number | null
          per_site_price?: number | null
          started_at?: string
          status?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "org_module_subscriptions_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_module_subscriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "org_module_subscriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_module_subscriptions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_module_subscriptions_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      org_rate_settings: {
        Row: {
          created_at: string
          currency: string
          default_platform_fee_treatment: string
          double_multiplier: number
          gst_rate: number
          invoice_prefix: string
          organization_id: string
          overtime_multiplier: number
          pay_policy: string
          payment_terms_days: number
          rounding: string
          target_margin_pct: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency?: string
          default_platform_fee_treatment?: string
          double_multiplier?: number
          gst_rate?: number
          invoice_prefix?: string
          organization_id: string
          overtime_multiplier?: number
          pay_policy?: string
          payment_terms_days?: number
          rounding?: string
          target_margin_pct?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency?: string
          default_platform_fee_treatment?: string
          double_multiplier?: number
          gst_rate?: number
          invoice_prefix?: string
          organization_id?: string
          overtime_multiplier?: number
          pay_policy?: string
          payment_terms_days?: number
          rounding?: string
          target_margin_pct?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_rate_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "org_rate_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "org_rate_settings_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_modules: {
        Row: {
          enabled: boolean
          id: string
          module_key: string
          organization_id: string
          settings: Json
        }
        Insert: {
          enabled?: boolean
          id?: string
          module_key: string
          organization_id: string
          settings?: Json
        }
        Update: {
          enabled?: boolean
          id?: string
          module_key?: string
          organization_id?: string
          settings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "organization_modules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "organization_modules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_modules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          account_notes: string | null
          active: boolean
          billing_address: string | null
          billing_email: string | null
          company_registration_number: string | null
          contact_email: string | null
          contact_phone: string | null
          corporate_profile_verified_at: string | null
          corporate_profile_verified_by: string | null
          corporate_status: string | null
          corporate_status_as_of: string | null
          created_at: string
          discoverable: boolean
          enforcement_workflow_mode: string
          external_refs: Json
          id: string
          jurisdiction_geom: unknown
          jurisdiction_verification: string
          jurisdiction_verified_at: string | null
          jurisdiction_verified_by: string | null
          logo_url: string | null
          name: string
          nzbn: string | null
          nzbn_entity_type: string | null
          organization_level: number | null
          organization_type: string
          parent_organization_id: string | null
          status: string
        }
        Insert: {
          account_notes?: string | null
          active?: boolean
          billing_address?: string | null
          billing_email?: string | null
          company_registration_number?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          corporate_profile_verified_at?: string | null
          corporate_profile_verified_by?: string | null
          corporate_status?: string | null
          corporate_status_as_of?: string | null
          created_at?: string
          discoverable?: boolean
          enforcement_workflow_mode?: string
          external_refs?: Json
          id?: string
          jurisdiction_geom?: unknown
          jurisdiction_verification?: string
          jurisdiction_verified_at?: string | null
          jurisdiction_verified_by?: string | null
          logo_url?: string | null
          name: string
          nzbn?: string | null
          nzbn_entity_type?: string | null
          organization_level?: number | null
          organization_type: string
          parent_organization_id?: string | null
          status?: string
        }
        Update: {
          account_notes?: string | null
          active?: boolean
          billing_address?: string | null
          billing_email?: string | null
          company_registration_number?: string | null
          contact_email?: string | null
          contact_phone?: string | null
          corporate_profile_verified_at?: string | null
          corporate_profile_verified_by?: string | null
          corporate_status?: string | null
          corporate_status_as_of?: string | null
          created_at?: string
          discoverable?: boolean
          enforcement_workflow_mode?: string
          external_refs?: Json
          id?: string
          jurisdiction_geom?: unknown
          jurisdiction_verification?: string
          jurisdiction_verified_at?: string | null
          jurisdiction_verified_by?: string | null
          logo_url?: string | null
          name?: string
          nzbn?: string | null
          nzbn_entity_type?: string | null
          organization_level?: number | null
          organization_type?: string
          parent_organization_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "organizations_corporate_profile_verified_by_fkey"
            columns: ["corporate_profile_verified_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizations_jurisdiction_verified_by_fkey"
            columns: ["jurisdiction_verified_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizations_parent_organization_id_fkey"
            columns: ["parent_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "organizations_parent_organization_id_fkey"
            columns: ["parent_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizations_parent_organization_id_fkey"
            columns: ["parent_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      parking_chalk_records: {
        Row: {
          bob_classification: string | null
          bob_confidence: number | null
          chalked_at: string
          client_site_id: string | null
          cof_expiry: string | null
          cof_status: string | null
          created_at: string
          effective_time_limit_minutes: number | null
          embedding: string | null
          embedding_quality: number | null
          geofence_context: Json
          id: string
          inference_provider: string | null
          infringement_number: string | null
          is_disabled_bay: boolean | null
          location_name: string | null
          movement_detected: boolean | null
          movement_similarity: number | null
          notes: string | null
          officer_id: string | null
          officer_name: string | null
          organization_id: string
          photo_url: string | null
          photo_urls: Json | null
          plate: string
          rego_expiry: string | null
          rego_status: string | null
          resolved_at: string | null
          return_by: string
          road_marking_detected: string | null
          sign_confidence: number | null
          sign_time_limit_minutes: number | null
          site_id: string | null
          status: string
          updated_at: string
          vehicle_colour: string | null
          vehicle_compliance_flags: Json | null
          vehicle_make: string | null
          vehicle_model: string | null
          wof_expiry: string | null
          wof_status: string | null
          zone_id: string | null
        }
        Insert: {
          bob_classification?: string | null
          bob_confidence?: number | null
          chalked_at?: string
          client_site_id?: string | null
          cof_expiry?: string | null
          cof_status?: string | null
          created_at?: string
          effective_time_limit_minutes?: number | null
          embedding?: string | null
          embedding_quality?: number | null
          geofence_context?: Json
          id?: string
          inference_provider?: string | null
          infringement_number?: string | null
          is_disabled_bay?: boolean | null
          location_name?: string | null
          movement_detected?: boolean | null
          movement_similarity?: number | null
          notes?: string | null
          officer_id?: string | null
          officer_name?: string | null
          organization_id: string
          photo_url?: string | null
          photo_urls?: Json | null
          plate: string
          rego_expiry?: string | null
          rego_status?: string | null
          resolved_at?: string | null
          return_by?: string
          road_marking_detected?: string | null
          sign_confidence?: number | null
          sign_time_limit_minutes?: number | null
          site_id?: string | null
          status?: string
          updated_at?: string
          vehicle_colour?: string | null
          vehicle_compliance_flags?: Json | null
          vehicle_make?: string | null
          vehicle_model?: string | null
          wof_expiry?: string | null
          wof_status?: string | null
          zone_id?: string | null
        }
        Update: {
          bob_classification?: string | null
          bob_confidence?: number | null
          chalked_at?: string
          client_site_id?: string | null
          cof_expiry?: string | null
          cof_status?: string | null
          created_at?: string
          effective_time_limit_minutes?: number | null
          embedding?: string | null
          embedding_quality?: number | null
          geofence_context?: Json
          id?: string
          inference_provider?: string | null
          infringement_number?: string | null
          is_disabled_bay?: boolean | null
          location_name?: string | null
          movement_detected?: boolean | null
          movement_similarity?: number | null
          notes?: string | null
          officer_id?: string | null
          officer_name?: string | null
          organization_id?: string
          photo_url?: string | null
          photo_urls?: Json | null
          plate?: string
          rego_expiry?: string | null
          rego_status?: string | null
          resolved_at?: string | null
          return_by?: string
          road_marking_detected?: string | null
          sign_confidence?: number | null
          sign_time_limit_minutes?: number | null
          site_id?: string | null
          status?: string
          updated_at?: string
          vehicle_colour?: string | null
          vehicle_compliance_flags?: Json | null
          vehicle_make?: string | null
          vehicle_model?: string | null
          wof_expiry?: string | null
          wof_status?: string | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "parking_chalk_records_client_site_id_fkey"
            columns: ["client_site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_chalk_records_officer_id_fkey"
            columns: ["officer_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_chalk_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "parking_chalk_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_chalk_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_chalk_records_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_chalk_records_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      parking_infringement_notices: {
        Row: {
          amount: number | null
          chalk_record_id: string | null
          client_site_id: string | null
          created_at: string
          evidence_photo_urls: Json | null
          id: string
          issued_at: string | null
          issued_by: string | null
          legislative_text: string | null
          notice_number: string
          offence_description: string | null
          officer_name: string | null
          organization_id: string
          plate_number: string
          status: string
          updated_at: string
          zone_id: string | null
          zone_name: string | null
        }
        Insert: {
          amount?: number | null
          chalk_record_id?: string | null
          client_site_id?: string | null
          created_at?: string
          evidence_photo_urls?: Json | null
          id?: string
          issued_at?: string | null
          issued_by?: string | null
          legislative_text?: string | null
          notice_number: string
          offence_description?: string | null
          officer_name?: string | null
          organization_id: string
          plate_number: string
          status?: string
          updated_at?: string
          zone_id?: string | null
          zone_name?: string | null
        }
        Update: {
          amount?: number | null
          chalk_record_id?: string | null
          client_site_id?: string | null
          created_at?: string
          evidence_photo_urls?: Json | null
          id?: string
          issued_at?: string | null
          issued_by?: string | null
          legislative_text?: string | null
          notice_number?: string
          offence_description?: string | null
          officer_name?: string | null
          organization_id?: string
          plate_number?: string
          status?: string
          updated_at?: string
          zone_id?: string | null
          zone_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "parking_infringement_notices_chalk_record_id_fkey"
            columns: ["chalk_record_id"]
            isOneToOne: false
            referencedRelation: "parking_chalk_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_infringement_notices_client_site_id_fkey"
            columns: ["client_site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_infringement_notices_issued_by_fkey"
            columns: ["issued_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_infringement_notices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "parking_infringement_notices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_infringement_notices_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_infringement_notices_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      parking_module_config: {
        Row: {
          auto_escalate_overstay: boolean
          default_time_limit_minutes: number
          grace_period_minutes: number
          id: string
          infringement_fee_dollars: number
          legislative_text: string | null
          organization_id: string
          require_photo_evidence: boolean
          updated_at: string
        }
        Insert: {
          auto_escalate_overstay?: boolean
          default_time_limit_minutes?: number
          grace_period_minutes?: number
          id?: string
          infringement_fee_dollars?: number
          legislative_text?: string | null
          organization_id: string
          require_photo_evidence?: boolean
          updated_at?: string
        }
        Update: {
          auto_escalate_overstay?: boolean
          default_time_limit_minutes?: number
          grace_period_minutes?: number
          id?: string
          infringement_fee_dollars?: number
          legislative_text?: string | null
          organization_id?: string
          require_photo_evidence?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "parking_module_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "parking_module_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_module_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: true
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      parking_sessions: {
        Row: {
          chalk_time: string | null
          compliance_status: string | null
          created_at: string
          evidence_id: string | null
          id: string
          location_id: string | null
          notes: string | null
          observed_at: string
          officer_user_id: string | null
          organization_id: string
          permit_reference: string | null
          permit_valid: boolean | null
          plate: string
          shift_id: string | null
          vehicle_id: string | null
          zone_id: string | null
        }
        Insert: {
          chalk_time?: string | null
          compliance_status?: string | null
          created_at?: string
          evidence_id?: string | null
          id?: string
          location_id?: string | null
          notes?: string | null
          observed_at?: string
          officer_user_id?: string | null
          organization_id: string
          permit_reference?: string | null
          permit_valid?: boolean | null
          plate: string
          shift_id?: string | null
          vehicle_id?: string | null
          zone_id?: string | null
        }
        Update: {
          chalk_time?: string | null
          compliance_status?: string | null
          created_at?: string
          evidence_id?: string | null
          id?: string
          location_id?: string | null
          notes?: string | null
          observed_at?: string
          officer_user_id?: string | null
          organization_id?: string
          permit_reference?: string | null
          permit_valid?: boolean | null
          plate?: string
          shift_id?: string | null
          vehicle_id?: string | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "parking_sessions_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_sessions_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "parking_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_sessions_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_sessions_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parking_sessions_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      patrol_checkpoint_visits: {
        Row: {
          checkpoint_id: string
          gps_accuracy: number | null
          gps_distance_from_checkpoint: number | null
          gps_lat: number | null
          gps_lng: number | null
          id: string
          notes: string | null
          officer_user_id: string | null
          organization_id: string
          patrol_id: string
          scan_method: string
          shift_stop_id: string | null
          visited_at: string
          within_radius: boolean | null
        }
        Insert: {
          checkpoint_id: string
          gps_accuracy?: number | null
          gps_distance_from_checkpoint?: number | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          officer_user_id?: string | null
          organization_id: string
          patrol_id: string
          scan_method?: string
          shift_stop_id?: string | null
          visited_at?: string
          within_radius?: boolean | null
        }
        Update: {
          checkpoint_id?: string
          gps_accuracy?: number | null
          gps_distance_from_checkpoint?: number | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          officer_user_id?: string | null
          organization_id?: string
          patrol_id?: string
          scan_method?: string
          shift_stop_id?: string | null
          visited_at?: string
          within_radius?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "patrol_checkpoint_visits_checkpoint_id_fkey"
            columns: ["checkpoint_id"]
            isOneToOne: false
            referencedRelation: "patrol_checkpoints"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_checkpoint_visits_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_checkpoint_visits_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "patrol_checkpoint_visits_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_checkpoint_visits_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_checkpoint_visits_patrol_id_fkey"
            columns: ["patrol_id"]
            isOneToOne: false
            referencedRelation: "patrols"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_checkpoint_visits_shift_stop_id_fkey"
            columns: ["shift_stop_id"]
            isOneToOne: false
            referencedRelation: "shift_stops"
            referencedColumns: ["id"]
          },
        ]
      }
      patrol_checkpoints: {
        Row: {
          active: boolean
          checkpoint_verification: string
          checkpoint_verified_at: string | null
          checkpoint_verified_by: string | null
          client_site_id: string | null
          created_at: string
          description: string | null
          gps_lat: number | null
          gps_lng: number | null
          id: string
          location_id: string | null
          name: string
          organization_id: string
          qr_code: string | null
          radius_meters: number
          zone_id: string | null
        }
        Insert: {
          active?: boolean
          checkpoint_verification?: string
          checkpoint_verified_at?: string | null
          checkpoint_verified_by?: string | null
          client_site_id?: string | null
          created_at?: string
          description?: string | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          location_id?: string | null
          name: string
          organization_id: string
          qr_code?: string | null
          radius_meters?: number
          zone_id?: string | null
        }
        Update: {
          active?: boolean
          checkpoint_verification?: string
          checkpoint_verified_at?: string | null
          checkpoint_verified_by?: string | null
          client_site_id?: string | null
          created_at?: string
          description?: string | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          location_id?: string | null
          name?: string
          organization_id?: string
          qr_code?: string | null
          radius_meters?: number
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patrol_checkpoints_checkpoint_verified_by_fkey"
            columns: ["checkpoint_verified_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_checkpoints_client_site_id_fkey"
            columns: ["client_site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_checkpoints_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "patrol_checkpoints_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_checkpoints_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_checkpoints_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      patrol_route_checkpoints: {
        Row: {
          created_at: string
          description: string | null
          expected_arrival_offset_minutes: number | null
          geofence_radius_meters: number
          gps_lat: number | null
          gps_lng: number | null
          id: string
          is_active: boolean
          is_mandatory: boolean
          name: string
          patrol_route_id: string
          qr_code_data: string | null
          required_actions: Json
          scan_type: string
          sequence_order: number
        }
        Insert: {
          created_at?: string
          description?: string | null
          expected_arrival_offset_minutes?: number | null
          geofence_radius_meters?: number
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          is_active?: boolean
          is_mandatory?: boolean
          name: string
          patrol_route_id: string
          qr_code_data?: string | null
          required_actions?: Json
          scan_type?: string
          sequence_order?: number
        }
        Update: {
          created_at?: string
          description?: string | null
          expected_arrival_offset_minutes?: number | null
          geofence_radius_meters?: number
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          is_active?: boolean
          is_mandatory?: boolean
          name?: string
          patrol_route_id?: string
          qr_code_data?: string | null
          required_actions?: Json
          scan_type?: string
          sequence_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "patrol_route_checkpoints_patrol_route_id_fkey"
            columns: ["patrol_route_id"]
            isOneToOne: false
            referencedRelation: "patrol_routes"
            referencedColumns: ["id"]
          },
        ]
      }
      patrol_route_sites: {
        Row: {
          coverage_priority: number
          created_at: string
          dwell_minutes: number
          expected_visits_per_shift: number | null
          notes: string | null
          patrol_route_id: string
          preferred_stop_order: number
          preferred_time_window: string | null
          required_module: string | null
          site_id: string
          sla_arrive_within_minutes: number
        }
        Insert: {
          coverage_priority?: number
          created_at?: string
          dwell_minutes?: number
          expected_visits_per_shift?: number | null
          notes?: string | null
          patrol_route_id: string
          preferred_stop_order?: number
          preferred_time_window?: string | null
          required_module?: string | null
          site_id: string
          sla_arrive_within_minutes?: number
        }
        Update: {
          coverage_priority?: number
          created_at?: string
          dwell_minutes?: number
          expected_visits_per_shift?: number | null
          notes?: string | null
          patrol_route_id?: string
          preferred_stop_order?: number
          preferred_time_window?: string | null
          required_module?: string | null
          site_id?: string
          sla_arrive_within_minutes?: number
        }
        Relationships: [
          {
            foreignKeyName: "patrol_route_sites_patrol_route_id_fkey"
            columns: ["patrol_route_id"]
            isOneToOne: false
            referencedRelation: "patrol_routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_route_sites_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      patrol_route_stop_modules: {
        Row: {
          active: boolean
          created_at: string
          display_order: number
          id: string
          is_required: boolean
          module_config: Json
          module_key: string
          organization_id: string
          patrol_config_id: string
          service_agreement_location_id: string | null
          service_agreement_module_id: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          display_order?: number
          id?: string
          is_required?: boolean
          module_config?: Json
          module_key: string
          organization_id: string
          patrol_config_id: string
          service_agreement_location_id?: string | null
          service_agreement_module_id?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          display_order?: number
          id?: string
          is_required?: boolean
          module_config?: Json
          module_key?: string
          organization_id?: string
          patrol_config_id?: string
          service_agreement_location_id?: string | null
          service_agreement_module_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "patrol_route_stop_modules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "patrol_route_stop_modules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_route_stop_modules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_route_stop_modules_patrol_config_id_fkey"
            columns: ["patrol_config_id"]
            isOneToOne: false
            referencedRelation: "client_site_patrol_config"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_route_stop_modules_service_agreement_location_id_fkey"
            columns: ["service_agreement_location_id"]
            isOneToOne: false
            referencedRelation: "location_visibility_for_viewer"
            referencedColumns: ["sal_id"]
          },
          {
            foreignKeyName: "patrol_route_stop_modules_service_agreement_location_id_fkey"
            columns: ["service_agreement_location_id"]
            isOneToOne: false
            referencedRelation: "service_agreement_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_route_stop_modules_service_agreement_module_id_fkey"
            columns: ["service_agreement_module_id"]
            isOneToOne: false
            referencedRelation: "service_agreement_modules"
            referencedColumns: ["id"]
          },
        ]
      }
      patrol_route_zones: {
        Row: {
          coverage_priority: number
          created_at: string
          expected_visits_per_shift: number | null
          notes: string | null
          patrol_route_id: string
          preferred_time_window: string | null
          required_module: string | null
          zone_id: string
        }
        Insert: {
          coverage_priority?: number
          created_at?: string
          expected_visits_per_shift?: number | null
          notes?: string | null
          patrol_route_id: string
          preferred_time_window?: string | null
          required_module?: string | null
          zone_id: string
        }
        Update: {
          coverage_priority?: number
          created_at?: string
          expected_visits_per_shift?: number | null
          notes?: string | null
          patrol_route_id?: string
          preferred_time_window?: string | null
          required_module?: string | null
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "patrol_route_zones_patrol_route_id_fkey"
            columns: ["patrol_route_id"]
            isOneToOne: false
            referencedRelation: "patrol_routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_route_zones_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      patrol_routes: {
        Row: {
          active_days: number[]
          assignment_type: string | null
          call_sign: string | null
          checkpoint_mode: string
          color: string | null
          created_at: string
          default_end_time: string | null
          default_shift: string | null
          default_start_time: string | null
          description: string | null
          expected_duration_minutes: number | null
          guards_required: number
          id: string
          is_active: boolean
          min_checkpoints_required: number | null
          name: string
          organization_id: string
          parent_assignment_id: string | null
          route_code: string | null
          route_type: string
          site_id: string | null
        }
        Insert: {
          active_days?: number[]
          assignment_type?: string | null
          call_sign?: string | null
          checkpoint_mode?: string
          color?: string | null
          created_at?: string
          default_end_time?: string | null
          default_shift?: string | null
          default_start_time?: string | null
          description?: string | null
          expected_duration_minutes?: number | null
          guards_required?: number
          id?: string
          is_active?: boolean
          min_checkpoints_required?: number | null
          name: string
          organization_id: string
          parent_assignment_id?: string | null
          route_code?: string | null
          route_type?: string
          site_id?: string | null
        }
        Update: {
          active_days?: number[]
          assignment_type?: string | null
          call_sign?: string | null
          checkpoint_mode?: string
          color?: string | null
          created_at?: string
          default_end_time?: string | null
          default_shift?: string | null
          default_start_time?: string | null
          description?: string | null
          expected_duration_minutes?: number | null
          guards_required?: number
          id?: string
          is_active?: boolean
          min_checkpoints_required?: number | null
          name?: string
          organization_id?: string
          parent_assignment_id?: string | null
          route_code?: string | null
          route_type?: string
          site_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patrol_routes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "patrol_routes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_routes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_routes_parent_assignment_id_fkey"
            columns: ["parent_assignment_id"]
            isOneToOne: false
            referencedRelation: "patrol_routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_routes_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      patrol_solve_cache: {
        Row: {
          cache_ttl_minutes: number
          id: string
          invalidated_at: string | null
          invalidation_reason: string | null
          officer_gps_lat: number | null
          officer_gps_lng: number | null
          organization_id: string
          shift_health: string
          shift_id: string
          solved_at: string
          solved_etas: Json
          solved_sequence: Json
          solved_sla_status: Json
          stop_count: number
          travel_matrix: Json
        }
        Insert: {
          cache_ttl_minutes?: number
          id?: string
          invalidated_at?: string | null
          invalidation_reason?: string | null
          officer_gps_lat?: number | null
          officer_gps_lng?: number | null
          organization_id: string
          shift_health?: string
          shift_id: string
          solved_at?: string
          solved_etas?: Json
          solved_sequence?: Json
          solved_sla_status?: Json
          stop_count?: number
          travel_matrix?: Json
        }
        Update: {
          cache_ttl_minutes?: number
          id?: string
          invalidated_at?: string | null
          invalidation_reason?: string | null
          officer_gps_lat?: number | null
          officer_gps_lng?: number | null
          organization_id?: string
          shift_health?: string
          shift_id?: string
          solved_at?: string
          solved_etas?: Json
          solved_sequence?: Json
          solved_sla_status?: Json
          stop_count?: number
          travel_matrix?: Json
        }
        Relationships: [
          {
            foreignKeyName: "patrol_solve_cache_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "patrol_solve_cache_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_solve_cache_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrol_solve_cache_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: true
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      patrols: {
        Row: {
          created_at: string
          ended_at: string | null
          id: string
          location_id: string | null
          notes: string | null
          officer_user_id: string
          organization_id: string
          shift_id: string | null
          started_at: string
          status: string
          zone_id: string | null
        }
        Insert: {
          created_at?: string
          ended_at?: string | null
          id?: string
          location_id?: string | null
          notes?: string | null
          officer_user_id: string
          organization_id: string
          shift_id?: string | null
          started_at?: string
          status?: string
          zone_id?: string | null
        }
        Update: {
          created_at?: string
          ended_at?: string | null
          id?: string
          location_id?: string | null
          notes?: string | null
          officer_user_id?: string
          organization_id?: string
          shift_id?: string | null
          started_at?: string
          status?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "patrols_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrols_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "patrols_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrols_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrols_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "patrols_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      payroll_export_batches: {
        Row: {
          exported_at: string
          exported_by: string | null
          format: string
          id: string
          notes: string | null
          organization_id: string
          period_from: string
          period_to: string
          timesheet_count: number
          total_hours: number
        }
        Insert: {
          exported_at?: string
          exported_by?: string | null
          format?: string
          id?: string
          notes?: string | null
          organization_id: string
          period_from: string
          period_to: string
          timesheet_count?: number
          total_hours?: number
        }
        Update: {
          exported_at?: string
          exported_by?: string | null
          format?: string
          id?: string
          notes?: string | null
          organization_id?: string
          period_from?: string
          period_to?: string
          timesheet_count?: number
          total_hours?: number
        }
        Relationships: [
          {
            foreignKeyName: "payroll_export_batches_exported_by_fkey"
            columns: ["exported_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_export_batches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "payroll_export_batches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payroll_export_batches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      person_identity_documents: {
        Row: {
          document_kind: string | null
          evidence_item_id: string | null
          extracted_fields: Json
          id: string
          id_photo_storage_path: string | null
          person_record_id: string | null
          review_state: string
        }
        Insert: {
          document_kind?: string | null
          evidence_item_id?: string | null
          extracted_fields?: Json
          id?: string
          id_photo_storage_path?: string | null
          person_record_id?: string | null
          review_state?: string
        }
        Update: {
          document_kind?: string | null
          evidence_item_id?: string | null
          extracted_fields?: Json
          id?: string
          id_photo_storage_path?: string | null
          person_record_id?: string | null
          review_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "person_identity_documents_evidence_item_id_fkey"
            columns: ["evidence_item_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_identity_documents_person_record_id_fkey"
            columns: ["person_record_id"]
            isOneToOne: false
            referencedRelation: "person_records"
            referencedColumns: ["id"]
          },
        ]
      }
      person_interactions: {
        Row: {
          client_site_id: string | null
          evidence_id: string | null
          id: string
          interacted_at: string
          interaction_type: string
          location_event_id: string | null
          location_id: string | null
          notes: string | null
          officer_user_id: string | null
          organization_id: string
          person_id: string
          zone_id: string | null
        }
        Insert: {
          client_site_id?: string | null
          evidence_id?: string | null
          id?: string
          interacted_at?: string
          interaction_type: string
          location_event_id?: string | null
          location_id?: string | null
          notes?: string | null
          officer_user_id?: string | null
          organization_id: string
          person_id: string
          zone_id?: string | null
        }
        Update: {
          client_site_id?: string | null
          evidence_id?: string | null
          id?: string
          interacted_at?: string
          interaction_type?: string
          location_event_id?: string | null
          location_id?: string | null
          notes?: string | null
          officer_user_id?: string | null
          organization_id?: string
          person_id?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "person_interactions_client_site_id_fkey"
            columns: ["client_site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_interactions_evidence_id_fkey"
            columns: ["evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_interactions_location_event_id_fkey"
            columns: ["location_event_id"]
            isOneToOne: false
            referencedRelation: "location_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_interactions_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_interactions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "person_interactions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_interactions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_interactions_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "persons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_interactions_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      person_records: {
        Row: {
          created_at: string
          display_name: string | null
          id: string
          metadata: Json
          organization_id: string
          review_state: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          id?: string
          metadata?: Json
          organization_id: string
          review_state?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          id?: string
          metadata?: Json
          organization_id?: string
          review_state?: string
        }
        Relationships: [
          {
            foreignKeyName: "person_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "person_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      person_vehicle_links: {
        Row: {
          id: string
          linked_at: string
          linked_by: string | null
          notes: string | null
          organization_id: string
          person_id: string
          vehicle_id: string
        }
        Insert: {
          id?: string
          linked_at?: string
          linked_by?: string | null
          notes?: string | null
          organization_id: string
          person_id: string
          vehicle_id: string
        }
        Update: {
          id?: string
          linked_at?: string
          linked_by?: string | null
          notes?: string | null
          organization_id?: string
          person_id?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "person_vehicle_links_linked_by_fkey"
            columns: ["linked_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_vehicle_links_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "person_vehicle_links_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_vehicle_links_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_vehicle_links_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "persons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "person_vehicle_links_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      persons: {
        Row: {
          created_at: string
          date_of_birth: string | null
          display_name: string | null
          homeless_notes: string | null
          homeless_status: string
          homeless_verified_at: string | null
          id: string
          organization_id: string | null
          person_record_id: string | null
          updated_at: string
          welfare_flag: boolean
          welfare_notes: string | null
        }
        Insert: {
          created_at?: string
          date_of_birth?: string | null
          display_name?: string | null
          homeless_notes?: string | null
          homeless_status?: string
          homeless_verified_at?: string | null
          id?: string
          organization_id?: string | null
          person_record_id?: string | null
          updated_at?: string
          welfare_flag?: boolean
          welfare_notes?: string | null
        }
        Update: {
          created_at?: string
          date_of_birth?: string | null
          display_name?: string | null
          homeless_notes?: string | null
          homeless_status?: string
          homeless_verified_at?: string | null
          id?: string
          organization_id?: string | null
          person_record_id?: string | null
          updated_at?: string
          welfare_flag?: boolean
          welfare_notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "persons_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "persons_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "persons_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "persons_person_record_id_fkey"
            columns: ["person_record_id"]
            isOneToOne: false
            referencedRelation: "person_records"
            referencedColumns: ["id"]
          },
        ]
      }
      preset_assignments: {
        Row: {
          assigned_by: string | null
          created_at: string
          id: string
          preset_id: string
          scope_org_id: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          assigned_by?: string | null
          created_at?: string
          id?: string
          preset_id: string
          scope_org_id: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          assigned_by?: string | null
          created_at?: string
          id?: string
          preset_id?: string
          scope_org_id?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "preset_assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "preset_assignments_preset_id_fkey"
            columns: ["preset_id"]
            isOneToOne: false
            referencedRelation: "access_presets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "preset_assignments_scope_org_id_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "preset_assignments_scope_org_id_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "preset_assignments_scope_org_id_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "preset_assignments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      provider_client_access_grants: {
        Row: {
          client_organization_id: string
          created_at: string
          ends_at: string | null
          grant_kind: string
          id: string
          module_key: string | null
          provider_organization_id: string
          service_agreement_id: string
          starts_at: string
        }
        Insert: {
          client_organization_id: string
          created_at?: string
          ends_at?: string | null
          grant_kind: string
          id?: string
          module_key?: string | null
          provider_organization_id: string
          service_agreement_id: string
          starts_at?: string
        }
        Update: {
          client_organization_id?: string
          created_at?: string
          ends_at?: string | null
          grant_kind?: string
          id?: string
          module_key?: string | null
          provider_organization_id?: string
          service_agreement_id?: string
          starts_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "provider_client_access_grants_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "provider_client_access_grants_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_client_access_grants_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_client_access_grants_provider_organization_id_fkey"
            columns: ["provider_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "provider_client_access_grants_provider_organization_id_fkey"
            columns: ["provider_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_client_access_grants_provider_organization_id_fkey"
            columns: ["provider_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "provider_client_access_grants_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
        ]
      }
      ptt_channels: {
        Row: {
          created_at: string
          emergency_enabled: boolean
          id: string
          name: string
          organization_id: string
        }
        Insert: {
          created_at?: string
          emergency_enabled?: boolean
          id?: string
          name: string
          organization_id: string
        }
        Update: {
          created_at?: string
          emergency_enabled?: boolean
          id?: string
          name?: string
          organization_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ptt_channels_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "ptt_channels_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ptt_channels_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      ptt_transmissions: {
        Row: {
          channel_id: string | null
          emergency: boolean
          ended_at: string | null
          id: string
          metadata: Json
          organization_id: string
          speaker_user_id: string | null
          started_at: string
          state: string
        }
        Insert: {
          channel_id?: string | null
          emergency?: boolean
          ended_at?: string | null
          id?: string
          metadata?: Json
          organization_id: string
          speaker_user_id?: string | null
          started_at?: string
          state: string
        }
        Update: {
          channel_id?: string | null
          emergency?: boolean
          ended_at?: string | null
          id?: string
          metadata?: Json
          organization_id?: string
          speaker_user_id?: string | null
          started_at?: string
          state?: string
        }
        Relationships: [
          {
            foreignKeyName: "ptt_transmissions_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "ptt_channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ptt_transmissions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "ptt_transmissions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ptt_transmissions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ptt_transmissions_speaker_user_id_fkey"
            columns: ["speaker_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_lines: {
        Row: {
          created_at: string
          description: string
          id: string
          kind: string
          line_order: number
          module_key: string | null
          quantity: number
          quote_id: string
          site_id: string | null
          source_dispatch_id: string | null
          unit_charge: number
          unit_cost: number
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          kind?: string
          line_order?: number
          module_key?: string | null
          quantity?: number
          quote_id: string
          site_id?: string | null
          source_dispatch_id?: string | null
          unit_charge?: number
          unit_cost?: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          kind?: string
          line_order?: number
          module_key?: string | null
          quantity?: number
          quote_id?: string
          site_id?: string | null
          source_dispatch_id?: string | null
          unit_charge?: number
          unit_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "quote_lines_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quotes: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          client_name: string | null
          client_org_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          discount_amount: number
          discount_pct: number
          gst_amount: number
          gst_rate: number
          id: string
          notes: string | null
          platform_fee_treatment: string
          provider_org_id: string
          service_agreement_id: string | null
          status: string
          subtotal_charge: number
          target_margin_pct: number
          title: string
          total_charge: number
          total_cost: number
          updated_at: string
          updated_by: string | null
          valid_until: string | null
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          client_name?: string | null
          client_org_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          discount_amount?: number
          discount_pct?: number
          gst_amount?: number
          gst_rate?: number
          id?: string
          notes?: string | null
          platform_fee_treatment?: string
          provider_org_id: string
          service_agreement_id?: string | null
          status?: string
          subtotal_charge?: number
          target_margin_pct?: number
          title?: string
          total_charge?: number
          total_cost?: number
          updated_at?: string
          updated_by?: string | null
          valid_until?: string | null
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          client_name?: string | null
          client_org_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          discount_amount?: number
          discount_pct?: number
          gst_amount?: number
          gst_rate?: number
          id?: string
          notes?: string | null
          platform_fee_treatment?: string
          provider_org_id?: string
          service_agreement_id?: string | null
          status?: string
          subtotal_charge?: number
          target_margin_pct?: number
          title?: string
          total_charge?: number
          total_cost?: number
          updated_at?: string
          updated_by?: string | null
          valid_until?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quotes_accepted_by_fkey"
            columns: ["accepted_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "quotes_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_provider_org_id_fkey"
            columns: ["provider_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "quotes_provider_org_id_fkey"
            columns: ["provider_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_provider_org_id_fkey"
            columns: ["provider_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      radio_transcript_segments: {
        Row: {
          confidence: number | null
          created_at: string
          id: string
          is_final: boolean
          organization_id: string
          sequence: number
          text: string
          transmission_id: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          id?: string
          is_final?: boolean
          organization_id: string
          sequence: number
          text: string
          transmission_id: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          id?: string
          is_final?: boolean
          organization_id?: string
          sequence?: number
          text?: string
          transmission_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "radio_transcript_segments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "radio_transcript_segments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "radio_transcript_segments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "radio_transcript_segments_transmission_id_fkey"
            columns: ["transmission_id"]
            isOneToOne: false
            referencedRelation: "ptt_transmissions"
            referencedColumns: ["id"]
          },
        ]
      }
      radio_translation_segments: {
        Row: {
          confidence: number | null
          created_at: string
          id: string
          organization_id: string
          provider: string | null
          target_language: string
          transcript_id: string
          translated_text: string
        }
        Insert: {
          confidence?: number | null
          created_at?: string
          id?: string
          organization_id: string
          provider?: string | null
          target_language: string
          transcript_id: string
          translated_text: string
        }
        Update: {
          confidence?: number | null
          created_at?: string
          id?: string
          organization_id?: string
          provider?: string | null
          target_language?: string
          transcript_id?: string
          translated_text?: string
        }
        Relationships: [
          {
            foreignKeyName: "radio_translation_segments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "radio_translation_segments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "radio_translation_segments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "radio_translation_segments_transcript_id_fkey"
            columns: ["transcript_id"]
            isOneToOne: false
            referencedRelation: "radio_transcript_segments"
            referencedColumns: ["id"]
          },
        ]
      }
      radio_voice_consents: {
        Row: {
          consented: boolean
          created_at: string
          id: string
          organization_id: string
          revoked_at: string | null
          user_id: string
        }
        Insert: {
          consented: boolean
          created_at?: string
          id?: string
          organization_id: string
          revoked_at?: string | null
          user_id: string
        }
        Update: {
          consented?: boolean
          created_at?: string
          id?: string
          organization_id?: string
          revoked_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "radio_voice_consents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "radio_voice_consents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "radio_voice_consents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "radio_voice_consents_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_rules: {
        Row: {
          active: boolean
          amount: number
          client_org_id: string | null
          created_at: string
          created_by: string | null
          day_category: string | null
          distance_max_km: number | null
          distance_min_km: number | null
          effective_from: string | null
          effective_to: string | null
          gl_account: string | null
          id: string
          job_code: string | null
          job_type: string | null
          module_key: string | null
          name: string
          organization_id: string
          outside_area: boolean | null
          pay_code: string | null
          priority: number
          rate_type: string
          region_code: string | null
          role_code: string | null
          rule_kind: string
          service_type: string | null
          site_id: string | null
          updated_at: string
          updated_by: string | null
          vehicle_type: string | null
          zone_id: string | null
        }
        Insert: {
          active?: boolean
          amount?: number
          client_org_id?: string | null
          created_at?: string
          created_by?: string | null
          day_category?: string | null
          distance_max_km?: number | null
          distance_min_km?: number | null
          effective_from?: string | null
          effective_to?: string | null
          gl_account?: string | null
          id?: string
          job_code?: string | null
          job_type?: string | null
          module_key?: string | null
          name: string
          organization_id: string
          outside_area?: boolean | null
          pay_code?: string | null
          priority?: number
          rate_type: string
          region_code?: string | null
          role_code?: string | null
          rule_kind: string
          service_type?: string | null
          site_id?: string | null
          updated_at?: string
          updated_by?: string | null
          vehicle_type?: string | null
          zone_id?: string | null
        }
        Update: {
          active?: boolean
          amount?: number
          client_org_id?: string | null
          created_at?: string
          created_by?: string | null
          day_category?: string | null
          distance_max_km?: number | null
          distance_min_km?: number | null
          effective_from?: string | null
          effective_to?: string | null
          gl_account?: string | null
          id?: string
          job_code?: string | null
          job_type?: string | null
          module_key?: string | null
          name?: string
          organization_id?: string
          outside_area?: boolean | null
          pay_code?: string | null
          priority?: number
          rate_type?: string
          region_code?: string | null
          role_code?: string | null
          rule_kind?: string
          service_type?: string | null
          site_id?: string | null
          updated_at?: string
          updated_by?: string | null
          vehicle_type?: string | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "rate_rules_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "rate_rules_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rate_rules_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rate_rules_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rate_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "rate_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rate_rules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rate_rules_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      reference_catalog_entries: {
        Row: {
          approval_status: string
          approved_at: string | null
          approved_by: string | null
          created_at: string
          document_type: string | null
          document_version_id: string
          id: string
          is_global_reference: boolean
          jurisdiction: string | null
          organization_id: string | null
          publisher: string | null
          searchable_tags: string[]
          title: string
          topic: string | null
          trust_level: string
          updated_at: string
        }
        Insert: {
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          document_type?: string | null
          document_version_id: string
          id?: string
          is_global_reference?: boolean
          jurisdiction?: string | null
          organization_id?: string | null
          publisher?: string | null
          searchable_tags?: string[]
          title: string
          topic?: string | null
          trust_level?: string
          updated_at?: string
        }
        Update: {
          approval_status?: string
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          document_type?: string | null
          document_version_id?: string
          id?: string
          is_global_reference?: boolean
          jurisdiction?: string | null
          organization_id?: string | null
          publisher?: string | null
          searchable_tags?: string[]
          title?: string
          topic?: string | null
          trust_level?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reference_catalog_entries_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reference_catalog_entries_document_version_id_fkey"
            columns: ["document_version_id"]
            isOneToOne: false
            referencedRelation: "document_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reference_catalog_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "reference_catalog_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reference_catalog_entries_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      reference_codes: {
        Row: {
          code: string
          code_type: string
          created_at: string
          created_by: string | null
          default_rate: number | null
          description: string | null
          external_refs: Json
          id: string
          is_active: boolean
          item_category: string | null
          name: string
          organization_id: string
          parent_code: string | null
          region_code: string | null
          service_type: string | null
          sort_order: number
          unit: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          code: string
          code_type: string
          created_at?: string
          created_by?: string | null
          default_rate?: number | null
          description?: string | null
          external_refs?: Json
          id?: string
          is_active?: boolean
          item_category?: string | null
          name: string
          organization_id: string
          parent_code?: string | null
          region_code?: string | null
          service_type?: string | null
          sort_order?: number
          unit?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          code?: string
          code_type?: string
          created_at?: string
          created_by?: string | null
          default_rate?: number | null
          description?: string | null
          external_refs?: Json
          id?: string
          is_active?: boolean
          item_category?: string | null
          name?: string
          organization_id?: string
          parent_code?: string | null
          region_code?: string | null
          service_type?: string | null
          sort_order?: number
          unit?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reference_codes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reference_codes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "reference_codes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reference_codes_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reference_codes_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      report_templates: {
        Row: {
          id: string
          module_key: string
          name: string
          organization_id: string
          output_policy: Json
          template_code: string
        }
        Insert: {
          id?: string
          module_key: string
          name: string
          organization_id: string
          output_policy?: Json
          template_code: string
        }
        Update: {
          id?: string
          module_key?: string
          name?: string
          organization_id?: string
          output_policy?: Json
          template_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "report_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "report_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "report_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      retention_policies: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          effective_from: string
          id: string
          is_active: boolean
          legal_basis: string | null
          module_key: string | null
          organization_id: string | null
          retention_days: number
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          created_by?: string | null
          effective_from?: string
          id?: string
          is_active?: boolean
          legal_basis?: string | null
          module_key?: string | null
          organization_id?: string | null
          retention_days: number
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          effective_from?: string
          id?: string
          is_active?: boolean
          legal_basis?: string | null
          module_key?: string | null
          organization_id?: string | null
          retention_days?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "retention_policies_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retention_policies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "retention_policies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "retention_policies_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      roster_assignments: {
        Row: {
          accepted_at: string | null
          assignment_status: string
          created_at: string
          created_by: string | null
          day_of_week: number | null
          decline_reason: string | null
          declined_at: string | null
          end_time: string | null
          external_refs: Json
          id: string
          notification_sent_at: string | null
          officer_id: string
          organization_id: string
          patrol_route_id: string | null
          roster_template_id: string | null
          service_type: string
          shift: string
          site_id: string | null
          specific_date: string | null
          start_time: string | null
          swapped_with_id: string | null
        }
        Insert: {
          accepted_at?: string | null
          assignment_status?: string
          created_at?: string
          created_by?: string | null
          day_of_week?: number | null
          decline_reason?: string | null
          declined_at?: string | null
          end_time?: string | null
          external_refs?: Json
          id?: string
          notification_sent_at?: string | null
          officer_id: string
          organization_id: string
          patrol_route_id?: string | null
          roster_template_id?: string | null
          service_type: string
          shift: string
          site_id?: string | null
          specific_date?: string | null
          start_time?: string | null
          swapped_with_id?: string | null
        }
        Update: {
          accepted_at?: string | null
          assignment_status?: string
          created_at?: string
          created_by?: string | null
          day_of_week?: number | null
          decline_reason?: string | null
          declined_at?: string | null
          end_time?: string | null
          external_refs?: Json
          id?: string
          notification_sent_at?: string | null
          officer_id?: string
          organization_id?: string
          patrol_route_id?: string | null
          roster_template_id?: string | null
          service_type?: string
          shift?: string
          site_id?: string | null
          specific_date?: string | null
          start_time?: string | null
          swapped_with_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "roster_assignments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_assignments_officer_id_fkey"
            columns: ["officer_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "roster_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_assignments_patrol_route_id_fkey"
            columns: ["patrol_route_id"]
            isOneToOne: false
            referencedRelation: "patrol_routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_assignments_roster_template_id_fkey"
            columns: ["roster_template_id"]
            isOneToOne: false
            referencedRelation: "roster_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_assignments_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_assignments_swapped_with_id_fkey"
            columns: ["swapped_with_id"]
            isOneToOne: false
            referencedRelation: "roster_assignments"
            referencedColumns: ["id"]
          },
        ]
      }
      roster_templates: {
        Row: {
          created_at: string
          description: string | null
          effective_from: string | null
          effective_to: string | null
          id: string
          is_active: boolean
          name: string
          organization_id: string
          template_type: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          is_active?: boolean
          name: string
          organization_id: string
          template_type?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          is_active?: boolean
          name?: string
          organization_id?: string
          template_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "roster_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "roster_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "roster_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      scv_import_batches: {
        Row: {
          completed_at: string | null
          created_at: string
          error_summary: string | null
          file_name: string | null
          id: string
          imported_by: string | null
          inserted_rows: number
          invalid_rows: number
          organization_id: string | null
          skipped_rows: number
          source_name: string
          started_at: string | null
          status: string
          total_rows: number
          updated_at: string
          updated_rows: number
          valid_rows: number
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_summary?: string | null
          file_name?: string | null
          id?: string
          imported_by?: string | null
          inserted_rows?: number
          invalid_rows?: number
          organization_id?: string | null
          skipped_rows?: number
          source_name?: string
          started_at?: string | null
          status?: string
          total_rows?: number
          updated_at?: string
          updated_rows?: number
          valid_rows?: number
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_summary?: string | null
          file_name?: string | null
          id?: string
          imported_by?: string | null
          inserted_rows?: number
          invalid_rows?: number
          organization_id?: string | null
          skipped_rows?: number
          source_name?: string
          started_at?: string | null
          status?: string
          total_rows?: number
          updated_at?: string
          updated_rows?: number
          valid_rows?: number
        }
        Relationships: [
          {
            foreignKeyName: "scv_import_batches_imported_by_fkey"
            columns: ["imported_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scv_import_batches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "scv_import_batches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scv_import_batches_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      scv_import_rows: {
        Row: {
          batch_id: string
          certificate_number: string | null
          certificate_status: string | null
          created_at: string
          error_message: string | null
          expiry_date: string | null
          id: string
          issued_date: string | null
          normalized_plate: string | null
          raw_row: Json
          row_number: number
          row_status: string
          vehicle_make: string | null
          vehicle_model: string | null
          vehicle_year: number | null
        }
        Insert: {
          batch_id: string
          certificate_number?: string | null
          certificate_status?: string | null
          created_at?: string
          error_message?: string | null
          expiry_date?: string | null
          id?: string
          issued_date?: string | null
          normalized_plate?: string | null
          raw_row?: Json
          row_number: number
          row_status?: string
          vehicle_make?: string | null
          vehicle_model?: string | null
          vehicle_year?: number | null
        }
        Update: {
          batch_id?: string
          certificate_number?: string | null
          certificate_status?: string | null
          created_at?: string
          error_message?: string | null
          expiry_date?: string | null
          id?: string
          issued_date?: string | null
          normalized_plate?: string | null
          raw_row?: Json
          row_number?: number
          row_status?: string
          vehicle_make?: string | null
          vehicle_model?: string | null
          vehicle_year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "scv_import_rows_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "scv_import_batches"
            referencedColumns: ["id"]
          },
        ]
      }
      service_agreement_locations: {
        Row: {
          created_at: string
          created_by: string | null
          head_contractor_org_id: string | null
          id: string
          service_agreement_id: string
          share_actual_cost: boolean | null
          share_contract_price: boolean | null
          site_id: string | null
          standalone_scan_enabled: boolean
          status: string
          subcontract_attribution_mode: string
          updated_at: string
          zone_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          head_contractor_org_id?: string | null
          id?: string
          service_agreement_id: string
          share_actual_cost?: boolean | null
          share_contract_price?: boolean | null
          site_id?: string | null
          standalone_scan_enabled?: boolean
          status?: string
          subcontract_attribution_mode?: string
          updated_at?: string
          zone_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          head_contractor_org_id?: string | null
          id?: string
          service_agreement_id?: string
          share_actual_cost?: boolean | null
          share_contract_price?: boolean | null
          site_id?: string | null
          standalone_scan_enabled?: boolean
          status?: string
          subcontract_attribution_mode?: string
          updated_at?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_agreement_locations_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreement_locations_head_contractor_org_id_fkey"
            columns: ["head_contractor_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "service_agreement_locations_head_contractor_org_id_fkey"
            columns: ["head_contractor_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreement_locations_head_contractor_org_id_fkey"
            columns: ["head_contractor_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreement_locations_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreement_locations_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreement_locations_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      service_agreement_modules: {
        Row: {
          allows_auto_dispatch: boolean
          allows_client_submission: boolean
          billing_direction: string
          client_access_mode: string
          enabled: boolean
          id: string
          module_key: string
          service_agreement_id: string
          settings: Json
          sla_minutes: number | null
          standalone_scan_enabled: boolean
        }
        Insert: {
          allows_auto_dispatch?: boolean
          allows_client_submission?: boolean
          billing_direction?: string
          client_access_mode?: string
          enabled?: boolean
          id?: string
          module_key: string
          service_agreement_id: string
          settings?: Json
          sla_minutes?: number | null
          standalone_scan_enabled?: boolean
        }
        Update: {
          allows_auto_dispatch?: boolean
          allows_client_submission?: boolean
          billing_direction?: string
          client_access_mode?: string
          enabled?: boolean
          id?: string
          module_key?: string
          service_agreement_id?: string
          settings?: Json
          sla_minutes?: number | null
          standalone_scan_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "service_agreement_modules_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
        ]
      }
      service_agreements: {
        Row: {
          agreement_type: string
          allows_auto_dispatch: boolean
          allows_client_submission: boolean
          client_organization_id: string
          client_portal_access_mode: string | null
          client_portal_finance_enabled: boolean
          client_portal_reports_enabled: boolean
          created_at: string
          default_share_actual_cost: boolean
          default_share_contract_price: boolean
          enabled_modules: string[] | null
          ends_on: string | null
          external_refs: Json
          id: string
          invitation_status: string
          monthly_report_template_code: string | null
          name: string
          provider_organization_id: string
          starts_on: string | null
          visibility_policy: Json
        }
        Insert: {
          agreement_type?: string
          allows_auto_dispatch?: boolean
          allows_client_submission?: boolean
          client_organization_id: string
          client_portal_access_mode?: string | null
          client_portal_finance_enabled?: boolean
          client_portal_reports_enabled?: boolean
          created_at?: string
          default_share_actual_cost?: boolean
          default_share_contract_price?: boolean
          enabled_modules?: string[] | null
          ends_on?: string | null
          external_refs?: Json
          id?: string
          invitation_status?: string
          monthly_report_template_code?: string | null
          name: string
          provider_organization_id: string
          starts_on?: string | null
          visibility_policy?: Json
        }
        Update: {
          agreement_type?: string
          allows_auto_dispatch?: boolean
          allows_client_submission?: boolean
          client_organization_id?: string
          client_portal_access_mode?: string | null
          client_portal_finance_enabled?: boolean
          client_portal_reports_enabled?: boolean
          created_at?: string
          default_share_actual_cost?: boolean
          default_share_contract_price?: boolean
          enabled_modules?: string[] | null
          ends_on?: string | null
          external_refs?: Json
          id?: string
          invitation_status?: string
          monthly_report_template_code?: string | null
          name?: string
          provider_organization_id?: string
          starts_on?: string | null
          visibility_policy?: Json
        }
        Relationships: [
          {
            foreignKeyName: "service_agreements_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "service_agreements_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreements_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreements_provider_organization_id_fkey"
            columns: ["provider_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "service_agreements_provider_organization_id_fkey"
            columns: ["provider_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreements_provider_organization_id_fkey"
            columns: ["provider_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_coverage_requests: {
        Row: {
          claimed_at: string | null
          claimed_by: string | null
          created_at: string
          created_by: string
          end_time: string
          filled_at: string | null
          id: string
          notes: string | null
          organization_id: string
          patrol_route_id: string | null
          required_credentials: string[]
          required_staff_count: number
          shift_date: string
          shift_template_id: string | null
          site_id: string | null
          start_time: string
          status: string
          urgency: string
        }
        Insert: {
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          created_by: string
          end_time: string
          filled_at?: string | null
          id?: string
          notes?: string | null
          organization_id: string
          patrol_route_id?: string | null
          required_credentials?: string[]
          required_staff_count?: number
          shift_date: string
          shift_template_id?: string | null
          site_id?: string | null
          start_time: string
          status?: string
          urgency?: string
        }
        Update: {
          claimed_at?: string | null
          claimed_by?: string | null
          created_at?: string
          created_by?: string
          end_time?: string
          filled_at?: string | null
          id?: string
          notes?: string | null
          organization_id?: string
          patrol_route_id?: string | null
          required_credentials?: string[]
          required_staff_count?: number
          shift_date?: string
          shift_template_id?: string | null
          site_id?: string | null
          start_time?: string
          status?: string
          urgency?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_coverage_requests_claimed_by_fkey"
            columns: ["claimed_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_coverage_requests_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_coverage_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "shift_coverage_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_coverage_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_coverage_requests_patrol_route_id_fkey"
            columns: ["patrol_route_id"]
            isOneToOne: false
            referencedRelation: "patrol_routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_coverage_requests_shift_template_id_fkey"
            columns: ["shift_template_id"]
            isOneToOne: false
            referencedRelation: "shift_templates"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_coverage_requests_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_stop_actions: {
        Row: {
          action_type: string
          created_at: string
          gps_lat: number | null
          gps_lng: number | null
          id: string
          notes: string | null
          organization_id: string
          outcome: string | null
          performed_at: string
          result_record_id: string | null
          result_table: string | null
          shift_id: string
          shift_stop_id: string
          shift_stop_module_id: string | null
        }
        Insert: {
          action_type: string
          created_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          organization_id: string
          outcome?: string | null
          performed_at?: string
          result_record_id?: string | null
          result_table?: string | null
          shift_id: string
          shift_stop_id: string
          shift_stop_module_id?: string | null
        }
        Update: {
          action_type?: string
          created_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          organization_id?: string
          outcome?: string | null
          performed_at?: string
          result_record_id?: string | null
          result_table?: string | null
          shift_id?: string
          shift_stop_id?: string
          shift_stop_module_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shift_stop_actions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "shift_stop_actions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stop_actions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stop_actions_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stop_actions_shift_stop_id_fkey"
            columns: ["shift_stop_id"]
            isOneToOne: false
            referencedRelation: "shift_stops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stop_actions_shift_stop_module_id_fkey"
            columns: ["shift_stop_module_id"]
            isOneToOne: false
            referencedRelation: "shift_stop_modules"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_stop_modules: {
        Row: {
          completed_at: string | null
          created_at: string
          id: string
          is_required: boolean
          module_key: string
          organization_id: string
          outcome: string | null
          result_record_id: string | null
          result_table: string | null
          service_agreement_location_id: string | null
          service_agreement_module_id: string | null
          shift_stop_id: string
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          id?: string
          is_required?: boolean
          module_key: string
          organization_id: string
          outcome?: string | null
          result_record_id?: string | null
          result_table?: string | null
          service_agreement_location_id?: string | null
          service_agreement_module_id?: string | null
          shift_stop_id: string
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          id?: string
          is_required?: boolean
          module_key?: string
          organization_id?: string
          outcome?: string | null
          result_record_id?: string | null
          result_table?: string | null
          service_agreement_location_id?: string | null
          service_agreement_module_id?: string | null
          shift_stop_id?: string
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_stop_modules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "shift_stop_modules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stop_modules_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stop_modules_service_agreement_location_id_fkey"
            columns: ["service_agreement_location_id"]
            isOneToOne: false
            referencedRelation: "location_visibility_for_viewer"
            referencedColumns: ["sal_id"]
          },
          {
            foreignKeyName: "shift_stop_modules_service_agreement_location_id_fkey"
            columns: ["service_agreement_location_id"]
            isOneToOne: false
            referencedRelation: "service_agreement_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stop_modules_service_agreement_module_id_fkey"
            columns: ["service_agreement_module_id"]
            isOneToOne: false
            referencedRelation: "service_agreement_modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stop_modules_shift_stop_id_fkey"
            columns: ["shift_stop_id"]
            isOneToOne: false
            referencedRelation: "shift_stops"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_stops: {
        Row: {
          actual_arrived_at: string | null
          actual_departed_at: string | null
          arrived_gps_lat: number | null
          arrived_gps_lng: number | null
          created_at: string
          dispatch_job_id: string | null
          estimated_arrival_at: string | null
          estimated_departure_at: string | null
          external_dispatch_id: string | null
          external_refs: Json
          id: string
          is_adhoc: boolean
          module_key: string
          officer_notes: string | null
          organization_id: string
          patrol_config_id: string | null
          required_dwell_minutes: number
          shift_id: string
          site_id: string | null
          sla_arrive_by: string
          sla_depart_by: string | null
          sla_status: string
          sla_window_open: string | null
          status: string
          stop_order: number
          travel_distance_metres: number | null
          travel_time_seconds: number | null
          updated_at: string
          visit_number: number
          zone_id: string | null
        }
        Insert: {
          actual_arrived_at?: string | null
          actual_departed_at?: string | null
          arrived_gps_lat?: number | null
          arrived_gps_lng?: number | null
          created_at?: string
          dispatch_job_id?: string | null
          estimated_arrival_at?: string | null
          estimated_departure_at?: string | null
          external_dispatch_id?: string | null
          external_refs?: Json
          id?: string
          is_adhoc?: boolean
          module_key: string
          officer_notes?: string | null
          organization_id: string
          patrol_config_id?: string | null
          required_dwell_minutes?: number
          shift_id: string
          site_id?: string | null
          sla_arrive_by: string
          sla_depart_by?: string | null
          sla_status?: string
          sla_window_open?: string | null
          status?: string
          stop_order?: number
          travel_distance_metres?: number | null
          travel_time_seconds?: number | null
          updated_at?: string
          visit_number?: number
          zone_id?: string | null
        }
        Update: {
          actual_arrived_at?: string | null
          actual_departed_at?: string | null
          arrived_gps_lat?: number | null
          arrived_gps_lng?: number | null
          created_at?: string
          dispatch_job_id?: string | null
          estimated_arrival_at?: string | null
          estimated_departure_at?: string | null
          external_dispatch_id?: string | null
          external_refs?: Json
          id?: string
          is_adhoc?: boolean
          module_key?: string
          officer_notes?: string | null
          organization_id?: string
          patrol_config_id?: string | null
          required_dwell_minutes?: number
          shift_id?: string
          site_id?: string | null
          sla_arrive_by?: string
          sla_depart_by?: string | null
          sla_status?: string
          sla_window_open?: string | null
          status?: string
          stop_order?: number
          travel_distance_metres?: number | null
          travel_time_seconds?: number | null
          updated_at?: string
          visit_number?: number
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shift_stops_dispatch_job_id_fkey"
            columns: ["dispatch_job_id"]
            isOneToOne: false
            referencedRelation: "dispatch_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stops_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "shift_stops_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stops_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stops_patrol_config_id_fkey"
            columns: ["patrol_config_id"]
            isOneToOne: false
            referencedRelation: "client_site_patrol_config"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stops_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stops_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_stops_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_swaps: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          completed_at: string | null
          created_at: string
          declined_reason: string | null
          id: string
          organization_id: string
          original_shift_id: string
          original_staff_id: string
          reason: string | null
          requested_at: string
          requested_by: string
          status: string
          swap_type: string
          swap_with_staff_id: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          completed_at?: string | null
          created_at?: string
          declined_reason?: string | null
          id?: string
          organization_id: string
          original_shift_id: string
          original_staff_id: string
          reason?: string | null
          requested_at?: string
          requested_by: string
          status?: string
          swap_type?: string
          swap_with_staff_id?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          completed_at?: string | null
          created_at?: string
          declined_reason?: string | null
          id?: string
          organization_id?: string
          original_shift_id?: string
          original_staff_id?: string
          reason?: string | null
          requested_at?: string
          requested_by?: string
          status?: string
          swap_type?: string
          swap_with_staff_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shift_swaps_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_swaps_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "shift_swaps_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_swaps_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_swaps_original_staff_id_fkey"
            columns: ["original_staff_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_swaps_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_swaps_swap_with_staff_id_fkey"
            columns: ["swap_with_staff_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      shift_templates: {
        Row: {
          active_days: number[]
          color: string | null
          created_at: string
          created_by: string | null
          description: string | null
          effective_from: string | null
          effective_to: string | null
          end_time: string
          id: string
          is_active: boolean
          name: string
          notes: string | null
          organization_id: string
          patrol_route_id: string | null
          recurrence_type: string
          required_credentials: string[]
          required_staff_count: number
          shift_type: string
          site_id: string | null
          start_time: string
        }
        Insert: {
          active_days?: number[]
          color?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          effective_from?: string | null
          effective_to?: string | null
          end_time: string
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          organization_id: string
          patrol_route_id?: string | null
          recurrence_type?: string
          required_credentials?: string[]
          required_staff_count?: number
          shift_type: string
          site_id?: string | null
          start_time: string
        }
        Update: {
          active_days?: number[]
          color?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          effective_from?: string | null
          effective_to?: string | null
          end_time?: string
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          organization_id?: string
          patrol_route_id?: string | null
          recurrence_type?: string
          required_credentials?: string[]
          required_staff_count?: number
          shift_type?: string
          site_id?: string | null
          start_time?: string
        }
        Relationships: [
          {
            foreignKeyName: "shift_templates_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "shift_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_templates_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_templates_patrol_route_id_fkey"
            columns: ["patrol_route_id"]
            isOneToOne: false
            referencedRelation: "patrol_routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shift_templates_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      shifts: {
        Row: {
          actual_end: string | null
          actual_start: string | null
          completed_stops: number
          created_at: string
          external_refs: Json
          generated_at: string | null
          id: string
          location_id: string | null
          notes: string | null
          officer_user_id: string
          organization_id: string
          osrm_matrix_cached_at: string | null
          patrol_route_id: string | null
          scheduled_end: string
          scheduled_start: string
          service_type: string
          shift_health: string | null
          status: string
          total_stops: number
          zone_id: string | null
        }
        Insert: {
          actual_end?: string | null
          actual_start?: string | null
          completed_stops?: number
          created_at?: string
          external_refs?: Json
          generated_at?: string | null
          id?: string
          location_id?: string | null
          notes?: string | null
          officer_user_id: string
          organization_id: string
          osrm_matrix_cached_at?: string | null
          patrol_route_id?: string | null
          scheduled_end: string
          scheduled_start: string
          service_type: string
          shift_health?: string | null
          status?: string
          total_stops?: number
          zone_id?: string | null
        }
        Update: {
          actual_end?: string | null
          actual_start?: string | null
          completed_stops?: number
          created_at?: string
          external_refs?: Json
          generated_at?: string | null
          id?: string
          location_id?: string | null
          notes?: string | null
          officer_user_id?: string
          organization_id?: string
          osrm_matrix_cached_at?: string | null
          patrol_route_id?: string | null
          scheduled_end?: string
          scheduled_start?: string
          service_type?: string
          shift_health?: string | null
          status?: string
          total_stops?: number
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shifts_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "shifts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_patrol_route_id_fkey"
            columns: ["patrol_route_id"]
            isOneToOne: false
            referencedRelation: "patrol_routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shifts_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      site_financial_config: {
        Row: {
          active: boolean
          billing_cycle: string
          billing_model: string
          callout_rate: number | null
          created_at: string
          flat_rate_monthly: number | null
          gst_rate: number
          gst_registered: boolean
          hourly_rate: number | null
          id: string
          invoice_email: string | null
          minimum_hours: number | null
          notes: string | null
          organization_id: string
          payment_terms_days: number
          per_notice_rate: number | null
          per_visit_rate: number | null
          purchase_order_number: string | null
          service_agreement_id: string | null
          site_id: string
          updated_at: string
          zone_id: string | null
        }
        Insert: {
          active?: boolean
          billing_cycle?: string
          billing_model?: string
          callout_rate?: number | null
          created_at?: string
          flat_rate_monthly?: number | null
          gst_rate?: number
          gst_registered?: boolean
          hourly_rate?: number | null
          id?: string
          invoice_email?: string | null
          minimum_hours?: number | null
          notes?: string | null
          organization_id: string
          payment_terms_days?: number
          per_notice_rate?: number | null
          per_visit_rate?: number | null
          purchase_order_number?: string | null
          service_agreement_id?: string | null
          site_id: string
          updated_at?: string
          zone_id?: string | null
        }
        Update: {
          active?: boolean
          billing_cycle?: string
          billing_model?: string
          callout_rate?: number | null
          created_at?: string
          flat_rate_monthly?: number | null
          gst_rate?: number
          gst_registered?: boolean
          hourly_rate?: number | null
          id?: string
          invoice_email?: string | null
          minimum_hours?: number | null
          notes?: string | null
          organization_id?: string
          payment_terms_days?: number
          per_notice_rate?: number | null
          per_visit_rate?: number | null
          purchase_order_number?: string | null
          service_agreement_id?: string | null
          site_id?: string
          updated_at?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "site_financial_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "site_financial_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_financial_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_financial_config_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_financial_config_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_financial_config_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      site_services: {
        Row: {
          active: boolean
          config: Json
          created_at: string
          created_by: string | null
          enabled: boolean
          id: string
          module_key: string
          organization_id: string
          response_sla_minutes: number | null
          service_agreement_id: string | null
          service_hours: Json
          site_id: string | null
          special_instructions: string | null
          zone_id: string | null
        }
        Insert: {
          active?: boolean
          config?: Json
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          module_key: string
          organization_id: string
          response_sla_minutes?: number | null
          service_agreement_id?: string | null
          service_hours?: Json
          site_id?: string | null
          special_instructions?: string | null
          zone_id?: string | null
        }
        Update: {
          active?: boolean
          config?: Json
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          module_key?: string
          organization_id?: string
          response_sla_minutes?: number | null
          service_agreement_id?: string | null
          service_hours?: Json
          site_id?: string | null
          special_instructions?: string | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "site_services_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_services_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "site_services_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_services_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_services_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_services_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "site_services_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      sla_clocks: {
        Row: {
          alarm_event_id: string | null
          arrived_at: string | null
          created_at: string
          dispatch_job_id: string | null
          elapsed_minutes: number | null
          id: string
          notes: string | null
          obligation_id: string | null
          organization_id: string
          service_agreement_id: string | null
          site_id: string | null
          started_at: string
          status: string
          target_minutes: number | null
          updated_at: string
        }
        Insert: {
          alarm_event_id?: string | null
          arrived_at?: string | null
          created_at?: string
          dispatch_job_id?: string | null
          elapsed_minutes?: number | null
          id?: string
          notes?: string | null
          obligation_id?: string | null
          organization_id: string
          service_agreement_id?: string | null
          site_id?: string | null
          started_at?: string
          status?: string
          target_minutes?: number | null
          updated_at?: string
        }
        Update: {
          alarm_event_id?: string | null
          arrived_at?: string | null
          created_at?: string
          dispatch_job_id?: string | null
          elapsed_minutes?: number | null
          id?: string
          notes?: string | null
          obligation_id?: string | null
          organization_id?: string
          service_agreement_id?: string | null
          site_id?: string | null
          started_at?: string
          status?: string
          target_minutes?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sla_clocks_alarm_event_id_fkey"
            columns: ["alarm_event_id"]
            isOneToOne: false
            referencedRelation: "alarm_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sla_clocks_dispatch_job_id_fkey"
            columns: ["dispatch_job_id"]
            isOneToOne: false
            referencedRelation: "dispatch_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sla_clocks_obligation_id_fkey"
            columns: ["obligation_id"]
            isOneToOne: false
            referencedRelation: "agreement_obligations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sla_clocks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "sla_clocks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sla_clocks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sla_clocks_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sla_clocks_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      sla_discount_bands: {
        Row: {
          created_at: string
          discount_pct: number
          id: string
          organization_id: string
          over_by_minutes_max: number | null
          over_by_minutes_min: number
          service_type: string | null
        }
        Insert: {
          created_at?: string
          discount_pct: number
          id?: string
          organization_id: string
          over_by_minutes_max?: number | null
          over_by_minutes_min: number
          service_type?: string | null
        }
        Update: {
          created_at?: string
          discount_pct?: number
          id?: string
          organization_id?: string
          over_by_minutes_max?: number | null
          over_by_minutes_min?: number
          service_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sla_discount_bands_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "sla_discount_bands_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sla_discount_bands_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      smoke_assessments: {
        Row: {
          action: string | null
          action_taken: string | null
          address: string | null
          assessed_at: string
          bob_classification: string | null
          bob_confidence: number | null
          bob_recommendation: string | null
          checklist: Json
          complainant_site_id: string | null
          complaint_address: string | null
          complaint_source: string | null
          created_at: string
          dispatch_job_id: string | null
          follow_up_required: boolean
          id: string
          is_out_of_hours: boolean
          legal_basis: string | null
          location_id: string | null
          notes: string | null
          notice_number: string | null
          officer_id: string | null
          officer_name: string | null
          officer_user_id: string | null
          organization_id: string
          photo_urls: Json | null
          scene_description: string | null
          severity: string | null
          site_id: string | null
          smoke_source: string | null
          smoke_source_type: string | null
          source_confirmed: boolean
          status: string
        }
        Insert: {
          action?: string | null
          action_taken?: string | null
          address?: string | null
          assessed_at?: string
          bob_classification?: string | null
          bob_confidence?: number | null
          bob_recommendation?: string | null
          checklist?: Json
          complainant_site_id?: string | null
          complaint_address?: string | null
          complaint_source?: string | null
          created_at?: string
          dispatch_job_id?: string | null
          follow_up_required?: boolean
          id?: string
          is_out_of_hours?: boolean
          legal_basis?: string | null
          location_id?: string | null
          notes?: string | null
          notice_number?: string | null
          officer_id?: string | null
          officer_name?: string | null
          officer_user_id?: string | null
          organization_id: string
          photo_urls?: Json | null
          scene_description?: string | null
          severity?: string | null
          site_id?: string | null
          smoke_source?: string | null
          smoke_source_type?: string | null
          source_confirmed?: boolean
          status?: string
        }
        Update: {
          action?: string | null
          action_taken?: string | null
          address?: string | null
          assessed_at?: string
          bob_classification?: string | null
          bob_confidence?: number | null
          bob_recommendation?: string | null
          checklist?: Json
          complainant_site_id?: string | null
          complaint_address?: string | null
          complaint_source?: string | null
          created_at?: string
          dispatch_job_id?: string | null
          follow_up_required?: boolean
          id?: string
          is_out_of_hours?: boolean
          legal_basis?: string | null
          location_id?: string | null
          notes?: string | null
          notice_number?: string | null
          officer_id?: string | null
          officer_name?: string | null
          officer_user_id?: string | null
          organization_id?: string
          photo_urls?: Json | null
          scene_description?: string | null
          severity?: string | null
          site_id?: string | null
          smoke_source?: string | null
          smoke_source_type?: string | null
          source_confirmed?: boolean
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "smoke_assessments_complainant_site_id_fkey"
            columns: ["complainant_site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "smoke_assessments_dispatch_job_id_fkey"
            columns: ["dispatch_job_id"]
            isOneToOne: false
            referencedRelation: "dispatch_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "smoke_assessments_officer_id_fkey"
            columns: ["officer_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "smoke_assessments_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "smoke_assessments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "smoke_assessments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "smoke_assessments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "smoke_assessments_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
        ]
      }
      spatial_ref_sys: {
        Row: {
          auth_name: string | null
          auth_srid: number | null
          proj4text: string | null
          srid: number
          srtext: string | null
        }
        Insert: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid: number
          srtext?: string | null
        }
        Update: {
          auth_name?: string | null
          auth_srid?: number | null
          proj4text?: string | null
          srid?: number
          srtext?: string | null
        }
        Relationships: []
      }
      staff_area_grants: {
        Row: {
          area: string
          created_at: string
          granted_by: string | null
          id: string
          level: string
          scope_org_id: string
          source_preset: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          area: string
          created_at?: string
          granted_by?: string | null
          id?: string
          level?: string
          scope_org_id: string
          source_preset?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          area?: string
          created_at?: string
          granted_by?: string | null
          id?: string
          level?: string
          scope_org_id?: string
          source_preset?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_area_grants_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_area_grants_scope_org_id_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "staff_area_grants_scope_org_id_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_area_grants_scope_org_id_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_area_grants_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_availability: {
        Row: {
          all_day: boolean
          availability_type: string
          available_from: string | null
          available_to: string | null
          created_at: string
          day_of_week: number | null
          id: string
          notes: string | null
          organization_id: string
          specific_date: string | null
          staff_id: string
        }
        Insert: {
          all_day?: boolean
          availability_type?: string
          available_from?: string | null
          available_to?: string | null
          created_at?: string
          day_of_week?: number | null
          id?: string
          notes?: string | null
          organization_id: string
          specific_date?: string | null
          staff_id: string
        }
        Update: {
          all_day?: boolean
          availability_type?: string
          available_from?: string | null
          available_to?: string | null
          created_at?: string
          day_of_week?: number | null
          id?: string
          notes?: string | null
          organization_id?: string
          specific_date?: string | null
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_availability_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "staff_availability_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_availability_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_availability_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_biometrics: {
        Row: {
          active: boolean
          created_by: string | null
          credential_ref: string | null
          device_label: string | null
          enrolled_at: string
          face_embedding: Json | null
          id: string
          method: string
          organization_id: string
          user_id: string
        }
        Insert: {
          active?: boolean
          created_by?: string | null
          credential_ref?: string | null
          device_label?: string | null
          enrolled_at?: string
          face_embedding?: Json | null
          id?: string
          method: string
          organization_id: string
          user_id: string
        }
        Update: {
          active?: boolean
          created_by?: string | null
          credential_ref?: string | null
          device_label?: string | null
          enrolled_at?: string
          face_embedding?: Json | null
          id?: string
          method?: string
          organization_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_biometrics_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_biometrics_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "staff_biometrics_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_biometrics_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_biometrics_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_branch_authorisations: {
        Row: {
          authorised_by: string | null
          branch_org_id: string
          can_be_rostered: boolean
          created_at: string
          ends_on: string | null
          id: string
          module_access: string[]
          role_at_branch: string
          starts_on: string | null
          status: string
          user_id: string
        }
        Insert: {
          authorised_by?: string | null
          branch_org_id: string
          can_be_rostered?: boolean
          created_at?: string
          ends_on?: string | null
          id?: string
          module_access?: string[]
          role_at_branch?: string
          starts_on?: string | null
          status?: string
          user_id: string
        }
        Update: {
          authorised_by?: string | null
          branch_org_id?: string
          can_be_rostered?: boolean
          created_at?: string
          ends_on?: string | null
          id?: string
          module_access?: string[]
          role_at_branch?: string
          starts_on?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_branch_authorisations_authorised_by_fkey"
            columns: ["authorised_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_branch_authorisations_branch_org_id_fkey"
            columns: ["branch_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "staff_branch_authorisations_branch_org_id_fkey"
            columns: ["branch_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_branch_authorisations_branch_org_id_fkey"
            columns: ["branch_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_branch_authorisations_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_credentials: {
        Row: {
          authorized_activities: string[]
          created_at: string
          credential_number: string | null
          credential_type: string
          document_storage_path: string | null
          expiry_date: string | null
          id: string
          issued_date: string | null
          issuing_authority: string | null
          notes: string | null
          organization_id: string
          staff_id: string
          verified: boolean
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          authorized_activities?: string[]
          created_at?: string
          credential_number?: string | null
          credential_type: string
          document_storage_path?: string | null
          expiry_date?: string | null
          id?: string
          issued_date?: string | null
          issuing_authority?: string | null
          notes?: string | null
          organization_id: string
          staff_id: string
          verified?: boolean
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          authorized_activities?: string[]
          created_at?: string
          credential_number?: string | null
          credential_type?: string
          document_storage_path?: string | null
          expiry_date?: string | null
          id?: string
          issued_date?: string | null
          issuing_authority?: string | null
          notes?: string | null
          organization_id?: string
          staff_id?: string
          verified?: boolean
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_credentials_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "staff_credentials_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_credentials_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_credentials_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_credentials_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_documents: {
        Row: {
          created_at: string
          credential_id: string | null
          description: string | null
          document_type: string
          expiry_date: string | null
          file_name: string
          file_size_bytes: number | null
          id: string
          mime_type: string | null
          notes: string | null
          organization_id: string
          staff_id: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          credential_id?: string | null
          description?: string | null
          document_type: string
          expiry_date?: string | null
          file_name: string
          file_size_bytes?: number | null
          id?: string
          mime_type?: string | null
          notes?: string | null
          organization_id: string
          staff_id: string
          storage_path: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          credential_id?: string | null
          description?: string | null
          document_type?: string
          expiry_date?: string | null
          file_name?: string
          file_size_bytes?: number | null
          id?: string
          mime_type?: string | null
          notes?: string | null
          organization_id?: string
          staff_id?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_documents_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "staff_credentials"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "staff_documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_documents_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_documents_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_profiles: {
        Row: {
          bank_account: string | null
          created_at: string
          date_of_birth: string | null
          emergency_contact_name: string | null
          emergency_contact_phone: string | null
          emergency_contact_relation: string | null
          employee_number: string | null
          employment_type: string
          end_date: string | null
          external_refs: Json
          id: string
          notes: string | null
          organization_id: string
          payroll_id: string | null
          start_date: string | null
          tax_code: string | null
          uniform_size: string | null
          user_id: string | null
          work_ready: boolean
        }
        Insert: {
          bank_account?: string | null
          created_at?: string
          date_of_birth?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relation?: string | null
          employee_number?: string | null
          employment_type?: string
          end_date?: string | null
          external_refs?: Json
          id: string
          notes?: string | null
          organization_id: string
          payroll_id?: string | null
          start_date?: string | null
          tax_code?: string | null
          uniform_size?: string | null
          user_id?: string | null
          work_ready?: boolean
        }
        Update: {
          bank_account?: string | null
          created_at?: string
          date_of_birth?: string | null
          emergency_contact_name?: string | null
          emergency_contact_phone?: string | null
          emergency_contact_relation?: string | null
          employee_number?: string | null
          employment_type?: string
          end_date?: string | null
          external_refs?: Json
          id?: string
          notes?: string | null
          organization_id?: string
          payroll_id?: string | null
          start_date?: string | null
          tax_code?: string | null
          uniform_size?: string | null
          user_id?: string | null
          work_ready?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "staff_profiles_id_fkey"
            columns: ["id"]
            isOneToOne: true
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "staff_profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_profiles_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_reporting: {
        Row: {
          created_at: string
          effective_from: string
          effective_to: string | null
          id: string
          notes: string | null
          relationship_type: string
          reports_to_user_id: string
          scope_org_id: string
          set_at: string
          set_by: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          notes?: string | null
          relationship_type?: string
          reports_to_user_id: string
          scope_org_id: string
          set_at?: string
          set_by?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          effective_from?: string
          effective_to?: string | null
          id?: string
          notes?: string | null
          relationship_type?: string
          reports_to_user_id?: string
          scope_org_id?: string
          set_at?: string
          set_by?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_reporting_reports_to_user_id_fkey"
            columns: ["reports_to_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_reporting_scope_org_id_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "staff_reporting_scope_org_id_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_reporting_scope_org_id_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_reporting_set_by_fkey"
            columns: ["set_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_reporting_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_skills: {
        Row: {
          certification_expiry: string | null
          certified: boolean
          created_at: string
          id: string
          notes: string | null
          organization_id: string
          proficiency_level: string | null
          skill_category: string | null
          skill_name: string
          staff_id: string
        }
        Insert: {
          certification_expiry?: string | null
          certified?: boolean
          created_at?: string
          id?: string
          notes?: string | null
          organization_id: string
          proficiency_level?: string | null
          skill_category?: string | null
          skill_name: string
          staff_id: string
        }
        Update: {
          certification_expiry?: string | null
          certified?: boolean
          created_at?: string
          id?: string
          notes?: string | null
          organization_id?: string
          proficiency_level?: string | null
          skill_category?: string | null
          skill_name?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_skills_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "staff_skills_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_skills_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_skills_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_training_records: {
        Row: {
          completed_date: string
          created_at: string
          expiry_date: string | null
          id: string
          notes: string | null
          officer_id: string | null
          organization_id: string
          passed: boolean | null
          provider: string | null
          recorded_by: string | null
          score: number | null
          staff_id: string | null
          training_name: string
          training_type: string
        }
        Insert: {
          completed_date: string
          created_at?: string
          expiry_date?: string | null
          id?: string
          notes?: string | null
          officer_id?: string | null
          organization_id: string
          passed?: boolean | null
          provider?: string | null
          recorded_by?: string | null
          score?: number | null
          staff_id?: string | null
          training_name: string
          training_type?: string
        }
        Update: {
          completed_date?: string
          created_at?: string
          expiry_date?: string | null
          id?: string
          notes?: string | null
          officer_id?: string | null
          organization_id?: string
          passed?: boolean | null
          provider?: string | null
          recorded_by?: string | null
          score?: number | null
          staff_id?: string | null
          training_name?: string
          training_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_training_records_officer_id_fkey"
            columns: ["officer_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_training_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "staff_training_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_training_records_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_training_records_recorded_by_fkey"
            columns: ["recorded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_training_records_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      task_assignments: {
        Row: {
          basis: string
          biosecurity_assessment_id: string | null
          created_at: string
          end_reason: string | null
          ended_at: string | null
          enforcement_case_id: string | null
          granted_by: string | null
          id: string
          incident_id: string | null
          noise_assessment_id: string | null
          notes: string | null
          notice_id: string | null
          observation_id: string | null
          organization_id: string
          smoke_assessment_id: string | null
          started_at: string
          updated_at: string
          user_id: string
        }
        Insert: {
          basis: string
          biosecurity_assessment_id?: string | null
          created_at?: string
          end_reason?: string | null
          ended_at?: string | null
          enforcement_case_id?: string | null
          granted_by?: string | null
          id?: string
          incident_id?: string | null
          noise_assessment_id?: string | null
          notes?: string | null
          notice_id?: string | null
          observation_id?: string | null
          organization_id: string
          smoke_assessment_id?: string | null
          started_at?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          basis?: string
          biosecurity_assessment_id?: string | null
          created_at?: string
          end_reason?: string | null
          ended_at?: string | null
          enforcement_case_id?: string | null
          granted_by?: string | null
          id?: string
          incident_id?: string | null
          noise_assessment_id?: string | null
          notes?: string | null
          notice_id?: string | null
          observation_id?: string | null
          organization_id?: string
          smoke_assessment_id?: string | null
          started_at?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "task_assignments_biosecurity_assessment_id_fkey"
            columns: ["biosecurity_assessment_id"]
            isOneToOne: false
            referencedRelation: "biosecurity_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignments_enforcement_case_id_fkey"
            columns: ["enforcement_case_id"]
            isOneToOne: false
            referencedRelation: "enforcement_cases"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignments_granted_by_fkey"
            columns: ["granted_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignments_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignments_noise_assessment_id_fkey"
            columns: ["noise_assessment_id"]
            isOneToOne: false
            referencedRelation: "noise_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignments_notice_id_fkey"
            columns: ["notice_id"]
            isOneToOne: false
            referencedRelation: "notices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignments_observation_id_fkey"
            columns: ["observation_id"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "task_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignments_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignments_smoke_assessment_id_fkey"
            columns: ["smoke_assessment_id"]
            isOneToOne: false
            referencedRelation: "smoke_assessments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "task_assignments_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      team_members: {
        Row: {
          added_by: string | null
          id: string
          joined_at: string
          left_at: string | null
          role_in_team: string
          team_id: string
          user_id: string
        }
        Insert: {
          added_by?: string | null
          id?: string
          joined_at?: string
          left_at?: string | null
          role_in_team?: string
          team_id: string
          user_id: string
        }
        Update: {
          added_by?: string | null
          id?: string
          joined_at?: string
          left_at?: string | null
          role_in_team?: string
          team_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "team_members_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_members_team_id_fkey"
            columns: ["team_id"]
            isOneToOne: false
            referencedRelation: "teams"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "team_members_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      teams: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          name: string
          organization_id: string
          scope_org_id: string | null
          status: string
          team_lead_user_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          organization_id: string
          scope_org_id?: string | null
          status?: string
          team_lead_user_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          organization_id?: string
          scope_org_id?: string | null
          status?: string
          team_lead_user_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "teams_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "teams_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_scope_org_id_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "teams_scope_org_id_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_scope_org_id_fkey"
            columns: ["scope_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "teams_team_lead_user_id_fkey"
            columns: ["team_lead_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tender_documents: {
        Row: {
          created_at: string
          document_name: string
          document_type: string | null
          id: string
          storage_path: string
          tender_id: string
          uploaded_by: string | null
        }
        Insert: {
          created_at?: string
          document_name: string
          document_type?: string | null
          id?: string
          storage_path: string
          tender_id: string
          uploaded_by?: string | null
        }
        Update: {
          created_at?: string
          document_name?: string
          document_type?: string | null
          id?: string
          storage_path?: string
          tender_id?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tender_documents_tender_id_fkey"
            columns: ["tender_id"]
            isOneToOne: false
            referencedRelation: "tenders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tender_documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      tenders: {
        Row: {
          client_organization_id: string | null
          created_at: string
          created_by: string | null
          currency: string
          due_date: string | null
          estimated_value: number | null
          id: string
          lead_author_id: string | null
          notes: string | null
          organization_id: string
          service_type: string | null
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          client_organization_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          due_date?: string | null
          estimated_value?: number | null
          id?: string
          lead_author_id?: string | null
          notes?: string | null
          organization_id: string
          service_type?: string | null
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          client_organization_id?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          due_date?: string | null
          estimated_value?: number | null
          id?: string
          lead_author_id?: string | null
          notes?: string | null
          organization_id?: string
          service_type?: string | null
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenders_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "tenders_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenders_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenders_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenders_lead_author_id_fkey"
            columns: ["lead_author_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenders_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "tenders_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenders_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      timesheets: {
        Row: {
          actual_hours: number | null
          approved_at: string | null
          approved_by: string | null
          created_at: string
          id: string
          notes: string | null
          organization_id: string
          overtime_hours: number
          payroll_export_batch_id: string | null
          period_end: string
          period_start: string
          scheduled_hours: number | null
          shift_id: string | null
          staff_id: string
          status: string
          submitted_at: string | null
        }
        Insert: {
          actual_hours?: number | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          organization_id: string
          overtime_hours?: number
          payroll_export_batch_id?: string | null
          period_end: string
          period_start: string
          scheduled_hours?: number | null
          shift_id?: string | null
          staff_id: string
          status?: string
          submitted_at?: string | null
        }
        Update: {
          actual_hours?: number | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          organization_id?: string
          overtime_hours?: number
          payroll_export_batch_id?: string | null
          period_end?: string
          period_start?: string
          scheduled_hours?: number | null
          shift_id?: string | null
          staff_id?: string
          status?: string
          submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "timesheets_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timesheets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "timesheets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timesheets_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timesheets_payroll_export_batch_fk"
            columns: ["payroll_export_batch_id"]
            isOneToOne: false
            referencedRelation: "payroll_export_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timesheets_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "timesheets_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      travel_allowances: {
        Row: {
          callout_shift_id: string | null
          created_at: string
          distance_km: number | null
          duration_minutes: number | null
          id: string
          journey_type: string
          officer_user_id: string
          organization_id: string
          outside_jurisdiction: boolean
          rate_per_km: number | null
          time_rate: number | null
        }
        Insert: {
          callout_shift_id?: string | null
          created_at?: string
          distance_km?: number | null
          duration_minutes?: number | null
          id?: string
          journey_type: string
          officer_user_id: string
          organization_id: string
          outside_jurisdiction?: boolean
          rate_per_km?: number | null
          time_rate?: number | null
        }
        Update: {
          callout_shift_id?: string | null
          created_at?: string
          distance_km?: number | null
          duration_minutes?: number | null
          id?: string
          journey_type?: string
          officer_user_id?: string
          organization_id?: string
          outside_jurisdiction?: boolean
          rate_per_km?: number | null
          time_rate?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "travel_allowances_callout_shift_id_fkey"
            columns: ["callout_shift_id"]
            isOneToOne: false
            referencedRelation: "callout_shifts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "travel_allowances_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "travel_allowances_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "travel_allowances_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "travel_allowances_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      user_management_audit: {
        Row: {
          action_type: string
          created_at: string
          id: string
          metadata: Json | null
          new_value: Json | null
          old_value: Json | null
          performed_by: string
          target_user_id: string
        }
        Insert: {
          action_type: string
          created_at?: string
          id?: string
          metadata?: Json | null
          new_value?: Json | null
          old_value?: Json | null
          performed_by: string
          target_user_id: string
        }
        Update: {
          action_type?: string
          created_at?: string
          id?: string
          metadata?: Json | null
          new_value?: Json | null
          old_value?: Json | null
          performed_by?: string
          target_user_id?: string
        }
        Relationships: []
      }
      user_profiles: {
        Row: {
          address: string | null
          authorized_organization_ids: string[]
          created_at: string
          deactivated_at: string | null
          deactivated_by: string | null
          display_name: string | null
          email: string | null
          employer_organization_id: string | null
          id: string
          module_access: string[]
          organization_id: string
          phone: string | null
          photo_url: string | null
          role: string
        }
        Insert: {
          address?: string | null
          authorized_organization_ids?: string[]
          created_at?: string
          deactivated_at?: string | null
          deactivated_by?: string | null
          display_name?: string | null
          email?: string | null
          employer_organization_id?: string | null
          id: string
          module_access?: string[]
          organization_id: string
          phone?: string | null
          photo_url?: string | null
          role: string
        }
        Update: {
          address?: string | null
          authorized_organization_ids?: string[]
          created_at?: string
          deactivated_at?: string | null
          deactivated_by?: string | null
          display_name?: string | null
          email?: string | null
          employer_organization_id?: string | null
          id?: string
          module_access?: string[]
          organization_id?: string
          phone?: string | null
          photo_url?: string | null
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_profiles_employer_organization_id_fkey"
            columns: ["employer_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "user_profiles_employer_organization_id_fkey"
            columns: ["employer_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_profiles_employer_organization_id_fkey"
            columns: ["employer_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "user_profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_profiles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_observations: {
        Row: {
          compliance_detail: Json
          compliance_status: string | null
          created_at: string
          gps_lat: number | null
          gps_lng: number | null
          id: string
          is_offline_queued: boolean
          location_id: string | null
          module_key: string
          movement_result: string | null
          observed_at: string
          officer_user_id: string | null
          organization_id: string
          patrol_id: string | null
          plate_confidence: number | null
          plate_raw: string
          previous_observation_id: string | null
          primary_evidence_id: string | null
          shift_id: string | null
          synced_at: string | null
          vehicle_id: string | null
          zone_id: string | null
        }
        Insert: {
          compliance_detail?: Json
          compliance_status?: string | null
          created_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          is_offline_queued?: boolean
          location_id?: string | null
          module_key: string
          movement_result?: string | null
          observed_at?: string
          officer_user_id?: string | null
          organization_id: string
          patrol_id?: string | null
          plate_confidence?: number | null
          plate_raw: string
          previous_observation_id?: string | null
          primary_evidence_id?: string | null
          shift_id?: string | null
          synced_at?: string | null
          vehicle_id?: string | null
          zone_id?: string | null
        }
        Update: {
          compliance_detail?: Json
          compliance_status?: string | null
          created_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          is_offline_queued?: boolean
          location_id?: string | null
          module_key?: string
          movement_result?: string | null
          observed_at?: string
          officer_user_id?: string | null
          organization_id?: string
          patrol_id?: string | null
          plate_confidence?: number | null
          plate_raw?: string
          previous_observation_id?: string | null
          primary_evidence_id?: string | null
          shift_id?: string | null
          synced_at?: string | null
          vehicle_id?: string | null
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_observations_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_observations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "vehicle_observations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_observations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_observations_previous_observation_id_fkey"
            columns: ["previous_observation_id"]
            isOneToOne: false
            referencedRelation: "vehicle_observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_observations_primary_evidence_id_fkey"
            columns: ["primary_evidence_id"]
            isOneToOne: false
            referencedRelation: "evidence_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_observations_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicle_overnight_sessions: {
        Row: {
          breach_alert_id: string | null
          client_org_id: string | null
          compliance_reason: string | null
          created_at: string
          evening_gps_lat: number | null
          evening_gps_lng: number | null
          evening_observation_id: string | null
          evening_photo_url: string | null
          evening_seen_at: string | null
          evidence_strength: string
          gps_distance_meters: number | null
          id: string
          is_compliant: boolean | null
          is_scv: boolean | null
          location_id: string | null
          manual_review_required: boolean
          morning_gps_lat: number | null
          morning_gps_lng: number | null
          morning_observation_id: string | null
          morning_photo_url: string | null
          morning_seen_at: string | null
          movement_decision: string | null
          movement_similarity: number | null
          observation_count: number
          organization_id: string
          overnight_date: string
          plate_number: string
          same_position_confidence: number | null
          site_id: string | null
          timezone: string
          updated_at: string
          verification_status: string
          zone_id: string | null
        }
        Insert: {
          breach_alert_id?: string | null
          client_org_id?: string | null
          compliance_reason?: string | null
          created_at?: string
          evening_gps_lat?: number | null
          evening_gps_lng?: number | null
          evening_observation_id?: string | null
          evening_photo_url?: string | null
          evening_seen_at?: string | null
          evidence_strength?: string
          gps_distance_meters?: number | null
          id?: string
          is_compliant?: boolean | null
          is_scv?: boolean | null
          location_id?: string | null
          manual_review_required?: boolean
          morning_gps_lat?: number | null
          morning_gps_lng?: number | null
          morning_observation_id?: string | null
          morning_photo_url?: string | null
          morning_seen_at?: string | null
          movement_decision?: string | null
          movement_similarity?: number | null
          observation_count?: number
          organization_id: string
          overnight_date: string
          plate_number: string
          same_position_confidence?: number | null
          site_id?: string | null
          timezone?: string
          updated_at?: string
          verification_status?: string
          zone_id?: string | null
        }
        Update: {
          breach_alert_id?: string | null
          client_org_id?: string | null
          compliance_reason?: string | null
          created_at?: string
          evening_gps_lat?: number | null
          evening_gps_lng?: number | null
          evening_observation_id?: string | null
          evening_photo_url?: string | null
          evening_seen_at?: string | null
          evidence_strength?: string
          gps_distance_meters?: number | null
          id?: string
          is_compliant?: boolean | null
          is_scv?: boolean | null
          location_id?: string | null
          manual_review_required?: boolean
          morning_gps_lat?: number | null
          morning_gps_lng?: number | null
          morning_observation_id?: string | null
          morning_photo_url?: string | null
          morning_seen_at?: string | null
          movement_decision?: string | null
          movement_similarity?: number | null
          observation_count?: number
          organization_id?: string
          overnight_date?: string
          plate_number?: string
          same_position_confidence?: number | null
          site_id?: string | null
          timezone?: string
          updated_at?: string
          verification_status?: string
          zone_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_overnight_sessions_breach_alert_id_fkey"
            columns: ["breach_alert_id"]
            isOneToOne: false
            referencedRelation: "breach_alerts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_overnight_sessions_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "vehicle_overnight_sessions_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_overnight_sessions_client_org_id_fkey"
            columns: ["client_org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_overnight_sessions_evening_observation_id_fkey"
            columns: ["evening_observation_id"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_overnight_sessions_morning_observation_id_fkey"
            columns: ["morning_observation_id"]
            isOneToOne: false
            referencedRelation: "observations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_overnight_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "vehicle_overnight_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_overnight_sessions_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_overnight_sessions_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_overnight_sessions_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      vehicles: {
        Row: {
          colour: string | null
          colour_confidence: number | null
          created_at: string
          flag_reason: string | null
          id: string
          is_flagged: boolean
          make: string | null
          make_confidence: number | null
          model: string | null
          model_confidence: number | null
          organization_id: string
          plate: string
          scv_checked_at: string | null
          scv_expiry: string | null
          scv_status: string | null
          updated_at: string
          year: number | null
        }
        Insert: {
          colour?: string | null
          colour_confidence?: number | null
          created_at?: string
          flag_reason?: string | null
          id?: string
          is_flagged?: boolean
          make?: string | null
          make_confidence?: number | null
          model?: string | null
          model_confidence?: number | null
          organization_id: string
          plate: string
          scv_checked_at?: string | null
          scv_expiry?: string | null
          scv_status?: string | null
          updated_at?: string
          year?: number | null
        }
        Update: {
          colour?: string | null
          colour_confidence?: number | null
          created_at?: string
          flag_reason?: string | null
          id?: string
          is_flagged?: boolean
          make?: string | null
          make_confidence?: number | null
          model?: string | null
          model_confidence?: number | null
          organization_id?: string
          plate?: string
          scv_checked_at?: string | null
          scv_expiry?: string | null
          scv_status?: string | null
          updated_at?: string
          year?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "vehicles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "vehicles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicles_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      welfare_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          acknowledgement_notes: string | null
          alert_type: string
          escalated_at: string | null
          escalation_level: number
          gps_accuracy: number | null
          gps_lat: number | null
          gps_lng: number | null
          id: string
          last_activity_at: string | null
          notes: string | null
          officer_phone: string | null
          officer_user_id: string
          organization_id: string
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          shift_id: string | null
          status: string
          triggered_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          acknowledgement_notes?: string | null
          alert_type: string
          escalated_at?: string | null
          escalation_level?: number
          gps_accuracy?: number | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          last_activity_at?: string | null
          notes?: string | null
          officer_phone?: string | null
          officer_user_id: string
          organization_id: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          shift_id?: string | null
          status?: string
          triggered_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          acknowledgement_notes?: string | null
          alert_type?: string
          escalated_at?: string | null
          escalation_level?: number
          gps_accuracy?: number | null
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          last_activity_at?: string | null
          notes?: string | null
          officer_phone?: string | null
          officer_user_id?: string
          organization_id?: string
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          shift_id?: string | null
          status?: string
          triggered_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "welfare_alerts_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "welfare_alerts_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "welfare_alerts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "welfare_alerts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "welfare_alerts_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "welfare_alerts_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "welfare_alerts_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      welfare_checks: {
        Row: {
          checked_in_at: string
          gps_lat: number | null
          gps_lng: number | null
          id: string
          notes: string | null
          officer_user_id: string
          organization_id: string
          shift_id: string | null
          status: string
        }
        Insert: {
          checked_in_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          officer_user_id: string
          organization_id: string
          shift_id?: string | null
          status: string
        }
        Update: {
          checked_in_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          officer_user_id?: string
          organization_id?: string
          shift_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "welfare_checks_officer_user_id_fkey"
            columns: ["officer_user_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "welfare_checks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "welfare_checks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "welfare_checks_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "welfare_checks_shift_id_fkey"
            columns: ["shift_id"]
            isOneToOne: false
            referencedRelation: "shifts"
            referencedColumns: ["id"]
          },
        ]
      }
      wf_approvals: {
        Row: {
          comment: string | null
          decided_at: string
          decided_by: string
          decision: Database["public"]["Enums"]["wf_approval_decision"]
          id: string
          job_id: string
          stage: Database["public"]["Enums"]["wf_approval_stage"]
        }
        Insert: {
          comment?: string | null
          decided_at?: string
          decided_by: string
          decision: Database["public"]["Enums"]["wf_approval_decision"]
          id?: string
          job_id: string
          stage: Database["public"]["Enums"]["wf_approval_stage"]
        }
        Update: {
          comment?: string | null
          decided_at?: string
          decided_by?: string
          decision?: Database["public"]["Enums"]["wf_approval_decision"]
          id?: string
          job_id?: string
          stage?: Database["public"]["Enums"]["wf_approval_stage"]
        }
        Relationships: [
          {
            foreignKeyName: "wf_approvals_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "wf_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      wf_artifacts: {
        Row: {
          bucket_id: string
          created_at: string
          created_by: string | null
          id: string
          job_id: string
          kind: Database["public"]["Enums"]["wf_artifact_kind"]
          object_path: string
          run_id: string | null
          sha256: string | null
          size_bytes: number | null
        }
        Insert: {
          bucket_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          job_id: string
          kind: Database["public"]["Enums"]["wf_artifact_kind"]
          object_path: string
          run_id?: string | null
          sha256?: string | null
          size_bytes?: number | null
        }
        Update: {
          bucket_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          job_id?: string
          kind?: Database["public"]["Enums"]["wf_artifact_kind"]
          object_path?: string
          run_id?: string | null
          sha256?: string | null
          size_bytes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "wf_artifacts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "wf_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "wf_artifacts_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "wf_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      wf_jobs: {
        Row: {
          created_at: string
          created_by: string
          id: string
          payload: Json
          promoted_at: string | null
          ratified_at: string | null
          state: Database["public"]["Enums"]["wf_job_state"]
          title: string
          updated_at: string
          verified_at: string | null
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          payload?: Json
          promoted_at?: string | null
          ratified_at?: string | null
          state?: Database["public"]["Enums"]["wf_job_state"]
          title: string
          updated_at?: string
          verified_at?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          payload?: Json
          promoted_at?: string | null
          ratified_at?: string | null
          state?: Database["public"]["Enums"]["wf_job_state"]
          title?: string
          updated_at?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      wf_runs: {
        Row: {
          created_at: string
          finished_at: string | null
          id: string
          job_id: string
          picked_up_at: string | null
          result_summary: Json | null
          runner_id: string
          status: Database["public"]["Enums"]["wf_run_status"]
        }
        Insert: {
          created_at?: string
          finished_at?: string | null
          id?: string
          job_id: string
          picked_up_at?: string | null
          result_summary?: Json | null
          runner_id: string
          status?: Database["public"]["Enums"]["wf_run_status"]
        }
        Update: {
          created_at?: string
          finished_at?: string | null
          id?: string
          job_id?: string
          picked_up_at?: string | null
          result_summary?: Json | null
          runner_id?: string
          status?: Database["public"]["Enums"]["wf_run_status"]
        }
        Relationships: [
          {
            foreignKeyName: "wf_runs_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "wf_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      wf_state_events: {
        Row: {
          actor_type: Database["public"]["Enums"]["wf_actor_type"]
          actor_user_id: string | null
          created_at: string
          from_state: Database["public"]["Enums"]["wf_job_state"] | null
          id: number
          job_id: string
          reason: string | null
          to_state: Database["public"]["Enums"]["wf_job_state"]
        }
        Insert: {
          actor_type: Database["public"]["Enums"]["wf_actor_type"]
          actor_user_id?: string | null
          created_at?: string
          from_state?: Database["public"]["Enums"]["wf_job_state"] | null
          id?: number
          job_id: string
          reason?: string | null
          to_state: Database["public"]["Enums"]["wf_job_state"]
        }
        Update: {
          actor_type?: Database["public"]["Enums"]["wf_actor_type"]
          actor_user_id?: string | null
          created_at?: string
          from_state?: Database["public"]["Enums"]["wf_job_state"] | null
          id?: number
          job_id?: string
          reason?: string | null
          to_state?: Database["public"]["Enums"]["wf_job_state"]
        }
        Relationships: [
          {
            foreignKeyName: "wf_state_events_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "wf_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      wf_user_roles: {
        Row: {
          created_at: string
          role: Database["public"]["Enums"]["wf_app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          role: Database["public"]["Enums"]["wf_app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          role?: Database["public"]["Enums"]["wf_app_role"]
          user_id?: string
        }
        Relationships: []
      }
      zone_closures: {
        Row: {
          closure_type: string
          created_at: string
          created_by: string | null
          effective_from: string
          effective_to: string | null
          id: string
          lifted_at: string | null
          lifted_by: string | null
          notice_bundle_url: string | null
          organization_id: string
          reason: string | null
          resolution_notes: string | null
          status: string
          updated_at: string
          zone_id: string
        }
        Insert: {
          closure_type?: string
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          lifted_at?: string | null
          lifted_by?: string | null
          notice_bundle_url?: string | null
          organization_id: string
          reason?: string | null
          resolution_notes?: string | null
          status?: string
          updated_at?: string
          zone_id: string
        }
        Update: {
          closure_type?: string
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          lifted_at?: string | null
          lifted_by?: string | null
          notice_bundle_url?: string | null
          organization_id?: string
          reason?: string | null
          resolution_notes?: string | null
          status?: string
          updated_at?: string
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "zone_closures_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_closures_lifted_by_fkey"
            columns: ["lifted_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_closures_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "zone_closures_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_closures_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_closures_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      zone_compliance_matrix: {
        Row: {
          allowed_vehicle_types: string[] | null
          bylaw_clause: string | null
          bylaw_source_url: string | null
          created_at: string
          created_by: string | null
          effective_from: string
          effective_to: string | null
          id: string
          is_current: boolean
          max_consecutive_nights: number | null
          max_nights_per_month: number | null
          max_nights_per_year: number | null
          no_camping_end_time: string | null
          no_camping_start_time: string | null
          notes: string | null
          organization_id: string
          restricted_from_date: string | null
          restricted_to_date: string | null
          scv_required: boolean
          version: number
          zone_id: string
        }
        Insert: {
          allowed_vehicle_types?: string[] | null
          bylaw_clause?: string | null
          bylaw_source_url?: string | null
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          is_current?: boolean
          max_consecutive_nights?: number | null
          max_nights_per_month?: number | null
          max_nights_per_year?: number | null
          no_camping_end_time?: string | null
          no_camping_start_time?: string | null
          notes?: string | null
          organization_id: string
          restricted_from_date?: string | null
          restricted_to_date?: string | null
          scv_required?: boolean
          version?: number
          zone_id: string
        }
        Update: {
          allowed_vehicle_types?: string[] | null
          bylaw_clause?: string | null
          bylaw_source_url?: string | null
          created_at?: string
          created_by?: string | null
          effective_from?: string
          effective_to?: string | null
          id?: string
          is_current?: boolean
          max_consecutive_nights?: number | null
          max_nights_per_month?: number | null
          max_nights_per_year?: number | null
          no_camping_end_time?: string | null
          no_camping_start_time?: string | null
          notes?: string | null
          organization_id?: string
          restricted_from_date?: string | null
          restricted_to_date?: string | null
          scv_required?: boolean
          version?: number
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "zone_compliance_matrix_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_compliance_matrix_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "zone_compliance_matrix_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_compliance_matrix_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_compliance_matrix_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      zone_legal_config: {
        Row: {
          authorising_act: string | null
          authorising_section: string | null
          council_email: string | null
          council_phone: string | null
          created_at: string
          dispute_portal_url: string | null
          id: string
          infringement_amount: number | null
          issuing_authority: string | null
          objections_address: string | null
          objections_email: string | null
          organization_id: string
          payment_deadline_days: number
          payment_url: string | null
          updated_at: string
          zone_id: string
        }
        Insert: {
          authorising_act?: string | null
          authorising_section?: string | null
          council_email?: string | null
          council_phone?: string | null
          created_at?: string
          dispute_portal_url?: string | null
          id?: string
          infringement_amount?: number | null
          issuing_authority?: string | null
          objections_address?: string | null
          objections_email?: string | null
          organization_id: string
          payment_deadline_days?: number
          payment_url?: string | null
          updated_at?: string
          zone_id: string
        }
        Update: {
          authorising_act?: string | null
          authorising_section?: string | null
          council_email?: string | null
          council_phone?: string | null
          created_at?: string
          dispute_portal_url?: string | null
          id?: string
          infringement_amount?: number | null
          issuing_authority?: string | null
          objections_address?: string | null
          objections_email?: string | null
          organization_id?: string
          payment_deadline_days?: number
          payment_url?: string | null
          updated_at?: string
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "zone_legal_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "zone_legal_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_legal_config_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_legal_config_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: true
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
      zone_signage_evidence: {
        Row: {
          captured_at: string
          gps_lat: number | null
          gps_lng: number | null
          id: string
          notes: string | null
          officer_id: string
          organization_id: string
          photo_url: string
          sign_type: string
          zone_id: string
        }
        Insert: {
          captured_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          officer_id: string
          organization_id: string
          photo_url: string
          sign_type?: string
          zone_id: string
        }
        Update: {
          captured_at?: string
          gps_lat?: number | null
          gps_lng?: number | null
          id?: string
          notes?: string | null
          officer_id?: string
          organization_id?: string
          photo_url?: string
          sign_type?: string
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "zone_signage_evidence_officer_id_fkey"
            columns: ["officer_id"]
            isOneToOne: false
            referencedRelation: "user_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_signage_evidence_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "zone_signage_evidence_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_signage_evidence_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_signage_evidence_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      crm_account_health: {
        Row: {
          active_breaches: number | null
          active_roster: number | null
          open_invoices: number | null
          organization_id: string | null
          organization_name: string | null
          overdue_invoices: number | null
        }
        Relationships: []
      }
      crm_account_list: {
        Row: {
          active: boolean | null
          contact_email: string | null
          contact_phone: string | null
          id: string | null
          name: string | null
          organization_level: number | null
          organization_type: string | null
          parent_organization_id: string | null
          primary_contact_name: string | null
          site_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "organizations_parent_organization_id_fkey"
            columns: ["parent_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "organizations_parent_organization_id_fkey"
            columns: ["parent_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organizations_parent_organization_id_fkey"
            columns: ["parent_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      geography_columns: {
        Row: {
          coord_dimension: number | null
          f_geography_column: unknown
          f_table_catalog: unknown
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Relationships: []
      }
      geometry_columns: {
        Row: {
          coord_dimension: number | null
          f_geometry_column: unknown
          f_table_catalog: string | null
          f_table_name: unknown
          f_table_schema: unknown
          srid: number | null
          type: string | null
        }
        Insert: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Update: {
          coord_dimension?: number | null
          f_geometry_column?: unknown
          f_table_catalog?: string | null
          f_table_name?: unknown
          f_table_schema?: unknown
          srid?: number | null
          type?: string | null
        }
        Relationships: []
      }
      location_visibility_for_viewer: {
        Row: {
          client_organization_id: string | null
          provider_organization_id: string | null
          sal_id: string | null
          service_agreement_id: string | null
          share_actual_cost: boolean | null
          share_contract_price: boolean | null
          site_id: string | null
          status: string | null
          zone_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_agreement_locations_service_agreement_id_fkey"
            columns: ["service_agreement_id"]
            isOneToOne: false
            referencedRelation: "service_agreements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreement_locations_site_id_fkey"
            columns: ["site_id"]
            isOneToOne: false
            referencedRelation: "client_sites"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreement_locations_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "location_zones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreements_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "service_agreements_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreements_client_organization_id_fkey"
            columns: ["client_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreements_provider_organization_id_fkey"
            columns: ["provider_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_health"
            referencedColumns: ["organization_id"]
          },
          {
            foreignKeyName: "service_agreements_provider_organization_id_fkey"
            columns: ["provider_organization_id"]
            isOneToOne: false
            referencedRelation: "crm_account_list"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_agreements_provider_organization_id_fkey"
            columns: ["provider_organization_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_tree: {
        Row: {
          depth: number | null
          id: string | null
          name: string | null
          organization_type: string | null
          parent_organization_id: string | null
          path: string | null
          root_id: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _entitled_org_ids_for: { Args: { p_user_id: string }; Returns: string[] }
      _gbh_next_version: {
        Args: { p_entity_id: string; p_entity_type: string }
        Returns: number
      }
      _geofence_active_at: {
        Args: { p_at: string; p_schedule: Json }
        Returns: boolean
      }
      _postgis_deprecate: {
        Args: { newname: string; oldname: string; version: string }
        Returns: undefined
      }
      _postgis_index_extent: {
        Args: { col: string; tbl: unknown }
        Returns: unknown
      }
      _postgis_pgsql_version: { Args: never; Returns: string }
      _postgis_scripts_pgsql_version: { Args: never; Returns: string }
      _postgis_selectivity: {
        Args: { att_name: string; geom: unknown; mode?: string; tbl: unknown }
        Returns: number
      }
      _postgis_stats: {
        Args: { ""?: string; att_name: string; tbl: unknown }
        Returns: string
      }
      _st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_crosses: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      _st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      _st_intersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      _st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      _st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      _st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_sortablehash: { Args: { geom: unknown }; Returns: number }
      _st_touches: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      _st_voronoi: {
        Args: {
          clip?: unknown
          g1: unknown
          return_polygons?: boolean
          tolerance?: number
        }
        Returns: unknown
      }
      _st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      accept_quote: { Args: { p_quote_id: string }; Returns: string }
      addauth: { Args: { "": string }; Returns: boolean }
      addgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              new_dim: number
              new_srid_in: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              schema_name: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              new_dim: number
              new_srid: number
              new_type: string
              table_name: string
              use_typmod?: boolean
            }
            Returns: string
          }
      bob_atlas_fk_reach: {
        Args: { p_from_name: string; p_from_type: string; p_max_depth?: number }
        Returns: {
          depth: number
          edge_from: string
          edge_kind: string
          edge_to: string
          entity_name: string
          entity_type: string
          path: string[]
        }[]
      }
      bob_atlas_flow_reach: {
        Args: {
          p_direction?: string
          p_from_name: string
          p_from_type: string
          p_max_depth?: number
        }
        Returns: {
          depth: number
          edge_kind: string
          entity_name: string
          entity_type: string
          path: string[]
        }[]
      }
      bob_atlas_gap_report: {
        Args: { p_include_columns?: boolean; p_include_unknown_exercise?: boolean; p_limit?: number; p_offset?: number }
        Returns: {
          caller_summary: string | null
          entity_name: string
          entity_type: string
          exercised: boolean | null
          gap_kind: string
          notes: string | null
          present: boolean
          retirement_status: string
          wired: boolean
        }[]
      }
      bob_atlas_expectation_report: {
        Args: { p_limit?: number; p_offset?: number }
        Returns: {
          assertion_kind: string
          expectation_id: string
          expectation_status: string
          from_name: string
          from_type: string
          gap_kind: string | null
          rationale: string | null
          signal_weight: number
          spine: string
          to_name: string
          to_type: string
          via_name: string | null
          via_type: string | null
        }[]
      }
      bob_cards_needing_embedding: {
        Args: { match_limit?: number }
        Returns: {
          content: string
          id: string
          title: string
        }[]
      }
      bob_cards_needing_embedding_count: { Args: never; Returns: number }
      bob_execute_read_query: {
        Args: { query_text: string; row_limit?: number; timeout_ms?: number }
        Returns: Json
      }
      bob_execute_read_query_scoped: {
        Args: { query_text: string; row_limit?: number; timeout_ms?: number }
        Returns: Json
      }
      bob_inspect_schema: {
        Args: { include_fks?: boolean; table_names?: string[] }
        Returns: Json
      }
      bob_match_knowledge: {
        Args: {
          match_count?: number
          query_embedding: string
          scope_org_id?: string
        }
        Returns: {
          category: string
          content: string
          id: string
          key: string
          similarity: number
          tags: string[]
          title: string
        }[]
      }
      bob_recall_prior_context: {
        Args: {
          lookback_days?: number
          max_results?: number
          scope_org_id?: string
          search_terms: string
        }
        Returns: Json
      }
      bob_search_reference_documents: {
        Args: {
          p_allow_restricted?: boolean
          p_document_type?: string
          p_jurisdiction?: string
          p_limit?: number
          p_organization_id?: string
          p_query?: string
          p_scope?: string
          p_tags?: string[]
        }
        Returns: Json
      }
      bob_site_risk: {
        Args: {
          p_radius_m?: number
          p_scope_org_ids?: string[]
          p_site_id: string
          p_unrestricted?: boolean
        }
        Returns: Json
      }
      calculate_vehicle_compliance: {
        Args: { p_org_id: string; p_plate: string; p_zone_id: string }
        Returns: Json
      }
      can_approve_action: {
        Args: { p_action_org_id: string; p_user_id: string }
        Returns: boolean
      }
      check_invite_rate_limit: {
        Args: { p_caller_id: string; p_target_org_id: string }
        Returns: boolean
      }
      check_repeat_stay: {
        Args: {
          p_at?: string
          p_lat: number
          p_lng: number
          p_org_id: string
          p_plate: string
          p_radius_m?: number
          p_window_nights?: number
        }
        Returns: Json
      }
      claim_first_org_user: {
        Args: {
          p_display_name: string
          p_email: string
          p_org_id: string
          p_role: string
          p_user_id: string
        }
        Returns: undefined
      }
      classify_fc_overnight_window: {
        Args: { p_observed_at: string; p_timezone?: string }
        Returns: {
          overnight_date: string
          scan_window: string
        }[]
      }
      closure_at_point: {
        Args: { p_lat: number; p_lng: number; p_org_id: string }
        Returns: {
          closure_id: string
          closure_type: string
          reason: string
          zone_id: string
        }[]
      }
      compare_boundaries_hausdorff: {
        Args: { p_geojson_a: string; p_geojson_b: string }
        Returns: number
      }
      complete_shift_stop: {
        Args: {
          p_gps_lat?: number
          p_gps_lng?: number
          p_officer_notes?: string
          p_stop_id: string
        }
        Returns: undefined
      }
      compute_point_distance_km: {
        Args: { lat1: number; lat2: number; lng1: number; lng2: number }
        Returns: number
      }
      current_user_role: { Args: never; Returns: string }
      daitch_mokotoff: { Args: { "": string }; Returns: string[] }
      disablelongtransactions: { Args: never; Returns: string }
      dmetaphone: { Args: { "": string }; Returns: string }
      dmetaphone_alt: { Args: { "": string }; Returns: string }
      dropgeometrycolumn:
        | {
            Args: {
              catalog_name: string
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | {
            Args: {
              column_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { column_name: string; table_name: string }; Returns: string }
      dropgeometrytable:
        | {
            Args: {
              catalog_name: string
              schema_name: string
              table_name: string
            }
            Returns: string
          }
        | { Args: { schema_name: string; table_name: string }; Returns: string }
        | { Args: { table_name: string }; Returns: string }
      enablelongtransactions: { Args: never; Returns: string }
      enqueue_notification: {
        Args: {
          p_body?: string
          p_category: string
          p_dedup_key?: string
          p_link_page?: string
          p_link_payload?: Json
          p_organization_id: string
          p_recipient_role?: string
          p_recipient_user_id?: string
          p_severity?: string
          p_title: string
        }
        Returns: string
      }
      equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      evaluate_parking_compliance: {
        Args: {
          p_is_disabled_bay?: boolean
          p_org_id: string
          p_plate: string
          p_sign_time_limit_minutes?: number
          p_zone_id: string
        }
        Returns: Json
      }
      generate_due_report_packs: {
        Args: { p_period_end: string; p_period_start: string }
        Returns: number
      }
      generate_noise_job_number: { Args: never; Returns: string }
      generate_parking_notice_number: {
        Args: { p_org_id: string }
        Returns: string
      }
      generate_shift_stops: {
        Args: { p_shift_date: string; p_shift_id: string }
        Returns: number
      }
      geometry: { Args: { "": string }; Returns: unknown }
      geometry_above: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_area_m2: { Args: { p_geojson: Json }; Returns: number }
      geometry_below: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_cmp: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_contained_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_contains_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_distance_box: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_distance_centroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      geometry_eq: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_ge: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_gt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_le: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_left: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_lt: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overabove: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overbelow: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overlaps_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overleft: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_overright: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_right: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_same_3d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geometry_within: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      geomfromewkt: { Args: { "": string }; Returns: unknown }
      get_approvals_activity: {
        Args: {
          p_action_types?: string[]
          p_limit?: number
          p_offset?: number
          p_statuses?: string[]
        }
        Returns: {
          action_type: string
          amended_payload: Json
          applied_at: string
          approved_at: string
          approved_by: string
          approved_by_name: string
          assigned_approver_id: string
          bob_reasoning: string
          can_decide: boolean
          confidence_score: number
          context_summary: string
          context_table: string
          created_at: string
          error_message: string
          id: string
          org_name: string
          organization_id: string
          proposed_payload: Json
          rejection_reason: string
          result_record_id: string
          result_table: string
          status: string
          triggered_by: string
          triggered_by_name: string
          user_id: string
          user_name: string
        }[]
      }
      get_boundary_history: {
        Args: { p_entity_id: string; p_entity_type: string }
        Returns: {
          boundary_source: string
          change_reason: string
          changed_by: string
          changed_via: string
          created_at: string
          entity_id: string
          entity_type: string
          has_boundary: boolean
          id: string
          verification_state: string
          verified_at: string
          verified_by: string
          version: number
        }[]
      }
      get_descendant_organizations: {
        Args: { org_id: string }
        Returns: string[]
      }
      get_my_pending_proposals: {
        Args: { p_limit?: number }
        Returns: {
          action_type: string
          amended_payload: Json
          bob_reasoning: string
          confidence_score: number
          context_table: string
          created_at: string
          id: string
          organization_id: string
          proposed_payload: Json
          status: string
          triggered_by: string
          user_id: string
        }[]
      }
      get_org_geofence_config: {
        Args: {
          p_config_key: string
          p_default?: number
          p_org_id: string
          p_zone_type?: string
        }
        Returns: number
      }
      get_orgs_by_jurisdiction_point: {
        Args: { p_lat: number; p_lng: number; p_module_key?: string }
        Returns: {
          id: string
          name: string
        }[]
      }
      get_zone_for_gps: {
        Args: { p_lat: number; p_lng: number; p_org_id: string }
        Returns: {
          closure_active: boolean
          compliance_rules: Json
          parent_zone_id: string
          site_id: string
          site_name: string
          zone_id: string
          zone_name: string
        }[]
      }
      gettransactionid: { Args: never; Returns: unknown }
      has_location_access: {
        Args: { p_direction?: string; p_site_id: string; p_zone_id: string }
        Returns: boolean
      }
      insert_adhoc_stop: {
        Args: {
          p_dispatch_job_id: string
          p_module_key: string
          p_officer_gps_lat: number
          p_officer_gps_lng: number
          p_shift_id: string
          p_site_id: string
          p_sla_respond_by: string
        }
        Returns: string
      }
      is_admin_for_org: { Args: { target_org_id: string }; Returns: boolean }
      is_grand_master: { Args: never; Returns: boolean }
      is_master_for_org: { Args: { p_org_id: string }; Returns: boolean }
      is_master_or_above: { Args: never; Returns: boolean }
      is_platform_owner: { Args: { p_user_id: string }; Returns: boolean }
      is_zone_closed: {
        Args: { p_at?: string; p_zone_id: string }
        Returns: Json
      }
      longtransactionsenabled: { Args: never; Returns: boolean }
      my_entitled_org_ids: { Args: never; Returns: string[] }
      my_entitled_org_ids_for_user: {
        Args: { p_user_id: string }
        Returns: string[]
      }
      org_access_allowed: { Args: { target_org_id: string }; Returns: boolean }
      org_default_level: { Args: { p_type: string }; Returns: number }
      patrol_stop_coords: {
        Args: { p_shift_id: string }
        Returns: {
          lat: number
          lng: number
          place_type: string
          site_id: string
          stop_id: string
          zone_id: string
        }[]
      }
      patrol_stop_module_keys: {
        Args: { p_stop_id: string }
        Returns: string[]
      }
      point_in_zone: {
        Args: { p_lat: number; p_lng: number; p_zone_id: string }
        Returns: boolean
      }
      populate_geometry_columns:
        | { Args: { tbl_oid: unknown; use_typmod?: boolean }; Returns: number }
        | { Args: { use_typmod?: boolean }; Returns: string }
      postgis_constraint_dims: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_srid: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: number
      }
      postgis_constraint_type: {
        Args: { geomcolumn: string; geomschema: string; geomtable: string }
        Returns: string
      }
      postgis_extensions_upgrade: { Args: never; Returns: string }
      postgis_full_version: { Args: never; Returns: string }
      postgis_geos_version: { Args: never; Returns: string }
      postgis_lib_build_date: { Args: never; Returns: string }
      postgis_lib_revision: { Args: never; Returns: string }
      postgis_lib_version: { Args: never; Returns: string }
      postgis_libjson_version: { Args: never; Returns: string }
      postgis_liblwgeom_version: { Args: never; Returns: string }
      postgis_libprotobuf_version: { Args: never; Returns: string }
      postgis_libxml_version: { Args: never; Returns: string }
      postgis_proj_version: { Args: never; Returns: string }
      postgis_scripts_build_date: { Args: never; Returns: string }
      postgis_scripts_installed: { Args: never; Returns: string }
      postgis_scripts_released: { Args: never; Returns: string }
      postgis_svn_version: { Args: never; Returns: string }
      postgis_type_name: {
        Args: {
          coord_dimension: number
          geomname: string
          use_new_name?: boolean
        }
        Returns: string
      }
      postgis_version: { Args: never; Returns: string }
      postgis_wagyu_version: { Args: never; Returns: string }
      promote_document_to_reference_library: {
        Args: {
          p_approver_id: string
          p_document_version_id: string
          p_metadata?: Json
          p_target_scope: string
        }
        Returns: Json
      }
      record_sla_arrival: {
        Args: { p_arrived_at?: string; p_clock_id: string }
        Returns: string
      }
      refresh_canonical_ta_names: {
        Args: { p_names: string[]; p_source?: string }
        Returns: Json
      }
      resolve_access_basis: {
        Args: {
          p_biosecurity_assessment_id?: string
          p_enforcement_case_id?: string
          p_incident_id?: string
          p_noise_assessment_id?: string
          p_notice_id?: string
          p_observation_id?: string
          p_smoke_assessment_id?: string
          p_user?: string
        }
        Returns: Json
      }
      resolve_access_basis_batch: {
        Args: { p_observation_ids: string[] }
        Returns: Database["public"]["CompositeTypes"]["access_basis_verdict"][]
        SetofOptions: {
          from: "*"
          to: "access_basis_verdict"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      resolve_access_grants: {
        Args: { p_org_id: string; p_user_id: string }
        Returns: {
          area: string
          level: string
        }[]
      }
      resolve_context: {
        Args: {
          p_at?: string
          p_lat: number
          p_lng: number
          p_module_key?: string
          p_org_id: string
        }
        Returns: {
          client_org_id: string
          effective_rules: Json
          governing_jurisdiction_id: string
          governing_jurisdiction_name: string
          governor_overlap_flag: boolean
          in_operating_bounds: boolean
          matched_module_key: string
          matched_zone_id: string
          on_site: boolean
          out_of_bounds_district: string
          resolution_status: string
          site_id: string
        }[]
      }
      resolve_context_authorized: {
        Args: {
          p_at?: string
          p_lat: number
          p_lng: number
          p_module_key?: string
          p_org_id: string
        }
        Returns: {
          client_org_id: string
          effective_rules: Json
          governing_jurisdiction_id: string
          governing_jurisdiction_name: string
          governor_overlap_flag: boolean
          in_operating_bounds: boolean
          matched_module_key: string
          matched_zone_id: string
          on_site: boolean
          out_of_bounds_district: string
          resolution_status: string
          site_id: string
        }[]
      }
      resolve_verified_site_context: {
        Args: {
          p_client_org_ids: string[]
          p_lat: number
          p_lng: number
        }
        Returns: {
          client_organization_id: string
          location_id: string | null
          match_kind: string
          site_id: string
          site_name: string
        }[]
      }
      resolve_enforcement_mode: { Args: { p_zone_id: string }; Returns: string }
      resolve_location_visibility: {
        Args: { p_sal_id: string; p_viewing_org_id: string }
        Returns: {
          is_client: boolean
          is_provider: boolean
          share_actual_cost: boolean
          share_contract_price: boolean
        }[]
      }
      resolve_manager_for_user: {
        Args: { p_context_org_id: string; p_user_id: string }
        Returns: {
          manager_user_id: string
          resolution_source: string
        }[]
      }
      resolve_retention_days: {
        Args: { p_category: string; p_module_key: string; p_org_id: string }
        Returns: number
      }
      save_site_boundary: {
        Args: {
          p_centroid_lat: number
          p_centroid_lng: number
          p_geojson: string
          p_org_id: string
          p_site_id: string
        }
        Returns: undefined
      }
      save_zone_boundary: {
        Args: {
          p_centroid_lat: number
          p_centroid_lng: number
          p_geojson: string
          p_org_id: string
          p_zone_id: string
        }
        Returns: number
      }
      set_org_jurisdiction_geom: {
        Args: {
          p_boundary_source?: string
          p_changed_by?: string
          p_changed_via?: string
          p_org_id: string
          p_polygons: Json
        }
        Returns: number
      }
      set_site_geometry: {
        Args: {
          p_boundary?: Json
          p_boundary_source?: string
          p_center_lat?: number
          p_center_lng?: number
          p_changed_by?: string
          p_changed_via?: string
          p_provisional_radius_m?: number
          p_site_id: string
        }
        Returns: number
      }
      set_zone_geometry:
        | {
            Args: {
              p_boundary_source?: string
              p_center_lat: number
              p_center_lng: number
              p_changed_by?: string
              p_changed_via?: string
              p_provisional_radius_m?: number
              p_zone_id: string
            }
            Returns: number
          }
        | {
            Args: {
              p_boundary_source?: string
              p_changed_by?: string
              p_changed_via?: string
              p_polygons: Json
              p_zone_id: string
            }
            Returns: number
          }
      soundex: { Args: { "": string }; Returns: string }
      st_3dclosestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3ddistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dintersects: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_3dlongestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmakebox: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_3dmaxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_3dshortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_addpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_angle:
        | { Args: { line1: unknown; line2: unknown }; Returns: number }
        | {
            Args: { pt1: unknown; pt2: unknown; pt3: unknown; pt4?: unknown }
            Returns: number
          }
      st_area:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_asencodedpolyline: {
        Args: { geom: unknown; nprecision?: number }
        Returns: string
      }
      st_asewkt: { Args: { "": string }; Returns: string }
      st_asgeojson:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | {
            Args: {
              geom_column?: string
              maxdecimaldigits?: number
              pretty_bool?: boolean
              r: Record<string, unknown>
            }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_asgml:
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
            }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
        | {
            Args: {
              geog: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown
              id?: string
              maxdecimaldigits?: number
              nprefix?: string
              options?: number
              version: number
            }
            Returns: string
          }
      st_askml:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; nprefix?: string }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_aslatlontext: {
        Args: { geom: unknown; tmpl?: string }
        Returns: string
      }
      st_asmarc21: { Args: { format?: string; geom: unknown }; Returns: string }
      st_asmvtgeom: {
        Args: {
          bounds: unknown
          buffer?: number
          clip_geom?: boolean
          extent?: number
          geom: unknown
        }
        Returns: unknown
      }
      st_assvg:
        | {
            Args: { geog: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | {
            Args: { geom: unknown; maxdecimaldigits?: number; rel?: number }
            Returns: string
          }
        | { Args: { "": string }; Returns: string }
      st_astext: { Args: { "": string }; Returns: string }
      st_astwkb:
        | {
            Args: {
              geom: unknown
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
        | {
            Args: {
              geom: unknown[]
              ids: number[]
              prec?: number
              prec_m?: number
              prec_z?: number
              with_boxes?: boolean
              with_sizes?: boolean
            }
            Returns: string
          }
      st_asx3d: {
        Args: { geom: unknown; maxdecimaldigits?: number; options?: number }
        Returns: string
      }
      st_azimuth:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: number }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_boundingdiagonal: {
        Args: { fits?: boolean; geom: unknown }
        Returns: unknown
      }
      st_buffer:
        | {
            Args: { geom: unknown; options?: string; radius: number }
            Returns: unknown
          }
        | {
            Args: { geom: unknown; quadsegs: number; radius: number }
            Returns: unknown
          }
      st_centroid: { Args: { "": string }; Returns: unknown }
      st_clipbybox2d: {
        Args: { box: unknown; geom: unknown }
        Returns: unknown
      }
      st_closestpoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_collect: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_concavehull: {
        Args: {
          param_allow_holes?: boolean
          param_geom: unknown
          param_pctconvex: number
        }
        Returns: unknown
      }
      st_contains: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_containsproperly: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_coorddim: { Args: { geometry: unknown }; Returns: number }
      st_coveredby:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_covers:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_crosses: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_curvetoline: {
        Args: { flags?: number; geom: unknown; tol?: number; toltype?: number }
        Returns: unknown
      }
      st_delaunaytriangles: {
        Args: { flags?: number; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_difference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_disjoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_distance:
        | {
            Args: { geog1: unknown; geog2: unknown; use_spheroid?: boolean }
            Returns: number
          }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
      st_distancesphere:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: number }
        | {
            Args: { geom1: unknown; geom2: unknown; radius: number }
            Returns: number
          }
      st_distancespheroid: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_dwithin: {
        Args: {
          geog1: unknown
          geog2: unknown
          tolerance: number
          use_spheroid?: boolean
        }
        Returns: boolean
      }
      st_equals: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_expand:
        | { Args: { box: unknown; dx: number; dy: number }; Returns: unknown }
        | {
            Args: { box: unknown; dx: number; dy: number; dz?: number }
            Returns: unknown
          }
        | {
            Args: {
              dm?: number
              dx: number
              dy: number
              dz?: number
              geom: unknown
            }
            Returns: unknown
          }
      st_force3d: { Args: { geom: unknown; zvalue?: number }; Returns: unknown }
      st_force3dm: {
        Args: { geom: unknown; mvalue?: number }
        Returns: unknown
      }
      st_force3dz: {
        Args: { geom: unknown; zvalue?: number }
        Returns: unknown
      }
      st_force4d: {
        Args: { geom: unknown; mvalue?: number; zvalue?: number }
        Returns: unknown
      }
      st_generatepoints:
        | { Args: { area: unknown; npoints: number }; Returns: unknown }
        | {
            Args: { area: unknown; npoints: number; seed: number }
            Returns: unknown
          }
      st_geogfromtext: { Args: { "": string }; Returns: unknown }
      st_geographyfromtext: { Args: { "": string }; Returns: unknown }
      st_geohash:
        | { Args: { geog: unknown; maxchars?: number }; Returns: string }
        | { Args: { geom: unknown; maxchars?: number }; Returns: string }
      st_geomcollfromtext: { Args: { "": string }; Returns: unknown }
      st_geometricmedian: {
        Args: {
          fail_if_not_converged?: boolean
          g: unknown
          max_iter?: number
          tolerance?: number
        }
        Returns: unknown
      }
      st_geometryfromtext: { Args: { "": string }; Returns: unknown }
      st_geomfromewkt: { Args: { "": string }; Returns: unknown }
      st_geomfromgeojson:
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": Json }; Returns: unknown }
        | { Args: { "": string }; Returns: unknown }
      st_geomfromgml: { Args: { "": string }; Returns: unknown }
      st_geomfromkml: { Args: { "": string }; Returns: unknown }
      st_geomfrommarc21: { Args: { marc21xml: string }; Returns: unknown }
      st_geomfromtext: { Args: { "": string }; Returns: unknown }
      st_gmltosql: { Args: { "": string }; Returns: unknown }
      st_hasarc: { Args: { geometry: unknown }; Returns: boolean }
      st_hausdorffdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_hexagon: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_hexagongrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_interpolatepoint: {
        Args: { line: unknown; point: unknown }
        Returns: number
      }
      st_intersection: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_intersects:
        | { Args: { geog1: unknown; geog2: unknown }; Returns: boolean }
        | { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_isvaliddetail: {
        Args: { flags?: number; geom: unknown }
        Returns: Database["public"]["CompositeTypes"]["valid_detail"]
        SetofOptions: {
          from: "*"
          to: "valid_detail"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      st_length:
        | { Args: { geog: unknown; use_spheroid?: boolean }; Returns: number }
        | { Args: { "": string }; Returns: number }
      st_letters: { Args: { font?: Json; letters: string }; Returns: unknown }
      st_linecrossingdirection: {
        Args: { line1: unknown; line2: unknown }
        Returns: number
      }
      st_linefromencodedpolyline: {
        Args: { nprecision?: number; txtin: string }
        Returns: unknown
      }
      st_linefromtext: { Args: { "": string }; Returns: unknown }
      st_linelocatepoint: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_linetocurve: { Args: { geometry: unknown }; Returns: unknown }
      st_locatealong: {
        Args: { geometry: unknown; leftrightoffset?: number; measure: number }
        Returns: unknown
      }
      st_locatebetween: {
        Args: {
          frommeasure: number
          geometry: unknown
          leftrightoffset?: number
          tomeasure: number
        }
        Returns: unknown
      }
      st_locatebetweenelevations: {
        Args: { fromelevation: number; geometry: unknown; toelevation: number }
        Returns: unknown
      }
      st_longestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makebox2d: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makeline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_makevalid: {
        Args: { geom: unknown; params: string }
        Returns: unknown
      }
      st_maxdistance: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: number
      }
      st_minimumboundingcircle: {
        Args: { inputgeom: unknown; segs_per_quarter?: number }
        Returns: unknown
      }
      st_mlinefromtext: { Args: { "": string }; Returns: unknown }
      st_mpointfromtext: { Args: { "": string }; Returns: unknown }
      st_mpolyfromtext: { Args: { "": string }; Returns: unknown }
      st_multilinestringfromtext: { Args: { "": string }; Returns: unknown }
      st_multipointfromtext: { Args: { "": string }; Returns: unknown }
      st_multipolygonfromtext: { Args: { "": string }; Returns: unknown }
      st_node: { Args: { g: unknown }; Returns: unknown }
      st_normalize: { Args: { geom: unknown }; Returns: unknown }
      st_offsetcurve: {
        Args: { distance: number; line: unknown; params?: string }
        Returns: unknown
      }
      st_orderingequals: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_overlaps: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: boolean
      }
      st_perimeter: {
        Args: { geog: unknown; use_spheroid?: boolean }
        Returns: number
      }
      st_pointfromtext: { Args: { "": string }; Returns: unknown }
      st_pointm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
        }
        Returns: unknown
      }
      st_pointz: {
        Args: {
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_pointzm: {
        Args: {
          mcoordinate: number
          srid?: number
          xcoordinate: number
          ycoordinate: number
          zcoordinate: number
        }
        Returns: unknown
      }
      st_polyfromtext: { Args: { "": string }; Returns: unknown }
      st_polygonfromtext: { Args: { "": string }; Returns: unknown }
      st_project: {
        Args: { azimuth: number; distance: number; geog: unknown }
        Returns: unknown
      }
      st_quantizecoordinates: {
        Args: {
          g: unknown
          prec_m?: number
          prec_x: number
          prec_y?: number
          prec_z?: number
        }
        Returns: unknown
      }
      st_reduceprecision: {
        Args: { geom: unknown; gridsize: number }
        Returns: unknown
      }
      st_relate: { Args: { geom1: unknown; geom2: unknown }; Returns: string }
      st_removerepeatedpoints: {
        Args: { geom: unknown; tolerance?: number }
        Returns: unknown
      }
      st_segmentize: {
        Args: { geog: unknown; max_segment_length: number }
        Returns: unknown
      }
      st_setsrid:
        | { Args: { geog: unknown; srid: number }; Returns: unknown }
        | { Args: { geom: unknown; srid: number }; Returns: unknown }
      st_sharedpaths: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_shortestline: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_simplifypolygonhull: {
        Args: { geom: unknown; is_outer?: boolean; vertex_fraction: number }
        Returns: unknown
      }
      st_split: { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
      st_square: {
        Args: { cell_i: number; cell_j: number; origin?: unknown; size: number }
        Returns: unknown
      }
      st_squaregrid: {
        Args: { bounds: unknown; size: number }
        Returns: Record<string, unknown>[]
      }
      st_srid:
        | { Args: { geog: unknown }; Returns: number }
        | { Args: { geom: unknown }; Returns: number }
      st_subdivide: {
        Args: { geom: unknown; gridsize?: number; maxvertices?: number }
        Returns: unknown[]
      }
      st_swapordinates: {
        Args: { geom: unknown; ords: unknown }
        Returns: unknown
      }
      st_symdifference: {
        Args: { geom1: unknown; geom2: unknown; gridsize?: number }
        Returns: unknown
      }
      st_symmetricdifference: {
        Args: { geom1: unknown; geom2: unknown }
        Returns: unknown
      }
      st_tileenvelope: {
        Args: {
          bounds?: unknown
          margin?: number
          x: number
          y: number
          zoom: number
        }
        Returns: unknown
      }
      st_touches: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_transform:
        | {
            Args: { from_proj: string; geom: unknown; to_proj: string }
            Returns: unknown
          }
        | {
            Args: { from_proj: string; geom: unknown; to_srid: number }
            Returns: unknown
          }
        | { Args: { geom: unknown; to_proj: string }; Returns: unknown }
      st_triangulatepolygon: { Args: { g1: unknown }; Returns: unknown }
      st_union:
        | { Args: { geom1: unknown; geom2: unknown }; Returns: unknown }
        | {
            Args: { geom1: unknown; geom2: unknown; gridsize: number }
            Returns: unknown
          }
      st_voronoilines: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_voronoipolygons: {
        Args: { extend_to?: unknown; g1: unknown; tolerance?: number }
        Returns: unknown
      }
      st_within: { Args: { geom1: unknown; geom2: unknown }; Returns: boolean }
      st_wkbtosql: { Args: { wkb: string }; Returns: unknown }
      st_wkttosql: { Args: { "": string }; Returns: unknown }
      st_wrapx: {
        Args: { geom: unknown; move: number; wrap: number }
        Returns: unknown
      }
      text_soundex: { Args: { "": string }; Returns: string }
      unlockrows: { Args: { "": string }; Returns: number }
      updategeometrysrid: {
        Args: {
          catalogn_name: string
          column_name: string
          new_srid_in: number
          schema_name: string
          table_name: string
        }
        Returns: string
      }
      user_authorised_branch_ids: { Args: never; Returns: string[] }
      user_has_task_entitlement: {
        Args: {
          p_biosecurity_assessment_id?: string
          p_enforcement_case_id?: string
          p_incident_id?: string
          p_noise_assessment_id?: string
          p_notice_id?: string
          p_observation_id?: string
          p_smoke_assessment_id?: string
          p_user?: string
        }
        Returns: boolean
      }
      user_managed_branch_ids: { Args: never; Returns: string[] }
      validate_ta_names: { Args: { p_names: string[] }; Returns: Json }
      verify_boundary: {
        Args: { p_entity_id: string; p_entity_type: string }
        Returns: boolean
      }
      wf_approve_job: {
        Args: {
          _comment?: string
          _decision: Database["public"]["Enums"]["wf_approval_decision"]
          _job_id: string
          _stage: Database["public"]["Enums"]["wf_approval_stage"]
        }
        Returns: {
          created_at: string
          created_by: string
          id: string
          payload: Json
          promoted_at: string | null
          ratified_at: string | null
          state: Database["public"]["Enums"]["wf_job_state"]
          title: string
          updated_at: string
          verified_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "wf_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      wf_create_job: {
        Args: { _payload?: Json; _title: string }
        Returns: {
          created_at: string
          created_by: string
          id: string
          payload: Json
          promoted_at: string | null
          ratified_at: string | null
          state: Database["public"]["Enums"]["wf_job_state"]
          title: string
          updated_at: string
          verified_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "wf_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      wf_has_role: {
        Args: { _role: Database["public"]["Enums"]["wf_app_role"] }
        Returns: boolean
      }
      wf_pickup_run: {
        Args: { _job_id: string; _runner_id: string }
        Returns: {
          created_at: string
          finished_at: string | null
          id: string
          job_id: string
          picked_up_at: string | null
          result_summary: Json | null
          runner_id: string
          status: Database["public"]["Enums"]["wf_run_status"]
        }
        SetofOptions: {
          from: "*"
          to: "wf_runs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      wf_record_promotion: {
        Args: { _job_id: string; _note?: string }
        Returns: {
          created_at: string
          created_by: string
          id: string
          payload: Json
          promoted_at: string | null
          ratified_at: string | null
          state: Database["public"]["Enums"]["wf_job_state"]
          title: string
          updated_at: string
          verified_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "wf_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      wf_return_artifact: {
        Args: {
          _bucket_id: string
          _job_id: string
          _kind: Database["public"]["Enums"]["wf_artifact_kind"]
          _object_path: string
          _run_id: string
          _sha256?: string
          _size_bytes?: number
        }
        Returns: {
          bucket_id: string
          created_at: string
          created_by: string | null
          id: string
          job_id: string
          kind: Database["public"]["Enums"]["wf_artifact_kind"]
          object_path: string
          run_id: string | null
          sha256: string | null
          size_bytes: number | null
        }
        SetofOptions: {
          from: "*"
          to: "wf_artifacts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      wf_transition_job_state: {
        Args: {
          _actor_type?: Database["public"]["Enums"]["wf_actor_type"]
          _job_id: string
          _reason?: string
          _to_state: Database["public"]["Enums"]["wf_job_state"]
        }
        Returns: {
          created_at: string
          created_by: string
          id: string
          payload: Json
          promoted_at: string | null
          ratified_at: string | null
          state: Database["public"]["Enums"]["wf_job_state"]
          title: string
          updated_at: string
          verified_at: string | null
        }
        SetofOptions: {
          from: "*"
          to: "wf_jobs"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      zones_for_site: {
        Args: { p_site_id: string }
        Returns: {
          boundary: unknown
          parent_zone_id: string
          zone_id: string
          zone_name: string
        }[]
      }
    }
    Enums: {
      report_severity: "low" | "medium" | "high" | "critical"
      report_status: "draft" | "submitted" | "reviewed" | "closed"
      report_type: "incident" | "maintenance" | "health_safety"
      wf_actor_type: "user" | "runner" | "system"
      wf_app_role: "requester" | "verifier" | "ratifier" | "operator" | "runner"
      wf_approval_decision: "approved" | "rejected"
      wf_approval_stage: "verify" | "ratify"
      wf_artifact_kind: "log" | "report" | "bundle"
      wf_job_state:
        | "draft"
        | "verify_pending"
        | "verified"
        | "ratify_pending"
        | "ratified"
        | "running"
        | "promoted"
        | "failed"
      wf_run_status: "queued" | "picked_up" | "succeeded" | "failed"
    }
    CompositeTypes: {
      access_basis_verdict: {
        id: string | null
        decision_state: string | null
        granted_basis: string | null
        failed_gate: string | null
        expiry_end_condition: string | null
        sensitivity_mode: string | null
        message_key: string | null
      }
      geometry_dump: {
        path: number[] | null
        geom: unknown
      }
      valid_detail: {
        valid: boolean | null
        reason: string | null
        location: unknown
      }
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      report_severity: ["low", "medium", "high", "critical"],
      report_status: ["draft", "submitted", "reviewed", "closed"],
      report_type: ["incident", "maintenance", "health_safety"],
      wf_actor_type: ["user", "runner", "system"],
      wf_app_role: ["requester", "verifier", "ratifier", "operator", "runner"],
      wf_approval_decision: ["approved", "rejected"],
      wf_approval_stage: ["verify", "ratify"],
      wf_artifact_kind: ["log", "report", "bundle"],
      wf_job_state: [
        "draft",
        "verify_pending",
        "verified",
        "ratify_pending",
        "ratified",
        "running",
        "promoted",
        "failed",
      ],
      wf_run_status: ["queued", "picked_up", "succeeded", "failed"],
    },
  },
} as const
