import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), '../../supabase/migrations/20261016102716_govern_bob_message_feedback.sql'),
  'utf8'
);
const component = readFileSync(resolve(process.cwd(), 'src/components/BobPanel.tsx'), 'utf8');

describe('governed Bob message feedback', () => {
  it('derives tenant and user linkage from the persisted assistant message', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION public.manage_bob_message_feedback');
    expect(migration).toContain("v_message.role <> 'assistant'");
    expect(migration).toContain('v_conversation.user_id <> v_actor');
    expect(migration).toContain('NOT public.org_access_allowed(v_message.organization_id)');
    expect(migration).toContain('v_message.organization_id');
    expect(migration).toContain('v_message.conversation_id');
    expect(migration).toContain('v_actor');
  });

  it('removes direct browser mutation and exposes only the governed command', () => {
    expect(migration).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.bob_message_feedback FROM PUBLIC, anon, authenticated');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public.manage_bob_message_feedback(uuid, text, text) FROM PUBLIC, anon');
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.manage_bob_message_feedback(uuid, text, text) TO authenticated, service_role');
  });

  it('reads persisted feedback and writes through the governed RPC with explicit UI states', () => {
    expect(component).toContain(".from('bob_message_feedback')");
    expect(component).toContain("supabase.rpc('manage_bob_message_feedback'");
    expect(component).toContain('Bob feedback was not confirmed after saving.');
    expect(component).toContain('What should Bob improve?');
    expect(component).toContain('Save feedback');
    expect(component).toContain('Cancel');
    expect(component).toContain('Saved reply feedback could not be loaded. Bob chat remains available.');
    expect(component).not.toMatch(/from\(['"]bob_message_feedback['"]\)[\s\S]{0,300}\.(insert|update|delete|upsert)\(/);
  });
});
