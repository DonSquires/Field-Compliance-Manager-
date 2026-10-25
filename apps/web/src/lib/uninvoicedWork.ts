/**
 * uninvoicedWork.ts — pure grouping for "completed work waiting to be invoiced":
 * completed workshop orders (uninvoiced_total) and dispatch charge lines with
 * no invoice line yet, rolled up per client so a finance person sees one row
 * per customer and one action.
 *
 * Dispatch billing basis (owner ruling 2026-10-25): contracted callouts are
 * covered by the agreement price and are never "waiting to be invoiced";
 * callouts with no billing decision are counted separately because the
 * invoice RPC refuses to run until someone sets them in Dispatch.
 *
 * Commercial model (owner ruling 2026-10-26): only fixed price plus Extra (or a
 * model not yet set) uses that decision. Pay as you go and per request bill every
 * callout at the agreed rates; per request also needs the client's request/PO
 * reference on the job. Do and invoice is standing authority: every callout is
 * invoiced at actuals, but a job costing more than the agreement's standing
 * authority limit (when one is set) is held until the client's approval reference
 * is recorded. The job total here is the uninvoiced lines on screen; the invoice
 * RPC re-checks against every line on the job and is the final word.
 */

import { overStandingAuthority, usesContractExtra, type CommercialModel } from './commercialModel';

export interface UninvoicedWorkshopRow {
  client_organization_id: string | null;
  client_name: string | null;
  order_number: string;
  uninvoiced_total: number;
  completed_at: string | null;
}

export interface UninvoicedDispatchRow {
  client_organization_id: string | null;
  client_name: string | null;
  source_dispatch_id: string;
  line_total: number;
  created_at: string;
  billing_basis: 'contract' | 'extra' | null;
  /** Commercial model of the line's agreement; null or absent = not set (Contract/Extra applies). */
  commercial_model?: CommercialModel | null;
  /** The client's request/PO reference (per request) or approval reference (do and invoice) on the job. */
  client_reference?: string | null;
  /** Do and invoice standing authority limit per job; null or absent = no limit. */
  standing_authority_limit?: number | null;
}

export interface UninvoicedPatrolVisitRow {
  client_organization_id: string | null;
  client_name: string | null;
  shift_stop_id: string;
  line_total: number;
  created_at: string;
}

export interface ClientUninvoicedSummary {
  clientId: string;
  clientName: string;
  workshopOrders: number;
  /** Extra callouts (fixed price plus Extra agreements). */
  dispatchJobs: number;
  /** Callouts billed at the agreed rates (pay as you go, per request). */
  rateCallouts: number;
  /** Do and invoice callouts invoiced at actuals under standing authority. */
  actualsCallouts: number;
  patrolVisits: number;
  /** Callouts with no Contracted/Extra decision — they block the invoice. */
  calloutsNeedingBilling: number;
  /** Per request callouts without the client's reference; they block the invoice. */
  calloutsNeedingReference: number;
  /** Do and invoice callouts over the standing authority limit without the client's approval reference; they block the invoice. */
  calloutsNeedingApproval: number;
  total: number;
  oldest: string | null;
}

export function groupUninvoicedWork(workshop: ReadonlyArray<UninvoicedWorkshopRow>, dispatch: ReadonlyArray<UninvoicedDispatchRow>, patrol: ReadonlyArray<UninvoicedPatrolVisitRow> = []): ClientUninvoicedSummary[] {
  const byClient = new Map<string, ClientUninvoicedSummary & { orders: Set<string>; jobs: Set<string>; rated: Set<string>; actuals: Set<string>; stops: Set<string>; unset: Set<string>; unreferenced: Set<string>; unapproved: Set<string> }>();
  const bucket = (clientId: string | null, clientName: string | null) => {
    if (!clientId) return null;
    let entry = byClient.get(clientId);
    if (!entry) {
      entry = { clientId, clientName: clientName ?? 'Client', workshopOrders: 0, dispatchJobs: 0, rateCallouts: 0, actualsCallouts: 0, patrolVisits: 0, calloutsNeedingBilling: 0, calloutsNeedingReference: 0, calloutsNeedingApproval: 0, total: 0, oldest: null, orders: new Set(), jobs: new Set(), rated: new Set(), actuals: new Set(), stops: new Set(), unset: new Set(), unreferenced: new Set(), unapproved: new Set() };
      byClient.set(clientId, entry);
    }
    return entry;
  };
  const older = (current: string | null, candidate: string | null) => (candidate && (!current || candidate < current) ? candidate : current);

  for (const row of workshop) {
    const entry = bucket(row.client_organization_id, row.client_name);
    if (!entry || !(row.uninvoiced_total > 0)) continue;
    entry.orders.add(row.order_number);
    entry.total += Number(row.uninvoiced_total);
    entry.oldest = older(entry.oldest, row.completed_at);
  }
  const jobTotals = new Map<string, number>();
  for (const row of dispatch) jobTotals.set(row.source_dispatch_id, (jobTotals.get(row.source_dispatch_id) ?? 0) + Number(row.line_total));
  for (const row of dispatch) {
    if (!usesContractExtra(row.commercial_model)) {
      const entry = bucket(row.client_organization_id, row.client_name);
      if (!entry) continue;
      if (row.commercial_model === 'per_request' && !row.client_reference?.trim()) {
        entry.unreferenced.add(row.source_dispatch_id);
        continue;
      }
      if (row.commercial_model === 'do_and_invoice') {
        if (!row.client_reference?.trim() && overStandingAuthority(row.standing_authority_limit, jobTotals.get(row.source_dispatch_id) ?? 0)) {
          entry.unapproved.add(row.source_dispatch_id);
          continue;
        }
        entry.actuals.add(row.source_dispatch_id);
      } else {
        entry.rated.add(row.source_dispatch_id);
      }
      entry.total += Number(row.line_total);
      entry.oldest = older(entry.oldest, row.created_at);
      continue;
    }
    if (row.billing_basis === 'contract') continue;
    const entry = bucket(row.client_organization_id, row.client_name);
    if (!entry) continue;
    if (row.billing_basis !== 'extra') {
      entry.unset.add(row.source_dispatch_id);
      continue;
    }
    entry.jobs.add(row.source_dispatch_id);
    entry.total += Number(row.line_total);
    entry.oldest = older(entry.oldest, row.created_at);
  }
  for (const row of patrol) {
    const entry = bucket(row.client_organization_id, row.client_name);
    if (!entry) continue;
    entry.stops.add(row.shift_stop_id);
    entry.total += Number(row.line_total);
    entry.oldest = older(entry.oldest, row.created_at);
  }
  return Array.from(byClient.values())
    .map(({ orders, jobs, rated, actuals, stops, unset, unreferenced, unapproved, ...entry }) => ({ ...entry, workshopOrders: orders.size, dispatchJobs: jobs.size, rateCallouts: rated.size, actualsCallouts: actuals.size, patrolVisits: stops.size, calloutsNeedingBilling: unset.size, calloutsNeedingReference: unreferenced.size, calloutsNeedingApproval: unapproved.size, total: Math.round(entry.total * 100) / 100 }))
    .filter((entry) => entry.total > 0 || entry.calloutsNeedingBilling > 0 || entry.calloutsNeedingReference > 0 || entry.calloutsNeedingApproval > 0)
    .sort((a, b) => b.total - a.total);
}

/** Plain-language line for one client's waiting work. */
export function describeUninvoiced(entry: ClientUninvoicedSummary): string {
  const parts: string[] = [];
  if (entry.workshopOrders > 0) parts.push(`${entry.workshopOrders} workshop job${entry.workshopOrders === 1 ? '' : 's'}`);
  if (entry.dispatchJobs > 0) parts.push(`${entry.dispatchJobs} Extra callout${entry.dispatchJobs === 1 ? '' : 's'}`);
  if (entry.rateCallouts > 0) parts.push(`${entry.rateCallouts} callout${entry.rateCallouts === 1 ? '' : 's'} at agreed rates`);
  if (entry.actualsCallouts > 0) parts.push(`${entry.actualsCallouts} callout${entry.actualsCallouts === 1 ? '' : 's'} at actuals (standing authority)`);
  if (entry.patrolVisits > 0) parts.push(`${entry.patrolVisits} patrol visit${entry.patrolVisits === 1 ? '' : 's'}`);
  const since = entry.oldest ? ` · oldest ${new Date(entry.oldest).toLocaleDateString('en-NZ')}` : '';
  if (parts.length === 0) return `Nothing ready to bill yet${since}`;
  return `${parts.join(' and ')} finished and not yet billed${since}`;
}

/** What has to happen before this client can be invoiced, or null when nothing blocks it. */
export function invoiceBlocker(entry: ClientUninvoicedSummary): string | null {
  const messages: string[] = [];
  const n = entry.calloutsNeedingBilling;
  if (n > 0) messages.push(`${n} callout${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} billing set in Dispatch — Contracted work (covered by the agreement price) or Extra (billed on top).`);
  const r = entry.calloutsNeedingReference;
  if (r > 0) messages.push(`${r} per-request callout${r === 1 ? '' : 's'} need${r === 1 ? 's' : ''} the client's request or PO reference in Dispatch.`);
  const a = entry.calloutsNeedingApproval;
  if (a > 0) messages.push(`${a} do-and-invoice callout${a === 1 ? '' : 's'} cost${a === 1 ? 's' : ''} more than the client's standing authority limit and need${a === 1 ? 's' : ''} the client's approval reference in Dispatch.`);
  return messages.length ? messages.join(' ') : null;
}
