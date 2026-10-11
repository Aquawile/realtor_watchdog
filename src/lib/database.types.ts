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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      comment_reactions: {
        Row: {
          comment_id: string
          created_at: string
          user_id: string
          value: number
        }
        Insert: {
          comment_id: string
          created_at?: string
          user_id: string
          value: number
        }
        Update: {
          comment_id?: string
          created_at?: string
          user_id?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "comment_reactions_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comment_feed"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comment_reactions_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comment_reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comment_reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      comments: {
        Row: {
          author_id: string | null
          body: string | null
          created_at: string
          dislike_count: number
          edited_at: string | null
          id: string
          like_count: number
          moderator_label: string | null
          parent_comment_id: string | null
          review_id: string
          status: Database["public"]["Enums"]["content_status"]
        }
        Insert: {
          author_id?: string | null
          body?: string | null
          created_at?: string
          dislike_count?: number
          edited_at?: string | null
          id?: string
          like_count?: number
          moderator_label?: string | null
          parent_comment_id?: string | null
          review_id: string
          status?: Database["public"]["Enums"]["content_status"]
        }
        Update: {
          author_id?: string | null
          body?: string | null
          created_at?: string
          dislike_count?: number
          edited_at?: string | null
          id?: string
          like_count?: number
          moderator_label?: string | null
          parent_comment_id?: string | null
          review_id?: string
          status?: Database["public"]["Enums"]["content_status"]
        }
        Relationships: [
          {
            foreignKeyName: "comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "public_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_parent_comment_id_fkey"
            columns: ["parent_comment_id"]
            isOneToOne: false
            referencedRelation: "comment_feed"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_parent_comment_id_fkey"
            columns: ["parent_comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "review_feed"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      dre_actions: {
        Row: {
          action_date: string | null
          document_url: string | null
          id: number
          kind: string
          license_number: string
          seq: number
          text_verbatim: string
        }
        Insert: {
          action_date?: string | null
          document_url?: string | null
          id?: never
          kind: string
          license_number: string
          seq: number
          text_verbatim: string
        }
        Update: {
          action_date?: string | null
          document_url?: string | null
          id?: never
          kind?: string
          license_number?: string
          seq?: number
          text_verbatim?: string
        }
        Relationships: [
          {
            foreignKeyName: "dre_actions_license_number_fkey"
            columns: ["license_number"]
            isOneToOne: false
            referencedRelation: "dre_licensee_records"
            referencedColumns: ["license_number"]
          },
          {
            foreignKeyName: "dre_actions_license_number_fkey"
            columns: ["license_number"]
            isOneToOne: false
            referencedRelation: "public_dre_records"
            referencedColumns: ["license_number"]
          },
        ]
      }
      dre_affiliations: {
        Row: {
          corporation_restricted: boolean | null
          ended_on: string | null
          ended_status: string | null
          from_date: string | null
          id: number
          is_current: boolean
          kind: string
          license_number: string
          officer_restricted: boolean | null
          raw_text: string
          related_expiration_date: string | null
          related_license_number: string | null
          related_name: string | null
          seq: number
          to_date: string | null
        }
        Insert: {
          corporation_restricted?: boolean | null
          ended_on?: string | null
          ended_status?: string | null
          from_date?: string | null
          id?: never
          is_current: boolean
          kind: string
          license_number: string
          officer_restricted?: boolean | null
          raw_text: string
          related_expiration_date?: string | null
          related_license_number?: string | null
          related_name?: string | null
          seq: number
          to_date?: string | null
        }
        Update: {
          corporation_restricted?: boolean | null
          ended_on?: string | null
          ended_status?: string | null
          from_date?: string | null
          id?: never
          is_current?: boolean
          kind?: string
          license_number?: string
          officer_restricted?: boolean | null
          raw_text?: string
          related_expiration_date?: string | null
          related_license_number?: string | null
          related_name?: string | null
          seq?: number
          to_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dre_affiliations_license_number_fkey"
            columns: ["license_number"]
            isOneToOne: false
            referencedRelation: "dre_licensee_records"
            referencedColumns: ["license_number"]
          },
          {
            foreignKeyName: "dre_affiliations_license_number_fkey"
            columns: ["license_number"]
            isOneToOne: false
            referencedRelation: "public_dre_records"
            referencedColumns: ["license_number"]
          },
        ]
      }
      dre_ingest_runs: {
        Row: {
          bulk_file_id: number | null
          error: string | null
          finished_at: string | null
          id: number
          inserted: number | null
          marked_not_in_file: number | null
          rows_in_file: number | null
          rows_in_scope: number | null
          source_url: string
          started_at: string
          status: string
          unchanged: number | null
          updated: number | null
        }
        Insert: {
          bulk_file_id?: number | null
          error?: string | null
          finished_at?: string | null
          id?: never
          inserted?: number | null
          marked_not_in_file?: number | null
          rows_in_file?: number | null
          rows_in_scope?: number | null
          source_url: string
          started_at?: string
          status?: string
          unchanged?: number | null
          updated?: number | null
        }
        Update: {
          bulk_file_id?: number | null
          error?: string | null
          finished_at?: string | null
          id?: never
          inserted?: number | null
          marked_not_in_file?: number | null
          rows_in_file?: number | null
          rows_in_scope?: number | null
          source_url?: string
          started_at?: string
          status?: string
          unchanged?: number | null
          updated?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "dre_ingest_runs_bulk_file_id_fkey"
            columns: ["bulk_file_id"]
            isOneToOne: false
            referencedRelation: "raw_dre_bulk_files"
            referencedColumns: ["id"]
          },
        ]
      }
      dre_licensee_records: {
        Row: {
          broker_associates_count_reported: number | null
          broker_license_issued: string | null
          company_mlo_nmls_id: string | null
          dre_records_as_of: string | null
          expiration_date: string | null
          expiration_note: string | null
          former_names: string[]
          is_non_working: boolean
          is_restricted: boolean
          issued_dates_unofficial: boolean
          license_number: string
          license_status_raw: string
          license_type: string
          mlo_nmls_id: string | null
          name_as_listed: string
          page_encoding: string
          parser_version: number
          processed_at: string
          salesperson_license_issued: string | null
          salespersons_count_reported: number | null
          source_fetch_id: number
          unparsed_lines: Json
        }
        Insert: {
          broker_associates_count_reported?: number | null
          broker_license_issued?: string | null
          company_mlo_nmls_id?: string | null
          dre_records_as_of?: string | null
          expiration_date?: string | null
          expiration_note?: string | null
          former_names?: string[]
          is_non_working: boolean
          is_restricted: boolean
          issued_dates_unofficial?: boolean
          license_number: string
          license_status_raw: string
          license_type: string
          mlo_nmls_id?: string | null
          name_as_listed: string
          page_encoding: string
          parser_version: number
          processed_at?: string
          salesperson_license_issued?: string | null
          salespersons_count_reported?: number | null
          source_fetch_id: number
          unparsed_lines?: Json
        }
        Update: {
          broker_associates_count_reported?: number | null
          broker_license_issued?: string | null
          company_mlo_nmls_id?: string | null
          dre_records_as_of?: string | null
          expiration_date?: string | null
          expiration_note?: string | null
          former_names?: string[]
          is_non_working?: boolean
          is_restricted?: boolean
          issued_dates_unofficial?: boolean
          license_number?: string
          license_status_raw?: string
          license_type?: string
          mlo_nmls_id?: string | null
          name_as_listed?: string
          page_encoding?: string
          parser_version?: number
          processed_at?: string
          salesperson_license_issued?: string | null
          salespersons_count_reported?: number | null
          source_fetch_id?: number
          unparsed_lines?: Json
        }
        Relationships: [
          {
            foreignKeyName: "dre_licensee_records_source_fetch_id_fkey"
            columns: ["source_fetch_id"]
            isOneToOne: false
            referencedRelation: "raw_dre_page_fetches"
            referencedColumns: ["id"]
          },
        ]
      }
      dre_process_runs: {
        Row: {
          action_rows: number
          affiliation_rows: number
          error: string | null
          finished_at: string | null
          id: number
          pages_considered: number | null
          pages_failed: number
          pages_processed: number
          pages_skipped: number
          pages_with_unparsed: number
          parser_version: number
          runner: string | null
          started_at: string
          status: string
        }
        Insert: {
          action_rows?: number
          affiliation_rows?: number
          error?: string | null
          finished_at?: string | null
          id?: never
          pages_considered?: number | null
          pages_failed?: number
          pages_processed?: number
          pages_skipped?: number
          pages_with_unparsed?: number
          parser_version: number
          runner?: string | null
          started_at?: string
          status?: string
        }
        Update: {
          action_rows?: number
          affiliation_rows?: number
          error?: string | null
          finished_at?: string | null
          id?: never
          pages_considered?: number | null
          pages_failed?: number
          pages_processed?: number
          pages_skipped?: number
          pages_with_unparsed?: number
          parser_version?: number
          runner?: string | null
          started_at?: string
          status?: string
        }
        Relationships: []
      }
      moderation_actions: {
        Row: {
          action: Database["public"]["Enums"]["moderation_action_type"]
          comment_id: string | null
          created_at: string
          id: number
          moderator_id: string | null
          reason: string | null
          review_id: string | null
        }
        Insert: {
          action: Database["public"]["Enums"]["moderation_action_type"]
          comment_id?: string | null
          created_at?: string
          id?: never
          moderator_id?: string | null
          reason?: string | null
          review_id?: string | null
        }
        Update: {
          action?: Database["public"]["Enums"]["moderation_action_type"]
          comment_id?: string | null
          created_at?: string
          id?: never
          moderator_id?: string | null
          reason?: string | null
          review_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "moderation_actions_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comment_feed"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "moderation_actions_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "moderation_actions_moderator_id_fkey"
            columns: ["moderator_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "moderation_actions_moderator_id_fkey"
            columns: ["moderator_id"]
            isOneToOne: false
            referencedRelation: "public_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "moderation_actions_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "review_feed"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "moderation_actions_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["user_role"]
          updated_at: string
          username: string
        }
        Insert: {
          created_at?: string
          id: string
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
          username: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["user_role"]
          updated_at?: string
          username?: string
        }
        Relationships: []
      }
      properties: {
        Row: {
          address_display: string
          address_normalized: string
          apn: string | null
          city: string | null
          created_at: string
          id: string
          latitude: number | null
          longitude: number | null
          updated_at: string
          zip: string | null
        }
        Insert: {
          address_display: string
          address_normalized: string
          apn?: string | null
          city?: string | null
          created_at?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          updated_at?: string
          zip?: string | null
        }
        Update: {
          address_display?: string
          address_normalized?: string
          apn?: string | null
          city?: string | null
          created_at?: string
          id?: string
          latitude?: number | null
          longitude?: number | null
          updated_at?: string
          zip?: string | null
        }
        Relationships: []
      }
      property_source_data: {
        Row: {
          expires_at: string
          fetched_at: string
          payload: Json
          property_id: string
          source: string
          source_url: string
        }
        Insert: {
          expires_at: string
          fetched_at?: string
          payload: Json
          property_id: string
          source: string
          source_url: string
        }
        Update: {
          expires_at?: string
          fetched_at?: string
          payload?: Json
          property_id?: string
          source?: string
          source_url?: string
        }
        Relationships: [
          {
            foreignKeyName: "property_source_data_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_archives: {
        Row: {
          byte_size: number
          created_at: string
          description: string
          id: number
          row_count: number | null
          sha256: string
          storage_path: string
        }
        Insert: {
          byte_size: number
          created_at?: string
          description: string
          id?: never
          row_count?: number | null
          sha256: string
          storage_path: string
        }
        Update: {
          byte_size?: number
          created_at?: string
          description?: string
          id?: never
          row_count?: number | null
          sha256?: string
          storage_path?: string
        }
        Relationships: []
      }
      raw_dre_bulk_files: {
        Row: {
          byte_size: number
          fetched_at: string
          http_status: number
          id: number
          purged_at: string | null
          sha256_raw: string
          source_url: string
          storage_path: string | null
        }
        Insert: {
          byte_size: number
          fetched_at?: string
          http_status: number
          id?: never
          purged_at?: string | null
          sha256_raw: string
          source_url: string
          storage_path?: string | null
        }
        Update: {
          byte_size?: number
          fetched_at?: string
          http_status?: number
          id?: never
          purged_at?: string | null
          sha256_raw?: string
          source_url?: string
          storage_path?: string | null
        }
        Relationships: []
      }
      raw_dre_bundles: {
        Row: {
          byte_size: number
          created_at: string
          entry_count: number
          first_license: string | null
          id: number
          last_license: string | null
          sha256: string
          storage_path: string
          verified_at: string | null
        }
        Insert: {
          byte_size: number
          created_at?: string
          entry_count: number
          first_license?: string | null
          id?: never
          last_license?: string | null
          sha256: string
          storage_path: string
          verified_at?: string | null
        }
        Update: {
          byte_size?: number
          created_at?: string
          entry_count?: number
          first_license?: string | null
          id?: never
          last_license?: string | null
          sha256?: string
          storage_path?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      raw_dre_fetch_batches: {
        Row: {
          attempted: number
          baseline_ms: number | null
          bulk_file_id: number | null
          current_concurrency: number | null
          error_count: number
          finished_at: string | null
          first_license: string | null
          id: number
          incomplete_count: number
          last_heartbeat_at: string
          last_license: string | null
          max_concurrency_used: number | null
          median_ms: number | null
          not_found_count: number
          ok_count: number
          p90_ms: number | null
          planned_count: number | null
          runner: string | null
          settings: Json
          started_at: string
          status: string
          stop_reason: string | null
          verify_failed_count: number
          window_median_ms: number | null
          window_ratio: number | null
        }
        Insert: {
          attempted?: number
          baseline_ms?: number | null
          bulk_file_id?: number | null
          current_concurrency?: number | null
          error_count?: number
          finished_at?: string | null
          first_license?: string | null
          id?: never
          incomplete_count?: number
          last_heartbeat_at?: string
          last_license?: string | null
          max_concurrency_used?: number | null
          median_ms?: number | null
          not_found_count?: number
          ok_count?: number
          p90_ms?: number | null
          planned_count?: number | null
          runner?: string | null
          settings?: Json
          started_at?: string
          status?: string
          stop_reason?: string | null
          verify_failed_count?: number
          window_median_ms?: number | null
          window_ratio?: number | null
        }
        Update: {
          attempted?: number
          baseline_ms?: number | null
          bulk_file_id?: number | null
          current_concurrency?: number | null
          error_count?: number
          finished_at?: string | null
          first_license?: string | null
          id?: never
          incomplete_count?: number
          last_heartbeat_at?: string
          last_license?: string | null
          max_concurrency_used?: number | null
          median_ms?: number | null
          not_found_count?: number
          ok_count?: number
          p90_ms?: number | null
          planned_count?: number | null
          runner?: string | null
          settings?: Json
          started_at?: string
          status?: string
          stop_reason?: string | null
          verify_failed_count?: number
          window_median_ms?: number | null
          window_ratio?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "raw_dre_fetch_batches_bulk_file_id_fkey"
            columns: ["bulk_file_id"]
            isOneToOne: false
            referencedRelation: "raw_dre_bulk_files"
            referencedColumns: ["id"]
          },
        ]
      }
      raw_dre_page_fetches: {
        Row: {
          attempts: number
          batch_id: number
          bundle_entry: string | null
          bundle_id: number | null
          byte_size: number | null
          duration_ms: number | null
          error: string | null
          fetched_at: string
          http_status: number | null
          id: number
          license_number: string
          outcome: string
          sha256_raw: string | null
          storage_path: string | null
          verified_at: string | null
        }
        Insert: {
          attempts?: number
          batch_id: number
          bundle_entry?: string | null
          bundle_id?: number | null
          byte_size?: number | null
          duration_ms?: number | null
          error?: string | null
          fetched_at?: string
          http_status?: number | null
          id?: never
          license_number: string
          outcome: string
          sha256_raw?: string | null
          storage_path?: string | null
          verified_at?: string | null
        }
        Update: {
          attempts?: number
          batch_id?: number
          bundle_entry?: string | null
          bundle_id?: number | null
          byte_size?: number | null
          duration_ms?: number | null
          error?: string | null
          fetched_at?: string
          http_status?: number | null
          id?: never
          license_number?: string
          outcome?: string
          sha256_raw?: string | null
          storage_path?: string | null
          verified_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "raw_dre_page_fetches_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "raw_dre_fetch_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "raw_dre_page_fetches_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "raw_dre_bundles"
            referencedColumns: ["id"]
          },
        ]
      }
      realtor_history: {
        Row: {
          changed_at: string
          id: number
          license_number: string
          new_values: Json
          old_values: Json
        }
        Insert: {
          changed_at?: string
          id?: never
          license_number: string
          new_values: Json
          old_values: Json
        }
        Update: {
          changed_at?: string
          id?: never
          license_number?: string
          new_values?: Json
          old_values?: Json
        }
        Relationships: [
          {
            foreignKeyName: "realtor_history_license_number_fkey"
            columns: ["license_number"]
            isOneToOne: false
            referencedRelation: "public_realtors"
            referencedColumns: ["license_number"]
          },
          {
            foreignKeyName: "realtor_history_license_number_fkey"
            columns: ["license_number"]
            isOneToOne: false
            referencedRelation: "realtors"
            referencedColumns: ["license_number"]
          },
        ]
      }
      realtors: {
        Row: {
          city: string | null
          county: string | null
          created_at: string
          dre_fingerprint: string | null
          employing_broker_license_number: string | null
          employing_broker_name: string | null
          first_name: string | null
          full_name: string | null
          in_current_dre_file: boolean
          last_name: string
          last_seen_in_dre_file_at: string
          license_effective_date: string | null
          license_expiration_date: string | null
          license_number: string
          license_status: string
          license_type: Database["public"]["Enums"]["realtor_license_type"]
          name_suffix: string | null
          officer_of: Json
          original_license_date: string | null
          restricted_license: boolean
          search_vector: unknown
          updated_at: string
        }
        Insert: {
          city?: string | null
          county?: string | null
          created_at?: string
          dre_fingerprint?: string | null
          employing_broker_license_number?: string | null
          employing_broker_name?: string | null
          first_name?: string | null
          full_name?: string | null
          in_current_dre_file?: boolean
          last_name: string
          last_seen_in_dre_file_at?: string
          license_effective_date?: string | null
          license_expiration_date?: string | null
          license_number: string
          license_status: string
          license_type: Database["public"]["Enums"]["realtor_license_type"]
          name_suffix?: string | null
          officer_of?: Json
          original_license_date?: string | null
          restricted_license?: boolean
          search_vector?: unknown
          updated_at?: string
        }
        Update: {
          city?: string | null
          county?: string | null
          created_at?: string
          dre_fingerprint?: string | null
          employing_broker_license_number?: string | null
          employing_broker_name?: string | null
          first_name?: string | null
          full_name?: string | null
          in_current_dre_file?: boolean
          last_name?: string
          last_seen_in_dre_file_at?: string
          license_effective_date?: string | null
          license_expiration_date?: string | null
          license_number?: string
          license_status?: string
          license_type?: Database["public"]["Enums"]["realtor_license_type"]
          name_suffix?: string | null
          officer_of?: Json
          original_license_date?: string | null
          restricted_license?: boolean
          search_vector?: unknown
          updated_at?: string
        }
        Relationships: []
      }
      reports: {
        Row: {
          comment_id: string | null
          created_at: string
          id: string
          notes: string | null
          reason: Database["public"]["Enums"]["report_reason"]
          reporter_id: string | null
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          review_id: string | null
          status: Database["public"]["Enums"]["report_status"]
          target_type: Database["public"]["Enums"]["content_target"]
        }
        Insert: {
          comment_id?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          reason: Database["public"]["Enums"]["report_reason"]
          reporter_id?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          review_id?: string | null
          status?: Database["public"]["Enums"]["report_status"]
          target_type: Database["public"]["Enums"]["content_target"]
        }
        Update: {
          comment_id?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          reason?: Database["public"]["Enums"]["report_reason"]
          reporter_id?: string | null
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          review_id?: string | null
          status?: Database["public"]["Enums"]["report_status"]
          target_type?: Database["public"]["Enums"]["content_target"]
        }
        Relationships: [
          {
            foreignKeyName: "reports_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comment_feed"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_comment_id_fkey"
            columns: ["comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_reporter_id_fkey"
            columns: ["reporter_id"]
            isOneToOne: false
            referencedRelation: "public_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "public_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "review_feed"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reports_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      review_documents: {
        Row: {
          created_at: string
          id: string
          mime_type: string
          review_id: string
          size_bytes: number
          storage_path: string
          uploader_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          mime_type: string
          review_id: string
          size_bytes: number
          storage_path: string
          uploader_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          mime_type?: string
          review_id?: string
          size_bytes?: number
          storage_path?: string
          uploader_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "review_documents_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "review_feed"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_documents_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_documents_uploader_id_fkey"
            columns: ["uploader_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_documents_uploader_id_fkey"
            columns: ["uploader_id"]
            isOneToOne: false
            referencedRelation: "public_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      review_reactions: {
        Row: {
          created_at: string
          review_id: string
          user_id: string
          value: number
        }
        Insert: {
          created_at?: string
          review_id: string
          user_id: string
          value: number
        }
        Update: {
          created_at?: string
          review_id?: string
          user_id?: string
          value?: number
        }
        Relationships: [
          {
            foreignKeyName: "review_reactions_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "review_feed"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_reactions_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "review_reactions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "public_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      reviews: {
        Row: {
          author_id: string | null
          body: string | null
          comment_count: number
          created_at: string
          dislike_count: number
          edited_at: string | null
          id: string
          is_verified_client: boolean
          like_count: number
          moderator_label: string | null
          rating: number
          realtor_license_number: string
          relationship_tag: Database["public"]["Enums"]["relationship_tag"]
          status: Database["public"]["Enums"]["content_status"]
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          author_id?: string | null
          body?: string | null
          comment_count?: number
          created_at?: string
          dislike_count?: number
          edited_at?: string | null
          id?: string
          is_verified_client?: boolean
          like_count?: number
          moderator_label?: string | null
          rating: number
          realtor_license_number: string
          relationship_tag: Database["public"]["Enums"]["relationship_tag"]
          status?: Database["public"]["Enums"]["content_status"]
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          author_id?: string | null
          body?: string | null
          comment_count?: number
          created_at?: string
          dislike_count?: number
          edited_at?: string | null
          id?: string
          is_verified_client?: boolean
          like_count?: number
          moderator_label?: string | null
          rating?: number
          realtor_license_number?: string
          relationship_tag?: Database["public"]["Enums"]["relationship_tag"]
          status?: Database["public"]["Enums"]["content_status"]
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reviews_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "public_profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_realtor_license_number_fkey"
            columns: ["realtor_license_number"]
            isOneToOne: false
            referencedRelation: "public_realtors"
            referencedColumns: ["license_number"]
          },
          {
            foreignKeyName: "reviews_realtor_license_number_fkey"
            columns: ["realtor_license_number"]
            isOneToOne: false
            referencedRelation: "realtors"
            referencedColumns: ["license_number"]
          },
          {
            foreignKeyName: "reviews_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reviews_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "public_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      comment_feed: {
        Row: {
          author_username: string | null
          body: string | null
          created_at: string | null
          dislike_count: number | null
          edited_at: string | null
          id: string | null
          like_count: number | null
          moderator_label: string | null
          parent_comment_id: string | null
          review_id: string | null
          status: Database["public"]["Enums"]["content_status"] | null
        }
        Relationships: [
          {
            foreignKeyName: "comments_parent_comment_id_fkey"
            columns: ["parent_comment_id"]
            isOneToOne: false
            referencedRelation: "comment_feed"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_parent_comment_id_fkey"
            columns: ["parent_comment_id"]
            isOneToOne: false
            referencedRelation: "comments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "review_feed"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "comments_review_id_fkey"
            columns: ["review_id"]
            isOneToOne: false
            referencedRelation: "reviews"
            referencedColumns: ["id"]
          },
        ]
      }
      public_dre_actions: {
        Row: {
          action_date: string | null
          document_url: string | null
          kind: string | null
          license_number: string | null
          seq: number | null
          text_verbatim: string | null
        }
        Insert: {
          action_date?: string | null
          document_url?: string | null
          kind?: string | null
          license_number?: string | null
          seq?: number | null
          text_verbatim?: string | null
        }
        Update: {
          action_date?: string | null
          document_url?: string | null
          kind?: string | null
          license_number?: string | null
          seq?: number | null
          text_verbatim?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dre_actions_license_number_fkey"
            columns: ["license_number"]
            isOneToOne: false
            referencedRelation: "dre_licensee_records"
            referencedColumns: ["license_number"]
          },
          {
            foreignKeyName: "dre_actions_license_number_fkey"
            columns: ["license_number"]
            isOneToOne: false
            referencedRelation: "public_dre_records"
            referencedColumns: ["license_number"]
          },
        ]
      }
      public_dre_affiliations: {
        Row: {
          corporation_restricted: boolean | null
          ended_on: string | null
          ended_status: string | null
          from_date: string | null
          is_current: boolean | null
          kind: string | null
          license_number: string | null
          officer_restricted: boolean | null
          raw_text: string | null
          related_expiration_date: string | null
          related_license_number: string | null
          related_name: string | null
          seq: number | null
          to_date: string | null
        }
        Insert: {
          corporation_restricted?: boolean | null
          ended_on?: string | null
          ended_status?: string | null
          from_date?: string | null
          is_current?: boolean | null
          kind?: string | null
          license_number?: string | null
          officer_restricted?: boolean | null
          raw_text?: string | null
          related_expiration_date?: string | null
          related_license_number?: string | null
          related_name?: string | null
          seq?: number | null
          to_date?: string | null
        }
        Update: {
          corporation_restricted?: boolean | null
          ended_on?: string | null
          ended_status?: string | null
          from_date?: string | null
          is_current?: boolean | null
          kind?: string | null
          license_number?: string | null
          officer_restricted?: boolean | null
          raw_text?: string | null
          related_expiration_date?: string | null
          related_license_number?: string | null
          related_name?: string | null
          seq?: number | null
          to_date?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "dre_affiliations_license_number_fkey"
            columns: ["license_number"]
            isOneToOne: false
            referencedRelation: "dre_licensee_records"
            referencedColumns: ["license_number"]
          },
          {
            foreignKeyName: "dre_affiliations_license_number_fkey"
            columns: ["license_number"]
            isOneToOne: false
            referencedRelation: "public_dre_records"
            referencedColumns: ["license_number"]
          },
        ]
      }
      public_dre_records: {
        Row: {
          broker_associates_count_reported: number | null
          broker_license_issued: string | null
          company_mlo_nmls_id: string | null
          dre_records_as_of: string | null
          expiration_date: string | null
          expiration_note: string | null
          former_names: string[] | null
          is_non_working: boolean | null
          is_restricted: boolean | null
          issued_dates_unofficial: boolean | null
          license_number: string | null
          license_status_raw: string | null
          license_type: string | null
          mlo_nmls_id: string | null
          name_as_listed: string | null
          salesperson_license_issued: string | null
          salespersons_count_reported: number | null
        }
        Insert: {
          broker_associates_count_reported?: number | null
          broker_license_issued?: string | null
          company_mlo_nmls_id?: string | null
          dre_records_as_of?: string | null
          expiration_date?: string | null
          expiration_note?: string | null
          former_names?: string[] | null
          is_non_working?: boolean | null
          is_restricted?: boolean | null
          issued_dates_unofficial?: boolean | null
          license_number?: string | null
          license_status_raw?: string | null
          license_type?: string | null
          mlo_nmls_id?: string | null
          name_as_listed?: string | null
          salesperson_license_issued?: string | null
          salespersons_count_reported?: number | null
        }
        Update: {
          broker_associates_count_reported?: number | null
          broker_license_issued?: string | null
          company_mlo_nmls_id?: string | null
          dre_records_as_of?: string | null
          expiration_date?: string | null
          expiration_note?: string | null
          former_names?: string[] | null
          is_non_working?: boolean | null
          is_restricted?: boolean | null
          issued_dates_unofficial?: boolean | null
          license_number?: string | null
          license_status_raw?: string | null
          license_type?: string | null
          mlo_nmls_id?: string | null
          name_as_listed?: string | null
          salesperson_license_issued?: string | null
          salespersons_count_reported?: number | null
        }
        Relationships: []
      }
      public_profiles: {
        Row: {
          created_at: string | null
          id: string | null
          username: string | null
        }
        Insert: {
          created_at?: string | null
          id?: string | null
          username?: never
        }
        Update: {
          created_at?: string | null
          id?: string | null
          username?: never
        }
        Relationships: []
      }
      public_realtors: {
        Row: {
          city: string | null
          county: string | null
          dre_last_confirmed_at: string | null
          employing_broker_license_number: string | null
          employing_broker_name: string | null
          first_name: string | null
          full_name: string | null
          in_current_dre_file: boolean | null
          is_non_working: boolean | null
          last_name: string | null
          license_effective_date: string | null
          license_expiration_date: string | null
          license_number: string | null
          license_status: string | null
          license_type:
            | Database["public"]["Enums"]["realtor_license_type"]
            | null
          name_suffix: string | null
          officer_of: Json | null
          original_license_date: string | null
          restricted_license: boolean | null
          search_vector: unknown
        }
        Insert: {
          city?: string | null
          county?: string | null
          dre_last_confirmed_at?: never
          employing_broker_license_number?: string | null
          employing_broker_name?: string | null
          first_name?: string | null
          full_name?: string | null
          in_current_dre_file?: boolean | null
          is_non_working?: never
          last_name?: string | null
          license_effective_date?: string | null
          license_expiration_date?: string | null
          license_number?: string | null
          license_status?: string | null
          license_type?:
            | Database["public"]["Enums"]["realtor_license_type"]
            | null
          name_suffix?: string | null
          officer_of?: Json | null
          original_license_date?: string | null
          restricted_license?: boolean | null
          search_vector?: unknown
        }
        Update: {
          city?: string | null
          county?: string | null
          dre_last_confirmed_at?: never
          employing_broker_license_number?: string | null
          employing_broker_name?: string | null
          first_name?: string | null
          full_name?: string | null
          in_current_dre_file?: boolean | null
          is_non_working?: never
          last_name?: string | null
          license_effective_date?: string | null
          license_expiration_date?: string | null
          license_number?: string | null
          license_status?: string | null
          license_type?:
            | Database["public"]["Enums"]["realtor_license_type"]
            | null
          name_suffix?: string | null
          officer_of?: Json | null
          original_license_date?: string | null
          restricted_license?: boolean | null
          search_vector?: unknown
        }
        Relationships: []
      }
      realtor_rating_summary: {
        Row: {
          average_rating: number | null
          realtor_license_number: string | null
          review_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "reviews_realtor_license_number_fkey"
            columns: ["realtor_license_number"]
            isOneToOne: false
            referencedRelation: "public_realtors"
            referencedColumns: ["license_number"]
          },
          {
            foreignKeyName: "reviews_realtor_license_number_fkey"
            columns: ["realtor_license_number"]
            isOneToOne: false
            referencedRelation: "realtors"
            referencedColumns: ["license_number"]
          },
        ]
      }
      review_feed: {
        Row: {
          author_username: string | null
          body: string | null
          comment_count: number | null
          created_at: string | null
          dislike_count: number | null
          edited_at: string | null
          id: string | null
          is_verified_client: boolean | null
          like_count: number | null
          moderator_label: string | null
          rating: number | null
          realtor_license_number: string | null
          relationship_tag:
            | Database["public"]["Enums"]["relationship_tag"]
            | null
          status: Database["public"]["Enums"]["content_status"] | null
        }
        Relationships: [
          {
            foreignKeyName: "reviews_realtor_license_number_fkey"
            columns: ["realtor_license_number"]
            isOneToOne: false
            referencedRelation: "public_realtors"
            referencedColumns: ["license_number"]
          },
          {
            foreignKeyName: "reviews_realtor_license_number_fkey"
            columns: ["realtor_license_number"]
            isOneToOne: false
            referencedRelation: "realtors"
            referencedColumns: ["license_number"]
          },
        ]
      }
    }
    Functions: {
      auto_hide_threshold: { Args: never; Returns: number }
      delete_own_comment: { Args: { p_comment_id: string }; Returns: undefined }
      delete_own_review: { Args: { p_review_id: string }; Returns: undefined }
      dre_apply_parsed: { Args: { p: Json }; Returns: number }
      is_moderator: { Args: never; Returns: boolean }
      mark_realtors_seen: {
        Args: { p_license_numbers: string[]; p_seen_at: string }
        Returns: number
      }
      moderate_content: {
        Args: {
          p_action: Database["public"]["Enums"]["moderation_action_type"]
          p_id: string
          p_label?: string
          p_reason?: string
          p_target: Database["public"]["Enums"]["content_target"]
        }
        Returns: undefined
      }
      raw_dre_attach_bundle: {
        Args: { p: Json; p_bundle_id: number }
        Returns: number
      }
      review_accepts_comments: {
        Args: { p_review_id: string }
        Returns: boolean
      }
      set_verified_client: {
        Args: { p_reason?: string; p_review_id: string; p_verified: boolean }
        Returns: undefined
      }
      username_available: { Args: { p_username: string }; Returns: boolean }
    }
    Enums: {
      content_status:
        | "visible"
        | "hidden_pending_review"
        | "removed"
        | "deleted_by_author"
      content_target: "review" | "comment"
      moderation_action_type:
        | "remove"
        | "restore"
        | "label"
        | "unlabel"
        | "verify_client"
        | "unverify_client"
        | "dismiss_report"
      realtor_license_type: "salesperson" | "broker"
      relationship_tag: "buyer" | "seller"
      report_reason:
        | "false_statement"
        | "defamatory"
        | "threatening"
        | "private_information"
        | "spam"
        | "other"
      report_status: "open" | "dismissed" | "actioned"
      user_role: "user" | "moderator"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
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
      content_status: [
        "visible",
        "hidden_pending_review",
        "removed",
        "deleted_by_author",
      ],
      content_target: ["review", "comment"],
      moderation_action_type: [
        "remove",
        "restore",
        "label",
        "unlabel",
        "verify_client",
        "unverify_client",
        "dismiss_report",
      ],
      realtor_license_type: ["salesperson", "broker"],
      relationship_tag: ["buyer", "seller"],
      report_reason: [
        "false_statement",
        "defamatory",
        "threatening",
        "private_information",
        "spam",
        "other",
      ],
      report_status: ["open", "dismissed", "actioned"],
      user_role: ["user", "moderator"],
    },
  },
} as const
