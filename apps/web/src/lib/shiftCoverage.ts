import { supabase } from './supabase';

export async function claimShiftCoverage(requestId: string): Promise<void> {
  const { data, error } = await supabase.rpc('claim_shift_coverage', {
    p_request_id: requestId,
    p_expected_status: 'open',
  });
  if (error) throw error;
  if (!data) throw new Error('The coverage claim was not confirmed.');
}