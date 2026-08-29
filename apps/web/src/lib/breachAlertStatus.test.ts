import { describe, it, expect } from 'vitest';

describe('Breach alert schema mapping', () => {
  it('documents that breach_alerts table has 6 status values but UI only filters 3', () => {
    // SCHEMA FACT: supabase/schema.sql breach_alerts.status CHECK constraint:
    // 'open' | 'acknowledged' | 'actioned' | 'dismissed' | 'resolved' | 'exempt_homeless'
    
    // BreachReviewPage filter dropdown only supports:
    // 'open' | 'actioned' | 'all'
    
    // MISSING FILTERS: 'acknowledged' | 'dismissed' | 'resolved' | 'exempt_homeless'
    // This is a gap: users cannot manage the full lifecycle of a breach from submission to resolution.
    
    // Status lifecycle per schema docs:
    // - open → acknowledged (user sees it) 
    // - open/acknowledged → actioned (action taken)
    // - actioned → dismissed (withdrawn) OR resolved (resolved via legal/payment)
    // - special: exempt_homeless (suppresses enforcement, tracks homeless claims)
    
    const validStatuses = [
      'open',
      'acknowledged', // MISSING from UI filter
      'actioned',
      'dismissed',     // MISSING from UI filter
      'resolved',      // MISSING from UI filter
      'exempt_homeless' // MISSING from UI filter
    ];
    
    const uiFilters = ['open', 'actioned', 'all'];
    const missingFilters = validStatuses.filter(s => !uiFilters.includes(s) && s !== 'all');
    
    expect(missingFilters).toEqual(['acknowledged', 'dismissed', 'resolved', 'exempt_homeless']);
  });
});
