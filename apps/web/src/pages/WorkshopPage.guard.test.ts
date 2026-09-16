import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = existsSync(resolve(process.cwd(), 'apps/web/src')) ? resolve(process.cwd(), 'apps/web') : process.cwd();
const repoRoot = existsSync(resolve(process.cwd(), 'supabase/migrations')) ? process.cwd() : resolve(process.cwd(), '../..');
const read = (relative: string) => readFileSync(resolve(root, relative), 'utf8');

const page = read('src/pages/WorkshopPage.tsx');
const lib = read('src/lib/workshop.ts');
const shell = read('src/shells/AdminShell.tsx');
const manifest = read('src/config/platformModuleManifest.ts');
const migration = readFileSync(resolve(repoRoot, 'supabase/migrations/20260916110000_workshop_module.sql'), 'utf8');

describe('workshop module contract (20260916110000)', () => {
  it('is a sellable module gated in the shell and declared in the manifest with its finance dependency', () => {
    expect(migration).toContain("VALUES ('workshop', 0, 0, 0, 'monthly', 'NZD', true)");
    expect(manifest).toContain("key: 'workshop'");
    expect(manifest).toMatch(/key: 'workshop'[^\n]*dependsOn: \['finance'\]/);
    expect(shell).toContain("workshop: 'workshop'");
    expect(shell).toContain("{ id: 'workshop', label: 'Workshop', icon: Wrench }");
    expect(shell).toContain("case 'workshop':");
  });

  it('reads through the security-invoker summary view and the RLS-scoped tables, never the base tables of other tenants', () => {
    for (const table of ['workshop_work_order_summary', 'workshop_work_order_lines', 'workshop_bom_templates', 'workshop_bom_template_lines', 'finance_inventory_locations', 'finance_inventory_balances']) {
      expect(page).toContain(`from('${table}')`);
    }
    expect(page).toContain(".eq('organization_id', organizationId)");
    expect(migration).toContain('CREATE OR REPLACE VIEW public.workshop_work_order_summary WITH (security_invoker = true)');
  });

  it('every write goes through a governed RPC that exists in the migration', () => {
    for (const rpc of ['create_workshop_work_order', 'add_workshop_work_order_line', 'remove_workshop_work_order_line', 'advance_workshop_work_order_status', 'manage_workshop_bom_template', 'manage_finance_inventory_location', 'record_finance_inventory_transaction', 'generate_crm_invoice_from_completed_work']) {
      expect(page).toContain(`supabase.rpc('${rpc}'`);
      if (rpc !== 'record_finance_inventory_transaction') expect(migration).toContain(`CREATE OR REPLACE FUNCTION public.${rpc}(`);
    }
    expect(page).not.toMatch(/from\('workshop_[a-z_]+'\)\s*\.(insert|update|delete)/);
    expect(page).not.toMatch(/from\('finance_inventory_[a-z_]+'\)\s*\.(insert|update|delete)/);
    expect(page).not.toMatch(/from\('invoices?'\)/);
  });

  it('keeps the UI ladder identical to the database ladder', () => {
    expect(lib).toContain("case 'draft':");
    expect(migration).toContain("(v_wo.status = 'draft' and p_status in ('approved', 'cancelled'))");
    expect(migration).toContain("(v_wo.status = 'approved' and p_status in ('in_progress', 'cancelled', 'draft'))");
    expect(migration).toContain("(v_wo.status = 'in_progress' and p_status in ('completed', 'cancelled'))");
  });

  it('completion effects are stated before the click and stock draw-down is strict', () => {
    expect(page).toContain('describeCompletionEffect(selected, lines)');
    expect(migration).toContain("raise exception 'Not enough \"%\" in stock at this location");
    expect(migration).toContain("'workshop_line:' || v_line.id::text");
  });

  it('the invoice sweep stamps source lines so nothing bills twice, and carries dispatch charge lines too', () => {
    expect(migration).toContain('update public.workshop_work_order_lines set invoice_line_item_id = v_line_id');
    expect(migration).toContain('update public.dispatch_job_charge_lines set invoice_line_item_id = v_line_id');
    expect(migration).toContain("raise exception 'No completed, uninvoiced work for this client in the period'");
  });

  it('fails closed without an organisation', () => {
    expect(page).toContain("setError('Organisation access could not be confirmed. Workshop data is unavailable.');");
    expect(page).toContain('setLoading(false);');
  });
});

describe('officer workshop surface (20260916120000)', () => {
  const officerPage = read('src/pages/OfficerWorkshopPage.tsx');
  const officerShell = read('src/shells/OfficerShell.tsx');
  const workerMigration = readFileSync(resolve(repoRoot, 'supabase/migrations/20260916120000_workshop_worker_lines.sql'), 'utf8');

  it('is a granted (non-core) officer module', () => {
    expect(officerShell).toContain("workshop: { label: 'Workshop'");
    expect(officerShell).toContain("case 'workshop':");
    expect(officerShell).not.toMatch(/CORE_OFFICER_MODULES = new Set<ActiveModule>\(\[[^\]]*'workshop'/);
  });

  it('shows only the jobs assigned to the signed-in worker', () => {
    expect(officerPage).toContain("from('workshop_work_order_summary')");
    expect(officerPage).toContain(".eq('assigned_user_id', profile.id)");
  });

  it('a worker never types a price: lines are price-book items and the RPC enforces it', () => {
    expect(officerPage).toContain('p_unit_price: null');
    expect(officerPage).toContain('p_unit_cost: null');
    expect(officerPage).toContain('includeRates={false}');
    expect(workerMigration).toContain("if v_role = 'worker' and p_item_id is null then");
    expect(workerMigration).toContain("case when v_role = 'admin' then coalesce(p_unit_price, v_price, 0) else coalesce(v_price, 0) end");
    expect(workerMigration).toContain("raise exception 'You can only remove lines you added yourself'");
  });

  it('brings the place brief and platform-wide safety warnings to the worker before they attend', () => {
    expect(officerPage).toContain("from('client_sites').select('id,name,address,hs_notes,access_instructions')");
    expect(officerPage).toContain('<SafetyWarningsPanel entityType="site"');
  });

  it('only start and complete are offered; stock-drawing orders are handed to the office', () => {
    expect(officerPage).toContain("advance('in_progress')");
    expect(officerPage).toContain("advance('completed')");
    expect(officerPage).not.toContain("'cancelled'");
    expect(officerPage).toContain('so a workshop administrator completes it');
  });
});
