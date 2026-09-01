import { describe, expect, it } from 'vitest';
import { readWorkflowContext, workflowContextQuery } from './workflowNavigation';

describe('workflow navigation context', () => {
  it('serializes only defined entity identifiers', () => {
    expect(workflowContextQuery({ accountId: 'account-1', siteId: 'site-1', zoneId: 'zone-1' })).toBe('?account=account-1&site=site-1&zone=zone-1');
  });

  it('round trips the complete supported context', () => {
    const context = { accountId: 'a', agreementId: 'g', ledgerId: 'l', locationId: 'p', siteId: 's', zoneId: 'z', workUnitId: 'w', handoffId: 'h' };
    expect(readWorkflowContext(workflowContextQuery(context))).toEqual(context);
  });
});