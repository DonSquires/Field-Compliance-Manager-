import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(process.cwd(), '../..');
const migration = readFileSync(
  resolve(root, 'supabase/migrations/20261014194450_retire_superseded_roster_target_setup.sql'),
  'utf8',
);
const schema = readFileSync(resolve(root, 'supabase/schema.sql'), 'utf8');
const databaseTypes = readFileSync(resolve(root, 'src/types/database.ts'), 'utf8');
const rosterTargetsPage = readFileSync(
  resolve(root, 'apps/web/src/pages/RosterTargetsPage.tsx'),
  'utf8',
);
const fixtures = readFileSync(resolve(root, 'apps/web/e2e/fixtures.ts'), 'utf8');

describe('superseded roster target setup retirement', () => {
  it('drops only the two home-organization-only setup authorities', () => {
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.create_cost_centre(text, text);',
    );
    expect(migration).toContain(
      'DROP FUNCTION IF EXISTS public.create_organization_workplace(text, text);',
    );
    expect(migration).not.toContain('DROP FUNCTION IF EXISTS public.create_roster_work_unit');
    expect(migration).not.toContain('DROP FUNCTION IF EXISTS public.create_roster_slot');
  });

  it('keeps operating-organization setup as the UI and typed authority', () => {
    expect(rosterTargetsPage).toContain("'create_operating_cost_centre'");
    expect(rosterTargetsPage).toContain("'create_operating_organization_workplace'");
    expect(databaseTypes).toContain('create_operating_cost_centre:');
    expect(databaseTypes).toContain('create_operating_organization_workplace:');
    expect(databaseTypes).not.toMatch(/\n      create_cost_centre:/);
    expect(databaseTypes).not.toMatch(/\n      create_organization_workplace:/);
    expect(fixtures).toContain("table === 'create_operating_cost_centre'");
    expect(fixtures).toContain("table === 'create_operating_organization_workplace'");
    expect(fixtures).not.toContain("table === 'create_cost_centre'");
    expect(fixtures).not.toContain("table === 'create_organization_workplace'");
  });

  it('aligns the live snapshot while preserving still-wired roster writers', () => {
    expect(schema).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."create_cost_centre"/,
    );
    expect(schema).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."create_organization_workplace"/,
    );
    expect(schema).toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."create_operating_cost_centre"/,
    );
    expect(schema).toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."create_operating_organization_workplace"/,
    );
    expect(schema).toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."create_roster_work_unit"/,
    );
    expect(schema).toMatch(
      /CREATE (OR REPLACE )?FUNCTION "public"\."create_roster_slot"/,
    );
  });
});
