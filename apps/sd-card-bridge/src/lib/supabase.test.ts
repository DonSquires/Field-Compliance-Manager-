import { describe, expect, it } from 'vitest';
import { FCM_SUPABASE_URL, getSupabaseClient } from './supabase';

describe('desktop Supabase client', () => {
  it('creates a direct client for the FCM project', () => {
    const client = getSupabaseClient();
    expect(FCM_SUPABASE_URL).toBe('https://dotczcyyzgabmtmnglqj.supabase.co');
    expect(client.auth.signInWithPassword).toBeTypeOf('function');
  });
});
