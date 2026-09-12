import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const caddie = readFileSync(resolve(process.cwd(), '../../supabase/functions/onspace-ai-chat/caddie.ts'), 'utf8');
const conductor = readFileSync(resolve(process.cwd(), '../../supabase/functions/onspace-ai-chat/index.ts'), 'utf8');
const doctrine = readFileSync(resolve(process.cwd(), '../../supabase/migrations/20260912153000_bob_patrol_import_operating_card.sql'), 'utf8');

describe('Bob patrol tool registration', () => {
  it('registers the planner in Caddie and maps it to its deployed edge function', () => {
    expect(caddie).toContain('plan_patrol_import:');
    expect(caddie).toContain("plan_patrol_import: 'bob-plan-patrol-import'");
    expect(conductor).toContain("allowedTools.push('ingest_document', 'plan_import', 'plan_patrol_import'");
    expect(conductor).toContain("case 'plan_patrol_import':");
    expect(conductor).toContain("callFn('bob-plan-patrol-import'");
  });

  it('keeps patrol planning read-only and source-domain aware', () => {
    expect(doctrine).toContain('Deputy location/site/patrol-zone exports');
    expect(doctrine).toContain('Patrol outcome/history exports');
    expect(doctrine).toContain('Never write directly to canonical patrol');
    expect(doctrine).toContain('Read back the resulting records');
  });
});
