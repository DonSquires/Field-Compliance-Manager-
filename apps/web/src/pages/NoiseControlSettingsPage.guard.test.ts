import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/NoiseControlSettingsPage.tsx'), 'utf8');
const shell = readFileSync(resolve(process.cwd(), 'src/shells/AdminShell.tsx'), 'utf8');

describe('NoiseControlSettingsPage', () => {
  it('reads and upserts the org noise_module_config row', () => {
    expect(source).toContain("from('noise_module_config')");
    expect(source).toContain(".eq('organization_id', profile.organizationId)");
    expect(source).toContain('.upsert(');
    expect(source).toContain("onConflict: 'organization_id'");
  });

  it('exposes the excessive threshold and skip_verbal_warning without a code change', () => {
    expect(source).toContain('excessive_threshold: form.excessiveThreshold');
    expect(source).toContain('skip_verbal_warning: form.skipVerbalWarning');
  });
});

describe('Noise control settings routing', () => {
  it('is wired as a field-ops sub-area reachable from the oversight page', () => {
    expect(shell).toContain("'noise-control-settings'");
    expect(shell).toContain("case 'noise-control-settings':");
    expect(shell).toContain('<NoiseControlSettingsPage />');
    expect(shell).toContain("onNavigateSettings={() => navigateToFieldOps('noise-control-settings')}");
  });
});
