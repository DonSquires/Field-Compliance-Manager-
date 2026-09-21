/**
 * CRMPage.tsx
 *
 * Canonical spine: organizations (hierarchy) + service_agreements (contracts).
 * There is no standalone "contact rolodex" entity — accounts ARE organizations,
 * grouped by organization_type and parent_organization_id. crm_contacts are
 * people attached to an organization, not accounts themselves.
 *
 * Sections mirror the live production screen:
 *  - Your Organisation (own org + child counts)
 *  - Our Clients        (organizations.organization_type = 'client', parent = own org)
 *  - Branches           (organizations.organization_type = 'branch', parent = own org)
 *  - Platform Subscription (service_agreements.agreement_type = 'financial', client = own org)
 *  - Organizations We Contract With (service_agreements.agreement_type = 'operational',
 *    counterpart not part of the branch hierarchy)
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { contractedDaysWords, contractedHoursWords } from '../lib/rosterWords';
import { readWorkflowContext, type NavigateWithContext } from '../lib/workflowNavigation';
import { CrmAccountWorkspace, type CrmWorkspaceAccount, type WorkspaceQuote } from '../components/CrmAccountWorkspace';
import { CrmOrganizationDialog, type EditableCrmOrganization } from '../components/CrmOrganizationDialog';
import { CrmSiteDialog } from '../components/CrmSiteDialog';
import { PriceListPicker } from '../components/PriceListPicker';
import { BomTemplateQuoteAdder } from '../components/BomTemplateQuoteAdder';
import './PageStyles.css';
import './CRMPage.css';

interface Organization {
  id: string;
  name: string;
  organization_type: string;
  parent_organization_id: string | null;
  active: boolean;
}

interface ServiceAgreement {
  id: string;
  provider_organization_id: string;
  client_organization_id: string;
  name: string;
  agreement_type: string;
  invitation_status: string;
}

interface AccountRow {
  id: string;
  name: string;
  organization_type: string;
  active: boolean;
  status: string;
  updated_at: string;
  nzbn: string | null;
  company_registration_number: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  billing_email: string | null;
  billing_address: string | null;
  account_notes: string | null;
  site_count: number;
  primary_contact_name: string | null;
  latest_quote_status: string | null;
  sites: Array<{ id: string; name: string }>;
  blockers: string[];
  next_action: string;
  operating_provider_organization_id?: string;
  operating_provider_name?: string;
}

interface ProviderPortfolioRow {
  organization_id: string;
  organization_name: string;
  organization_type: string;
  organization_status: string;
  operating_provider_organization_id: string;
  operating_provider_name: string;
}

interface PricingQuote {
  id: string;
  title: string;
  status: string;
  client: AccountRow;
  /** Set when the quote varies an existing agreement rather than creating one. */
  variedAgreementName?: string | null;
}

interface AgreementRow extends ServiceAgreement {
  counterparty_name: string;
  counterparty_type: string;
}

interface InvoiceRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  status: 'draft' | 'sent' | 'paid' | 'overdue' | 'void';
  total_amount: number;
  currency: string;
  client: { name: string } | null;
}

interface InvoiceReadiness {
  accountName: string;
  agreementName: string;
  source: 'accepted_quote' | 'commercial_rate' | 'client_approval_required' | 'missing';
  detail: string;
  billingCycle: string | null;
  paymentTermsDays: number | null;
}
interface ConsolidatedCommercialRow {
  source_organization_id: string;
  source_organization_name: string;
  invoice_count: number;
  open_receivables: number;
  overdue_receivables: number;
  invoice_total: number;
  quote_count: number;
  accepted_agreement_count: number;
  report_pack_count: number;
}

interface ModuleCatalogRow { module_key: string; billing_period: string; }
interface ProviderBillingRateRule {
  id: string;
  organization_id: string;
  name: string;
  rate_type: string;
  amount: number;
  module_key: string | null;
}
interface ProposalModuleDraft {
  moduleKey: string;
  slaMinutes: string;
  pricingBasis: 'quote_lines' | 'standard_rate_rule' | 'site_override_pending';
  rateRuleId: string;
  workModel: 'scheduled_patrol' | 'scheduled_static' | 'on_demand_callout' | 'inspection_or_notice' | 'recurring_service';
  activeDays: string[];
  startTime: string;
  endTime: string;
}
interface ProposalScopePlace { id: string; name: string; kind: 'Site' | 'Zone' | 'Proposed Site' | 'Proposed Zone'; }
interface ProposalServiceScope { id: string; module_key: string; site_id: string | null; zone_id: string | null; proposed_place_id: string | null; }
interface ProposalScopeSchedule { id: string; proposal_scope_id: string; capability_key: string; work_model: string; active_days: number[]; active_months: number[]; visits_per_shift: number; min_gap_between_visits_minutes: number; window_start: string | null; window_end: string | null; response_sla_minutes: number | null; depart_sla_minutes: number | null; dwell_minutes: number; preferred_stop_order: number; pricing_basis: string; rate_rule_id: string | null; notes: string | null; officer_instructions: string | null; updated_at: string; }
interface ProposalPlace { id: string; place_kind: 'site' | 'zone'; name: string; address: string; module_key: string; site_type: string | null; zone_type: string | null; geometry_source: string; resolution: 'create_new' | 'use_existing'; }

const MODULE_LABELS: Record<string, string> = {
  access_control: 'Access Control',
  biosecurity: 'Biosecurity',
  bob_assistant: 'Bob Assistant',
  client_reporting: 'Client Reporting',
  ems: 'Emergency Management System',
  freedom_camping: 'Freedom Camping',
  invoicing: 'Invoicing',
  noise_control: 'Noise Control',
  parking: 'Parking Enforcement',
  smoke_complaints: 'Smoke Complaints',
  static_guarding: 'Static Guarding',
  welfare: 'Welfare Check',
};

const formatModuleLabel = (moduleKey: string) => MODULE_LABELS[moduleKey]
  ?? moduleKey.split('_').map((word) => word.slice(0, 1).toUpperCase() + word.slice(1)).join(' ');

interface CrmState {
  ownOrg: Organization | null;
  clients: AccountRow[];
  branches: AccountRow[];
  platformSubscribers: AgreementRow[];
  contractedOrgs: AgreementRow[];
  invoices: InvoiceRow[];
  consolidatedCommercial: ConsolidatedCommercialRow[];
  loading: boolean;
  error: string | null;
}

const CRMPage: React.FC<{ onNavigate?: NavigateWithContext }> = ({ onNavigate = () => undefined }) => {
  const location = useLocation();
  const requestedAccountId = readWorkflowContext(location.search).accountId;
  const { profile, operatingOrganizationId } = useAuth();
  const [state, setState] = useState<CrmState>({
    ownOrg: null,
    clients: [],
    branches: [],
    platformSubscribers: [],
    contractedOrgs: [],
    invoices: [],
    consolidatedCommercial: [],
    loading: true,
    error: null,
  });
  const [quoteClient, setQuoteClient] = useState<AccountRow | null>(null);
  const [proposalAnchor, setProposalAnchor] = useState<{ siteId?: string; zoneId?: string; name: string } | null>(null);
  const [quoteOperatingProviderId, setQuoteOperatingProviderId] = useState('');
  // Existing operational agreements for the client: a quote may vary one of them instead of creating another.
  const [quoteAgreements, setQuoteAgreements] = useState<Array<{ id: string; name: string; starts_on: string | null; ends_on: string | null; invitation_status: string }>>([]);
  const [quoteVariationAgreementId, setQuoteVariationAgreementId] = useState('');
  const [quoteForm, setQuoteForm] = useState({
    title: '',
    targetMargin: '20',
    validUntil: '',
    notes: '',
  });
  const [proposalModules, setProposalModules] = useState<ProposalModuleDraft[]>([]);
  const [moduleCatalog, setModuleCatalog] = useState<ModuleCatalogRow[]>([]);
  const [providerBillingRules, setProviderBillingRules] = useState<ProviderBillingRateRule[]>([]);
  const [quotedModuleKeys, setQuotedModuleKeys] = useState<string[]>([]);
  const [proposalScopePlaces, setProposalScopePlaces] = useState<ProposalScopePlace[]>([]);
  const [proposalServiceScopes, setProposalServiceScopes] = useState<ProposalServiceScope[]>([]);
  const [proposalScopeForm, setProposalScopeForm] = useState({ moduleKey: '', placeId: '' });
  const [proposalPlaces, setProposalPlaces] = useState<ProposalPlace[]>([]);
  const [proposalPlaceForm, setProposalPlaceForm] = useState({ kind: 'site' as 'site' | 'zone', name: '', address: '', moduleKey: '', siteType: 'commercial_premises', zoneType: 'general', geometrySource: 'manual' });
  const [proposalScopeSchedules, setProposalScopeSchedules] = useState<ProposalScopeSchedule[]>([]);
  const [editingProposalSchedule, setEditingProposalSchedule] = useState<ProposalScopeSchedule | null>(null);
  const [proposalScheduleForm, setProposalScheduleForm] = useState({ scopeId: '', capability: 'patrol', workModel: 'scheduled_patrol', activeDays: [1,2,3,4,5,6,7], activeMonths: [] as number[], visits: '1', minimumGap: '60', startTime: '', endTime: '', sla: '', departSla: '', dwell: '15', stopOrder: '0', rateRuleId: '', notes: '', officerInstructions: '' });
  const [quoteSaving, setQuoteSaving] = useState(false);
  const [quoteAgreementsChecked, setQuoteAgreementsChecked] = useState(false);
  const [pricingQuote, setPricingQuote] = useState<PricingQuote | null>(null);
  const [lineForm, setLineForm] = useState({
    kind: 'labour',
    description: 'Service labour',
    quantity: '1',
    unitCost: '',
    unitCharge: '',
    moduleKey: '',
    siteId: '',
  });
  const [linePick, setLinePick] = useState('');
  const [pricingReceipt, setPricingReceipt] = useState<{
    totalCost: number;
    totalCharge: number;
  } | null>(null);
  const [quoteAction, setQuoteAction] = useState<'send' | 'accept' | 'decline' | null>(null);
  const [quoteActionReason, setQuoteActionReason] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [quoteAcceptance, setQuoteAcceptance] = useState<{ quoteTitle: string; accountId: string; accountName: string; agreementId: string; variedAgreementName?: string | null } | null>(null);
  const [workspaceAccount, setWorkspaceAccount] = useState<CrmWorkspaceAccount | null>(null);
  const [workspaceInitialView, setWorkspaceInitialView] = useState<'overview' | 'sites'>('overview');
  const [invoiceAction, setInvoiceAction] = useState<{ invoice: InvoiceRow; action: 'send' | 'mark_paid' | 'void' } | null>(null);
  const [invoiceReason, setInvoiceReason] = useState('');
  const [showGenerateInvoice, setShowGenerateInvoice] = useState(false);
  const [invoiceReadiness, setInvoiceReadiness] = useState<InvoiceReadiness | null>(null);
  const [invoiceReadinessLoading, setInvoiceReadinessLoading] = useState(false);
  const [selectedAgreementId, setSelectedAgreementId] = useState('');
  const [quoteLines, setQuoteLines] = useState<Array<{ id: string; kind: string; description: string; quantity: number; unit_cost: number; unit_charge: number }>>([]);
  const [organizationDialog, setOrganizationDialog] = useState<EditableCrmOrganization | 'create' | null>(null);
  const [siteAccount, setSiteAccount] = useState<{ id: string; name: string } | null>(null);
  const openedContextAccountId = useRef<string | null>(null);
  const quoteRequestId = useRef(crypto.randomUUID());
  const lineRequestId = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!requestedAccountId) {
      openedContextAccountId.current = null;
      return;
    }
    const requestedAccount = [...state.clients, ...state.branches].find((account) => account.id === requestedAccountId);
    if (!requestedAccount || openedContextAccountId.current === requestedAccountId) return;
    openedContextAccountId.current = requestedAccountId;
    setWorkspaceAccount({ id: requestedAccount.id, name: requestedAccount.name, status: requestedAccount.status, primaryContactName: requestedAccount.primary_contact_name, siteCount: requestedAccount.site_count, readinessBlockers: requestedAccount.blockers, nextAction: requestedAccount.next_action, latestQuoteStatus: requestedAccount.latest_quote_status });
    document.getElementById(`crm-account-${requestedAccountId}`)?.scrollIntoView({ block: 'center' });
  }, [requestedAccountId, state.branches, state.clients]);

  // ATLAS READS: organizations, crm_account_list (view), service_agreements
  const loadCrm = useCallback(async () => {
    const orgId = operatingOrganizationId ?? profile?.organizationId;
    if (!orgId) {
      setState((s) => ({ ...s, loading: false, error: null }));
      return;
    }

    try {
      setState((s) => ({ ...s, loading: true, error: null }));

      const { data: ownOrg, error: ownErr } = await supabase
        .from('organizations')
        .select('id,name,organization_type,active,status,parent_organization_id,updated_at,nzbn,company_registration_number,contact_email,contact_phone,billing_email,billing_address,account_notes')
        .eq('id', orgId)
        .single();
      if (ownErr) throw ownErr;

      // SCHEMA FIX: crm_account_list view does not exist.
      // Query organizations directly; site_count loaded separately.
      const { data: directChildren, error: acctErr } = await supabase
        .from('organizations')
        .select('id,name,organization_type,active,status,parent_organization_id,updated_at,nzbn,company_registration_number,contact_email,contact_phone,billing_email,billing_address,account_notes')
        .eq('parent_organization_id', orgId)
        .limit(200);
      if (acctErr) throw acctErr;
      const { data: portfolio, error: portfolioError } = await supabase.rpc('get_crm_provider_portfolio', { p_operating_provider_organization_id: orgId });
      if (portfolioError) throw portfolioError;
      const portfolioRows = (portfolio as ProviderPortfolioRow[]) ?? [];
      const portfolioIds = [...new Set(portfolioRows.map((row) => row.organization_id))];
      const { data: accounts, error: portfolioAccountsError } = portfolioIds.length
        ? await supabase.from('organizations').select('id,name,organization_type,active,status,parent_organization_id,updated_at,nzbn,company_registration_number,contact_email,contact_phone,billing_email,billing_address,account_notes').in('id', portfolioIds).limit(200)
        : { data: [], error: null };
      if (portfolioAccountsError) throw portfolioAccountsError;

      const branches = (directChildren ?? []).filter((account) => account.organization_type === 'branch');
      const accountIds = [...new Set([...(accounts ?? []).map((account) => account.id), ...branches.map((branch) => branch.id)])];
      const providerOrgIds = [orgId, ...branches.map((branch) => branch.id)];
      const [sitesRes, contactsRes, quotesRes, readinessRes, moduleCatalogRes, billingRulesRes] = accountIds.length
        ? await Promise.all([
            supabase
              .from('client_sites')
              .select('id,name,client_organization_id')
              .in('client_organization_id', accountIds)
              .limit(500),
            supabase
              .from('crm_contacts')
              .select('organization_id,first_name,last_name,is_primary')
              .in('organization_id', accountIds)
              .eq('is_primary', true)
              .limit(200),
            supabase
              .from('quotes')
              .select('client_org_id,status,created_at')
              .in('client_org_id', accountIds)
              .order('created_at', { ascending: false })
              .limit(500),
            supabase.rpc('get_crm_organization_readiness', { p_organization_ids: accountIds }),
            supabase.from('module_catalog').select('module_key,billing_period').eq('active', true).order('module_key'),
            supabase.from('rate_rules').select('id,organization_id,name,rate_type,amount,module_key').in('organization_id', providerOrgIds).eq('rule_kind', 'billing').eq('active', true).order('priority', { ascending: false }).order('name'),
          ])
        : [
            { data: [], error: null },
            { data: [], error: null },
            { data: [], error: null },
            { data: [], error: null },
            await supabase.from('module_catalog').select('module_key,billing_period').eq('active', true).order('module_key'),
            await supabase.from('rate_rules').select('id,organization_id,name,rate_type,amount,module_key').in('organization_id', providerOrgIds).eq('rule_kind', 'billing').eq('active', true).order('priority', { ascending: false }).order('name'),
          ];
      if (sitesRes.error) throw sitesRes.error;
      if (contactsRes.error) throw contactsRes.error;
      if (quotesRes.error) throw quotesRes.error;
      if (readinessRes.error) throw readinessRes.error;
      if (moduleCatalogRes.error) throw moduleCatalogRes.error;
      if (billingRulesRes.error) throw billingRulesRes.error;
      const readiness = new Map(((readinessRes.data as Array<{ organization_id: string; blockers: string[]; next_action: string }>) ?? []).map((row) => [row.organization_id, row]));
      setModuleCatalog((moduleCatalogRes.data as ModuleCatalogRow[]) ?? []);
      setProviderBillingRules((billingRulesRes.data as ProviderBillingRateRule[]) ?? []);
      const siteCounts = new Map<string, number>();
      for (const site of sitesRes.data ?? [])
        siteCounts.set(
          site.client_organization_id,
          (siteCounts.get(site.client_organization_id) ?? 0) + 1,
        );
      const primaryContacts = new Map(
        (contactsRes.data ?? []).map((contact) => [
          contact.organization_id,
          `${contact.first_name} ${contact.last_name}`.trim(),
        ]),
      );
      const latestQuotes = new Map<string, string>();
      for (const quote of quotesRes.data ?? [])
        if (quote.client_org_id && !latestQuotes.has(quote.client_org_id))
          latestQuotes.set(quote.client_org_id, quote.status);
      const operatingProviderByAccount = new Map(portfolioRows.map((row) => [row.organization_id, row]));
      const accountsWithCounts: AccountRow[] = (accounts ?? []).map((acct) => ({
        ...acct,
        id: acct.id,
        name: acct.name,
        organization_type: acct.organization_type,
        active: acct.active,
        site_count: siteCounts.get(acct.id) ?? 0,
        primary_contact_name: primaryContacts.get(acct.id) ?? null,
        latest_quote_status: latestQuotes.get(acct.id) ?? null,
        sites: (sitesRes.data ?? [])
          .filter((site) => site.client_organization_id === acct.id)
          .map((site) => ({ id: site.id, name: site.name })),
        blockers: readiness.get(acct.id)?.blockers ?? [],
        next_action: readiness.get(acct.id)?.next_action ?? 'Review account readiness',
        operating_provider_organization_id: operatingProviderByAccount.get(acct.id)?.operating_provider_organization_id,
        operating_provider_name: operatingProviderByAccount.get(acct.id)?.operating_provider_name,
      }));
      const branchAccounts: AccountRow[] = branches.map((branch) => ({
        ...branch,
        site_count: siteCounts.get(branch.id) ?? 0,
        primary_contact_name: primaryContacts.get(branch.id) ?? null,
        latest_quote_status: latestQuotes.get(branch.id) ?? null,
        sites: (sitesRes.data ?? []).filter((site) => site.client_organization_id === branch.id).map((site) => ({ id: site.id, name: site.name })),
        blockers: readiness.get(branch.id)?.blockers ?? [],
        next_action: readiness.get(branch.id)?.next_action ?? 'Review branch readiness',
      }));

      const rows = accountsWithCounts;
      const clients = rows;

      // Platform subscriptions: Layer-1 Iron Eagle -> current organization agreements.
      const { data: subscriberAgreements, error: subErr } = await supabase
        .from('service_agreements')
        .select('*, provider:provider_organization_id(id, name, organization_type)')
        .eq('client_organization_id', orgId)
        .eq('agreement_type', 'financial')
        .limit(100);
      if (subErr) throw subErr;

      // Contracted orgs: Layer-2 operational agreements, either direction
      const { data: operationalAgreements, error: opErr } = await supabase
        .from('service_agreements')
        .select(
          '*, client:client_organization_id(id, name, organization_type), provider:provider_organization_id(id, name, organization_type)',
        )
        .or(
          `client_organization_id.eq.${orgId},provider_organization_id.eq.${orgId}`,
        )
        .eq('agreement_type', 'operational')
        .limit(100);
      if (opErr) throw opErr;
      const { data: invoices, error: invoiceErr } = await supabase.from('invoices').select('id,invoice_number,invoice_date,due_date,status,total_amount,currency,client:client_organization_id(name)').eq('organization_id', orgId).order('due_date', { ascending: true }).limit(100);
      if (invoiceErr) throw invoiceErr;
      const { data: consolidatedCommercial, error: consolidatedError } = await supabase.rpc('get_consolidated_commercial_overview', { p_root_organization_id: orgId });
      if (consolidatedError) throw consolidatedError;

      const branchOrgIds = new Set(branches.map((b) => b.id));

      const platformSubscribers: AgreementRow[] = (
        subscriberAgreements ?? []
      ).map((a: any) => ({
        ...a,
        counterparty_name: a.provider?.name ?? 'Unknown platform provider',
        counterparty_type: a.provider?.organization_type ?? 'unknown',
      }));

      const contractedOrgs: AgreementRow[] = (operationalAgreements ?? [])
        .filter((a: any) => {
          const counterpartId =
            a.provider_organization_id === orgId
              ? a.client_organization_id
              : a.provider_organization_id;
          return !branchOrgIds.has(counterpartId);
        })
        .map((a: any) => {
          const isProvider = a.provider_organization_id === orgId;
          const counterparty = isProvider ? a.client : a.provider;
          return {
            ...a,
            counterparty_name: counterparty?.name ?? 'Unknown organisation',
            counterparty_type: counterparty?.organization_type ?? 'unknown',
          };
        });

      setState({
        ownOrg: ownOrg as Organization,
        clients,
        branches: branchAccounts,
        platformSubscribers,
        contractedOrgs,
        invoices: (invoices as unknown as InvoiceRow[]) ?? [],
        consolidatedCommercial: (consolidatedCommercial as ConsolidatedCommercialRow[]) ?? [],
        loading: false,
        error: null,
      });
    } catch (err) {
      setState((s) => ({
        ...s,
        error: err instanceof Error ? err.message : 'Failed to load CRM data',
        loading: false,
      }));
    }
  }, [operatingOrganizationId, profile?.organizationId]);

  useEffect(() => {
    loadCrm();
  }, [loadCrm]);

  const loadQuoteLines = useCallback(async (quoteId: string) => {
    const { data } = await supabase.from('quote_lines').select('id,kind,description,quantity,unit_cost,unit_charge').eq('quote_id', quoteId).order('created_at', { ascending: true });
    setQuoteLines((data as any) ?? []);
  }, []);

  const loadProposalServiceScopes = useCallback(async (quote: PricingQuote) => {
    const [moduleResponse, scopeResponse, siteResponse, zoneResponse, proposalPlaceResponse] = await Promise.all([
      supabase.from('quote_proposal_modules').select('module_key').eq('quote_id', quote.id),
      supabase.from('quote_proposal_service_scopes').select('id,module_key,site_id,zone_id,proposed_place_id').eq('quote_id', quote.id),
      supabase.from('client_sites').select('id,name').eq('client_organization_id', quote.client.id).eq('active', true).order('name'),
      supabase.from('location_zones').select('id,name').eq('organization_id', quote.client.id).eq('is_active', true).order('name'),
      supabase.from('quote_proposal_places').select('id,place_kind,name,address,module_key,site_type,zone_type,geometry_source,resolution').eq('quote_id', quote.id).order('created_at'),
    ]);
    const loadError = moduleResponse.error ?? scopeResponse.error ?? siteResponse.error ?? zoneResponse.error ?? proposalPlaceResponse.error;
    if (loadError) { setState((current) => ({ ...current, error: loadError.message })); return; }
    const moduleKeys = ((moduleResponse.data as Array<{ module_key: string }>) ?? []).map((module) => module.module_key);
    const livePlaces: ProposalScopePlace[] = [
      ...((siteResponse.data as Array<{ id: string; name: string }>) ?? []).map((site) => ({ ...site, kind: 'Site' as const })),
      ...((zoneResponse.data as Array<{ id: string; name: string }>) ?? []).map((zone) => ({ ...zone, kind: 'Zone' as const })),
    ];
    const draftPlaces: ProposalScopePlace[] = ((proposalPlaceResponse.data as ProposalPlace[]) ?? []).map((place) => ({ id: place.id, name: place.name, kind: place.place_kind === 'site' ? 'Proposed Site' : 'Proposed Zone' }));
    const places = [...livePlaces, ...draftPlaces];
    setQuotedModuleKeys(moduleKeys);
    setProposalPlaces((proposalPlaceResponse.data as ProposalPlace[]) ?? []);
    setProposalServiceScopes((scopeResponse.data as ProposalServiceScope[]) ?? []);
    const scopeIds = ((scopeResponse.data as ProposalServiceScope[]) ?? []).map((scope) => scope.id);
    if (scopeIds.length) { const { data, error } = await supabase.from('quote_proposal_scope_schedules').select('id,proposal_scope_id,capability_key,work_model,active_days,active_months,visits_per_shift,min_gap_between_visits_minutes,window_start,window_end,response_sla_minutes,depart_sla_minutes,dwell_minutes,preferred_stop_order,pricing_basis,rate_rule_id,notes,officer_instructions,updated_at').in('proposal_scope_id', scopeIds); if (error) { setState((current) => ({ ...current, error: error.message })); return; } setProposalScopeSchedules((data as ProposalScopeSchedule[]) ?? []); } else setProposalScopeSchedules([]);
    setProposalScopePlaces(places);
    setProposalScopeForm((current) => ({
      moduleKey: moduleKeys.includes(current.moduleKey) ? current.moduleKey : (moduleKeys[0] ?? ''),
      placeId: livePlaces.some((place) => place.id === current.placeId) ? current.placeId : (livePlaces[0]?.id ?? ''),
    }));
    setProposalPlaceForm((current) => ({ ...current, moduleKey: moduleKeys.includes(current.moduleKey) ? current.moduleKey : (moduleKeys[0] ?? '') }));
    setProposalScheduleForm((current) => ({ ...current, scopeId: scopeIds.includes(current.scopeId) ? current.scopeId : (scopeIds[0] ?? '') }));
  }, []);

  useEffect(() => {
    if (pricingQuote) {
      void loadQuoteLines(pricingQuote.id);
      void loadProposalServiceScopes(pricingQuote);
    } else {
      setQuoteLines([]);
      setProposalServiceScopes([]);
      setProposalScopePlaces([]);
    }
  }, [pricingQuote, loadProposalServiceScopes, loadQuoteLines]);

  const addProposalServiceScope = async () => {
    if (!pricingQuote || !proposalScopeForm.moduleKey || !proposalScopeForm.placeId) return;
    const place = proposalScopePlaces.find((candidate) => candidate.id === proposalScopeForm.placeId);
    if (!place) return;
    setQuoteSaving(true); setState((current) => ({ ...current, error: null }));
    const { error } = await supabase.rpc('manage_crm_quote_proposal_service_scope', {
      p_client_request_id: crypto.randomUUID(), p_quote_id: pricingQuote.id, p_action: 'set',
      p_module_key: proposalScopeForm.moduleKey, p_site_id: place.kind === 'Site' ? place.id : null,
      p_zone_id: place.kind === 'Zone' ? place.id : null, p_proposed_place_id: null,
    });
    if (error) setState((current) => ({ ...current, error: error.message }));
    else { setNotice(`${proposalScopeForm.moduleKey} is now proposed for ${place.name}.`); await loadProposalServiceScopes(pricingQuote); }
    setQuoteSaving(false);
  };

  const addProposalPlace = async () => {
    if (!pricingQuote || !proposalPlaceForm.name.trim() || !proposalPlaceForm.address.trim() || !proposalPlaceForm.moduleKey) return;
    setQuoteSaving(true); setState((current) => ({ ...current, error: null }));
    const { data, error } = await supabase.rpc('manage_crm_quote_proposal_place', {
      p_client_request_id: crypto.randomUUID(), p_quote_id: pricingQuote.id, p_action: 'create', p_place_id: null,
      p_place_kind: proposalPlaceForm.kind, p_name: proposalPlaceForm.name.trim(), p_address: proposalPlaceForm.address.trim(), p_module_key: proposalPlaceForm.moduleKey,
      p_site_type: proposalPlaceForm.kind === 'site' ? proposalPlaceForm.siteType : null, p_zone_type: proposalPlaceForm.kind === 'zone' ? proposalPlaceForm.zoneType : null,
      p_proposed_geometry: null, p_geometry_source: proposalPlaceForm.geometrySource, p_candidate_site_id: null, p_candidate_zone_id: null, p_resolution: 'create_new',
    });
    if (error || !data) setState((current) => ({ ...current, error: error?.message ?? 'Proposed place receipt was not confirmed.' }));
    else {
      const proposedPlace = data as ProposalPlace;
      const { error: scopeError } = await supabase.rpc('manage_crm_quote_proposal_service_scope', { p_client_request_id: crypto.randomUUID(), p_quote_id: pricingQuote.id, p_action: 'set', p_module_key: proposedPlace.module_key, p_site_id: null, p_zone_id: null, p_proposed_place_id: proposedPlace.id });
      if (scopeError) setState((current) => ({ ...current, error: scopeError.message }));
      else { setNotice(`${proposedPlace.name} is captured as a draft ${proposedPlace.place_kind} and ready for delivery scheduling. It will not become operational until acceptance.`); setProposalPlaceForm({ ...proposalPlaceForm, name: '', address: '' }); await loadProposalServiceScopes(pricingQuote); }
    }
    setQuoteSaving(false);
  };

  const addProposalScopeSchedule = async () => {
    if (!pricingQuote || !proposalScheduleForm.scopeId) return;
    setQuoteSaving(true); setState((current) => ({ ...current, error: null }));
    const { error } = await supabase.rpc('manage_crm_quote_proposal_scope_schedule_details', { p_client_request_id: crypto.randomUUID(), p_quote_id: pricingQuote.id, p_action: editingProposalSchedule ? 'update' : 'create', p_schedule_id: editingProposalSchedule?.id ?? null, p_proposal_scope_id: proposalScheduleForm.scopeId, p_capability_key: proposalScheduleForm.capability, p_work_model: proposalScheduleForm.workModel, p_active_days: proposalScheduleForm.activeDays, p_active_months: proposalScheduleForm.activeMonths, p_visits_per_shift: Number(proposalScheduleForm.visits), p_min_gap_between_visits_minutes: Number(proposalScheduleForm.minimumGap), p_window_start: proposalScheduleForm.startTime || null, p_window_end: proposalScheduleForm.endTime || null, p_response_sla_minutes: proposalScheduleForm.sla ? Number(proposalScheduleForm.sla) : null, p_depart_sla_minutes: proposalScheduleForm.departSla ? Number(proposalScheduleForm.departSla) : null, p_dwell_minutes: Number(proposalScheduleForm.dwell), p_preferred_stop_order: Number(proposalScheduleForm.stopOrder), p_rate_rule_id: proposalScheduleForm.rateRuleId || null, p_notes: proposalScheduleForm.notes || null, p_officer_instructions: proposalScheduleForm.officerInstructions || null, p_expected_updated_at: editingProposalSchedule?.updated_at ?? null });
    if (error) setState((current) => ({ ...current, error: error.message })); else { setNotice(editingProposalSchedule ? 'Delivery schedule updated.' : 'Delivery schedule added to the draft proposal.'); setEditingProposalSchedule(null); await loadProposalServiceScopes(pricingQuote); }
    setQuoteSaving(false);
  };

  const removeProposalScopeSchedule = async (schedule: ProposalScopeSchedule) => {
    if (!pricingQuote) return;
    setQuoteSaving(true); setState((current) => ({ ...current, error: null }));
    const { error } = await supabase.rpc('manage_crm_quote_proposal_scope_schedule_details', { p_client_request_id: crypto.randomUUID(), p_quote_id: pricingQuote.id, p_action: 'remove', p_schedule_id: schedule.id, p_proposal_scope_id: null, p_capability_key: null, p_work_model: null, p_active_days: [], p_active_months: [], p_visits_per_shift: 1, p_min_gap_between_visits_minutes: 0, p_window_start: null, p_window_end: null, p_response_sla_minutes: null, p_depart_sla_minutes: null, p_dwell_minutes: 1, p_preferred_stop_order: 0, p_rate_rule_id: null, p_notes: null, p_officer_instructions: null, p_expected_updated_at: schedule.updated_at });
    if (error) setState((current) => ({ ...current, error: error.message })); else { setNotice('Delivery schedule removed from the draft proposal.'); if (editingProposalSchedule?.id === schedule.id) setEditingProposalSchedule(null); await loadProposalServiceScopes(pricingQuote); }
    setQuoteSaving(false);
  };

  const editProposalScopeSchedule = (schedule: ProposalScopeSchedule) => {
    setEditingProposalSchedule(schedule);
    setProposalScheduleForm({ scopeId: schedule.proposal_scope_id, capability: schedule.capability_key, workModel: schedule.work_model, activeDays: schedule.active_days, activeMonths: schedule.active_months ?? [], visits: String(schedule.visits_per_shift), minimumGap: String(schedule.min_gap_between_visits_minutes), startTime: schedule.window_start ?? '', endTime: schedule.window_end ?? '', sla: schedule.response_sla_minutes ? String(schedule.response_sla_minutes) : '', departSla: schedule.depart_sla_minutes ? String(schedule.depart_sla_minutes) : '', dwell: String(schedule.dwell_minutes ?? 15), stopOrder: String(schedule.preferred_stop_order ?? 0), rateRuleId: schedule.rate_rule_id ?? '', notes: schedule.notes ?? '', officerInstructions: schedule.officer_instructions ?? '' });
  };

  const removeQuoteLine = async (lineId: string) => {
    if (!pricingQuote) return;
    setQuoteSaving(true);
    const { data, error } = await supabase.rpc('remove_crm_quote_line', {
      p_client_request_id: crypto.randomUUID(),
      p_quote_id: pricingQuote.id,
      p_line_id: lineId,
      p_expected_status: pricingQuote.status,
    });
    if (error) setState((s) => ({ ...s, error: error.message }));
    else {
      const receipt = Array.isArray(data) ? data[0] : data;
      if (receipt) {
        setPricingReceipt({ totalCost: Number(receipt.total_cost), totalCharge: Number(receipt.total_charge) });
      }
      setNotice('Quote line removed.');
      await loadQuoteLines(pricingQuote.id);
    }
    setQuoteSaving(false);
  };

  const generateInvoiceFromAgreement = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedAgreementId || invoiceReadiness?.source === 'missing') return;
    setQuoteSaving(true);
    const now = new Date();
    const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);
    const { error } = await supabase.rpc('generate_crm_invoice_from_agreement', {
      p_client_request_id: crypto.randomUUID(),
      p_service_agreement_id: selectedAgreementId,
      p_service_period_start: startDate,
      p_service_period_end: endDate,
    });
    if (error) setState((s) => ({ ...s, error: s.error ? `${s.error} · ${error.message}` : error.message }));
    else {
      setNotice('Invoice generated from agreement with line items.');
      setShowGenerateInvoice(false);
      await loadCrm();
    }
    setQuoteSaving(false);
  };

  const loadInvoiceReadiness = useCallback(async (agreementId: string) => {
    const agreement = [...state.platformSubscribers, ...state.contractedOrgs].find((item) => item.id === agreementId);
    if (!agreement) { setInvoiceReadiness(null); return; }
    setInvoiceReadinessLoading(true); setInvoiceReadiness(null);
    const [quotesResponse, settingsResponse] = await Promise.all([
      supabase.from('quotes').select('id,quote_lines(id)').eq('service_agreement_id', agreementId).eq('status', 'accepted'),
      supabase.from('crm_commercial_settings').select('base_rate_per_hour,billing_cycle,payment_terms_days').eq('service_agreement_id', agreementId).maybeSingle(),
    ]);
    if (quotesResponse.error || settingsResponse.error) {
      setState((current) => ({ ...current, error: quotesResponse.error?.message ?? settingsResponse.error?.message ?? 'Invoice readiness could not be loaded.' }));
    } else {
      const quoteLineCount = ((quotesResponse.data as Array<{ quote_lines: Array<{ id: string }> | null }> | null) ?? []).reduce((count, quote) => count + (quote.quote_lines?.length ?? 0), 0);
      const settings = settingsResponse.data as { base_rate_per_hour: number | null; billing_cycle: string; payment_terms_days: number } | null;
      setInvoiceReadiness({
        accountName: agreement.counterparty_name,
        agreementName: agreement.name,
        source: agreement.invitation_status !== 'accepted' ? 'client_approval_required' : quoteLineCount > 0 ? 'accepted_quote' : settings?.base_rate_per_hour != null ? 'commercial_rate' : 'missing',
        detail: agreement.invitation_status !== 'accepted' ? 'The client has not approved this service agreement yet. Invoicing remains blocked.' : quoteLineCount > 0 ? `${quoteLineCount} accepted quote line${quoteLineCount === 1 ? '' : 's'} will be copied.` : settings?.base_rate_per_hour != null ? `Monthly commercial rate: NZ$${Number(settings.base_rate_per_hour).toFixed(2)}.` : 'No accepted quote lines or commercial base rate are configured.',
        billingCycle: settings?.billing_cycle ?? null,
        paymentTermsDays: settings?.payment_terms_days ?? null,
      });
    }
    setInvoiceReadinessLoading(false);
  }, [state.contractedOrgs, state.platformSubscribers]);

  useEffect(() => {
    if (!showGenerateInvoice || !selectedAgreementId) { setInvoiceReadiness(null); return; }
    void loadInvoiceReadiness(selectedAgreementId);
  }, [loadInvoiceReadiness, selectedAgreementId, showGenerateInvoice]);

  const openQuote = (client: AccountRow, place?: { siteId?: string; zoneId?: string; name: string }) => {
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + 30);
    quoteRequestId.current = crypto.randomUUID();
    setQuoteClient(client);
    setProposalAnchor(place ?? null);
    setQuoteOperatingProviderId(client.operating_provider_organization_id ?? operatingOrganizationId ?? profile?.organizationId ?? '');
    setProposalModules([]);
    setQuotedModuleKeys([]);
    setQuoteAgreements([]);
    setQuoteAgreementsChecked(false);
    setQuoteVariationAgreementId('');
    // ATLAS READS: service_agreements (client's live operational agreements this quote may vary)
    void supabase.from('service_agreements').select('id,name,starts_on,ends_on,invitation_status,agreement_type').eq('client_organization_id', client.id).eq('agreement_type', 'operational').order('created_at', { ascending: false }).limit(50)
      .then(({ data, error }) => {
        // a failed check must not let a duplicate agreement slip through unnoticed
        setQuoteAgreementsChecked(true);
        if (error) { setState((current) => ({ ...current, error: `Existing agreements could not be checked: ${error.message}` })); return; }
        const today = new Date().toISOString().slice(0, 10);
        setQuoteAgreements(((data as Array<{ id: string; name: string; starts_on: string | null; ends_on: string | null; invitation_status: string }> | null) ?? []).filter((agreement) => !agreement.ends_on || agreement.ends_on >= today));
      });
    setQuoteForm({
      title: `${client.name} - ${place?.name ?? 'service'} proposal`,
      targetMargin: '20',
      validUntil: validUntil.toISOString().slice(0, 10),
      notes: '',
    });
    setNotice(null);
  };

  const createQuote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!quoteClient) return;
    const variedAgreement = quoteAgreements.find((agreement) => agreement.id === quoteVariationAgreementId) ?? null;
    setQuoteSaving(true);
    setState((current) => ({ ...current, error: null }));
    const { data, error } = await supabase.rpc('create_crm_draft_quote_for_provider', {
      p_client_request_id: quoteRequestId.current,
      p_operating_provider_organization_id: quoteOperatingProviderId,
      p_client_org_id: quoteClient.id,
      p_title: quoteForm.title.trim(),
      p_target_margin_pct: Number(quoteForm.targetMargin),
      p_valid_until: quoteForm.validUntil || null,
      p_notes: quoteForm.notes.trim() || null,
      p_service_agreement_id: variedAgreement?.id ?? null,
    });
    if (error || !data)
      setState((current) => ({
        ...current,
        error: error?.message ?? 'Draft quote receipt was not confirmed.',
      }));
    else {
      const quote = data as { id: string; title: string; status: string };
      setNotice(
        variedAgreement
          ? `Draft variation created for ${variedAgreement.name}. Add the new places, services, and prices, then send it for acceptance.`
          : `Draft quote created for ${quoteClient.name}. Add explicit pricing lines before review.`,
      );
      for (const module of proposalModules) {
        const { error: moduleError } = await supabase.rpc(
          'manage_crm_quote_proposal_module',
          {
            p_client_request_id: crypto.randomUUID(),
            p_quote_id: quote.id,
            p_action: 'set',
            p_module_key: module.moduleKey,
            p_sla_minutes: module.slaMinutes ? Number(module.slaMinutes) : null,
            p_service_window: {
              active_days: module.activeDays,
              start_time: module.startTime || null,
              end_time: module.endTime || null,
            },
            p_pricing_basis: module.pricingBasis,
            p_rate_rule_id: module.rateRuleId || null,
          },
        );
        if (moduleError) {
          setState((current) => ({ ...current, error: moduleError.message }));
          setQuoteSaving(false);
          return;
        }
        const { error: workModelError } = await supabase.rpc('set_crm_quote_proposal_work_model', {
          p_quote_id: quote.id,
          p_module_key: module.moduleKey,
          p_work_model: module.workModel,
        });
        if (workModelError) {
          setState((current) => ({ ...current, error: workModelError.message }));
          setQuoteSaving(false);
          return;
        }
      }
      if (proposalAnchor) {
        for (const module of proposalModules) {
          const { error: scopeError } = await supabase.rpc('manage_crm_quote_proposal_service_scope', {
            p_client_request_id: crypto.randomUUID(), p_quote_id: quote.id, p_action: 'set',
            p_module_key: module.moduleKey, p_site_id: proposalAnchor.siteId ?? null,
            p_zone_id: proposalAnchor.zoneId ?? null, p_proposed_place_id: null,
          });
          if (scopeError) {
            setState((current) => ({ ...current, error: scopeError.message }));
            setQuoteSaving(false);
            return;
          }
        }
      }
      setQuotedModuleKeys(proposalModules.map((module) => module.moduleKey));
      setPricingQuote({ ...quote, client: quoteClient, variedAgreementName: variedAgreement?.name ?? null });
      setLineForm({
        kind: 'labour',
        description: 'Service labour',
        quantity: '1',
        unitCost: '',
        unitCharge: '',
        moduleKey: proposalModules[0]?.moduleKey ?? '',
        siteId: proposalAnchor?.siteId ?? quoteClient.sites[0]?.id ?? '',
      });
      setPricingReceipt(null);
      setQuoteClient(null);
      lineRequestId.current = crypto.randomUUID();
      quoteRequestId.current = crypto.randomUUID();
      await loadCrm();
    }
    setQuoteSaving(false);
  };

  const addQuoteLine = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pricingQuote) return;
    setQuoteSaving(true);
    setState((current) => ({ ...current, error: null }));
    const { data, error } = await supabase.rpc('add_crm_quote_line', {
      p_client_request_id: lineRequestId.current,
      p_quote_id: pricingQuote.id,
      p_expected_status: pricingQuote.status,
      p_kind: lineForm.kind,
      p_description: lineForm.description.trim(),
      p_quantity: Number(lineForm.quantity),
      p_unit_cost: Number(lineForm.unitCost),
      p_unit_charge: Number(lineForm.unitCharge),
      p_module_key:
        lineForm.kind === 'module' ? lineForm.moduleKey.trim() : null,
      p_site_id: lineForm.siteId || null,
    });
    const receipt = Array.isArray(data) ? data[0] : data;
    if (error || !receipt)
      setState((current) => ({
        ...current,
        error: error?.message ?? 'Quote line receipt was not confirmed.',
      }));
    else {
      setPricingReceipt({
        totalCost: Number(receipt.total_cost),
        totalCharge: Number(receipt.total_charge),
      });
      setNotice(`Pricing line added to ${pricingQuote.title}.`);
      setLinePick('');
      lineRequestId.current = crypto.randomUUID();
      await loadQuoteLines(pricingQuote.id);
      await loadCrm();
    }
    setQuoteSaving(false);
  };

  // A draft that was closed (or a sent quote awaiting the client) comes back to the same pricing dialog.
  const reopenQuote = async (account: CrmWorkspaceAccount, quote: WorkspaceQuote) => {
    const sourceAccount = [...state.clients, ...state.branches].find((candidate) => candidate.id === account.id)
      ?? { id: account.id, name: account.name, organization_type: 'client', active: true, status: account.status ?? 'active', updated_at: '', nzbn: null, company_registration_number: null, contact_email: null, contact_phone: null, billing_email: null, billing_address: null, account_notes: null, site_count: account.siteCount ?? 0, primary_contact_name: account.primaryContactName ?? null, latest_quote_status: null, sites: [], blockers: account.readinessBlockers ?? [], next_action: '' } as AccountRow;
    let variedAgreementName: string | null = null;
    if (quote.service_agreement_id) {
      const { data } = await supabase.from('service_agreements').select('name').eq('id', quote.service_agreement_id).maybeSingle();
      variedAgreementName = (data as { name: string } | null)?.name ?? null;
    }
    setQuoteAction(null);
    setPricingQuote({ id: quote.id, title: quote.title, status: quote.status, client: sourceAccount, variedAgreementName });
  };

  const manageQuote = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pricingQuote || !quoteAction) return;
    setQuoteSaving(true);
    setState((current) => ({ ...current, error: null }));
    const { data, error } = await supabase.rpc('manage_crm_quote', {
      p_quote_id: pricingQuote.id,
      p_expected_status: pricingQuote.status,
      p_action: quoteAction,
      p_reason: quoteAction === 'decline' ? quoteActionReason.trim() : null,
    });
    const receipt = Array.isArray(data) ? data[0] : data;
    const agreementId = receipt?.service_agreement_id ? String(receipt.service_agreement_id) : null;
    if (error || !receipt || (quoteAction === 'accept' && !agreementId)) {
      setState((current) => ({ ...current, error: error?.message ?? 'Quote lifecycle receipt was not confirmed.' }));
    } else {
      const nextStatus = String(receipt.quote_status);
      setNotice(quoteAction === 'send' ? `${pricingQuote.title} sent for acceptance.` : quoteAction === 'accept' ? null : `${pricingQuote.title} declined with reason retained.`);
      if (quoteAction === 'accept' && agreementId) setQuoteAcceptance({ quoteTitle: pricingQuote.title, accountId: pricingQuote.client.id, accountName: pricingQuote.client.name, agreementId, variedAgreementName: pricingQuote.variedAgreementName ?? null });
      if (quoteAction === 'send') setPricingQuote({ ...pricingQuote, status: nextStatus }); else setPricingQuote(null);
      setQuoteAction(null);
      setQuoteActionReason('');
      await loadCrm();
    }
    setQuoteSaving(false);
  };

  const manageInvoice = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!invoiceAction) return;
    setQuoteSaving(true); setState((current) => ({ ...current, error: null }));
    const { data, error } = await supabase.rpc('manage_crm_invoice', { p_invoice_id: invoiceAction.invoice.id, p_expected_status: invoiceAction.invoice.status, p_action: invoiceAction.action, p_reason: invoiceAction.action === 'void' ? invoiceReason.trim() : null });
    if (error || !data) setState((current) => ({ ...current, error: error?.message ?? 'Invoice lifecycle receipt was not confirmed.' }));
    else { setNotice(invoiceAction.action === 'send' ? `${invoiceAction.invoice.invoice_number} sent to accounts receivable.` : invoiceAction.action === 'mark_paid' ? `${invoiceAction.invoice.invoice_number} marked paid.` : `${invoiceAction.invoice.invoice_number} voided with its reason retained.`); setInvoiceAction(null); setInvoiceReason(''); await loadCrm(); }
    setQuoteSaving(false);
  };

  const pricingDialog = pricingQuote ? (
    <div className="crm-quote-backdrop">
      <form
        className="crm-quote-dialog crm-line-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="crm-line-title"
        onSubmit={addQuoteLine}
      >
        <header>
          <div>
            <span>Quote pricing</span>
            <h2 id="crm-line-title">Price {pricingQuote.title}</h2>
          </div>
          <button
            type="button"
            onClick={() => setPricingQuote(null)}
            aria-label="Close pricing"
          >
            ×
          </button>
        </header>
        <p>
          Provider cost and client charge remain distinct. Totals, discount,
          GST, and final charge are recalculated by the server.
        </p>
        {pricingReceipt && (
          <div className="crm-pricing-receipt">
            <span>
              Total cost <strong>${pricingReceipt.totalCost.toFixed(2)}</strong>
            </span>
            <span>
              Total charge{' '}
              <strong>${pricingReceipt.totalCharge.toFixed(2)}</strong>
            </span>
          </div>
        )}
        {pricingQuote.status === 'draft' && <section className="crm-quote-package crm-proposed-places" aria-labelledby="proposal-places-title"><div><span>Pre-acceptance place capture</span><h3 id="proposal-places-title">Proposed Sites and Zones</h3></div><p>Capture the place this proposal covers. It remains draft-only until acceptance creates the governed operational Site or Zone, where boundary verification is still required.</p>{proposalPlaces.length > 0 && <div className="crm-account-register is-compact" role="table" aria-label="Draft proposed places"><div className="crm-account-register-row is-header" role="row"><span>Place</span><span>Address</span><span>Kind</span></div>{proposalPlaces.map((place) => <div key={place.id} className="crm-account-register-row is-static" role="row"><strong>{place.name}<small>{formatModuleLabel(place.module_key)} | {place.geometry_source.replaceAll('_', ' ')}</small></strong><span>{place.address}</span><span>{place.place_kind}</span></div>)}</div>}{quotedModuleKeys.length === 0 ? <p>Select a quoted module before capturing a proposed place.</p> : <div className="crm-proposed-place-form"><label><span>Place kind</span><select value={proposalPlaceForm.kind} onChange={(event) => setProposalPlaceForm({ ...proposalPlaceForm, kind: event.target.value as 'site' | 'zone' })}><option value="site">Site</option><option value="zone">Zone</option></select></label><label><span>Quoted module</span><select value={proposalPlaceForm.moduleKey} onChange={(event) => setProposalPlaceForm({ ...proposalPlaceForm, moduleKey: event.target.value })}>{quotedModuleKeys.map((moduleKey) => <option key={moduleKey} value={moduleKey}>{formatModuleLabel(moduleKey)}</option>)}</select></label><label><span>{proposalPlaceForm.kind === 'site' ? 'Site type' : 'Zone type'}</span><select value={proposalPlaceForm.kind === 'site' ? proposalPlaceForm.siteType : proposalPlaceForm.zoneType} onChange={(event) => proposalPlaceForm.kind === 'site' ? setProposalPlaceForm({ ...proposalPlaceForm, siteType: event.target.value }) : setProposalPlaceForm({ ...proposalPlaceForm, zoneType: event.target.value })}>{proposalPlaceForm.kind === 'site' ? <><option value="commercial_premises">Commercial premises</option><option value="government_facility">Government facility</option><option value="public_space">Public space</option><option value="other">Other</option></> : <><option value="general">General operational area</option><option value="patrol_route">Patrol route</option><option value="noise_control">Noise control</option><option value="parking">Parking</option><option value="freedom_camping">Freedom camping</option></>}</select></label><label><span>Place name</span><input value={proposalPlaceForm.name} onChange={(event) => setProposalPlaceForm({ ...proposalPlaceForm, name: event.target.value })} placeholder="Named site or operational area" /></label><label className="crm-proposed-place-address"><span>Address or place description</span><input value={proposalPlaceForm.address} onChange={(event) => setProposalPlaceForm({ ...proposalPlaceForm, address: event.target.value })} placeholder="Street address or identifiable place description" /></label><label><span>Source</span><select value={proposalPlaceForm.geometrySource} onChange={(event) => setProposalPlaceForm({ ...proposalPlaceForm, geometrySource: event.target.value })}><option value="manual">Manual entry</option><option value="document">Source document</option><option value="map_pin">Map pin</option><option value="linz_address">LINZ address</option><option value="linz_parcel">LINZ parcel</option></select></label><button type="button" className="btn btn-secondary" disabled={quoteSaving || !proposalPlaceForm.name.trim() || !proposalPlaceForm.address.trim()} onClick={() => void addProposalPlace()}>Capture proposed place</button></div>}</section>}
        {pricingQuote.status === 'draft' && <section className="crm-quote-package" aria-labelledby="proposal-scope-title">
          <div><span>Service activation</span><h3 id="proposal-scope-title">Module coverage</h3></div>
          <p>Coverage becomes an active agreement location and service only after the quote is accepted. Roster work units and shifts are configured separately.</p>
          {proposalServiceScopes.length > 0 && <div className="crm-account-register" role="table" aria-label="Proposed module coverage"><div className="crm-account-register-row is-header" role="row"><span>Module</span><span>Place</span><span>Facet</span></div>{proposalServiceScopes.map((scope) => { const place = proposalScopePlaces.find((candidate) => candidate.id === (scope.site_id ?? scope.zone_id ?? scope.proposed_place_id)); return <div key={scope.id} className="crm-account-register-row" role="row"><strong>{scope.module_key}</strong><span>{place?.name ?? 'Authorized place'}</span><span>{place?.kind ?? 'Place'}</span></div>; })}</div>}
          {quotedModuleKeys.length === 0 ? <p>No quoted modules are available for coverage.</p> : proposalScopePlaces.filter((place) => place.kind === 'Site' || place.kind === 'Zone').length === 0 ? <p>No visible active Sites or Zones are available. Capture a draft proposed place above or complete client place onboarding before assigning operational coverage.</p> : <div className="crm-form-grid"><label><span>Quoted module</span><select value={proposalScopeForm.moduleKey} onChange={(event) => setProposalScopeForm({ ...proposalScopeForm, moduleKey: event.target.value })}>{quotedModuleKeys.map((moduleKey) => <option key={moduleKey} value={moduleKey}>{moduleKey}</option>)}</select></label><label><span>Client facet</span><select value={proposalScopeForm.placeId} onChange={(event) => setProposalScopeForm({ ...proposalScopeForm, placeId: event.target.value })}>{proposalScopePlaces.filter((place) => place.kind === 'Site' || place.kind === 'Zone').map((place) => <option key={place.id} value={place.id}>{place.kind}: {place.name}</option>)}</select></label><button type="button" className="btn btn-secondary" disabled={quoteSaving} onClick={() => void addProposalServiceScope()}>Add coverage</button></div>}
        </section>}
        {pricingQuote.status === 'draft' && <section className="crm-quote-package crm-delivery-schedules"><div><span>Delivery schedules</span><h3>Places and schedules</h3></div><p>Add module coverage for each Site or Zone above, then add one or more delivery schedules here. These become operational agreement schedule records only after acceptance.</p>{proposalScopeSchedules.map((schedule) => { const scope=proposalServiceScopes.find((item)=>item.id===schedule.proposal_scope_id);const place=proposalScopePlaces.find((item)=>item.id===(scope?.site_id??scope?.zone_id??scope?.proposed_place_id));return <div className="crm-schedule-summary" key={schedule.id}><strong>{place?.name??'Covered place'} · {formatModuleLabel(schedule.capability_key)}</strong><span>{schedule.work_model.replaceAll('_',' ')} · {schedule.visits_per_shift} visit{schedule.visits_per_shift===1?'':'s'} · {contractedDaysWords(schedule.active_days)} · {contractedHoursWords(schedule.window_start, schedule.window_end)}</span><span className="crm-schedule-actions"><button type="button" className="btn btn-sm btn-secondary" disabled={quoteSaving} onClick={()=>editProposalScopeSchedule(schedule)}>Edit</button><button type="button" className="btn btn-sm btn-secondary" disabled={quoteSaving} onClick={()=>void removeProposalScopeSchedule(schedule)}>Remove</button></span></div>; })}<div className="crm-schedule-form"><label><span>Covered Site, Zone, or proposed place</span><select value={proposalScheduleForm.scopeId} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,scopeId:event.target.value})}><option value="">Add module coverage first</option>{proposalServiceScopes.map((scope)=>{const place=proposalScopePlaces.find((item)=>item.id===(scope.site_id??scope.zone_id??scope.proposed_place_id));return <option key={scope.id} value={scope.id}>{place?.kind}: {place?.name} · {formatModuleLabel(scope.module_key)}</option>})}</select></label><label><span>Service capability</span><select value={proposalScheduleForm.capability} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,capability:event.target.value,workModel:event.target.value==='alarm_response'?'on_demand_callout':proposalScheduleForm.workModel})}><option value="patrol">Patrol</option><option value="noise_control">Noise Control</option><option value="static_guarding">Static Guarding</option><option value="freedom_camping">Freedom Camping</option><option value="alarm_response">Alarm Response</option></select></label><label><span>Work model</span><select value={proposalScheduleForm.workModel} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,workModel:event.target.value})}><option value="scheduled_patrol">Scheduled patrol</option><option value="scheduled_static">Scheduled static coverage</option><option value="on_demand_callout">On-demand response</option><option value="inspection_or_notice">Inspection or notice</option><option value="recurring_service">Recurring service</option></select></label><fieldset><legend>Active days</legend><div className="crm-schedule-toggles">{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map((label,index)=><label key={label}><input type="checkbox" checked={proposalScheduleForm.activeDays.includes(index+1)} onChange={()=>setProposalScheduleForm({...proposalScheduleForm,activeDays:proposalScheduleForm.activeDays.includes(index+1)?proposalScheduleForm.activeDays.filter((day)=>day!==index+1):[...proposalScheduleForm.activeDays,index+1]})}/>{label}</label>)}</div></fieldset><fieldset><legend>Active months</legend><div className="crm-schedule-toggles">{['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((label,index)=><label key={label}><input type="checkbox" checked={proposalScheduleForm.activeMonths.includes(index+1)} onChange={()=>setProposalScheduleForm({...proposalScheduleForm,activeMonths:proposalScheduleForm.activeMonths.includes(index+1)?proposalScheduleForm.activeMonths.filter((month)=>month!==index+1):[...proposalScheduleForm.activeMonths,index+1]})}/>{label}</label>)}</div></fieldset><label><span>Visits per shift</span><input type="number" min="1" value={proposalScheduleForm.visits} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,visits:event.target.value})}/></label><label><span>Minimum gap (minutes)</span><input type="number" min="0" value={proposalScheduleForm.minimumGap} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,minimumGap:event.target.value})}/></label><label><span>Window start</span><input type="time" value={proposalScheduleForm.startTime} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,startTime:event.target.value})}/></label><label><span>Window end</span><input type="time" value={proposalScheduleForm.endTime} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,endTime:event.target.value})}/></label><p className="crm-schedule-hint">Days run Monday to Sunday. Leave both window times empty when the work can be required at any time of day (24-hour cover); set them only when the client contracts fixed hours.</p><label><span>Dwell time (minutes)</span><input type="number" min="1" value={proposalScheduleForm.dwell} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,dwell:event.target.value})}/></label><label><span>Arrive SLA (minutes)</span><input type="number" min="1" value={proposalScheduleForm.sla} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,sla:event.target.value})}/></label><label><span>Depart SLA (minutes)</span><input type="number" min="1" value={proposalScheduleForm.departSla} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,departSla:event.target.value})}/></label><label><span>Preferred stop order</span><input type="number" min="0" value={proposalScheduleForm.stopOrder} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,stopOrder:event.target.value})}/></label><label><span>Billing rate</span><select value={proposalScheduleForm.rateRuleId} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,rateRuleId:event.target.value})}><option value="">Quote lines / confirm later</option>{providerBillingRules.filter((rule)=>rule.organization_id===quoteOperatingProviderId).map((rule)=><option value={rule.id} key={rule.id}>{rule.name} · ${Number(rule.amount).toFixed(2)}</option>)}</select></label><label className="crm-schedule-notes"><span>Officer instructions</span><textarea rows={3} value={proposalScheduleForm.officerInstructions} onChange={(event)=>setProposalScheduleForm({...proposalScheduleForm,officerInstructions:event.target.value})}/></label><div className="crm-schedule-form-actions"><button type="button" className="btn btn-secondary" disabled={quoteSaving||!proposalScheduleForm.scopeId||proposalScheduleForm.activeDays.length===0} onClick={()=>void addProposalScopeSchedule()}>{editingProposalSchedule ? 'Save schedule' : 'Add schedule'}</button>{editingProposalSchedule && <button type="button" className="btn btn-ghost" disabled={quoteSaving} onClick={()=>setEditingProposalSchedule(null)}>Cancel edit</button>}</div></div></section>}
        {quoteLines.length > 0 && (
          <div className="crm-quote-lines-list" style={{ marginBottom: '1rem', border: '1px solid var(--border-color, #e2e8f0)', borderRadius: '6px', padding: '0.5rem' }}>
            <strong style={{ fontSize: '0.85rem', display: 'block', marginBottom: '0.5rem' }}>Existing quote lines ({quoteLines.length}):</strong>
            {quoteLines.map((line) => (
              <div key={line.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.85rem', padding: '0.25rem 0', borderBottom: '1px border-subtle' }}>
                <span><strong>[{line.kind}]</strong> {line.description} — {line.quantity} × ${Number(line.unit_charge).toFixed(2)}</span>
                {pricingQuote.status === 'draft' && (
                  <button type="button" className="btn btn-sm btn-secondary" style={{ color: 'var(--danger-color, #e53e3e)', padding: '0.1rem 0.4rem', fontSize: '0.75rem' }} disabled={quoteSaving} onClick={() => void removeQuoteLine(line.id)}>Remove</button>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="crm-quote-full">
          <PriceListPicker
            id="quote-line-price-list"
            organizationIds={[quoteOperatingProviderId, state.ownOrg?.id ?? ''].filter(Boolean)}
            value={linePick}
            onSelect={(selection, token) => {
              setLinePick(token);
              if (!selection) return;
              setLineForm((current) => ({ ...current, kind: selection.kind, description: selection.description, unitCharge: selection.unitCharge === null ? current.unitCharge : selection.unitCharge.toFixed(2), unitCost: selection.unitCost === null ? current.unitCost : selection.unitCost.toFixed(2), moduleKey: '' }));
            }}
          />
          {pricingQuote.status === 'draft' && (
            <BomTemplateQuoteAdder
              organizationIds={[quoteOperatingProviderId].filter(Boolean)}
              quoteId={pricingQuote.id}
              quoteStatus={pricingQuote.status}
              siteId={lineForm.siteId || null}
              disabled={quoteSaving}
              onError={(message) => setState((current) => ({ ...current, error: message }))}
              onAdded={async (receipt, template) => {
                setPricingReceipt({ totalCost: receipt.total_cost, totalCharge: receipt.total_charge });
                setNotice(receipt.lines_added === 0
                  ? `${template.name} was already on ${pricingQuote.title} — nothing added twice.`
                  : `${receipt.lines_added} line${receipt.lines_added === 1 ? '' : 's'} from ${template.name} added to ${pricingQuote.title}.${receipt.lines_needing_price > 0 ? ` ${receipt.lines_needing_price} line${receipt.lines_needing_price === 1 ? ' has' : 's have'} no price yet — set a price before sending.` : ''}`);
                await loadQuoteLines(pricingQuote.id);
                await loadCrm();
              }}
            />
          )}
        </div>
        <div>
          <label>
            <span>Line kind</span>
            <select
              value={lineForm.kind}
              onChange={(event) =>
                setLineForm({ ...lineForm, kind: event.target.value })
              }
            >
              <option value="labour">Labour</option>
              <option value="travel">Travel</option>
              <option value="materials">Materials</option>
              <option value="equipment">Equipment</option>
              <option value="overhead">Overhead</option>
              <option value="module">Module</option>
              <option value="custom">Custom</option>
            </select>
          </label>
          <label>
            <span>Client site</span>
            <select
              value={lineForm.siteId}
              onChange={(event) =>
                setLineForm({ ...lineForm, siteId: event.target.value })
              }
            >
              <option value="">No site</option>
              {pricingQuote.client.sites.map((site) => (
                <option value={site.id} key={site.id}>
                  {site.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          <span>Description</span>
          <input
            required
            value={lineForm.description}
            onChange={(event) =>
              setLineForm({ ...lineForm, description: event.target.value })
            }
          />
        </label>
        {lineForm.kind === 'module' && (
          <label>
            <span>Module key</span>
            <input
              required
              value={lineForm.moduleKey}
              onChange={(event) =>
                setLineForm({ ...lineForm, moduleKey: event.target.value })
              }
            />
          </label>
        )}
        <div>
          <label>
            <span>Quantity</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              required
              value={lineForm.quantity}
              onChange={(event) =>
                setLineForm({ ...lineForm, quantity: event.target.value })
              }
            />
          </label>
          <label>
            <span>Provider unit cost</span>
            <input
              type="number"
              min="0"
              step="0.01"
              required
              value={lineForm.unitCost}
              onChange={(event) =>
                setLineForm({ ...lineForm, unitCost: event.target.value })
              }
            />
          </label>
        </div>
        <label>
          <span>Client unit charge</span>
          <input
            type="number"
            min="0"
            step="0.01"
            required
            value={lineForm.unitCharge}
            onChange={(event) =>
              setLineForm({ ...lineForm, unitCharge: event.target.value })
            }
          />
        </label>
        <footer>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setPricingQuote(null)}
          >
            Done
          </button>
          {pricingQuote.status === 'draft' && <button
              type="submit"
              className="btn btn-primary"
              disabled={
                quoteSaving ||
                !lineForm.description.trim() ||
                !lineForm.unitCost ||
                !lineForm.unitCharge ||
                (lineForm.kind === 'module' && !lineForm.moduleKey.trim())
              }
            >
              {quoteSaving ? 'Adding' : 'Add pricing line'}
            </button>}
        </footer>
        {pricingQuote.status === 'draft' && pricingReceipt && <button type="button" className="btn btn-primary crm-quote-lifecycle" onClick={() => setQuoteAction('send')}>Send quote</button>}
        {pricingQuote.status === 'sent' && <div className="crm-quote-lifecycle-actions"><button type="button" className="btn btn-secondary" onClick={() => { setQuoteActionReason(''); setQuoteAction('decline'); }}>Decline</button><button type="button" className="btn btn-primary" onClick={() => setQuoteAction('accept')}>Accept quote</button></div>}
      </form>
    </div>
  ) : null;

  if (state.loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading CRM accounts...</p>
        </div>
      </div>
    );
  }

  const totalAccounts = state.clients.length + state.branches.length;
  const openReceivables = state.invoices.filter((invoice) => invoice.status === 'sent' || invoice.status === 'overdue');
  const receivableTotal = openReceivables.reduce((sum, invoice) => sum + Number(invoice.total_amount), 0);

  return (
    <div className="page-container crm-page">
      <header className="page-header">
        <div><h1>Client Portfolios</h1><p className="subtitle">{totalAccounts} accounts · every client and provider you work with, one page each</p></div>
        <div className="crm-header-actions">
          <button type="button" className="btn btn-primary" onClick={() => onNavigate('client-setup')}>Set up a new client</button>
          <button type="button" className="btn btn-secondary" onClick={() => setOrganizationDialog('create')} title="Add a provider, council or other organisation without the guided setup">Add other organisation</button>
        </div>
      </header>

      {state.error && (
        <div className="alert alert-error" role="alert">
          <button
            className="alert-close"
            onClick={() => setState((s) => ({ ...s, error: null }))}
            aria-label="Close alert"
          >
            ×
          </button>
          {state.error}
        </div>
      )}
      {notice && (
        <div className="alert alert-success" role="status">
          {notice}
        </div>
      )}
      {quoteAcceptance && (
        <section className="crm-quote-acceptance" aria-label="Quote acceptance receipt">
          <div>
            <span>Quote accepted</span>
            <strong>{quoteAcceptance.quoteTitle}</strong>
            <p>{quoteAcceptance.variedAgreementName ? `Variation accepted on ${quoteAcceptance.variedAgreementName}; its prices and any new places now apply.` : `Service agreement ${quoteAcceptance.agreementId.slice(0, 8)} established for ${quoteAcceptance.accountName}.`}</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => onNavigate('relationships', { accountId: quoteAcceptance.accountId, agreementId: quoteAcceptance.agreementId })}>Open service agreement</button>
        </section>
      )}

      {state.ownOrg && (
        <section className="reports-section">
          <h2>{state.ownOrg.name}</h2>
          <p className="subtitle">
            {state.clients.length} clients · 0 contractors ·{' '}
            {state.branches.length} branches
          </p>
        </section>
      )}

      <section className="reports-section crm-finance-section">
        <div className="crm-section-heading"><div><h2>Accounts receivable</h2><p className="subtitle">Invoice status, collection actions, and retained finance decisions.</p></div><div className="crm-finance-kpis"><span>Open <strong>{openReceivables.length}</strong></span><span>Receivable <strong>NZ${receivableTotal.toFixed(2)}</strong></span><span>Overdue <strong>{state.invoices.filter((invoice) => invoice.status === 'overdue').length}</strong></span><button type="button" className="btn btn-sm btn-secondary" onClick={() => setShowGenerateInvoice(true)}>Generate from agreement</button></div></div>
        {state.invoices.length === 0 ? <div className="empty-state"><p>No invoice headers exist yet. Invoice generation remains blocked until line-level billing evidence is implemented.</p></div> : <div className="crm-invoice-table" role="table" aria-label="Accounts receivable"><div className="crm-invoice-row is-header" role="row"><span>Invoice</span><span>Account</span><span>Due</span><span>Total</span><span>Status</span><span>Action</span></div>{state.invoices.map((invoice) => <div className="crm-invoice-row" role="row" key={invoice.id}><strong>{invoice.invoice_number}</strong><span>{invoice.client?.name ?? 'Unknown account'}</span><time dateTime={invoice.due_date}>{new Date(`${invoice.due_date}T00:00:00`).toLocaleDateString('en-NZ')}</time><span>{invoice.currency} {Number(invoice.total_amount).toFixed(2)}</span><span className={`crm-invoice-status status-${invoice.status}`}>{invoice.status}</span><div>{invoice.status === 'draft' && <button type="button" onClick={() => setInvoiceAction({ invoice, action: 'send' })}>Send</button>}{(invoice.status === 'sent' || invoice.status === 'overdue') && <button type="button" onClick={() => setInvoiceAction({ invoice, action: 'mark_paid' })}>Mark paid</button>}{!['paid','void'].includes(invoice.status) && <button type="button" onClick={() => { setInvoiceReason(''); setInvoiceAction({ invoice, action: 'void' }); }}>Void</button>}</div></div>)}</div>}
      </section>

      {state.consolidatedCommercial.length > 1 && <section className="reports-section crm-finance-section"><div className="crm-section-heading"><div><h2>Group commercial oversight</h2><p className="subtitle">Branch-owned commercial activity, consolidated for parent oversight. Open the branch workspace to manage its clients, pricing, agreements, and delivery.</p></div></div><div className="crm-account-register crm-commercial-oversight" role="table" aria-label="Group commercial oversight"><div className="crm-account-register-row is-header" role="row"><span>Operating organization</span><span>Invoices</span><span>Open receivables</span><span>Agreements</span><span>Quotes</span><span>Report packs</span></div>{state.consolidatedCommercial.map((row) => <button key={row.source_organization_id} type="button" role="row" className="crm-account-register-row" onClick={() => setWorkspaceAccount({ id: row.source_organization_id, name: row.source_organization_name })}><strong>{row.source_organization_name}</strong><span>{row.invoice_count}</span><span>NZ${Number(row.open_receivables).toFixed(2)}{Number(row.overdue_receivables) > 0 ? ` · NZ$${Number(row.overdue_receivables).toFixed(2)} overdue` : ''}</span><span>{row.accepted_agreement_count}</span><span>{row.quote_count}</span><span>{row.report_pack_count}</span></button>)}</div></section>}

      <section className="reports-section">
        <h2>Client Portfolios ({state.clients.length})</h2>
        <div className="crm-account-register" role="table" aria-label="Client accounts">
          {state.clients.length === 0 ? (
            <div className="empty-state">
              <p>No client accounts yet.</p>
            </div>
          ) : (
            <>
              <div className="crm-account-register-row is-header" role="row"><span>Client and operating provider</span><span>Primary contact</span><span>Sites</span><span>Readiness</span><span>Quote</span><span>Next action</span></div>
              {state.clients.map((client) => (
                <button id={`crm-account-${client.id}`} type="button" role="row" key={client.id} className={`crm-account-register-row ${client.id === requestedAccountId ? 'is-context-focus' : ''}`} onClick={() => setWorkspaceAccount({ id: client.id, name: client.name, status: client.status, primaryContactName: client.primary_contact_name, siteCount: client.site_count, readinessBlockers: client.blockers, nextAction: client.next_action, latestQuoteStatus: client.latest_quote_status })}>
                  <strong>{client.name}<small>{client.operating_provider_name ? `Operating provider: ${client.operating_provider_name}` : 'Operating provider not recorded'}</small></strong><span>{client.primary_contact_name ?? 'Not assigned'}</span><span>{client.site_count}</span><span className={client.blockers.length ? 'is-attention' : 'is-ready'}>{client.blockers.length ? `${client.blockers.length} open` : 'Ready'}</span><span>{client.latest_quote_status ?? 'None'}</span><span>{client.next_action}</span>
                </button>
              ))}
            </>
          )}
        </div>
      </section>

      <section className="reports-section">
        <h2>Branches ({state.branches.length})</h2>
        <div className="contacts-list">
          {state.branches.length === 0 ? (
            <div className="empty-state">
              <p>No branch accounts yet.</p>
            </div>
          ) : (
            state.branches.map((branch) => (
              <div key={branch.id} className="contact-card">
                <div className="contact-header">
                  <h3>{branch.name}</h3>
                  <span className="contact-type-badge">Branch</span>
                </div>
                <div className="contact-details">
                  <p>{branch.primary_contact_name ?? 'No primary contact'}</p>
                  <p className="contact-meta">
                    {branch.active ? 'Active' : 'Inactive'} ·{' '}
                    {branch.site_count} site
                    {branch.site_count === 1 ? '' : 's'}
                  </p>
                  <div className="crm-account-actions"><span>Internal branch</span><div><button type="button" className="btn btn-sm btn-secondary" onClick={() => setWorkspaceAccount({ id: branch.id, name: branch.name })}>Manage account</button></div></div>
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="reports-section">
        <h2>Platform Subscription ({state.platformSubscribers.length})</h2>
        <p className="subtitle">
          Your Iron Eagle platform agreement (Layer-1 financial subscription).
        </p>
        <div className="crm-account-register is-compact" role="table" aria-label="Platform subscription">
          {state.platformSubscribers.length === 0 ? (
            <div className="empty-state">
              <p>No platform subscription is recorded for this organization.</p>
            </div>
          ) : (
            <>
              <div className="crm-account-register-row is-header" role="row"><span>Platform provider</span><span>Agreement</span><span>Type</span></div>
              {state.platformSubscribers.map((agreement) => (
                <div key={agreement.id} role="row" className="crm-account-register-row is-static">
                  <strong>{agreement.counterparty_name}</strong><span>{agreement.name}</span><span>{agreement.counterparty_type}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </section>

      <section className="reports-section">
        <h2>Organizations We Contract With ({state.contractedOrgs.length})</h2>
        <p className="subtitle">
          Organizations linked via operational service agreements (Layer-2
          fieldwork) — not part of your branch hierarchy.
        </p>
        <div className="crm-account-register is-compact" role="table" aria-label="Contracted organizations">
          {state.contractedOrgs.length === 0 ? (
            <div className="empty-state">
              <p>
                No operational contracted organizations found. Service
                agreements create these links.
              </p>
            </div>
          ) : (
            <>
              <div className="crm-account-register-row is-header" role="row"><span>Organization</span><span>Agreement</span><span>Type</span></div>
              {state.contractedOrgs.map((agreement) => (
                <div key={agreement.id} role="row" className="crm-account-register-row is-static">
                  <strong>{agreement.counterparty_name}</strong><span>{agreement.name}</span><span>{agreement.counterparty_type}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </section>
      {quoteClient && (
        <div className="crm-quote-backdrop">
          <form
            className="crm-quote-dialog crm-proposal-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="crm-quote-title"
            onSubmit={createQuote}
          >
            <header>
              <div>
                <span>Commercial proposal</span>
                <h2 id="crm-quote-title">New quote for {quoteClient.name}</h2>
              </div>
              <button
                type="button"
                onClick={() => setQuoteClient(null)}
                aria-label="Close quote"
              >
                ×
              </button>
            </header>
            <p>
              Define the service package first. Labour, travel, and other
              commercial charges remain explicit pricing lines after the draft
              is created.
            </p>
            <label>
              <span>Operating provider</span>
              <select value={quoteOperatingProviderId} onChange={(event) => setQuoteOperatingProviderId(event.target.value)} required>
                {state.ownOrg && <option value={state.ownOrg.id}>{state.ownOrg.name} (parent oversight / default provider)</option>}
                {state.branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name} (operating branch)</option>)}
              </select>
            </label>
            {!quoteAgreementsChecked && <p className="crm-quote-checking" role="status">Checking whether {quoteClient.name} already has a live agreement this quote should vary…</p>}
            {quoteAgreements.length > 0 && (
              <fieldset className="crm-quote-purpose">
                <legend>What is this quote for?</legend>
                <label className="crm-quote-purpose-option">
                  <input type="radio" name="crm-quote-purpose" value="" checked={quoteVariationAgreementId === ''} onChange={() => setQuoteVariationAgreementId('')} />
                  <span><strong>A new agreement</strong><small>Creates a separate contract for {quoteClient.name} when it is accepted.</small></span>
                </label>
                <label className="crm-quote-purpose-option">
                  <input type="radio" name="crm-quote-purpose" value="variation" checked={quoteVariationAgreementId !== ''} onChange={() => setQuoteVariationAgreementId(quoteAgreements[0]?.id ?? '')} />
                  <span><strong>A change to an existing agreement (variation)</strong><small>Adds new places, services, or prices to the agreement you choose. Nothing changes until the variation is accepted.</small></span>
                </label>
                {quoteVariationAgreementId !== '' && (
                  <label>
                    <span>Agreement being varied</span>
                    <select value={quoteVariationAgreementId} onChange={(event) => setQuoteVariationAgreementId(event.target.value)} aria-label="Agreement being varied">
                      {quoteAgreements.map((agreement) => (
                        <option key={agreement.id} value={agreement.id}>
                          {agreement.name}{agreement.starts_on ? ` · in force since ${new Date(`${agreement.starts_on}T00:00:00`).toLocaleDateString('en-NZ', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}{agreement.invitation_status !== 'accepted' ? ' · not yet accepted by client' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </fieldset>
            )}
            <label>
              <span>Quote title</span>
              <input
                required
                value={quoteForm.title}
                onChange={(event) =>
                  setQuoteForm({ ...quoteForm, title: event.target.value })
                }
              />
            </label>
            <div>
              <label>
                <span>Target margin %</span>
                <input
                  type="number"
                  min="0"
                  max="99.99"
                  step="0.01"
                  required
                  value={quoteForm.targetMargin}
                  onChange={(event) =>
                    setQuoteForm({
                      ...quoteForm,
                      targetMargin: event.target.value,
                    })
                  }
                />
              </label>
              <label>
                <span>Valid until</span>
                <input
                  type="date"
                  value={quoteForm.validUntil}
                  onChange={(event) =>
                    setQuoteForm({
                      ...quoteForm,
                      validUntil: event.target.value,
                    })
                  }
                />
              </label>
            </div>
            <label>
              <span>Commercial notes</span>
              <textarea
                rows={4}
                value={quoteForm.notes}
                onChange={(event) =>
                  setQuoteForm({ ...quoteForm, notes: event.target.value })
                }
              />
            </label>
            <section className="crm-quote-package" aria-labelledby="proposal-package-title">
              <div>
                <span>Contract package</span>
                <h3 id="proposal-package-title">Quoted modules</h3>
              </div>
              {moduleCatalog.length === 0 ? (
                <p>No active modules are available to quote.</p>
              ) : (
                <div className="crm-proposal-module-register" role="table" aria-label="Quoted modules">
                  <div className="crm-proposal-module-row is-header" role="row">
                    <span>Include</span>
                    <span>Module</span>
                    <span>Service commitment</span>
                    <span>Work and charging</span>
                  </div>
                  {moduleCatalog.map((module) => {
                    const proposalModule = proposalModules.find((item) => item.moduleKey === module.module_key);
                    return (
                      <div key={module.module_key} className="crm-proposal-module-row" role="row">
                        <span>
                          <input
                            type="checkbox"
                            checked={Boolean(proposalModule)}
                            onChange={() => setProposalModules((current) => proposalModule
                              ? current.filter((item) => item.moduleKey !== module.module_key)
                              : [...current, { moduleKey: module.module_key, slaMinutes: '', pricingBasis: 'quote_lines', rateRuleId: '', workModel: 'scheduled_patrol', activeDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], startTime: '', endTime: '' }])}
                            aria-label={`Include ${module.module_key}`}
                          />
                        </span>
                        <strong>{formatModuleLabel(module.module_key)}<small>{module.billing_period}</small></strong>
                        <span>
                          {proposalModule ? <div className="crm-proposal-service-window"><label><span>Response target (minutes)</span><input type="number" min="1" max="10080" placeholder="Not set" value={proposalModule.slaMinutes} onChange={(event) => setProposalModules((current) => current.map((item) => item.moduleKey === module.module_key ? { ...item, slaMinutes: event.target.value } : item))} aria-label={`${formatModuleLabel(module.module_key)} response target minutes`} /></label><div><input type="time" value={proposalModule.startTime} onChange={(event) => setProposalModules((current) => current.map((item) => item.moduleKey === module.module_key ? { ...item, startTime: event.target.value } : item))} aria-label={`${formatModuleLabel(module.module_key)} service start time`} /><span>to</span><input type="time" value={proposalModule.endTime} onChange={(event) => setProposalModules((current) => current.map((item) => item.moduleKey === module.module_key ? { ...item, endTime: event.target.value } : item))} aria-label={`${formatModuleLabel(module.module_key)} service end time`} /></div><div className="crm-proposal-days">{['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => <label key={day}><input type="checkbox" checked={proposalModule.activeDays.includes(day)} onChange={() => setProposalModules((current) => current.map((item) => item.moduleKey === module.module_key ? { ...item, activeDays: item.activeDays.includes(day) ? item.activeDays.filter((activeDay) => activeDay !== day) : [...item.activeDays, day] } : item))} />{day.slice(0, 1).toUpperCase()}</label>)}</div></div> : <span className="crm-proposal-empty">Select module first</span>}
                        </span>
                        <span>
                          {proposalModule ? <><select value={proposalModule.workModel} onChange={(event) => setProposalModules((current) => current.map((item) => item.moduleKey === module.module_key ? { ...item, workModel: event.target.value as ProposalModuleDraft['workModel'] } : item))} aria-label={`${formatModuleLabel(module.module_key)} work model`}><option value="scheduled_patrol">Scheduled patrol visits</option><option value="scheduled_static">Scheduled static coverage</option><option value="on_demand_callout">On-demand callouts</option><option value="inspection_or_notice">Inspection or notice work</option><option value="recurring_service">Recurring service / retainer</option></select><select value={proposalModule.pricingBasis} onChange={(event) => setProposalModules((current) => current.map((item) => item.moduleKey === module.module_key ? { ...item, pricingBasis: event.target.value as ProposalModuleDraft['pricingBasis'], rateRuleId: event.target.value === 'standard_rate_rule' ? item.rateRuleId : '' } : item))} aria-label={`${formatModuleLabel(module.module_key)} pricing basis`}><option value="quote_lines">Set charges from requirements</option><option value="standard_rate_rule">Use rate book</option><option value="site_override_pending">Confirm charge by place</option></select>{proposalModule.pricingBasis === 'standard_rate_rule' && <select required value={proposalModule.rateRuleId} onChange={(event) => setProposalModules((current) => current.map((item) => item.moduleKey === module.module_key ? { ...item, rateRuleId: event.target.value } : item))} aria-label={`${formatModuleLabel(module.module_key)} provider rate rule`}><option value="">Choose rate for this work</option>{providerBillingRules.filter((rule) => (rule.organization_id === quoteOperatingProviderId || rule.organization_id === state.ownOrg?.id) && (rule.module_key === null || rule.module_key === module.module_key)).sort((left, right) => Number(right.organization_id === quoteOperatingProviderId) - Number(left.organization_id === quoteOperatingProviderId)).map((rule) => <option key={rule.id} value={rule.id}>{rule.organization_id === quoteOperatingProviderId ? 'Operating rate' : 'Parent template'}: {rule.name} ({rule.rate_type}, ${Number(rule.amount).toFixed(2)})</option>)}</select>}</> : <span className="crm-proposal-empty">Select module first</span>}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            <footer>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setQuoteClient(null)}
              >
                Back
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={quoteSaving || !quoteAgreementsChecked || !quoteForm.title.trim() || proposalModules.length === 0 || proposalModules.some((module) => module.pricingBasis === 'standard_rate_rule' && !module.rateRuleId)}
              >
                {quoteSaving ? 'Creating' : !quoteAgreementsChecked ? 'Checking existing agreements…' : 'Create draft quote'}
              </button>
            </footer>
          </form>
        </div>
      )}
      {pricingDialog}
      {workspaceAccount && <CrmAccountWorkspace account={workspaceAccount} initialView={workspaceInitialView} onClose={() => { setWorkspaceAccount(null); void loadCrm(); }} onNavigate={onNavigate} onOpenAccount={(account) => { setWorkspaceInitialView('overview'); setWorkspaceAccount(account); }} onEditOrganization={(organization) => setOrganizationDialog(organization)} onSaveAsClient={state.clients.some((candidate) => candidate.id === workspaceAccount.id) || state.branches.some((candidate) => candidate.id === workspaceAccount.id) ? undefined : async () => { const { data, error } = await supabase.rpc('save_discovered_org_as_client', { p_client_request_id: crypto.randomUUID(), p_source_organization_id: workspaceAccount.id }); if (error || !data) setState((current) => ({ ...current, error: error?.message ?? 'Client account receipt was not confirmed.' })); else { const row = data as { id: string; name: string; status: string }; setNotice(`${row.name} is now saved as a provider client prospect.`); setWorkspaceInitialView('overview'); setWorkspaceAccount({ id: row.id, name: row.name, status: row.status }); await loadCrm(); } }} onOpenQuote={(account, quote) => void reopenQuote(account, quote)} onCreateProposal={(account, place) => { const sourceAccount = [...state.clients, ...state.branches].find((candidate) => candidate.id === account.id); setWorkspaceInitialView('sites'); openQuote(sourceAccount ?? { id: account.id, name: account.name, organization_type: 'client', active: true, status: account.status ?? 'active', updated_at: '', nzbn: null, company_registration_number: null, contact_email: null, contact_phone: null, billing_email: null, billing_address: null, account_notes: null, site_count: account.siteCount ?? 0, primary_contact_name: account.primaryContactName ?? null, latest_quote_status: null, sites: [], blockers: account.readinessBlockers ?? [], next_action: 'Add place-scoped proposal' }, place); }} />}
      {organizationDialog && <CrmOrganizationDialog organization={organizationDialog === 'create' ? null : organizationDialog} onClose={() => { setOrganizationDialog(null); void loadCrm(); }} onUpdated={(name) => { setOrganizationDialog(null); setNotice(`${name} organization details updated. Review its readiness steps next.`); void loadCrm(); }} onOpenAccount={(account) => { setOrganizationDialog(null); setWorkspaceInitialView('sites'); setWorkspaceAccount(account); }} onUseOrganization={(organization) => { setOrganizationDialog(null); setWorkspaceInitialView('overview'); setWorkspaceAccount({ id: organization.id, name: organization.name, status: organization.status }); }} />}
      {siteAccount && <CrmSiteDialog account={siteAccount} onClose={() => setSiteAccount(null)} onCreated={(site) => { setSiteAccount(null); setNotice(`${site.name} created with a provisional boundary. Operations boundary review is required before activation.`); void loadCrm(); }} />}
      {invoiceAction && <div className="crm-quote-backdrop"><form className="crm-quote-dialog" role="dialog" aria-modal="true" aria-labelledby="crm-invoice-action-title" onSubmit={manageInvoice}><header><div><span>Invoice lifecycle</span><h2 id="crm-invoice-action-title">{invoiceAction.action === 'send' ? 'Send invoice' : invoiceAction.action === 'mark_paid' ? 'Confirm payment' : 'Void invoice'}</h2></div><button type="button" onClick={() => setInvoiceAction(null)} aria-label="Close invoice action">×</button></header><p>{invoiceAction.invoice.invoice_number} · {invoiceAction.invoice.client?.name ?? 'Unknown account'} · {invoiceAction.invoice.currency} {Number(invoiceAction.invoice.total_amount).toFixed(2)}</p>{invoiceAction.action === 'void' && <label><span>Void reason</span><textarea required rows={4} value={invoiceReason} onChange={(event) => setInvoiceReason(event.target.value)} /></label>}<footer><button type="button" className="btn btn-secondary" onClick={() => setInvoiceAction(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={quoteSaving || (invoiceAction.action === 'void' && !invoiceReason.trim())}>{quoteSaving ? 'Saving' : 'Confirm action'}</button></footer></form></div>}
      {showGenerateInvoice && (
        <div className="crm-quote-backdrop">
          <form className="crm-quote-dialog" role="dialog" aria-modal="true" aria-labelledby="crm-gen-inv-title" onSubmit={generateInvoiceFromAgreement}>
            <header>
              <div><span>Accounts receivable</span><h2 id="crm-gen-inv-title">Generate invoice from agreement</h2></div>
              <button type="button" onClick={() => setShowGenerateInvoice(false)} aria-label="Close invoice generator">×</button>
            </header>
            <p>Draft invoice will be populated with line items directly from accepted service agreement quotes or commercial rates.</p>
            <label>
              <span>Service agreement</span>
              <select required value={selectedAgreementId} onChange={(e) => setSelectedAgreementId(e.target.value)}>
                <option value="">Select an agreement...</option>
                {state.contractedOrgs.filter((agreement) => agreement.provider_organization_id === (operatingOrganizationId ?? profile?.organizationId) && agreement.invitation_status === 'accepted').map((ag) => (
                  <option key={ag.id} value={ag.id}>{ag.counterparty_name} — {ag.name}</option>
                ))}
              </select>
            </label>
            {invoiceReadinessLoading && <div className="crm-invoice-readiness">Checking agreement billing readiness.</div>}
            {invoiceReadiness && <div className={`crm-invoice-readiness is-${invoiceReadiness.source}`}><strong>{invoiceReadiness.accountName}</strong><span>{invoiceReadiness.agreementName}</span><p>{invoiceReadiness.detail}</p>{invoiceReadiness.billingCycle && <small>{invoiceReadiness.billingCycle} billing · {invoiceReadiness.paymentTermsDays} day payment terms</small>}{invoiceReadiness.source === 'missing' && <small>Configure accepted quote lines or commercial settings before creating a draft invoice.</small>}</div>}
            <footer>
              <button type="button" className="btn btn-secondary" onClick={() => setShowGenerateInvoice(false)}>Cancel</button>
              <button type="submit" className="btn btn-primary" disabled={quoteSaving || !selectedAgreementId || invoiceReadinessLoading || invoiceReadiness?.source === 'missing' || invoiceReadiness?.source === 'client_approval_required'}>{quoteSaving ? 'Generating...' : 'Generate draft invoice'}</button>
            </footer>
          </form>
        </div>
      )}
      {pricingQuote && quoteAction && <div className="crm-quote-backdrop"><form className="crm-quote-dialog crm-lifecycle-dialog" role="dialog" aria-modal="true" aria-labelledby="crm-lifecycle-title" onSubmit={manageQuote}><header><div><span>Quote lifecycle</span><h2 id="crm-lifecycle-title">{quoteAction === 'send' ? 'Send quote?' : quoteAction === 'accept' ? 'Accept quote?' : 'Decline quote?'}</h2></div><button type="button" onClick={() => setQuoteAction(null)} aria-label="Close quote action">×</button></header><p>{quoteAction === 'send' ? 'The server will recheck labour pricing, positive totals, validity, and achieved margin before sending.' : quoteAction === 'accept' ? (pricingQuote.variedAgreementName ? `Acceptance applies this variation to ${pricingQuote.variedAgreementName}: its prices become the agreement's commercial settings and any covered places and schedules are added.` : 'Acceptance creates the operational service agreement and writes its commercial settings.') : 'The quote will close as declined and the reason will remain in its audit history.'}</p>{quoteAction === 'decline' && <label><span>Decline reason</span><textarea rows={4} required value={quoteActionReason} onChange={(event) => setQuoteActionReason(event.target.value)} /></label>}{quoteAction !== 'decline' && quotedModuleKeys.length > 0 && (proposalServiceScopes.length === 0 || proposalScopeSchedules.length === 0) && <p className="crm-lifecycle-warning" role="alert">{proposalServiceScopes.length === 0 ? 'No place is covered by this quote yet.' : 'No delivery schedule is set for the covered places yet.'} It can still be {quoteAction === 'send' ? 'sent' : 'accepted'}, but nothing will be rostered from it until a variation adds the places and times{quoteAction === 'send' ? ' — add them under Module coverage and Places and schedules first if this is the service being sold' : ''}.</p>}<footer><button type="button" className="btn btn-secondary" onClick={() => setQuoteAction(null)}>Back</button><button type="submit" className="btn btn-primary" disabled={quoteSaving || (quoteAction === 'decline' && !quoteActionReason.trim())}>{quoteSaving ? 'Saving' : quoteAction === 'send' ? 'Confirm send' : quoteAction === 'accept' ? 'Confirm acceptance' : 'Confirm decline'}</button></footer></form></div>}
    </div>
  );
};

export default CRMPage;
