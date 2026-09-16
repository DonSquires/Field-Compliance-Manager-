/**
 * uninvoicedWork.ts — pure grouping for "completed work waiting to be invoiced":
 * completed workshop orders (uninvoiced_total) and dispatch charge lines with
 * no invoice line yet, rolled up per client so a finance person sees one row
 * per customer and one action.
 */

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
}

export interface ClientUninvoicedSummary {
  clientId: string;
  clientName: string;
  workshopOrders: number;
  dispatchJobs: number;
  total: number;
  oldest: string | null;
}

export function groupUninvoicedWork(workshop: ReadonlyArray<UninvoicedWorkshopRow>, dispatch: ReadonlyArray<UninvoicedDispatchRow>): ClientUninvoicedSummary[] {
  const byClient = new Map<string, ClientUninvoicedSummary & { orders: Set<string>; jobs: Set<string> }>();
  const bucket = (clientId: string | null, clientName: string | null) => {
    if (!clientId) return null;
    let entry = byClient.get(clientId);
    if (!entry) {
      entry = { clientId, clientName: clientName ?? 'Client', workshopOrders: 0, dispatchJobs: 0, total: 0, oldest: null, orders: new Set(), jobs: new Set() };
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
  for (const row of dispatch) {
    const entry = bucket(row.client_organization_id, row.client_name);
    if (!entry) continue;
    entry.jobs.add(row.source_dispatch_id);
    entry.total += Number(row.line_total);
    entry.oldest = older(entry.oldest, row.created_at);
  }
  return Array.from(byClient.values())
    .map(({ orders, jobs, ...entry }) => ({ ...entry, workshopOrders: orders.size, dispatchJobs: jobs.size, total: Math.round(entry.total * 100) / 100 }))
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total);
}

/** Plain-language line for one client's waiting work. */
export function describeUninvoiced(entry: ClientUninvoicedSummary): string {
  const parts: string[] = [];
  if (entry.workshopOrders > 0) parts.push(`${entry.workshopOrders} workshop job${entry.workshopOrders === 1 ? '' : 's'}`);
  if (entry.dispatchJobs > 0) parts.push(`${entry.dispatchJobs} callout${entry.dispatchJobs === 1 ? '' : 's'}`);
  const since = entry.oldest ? ` · oldest ${new Date(entry.oldest).toLocaleDateString('en-NZ')}` : '';
  return `${parts.join(' and ')} finished and not yet billed${since}`;
}
