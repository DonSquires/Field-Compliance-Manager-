/**
 * workshop.ts — pure helpers for the manufacturing & maintenance ("workshop")
 * module (migration 20260916110000). Kept free of Supabase imports so it is
 * unit-testable.
 */

import type { PriceListSelection } from './priceList';

export type WorkOrderKind = 'fabrication' | 'maintenance';
export type WorkOrderStatus = 'draft' | 'approved' | 'in_progress' | 'completed' | 'cancelled';
export type WorkOrderLineKind = 'material' | 'labour' | 'travel' | 'equipment';

export interface WorkOrderSummary {
  id: string;
  organization_id: string;
  order_number: string;
  kind: WorkOrderKind;
  status: WorkOrderStatus;
  title: string;
  description: string | null;
  client_organization_id: string | null;
  client_name: string | null;
  service_agreement_id: string | null;
  client_site_id: string | null;
  site_name: string | null;
  asset_id: string | null;
  asset_name: string | null;
  inventory_location_id: string | null;
  stock_location_name: string | null;
  bom_template_id: string | null;
  template_name: string | null;
  assigned_user_id: string | null;
  assigned_name: string | null;
  scheduled_for: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  completion_note: string | null;
  created_at: string;
  updated_at: string;
  line_count: number;
  charge_total: number;
  cost_total: number;
  uninvoiced_total: number;
}

export interface WorkOrderLine {
  id: string;
  work_order_id: string;
  line_kind: WorkOrderLineKind;
  item_id: string | null;
  description: string;
  quantity: number;
  unit_of_measure: string | null;
  unit_cost: number;
  unit_price: number;
  line_total: number;
  inventory_transaction_id: string | null;
  invoice_line_item_id: string | null;
  position: number;
}

export interface BomTemplateLineInput {
  line_kind: WorkOrderLineKind;
  item_id: string | null;
  description: string;
  quantity: number;
  unit_of_measure: string | null;
}

export const WORK_ORDER_KIND_LABELS: Record<WorkOrderKind, string> = {
  fabrication: 'Fabrication (build in the workshop)',
  maintenance: 'Maintenance (visit a place or asset)',
};

export const WORK_ORDER_STATUS_LABELS: Record<WorkOrderStatus, string> = {
  draft: 'Draft',
  approved: 'Approved',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

export const LINE_KIND_LABELS: Record<WorkOrderLineKind, string> = {
  material: 'Material',
  labour: 'Labour',
  travel: 'Travel',
  equipment: 'Equipment',
};

/** The buttons an administrator sees for a work order in this status (mirrors advance_workshop_work_order_status). */
export function nextWorkOrderActions(status: WorkOrderStatus): Array<{ status: WorkOrderStatus; label: string; tone: 'primary' | 'secondary' | 'danger'; needsNote?: boolean }> {
  switch (status) {
    case 'draft':
      return [
        { status: 'approved', label: 'Approve', tone: 'primary' },
        { status: 'cancelled', label: 'Cancel order', tone: 'danger', needsNote: true },
      ];
    case 'approved':
      return [
        { status: 'in_progress', label: 'Start work', tone: 'primary' },
        { status: 'draft', label: 'Back to draft', tone: 'secondary' },
        { status: 'cancelled', label: 'Cancel order', tone: 'danger', needsNote: true },
      ];
    case 'in_progress':
      return [
        { status: 'completed', label: 'Complete', tone: 'primary', needsNote: true },
        { status: 'cancelled', label: 'Cancel order', tone: 'danger', needsNote: true },
      ];
    default:
      return [];
  }
}

export function isWorkOrderOpen(status: WorkOrderStatus): boolean {
  return status === 'draft' || status === 'approved' || status === 'in_progress';
}

/** Map a price-list pick onto a work-order line kind. */
export function lineKindFromSelection(selection: PriceListSelection | null): WorkOrderLineKind {
  if (!selection) return 'material';
  switch (selection.kind) {
    case 'labour':
      return 'labour';
    case 'travel':
      return 'travel';
    case 'equipment':
      return 'equipment';
    case 'materials':
      return 'material';
    default:
      return 'labour';
  }
}

export function money(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' }).format(value);
}

export function lineTotal(quantity: number, unitPrice: number): number {
  return Math.round(quantity * unitPrice * 100) / 100;
}

/** Sum of lines, and the margin the price book implies. */
export function summariseLines(lines: ReadonlyArray<Pick<WorkOrderLine, 'quantity' | 'unit_price' | 'unit_cost'>>): { charge: number; cost: number; marginPct: number | null } {
  const charge = lines.reduce((sum, line) => sum + lineTotal(line.quantity, line.unit_price), 0);
  const cost = lines.reduce((sum, line) => sum + lineTotal(line.quantity, line.unit_cost), 0);
  return { charge: Math.round(charge * 100) / 100, cost: Math.round(cost * 100) / 100, marginPct: charge > 0 ? Math.round(((charge - cost) / charge) * 10000) / 100 : null };
}

/** Shape template lines for manage_workshop_bom_template(p_lines). Throws a human message on a bad line. */
export function buildTemplateLinesPayload(lines: ReadonlyArray<BomTemplateLineInput>): Array<Record<string, unknown>> {
  if (lines.length === 0) throw new Error('Add at least one line to the template.');
  return lines.map((line, index) => {
    if (!(line.quantity > 0)) throw new Error(`Line ${index + 1} needs a quantity above zero.`);
    if (!line.item_id && !line.description.trim()) throw new Error(`Line ${index + 1} needs a description or a price-book item.`);
    return {
      line_kind: line.line_kind,
      item_id: line.item_id,
      description: line.description.trim() || null,
      quantity: line.quantity,
      unit_of_measure: line.unit_of_measure,
    };
  });
}

/** Human explanation of what completing this order will do (so nobody is surprised). */
export function describeCompletionEffect(order: Pick<WorkOrderSummary, 'inventory_location_id' | 'stock_location_name' | 'client_name'>, lines: ReadonlyArray<Pick<WorkOrderLine, 'line_kind' | 'item_id'>>): string {
  const stockLines = lines.filter((line) => (line.line_kind === 'material' || line.line_kind === 'equipment') && line.item_id).length;
  const parts: string[] = [];
  if (order.inventory_location_id && stockLines > 0) parts.push(`${stockLines} stock line${stockLines === 1 ? '' : 's'} will be drawn down from ${order.stock_location_name ?? 'the stock location'}`);
  else if (order.inventory_location_id) parts.push('no price-book materials to draw from stock');
  else parts.push('no stock movement (no stock location on this order)');
  parts.push(order.client_name ? `the lines become billable to ${order.client_name} on the next invoice sweep` : 'the lines stay internal (no client on this order)');
  return `On completion: ${parts.join('; ')}.`;
}
