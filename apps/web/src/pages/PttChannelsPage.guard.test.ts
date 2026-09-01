import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const officerSource = readFileSync(resolve(process.cwd(), 'src/pages/OfficerVoiceConsentPage.tsx'), 'utf8');
const adminSource = readFileSync(resolve(process.cwd(), 'src/pages/PttChannelsPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/OfficerShell.tsx'), 'utf8');
const adminShell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');
const fieldOps = readFileSync(resolve(process.cwd(), 'src/pages/FieldOperationsPage.tsx'), 'utf8');

describe('OfficerVoiceConsentPage', () => {
  it('grants/revokes consent through the RPC rather than a direct table write', () => {
    expect(officerSource).toContain("supabase.rpc('record_voice_consent'");
    expect(officerSource).not.toContain("from('radio_voice_consents').insert(");
  });

  it('is wired as an officer module', () => {
    expect(shell).toContain("case 'voice_consent':");
    expect(shell).toContain('<OfficerVoiceConsentPage />');
  });
});

describe('PttChannelsPage', () => {
  it('manages channels via a direct write, since RLS already grants org-admin insert/update', () => {
    expect(adminSource).toContain("from('ptt_channels').insert(");
    expect(adminSource).toContain("from('ptt_channels').update(");
  });

  it('is wired as a field-ops sub-area reachable from the operations landing grid', () => {
    expect(adminShell).toContain("'ptt-channels'");
    expect(adminShell).toContain("case 'ptt-channels':");
    expect(adminShell).toContain('<PttChannelsPage />');
    expect(fieldOps).toContain("area: 'ptt-channels'");
  });
});
