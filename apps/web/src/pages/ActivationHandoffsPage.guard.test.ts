/// <reference types="node" />
import { readFileSync } from 'node:fs';import { resolve } from 'node:path';import { describe,expect,it } from 'vitest';
const page=readFileSync(resolve(process.cwd(),'src/pages/ActivationHandoffsPage.tsx'),'utf8');
describe('Activation Handoffs page',()=>{
  it('reads and mutates only through governed handoff RPCs',()=>{expect(page).toContain("supabase.rpc('get_crm_activation_handoffs'");expect(page).toContain("supabase.rpc('manage_crm_activation_handoff_task'");expect(page).not.toContain("supabase.from('crm_activation_handoffs')");});
  it('surfaces canonical site, work-unit, and first-roster evidence',()=>{for(const evidence of ['access_instructions','hs_notes','work_units','first_roster_at'])expect(page).toContain(evidence);});
  it('requires completion notes and exposes owning workspaces',()=>{expect(page).toContain('Completion note for');expect(page).toContain("onNavigate(task.destination)");expect(page).toContain("notes[task.task_id]?.trim().length");});
});