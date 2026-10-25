/** Extra works orders: client-authorised work outside the contracted scope, billed as Extra, never a variation. */
export interface ExtraWorkOrder {
  id: string;
  reference: string;
  title: string;
  scope: string;
  authority_kind: 'written' | 'purchase_order' | 'verbal' | 'standing_instruction';
  authority_reference: string | null;
  charge_code: string | null;
  rate_note: string | null;
  starts_on: string;
  ends_on: string | null;
  review_on: string | null;
  end_reason: string | null;
  updated_at: string;
}

export type ExtraWorkOrderState = 'upcoming' | 'active' | 'review_due' | 'ending' | 'ended' | 'cancelled';

export const extraWorkOrderStateLabels: Record<ExtraWorkOrderState, string> = {
  upcoming: 'Starts later',
  active: 'Active',
  review_due: 'Review due',
  ending: 'Ends today',
  ended: 'Ended',
  cancelled: 'Cancelled',
};

/** Dates are inclusive yyyy-mm-dd strings; an order ending the day before it starts was cancelled. */
export const extraWorkOrderState = (order: Pick<ExtraWorkOrder, 'starts_on' | 'ends_on' | 'review_on'>, today: string): ExtraWorkOrderState => {
  if (order.ends_on && order.ends_on < order.starts_on) return 'cancelled';
  if (order.ends_on && order.ends_on < today) return 'ended';
  if (order.starts_on > today) return 'upcoming';
  if (order.ends_on === today) return 'ending';
  if (order.review_on && order.review_on <= today) return 'review_due';
  return 'active';
};

/** True when a job created on `day` may be billed under the order. */
export const extraWorkOrderInForce = (order: Pick<ExtraWorkOrder, 'starts_on' | 'ends_on'>, day: string): boolean =>
  order.starts_on <= day && (!order.ends_on || order.ends_on >= day);
