import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const prompt = readFileSync(resolve(process.cwd(), '../../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');

describe('Bob NZ finance policy', () => {
  it('distinguishes management information from filed or statutory finance', () => {
    expect(prompt).toContain('[NZ FINANCE POLICY]');
    expect(prompt).toContain('Treat finance outputs as management information');
    expect(prompt).toContain('Separate money earned, money received, costs incurred, GST, and profit');
  });

  it('requires authoritative sources and human approval for consequential finance decisions', () => {
    expect(prompt).toContain('official IRD or other authoritative source material');
    expect(prompt).toContain('Never guess a tax rate, filing due date, deductibility treatment, or accounting standard');
    expect(prompt).toContain('a human must approve filing, payment, period close, journal adjustments');
  });
});
