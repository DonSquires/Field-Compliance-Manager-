/**
 * OrganizationSetupPage.tsx — "Organisation settings"
 *
 * One place for a subscriber's master/admin to run their organisation:
 * company details, branches, modules in use, location accuracy (geofence
 * radii), service area, notice templates. Every write goes through the
 * governed operating-organisation RPCs; the page reads
 * organizations, organization_modules, org_geofence_config, notice_templates.
 */

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Building2, GitBranch, MapPin, Package, Plus, Printer, Ruler, ScrollText, ShieldCheck } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { addLinzBaseLayers } from '../lib/mapPreferences';
import type { PrinterConnectionType, PrinterPaperWidth } from '../hooks/useOrganizationPrinterSettings';
import { PLATFORM_MODULE_BY_KEY, type PlatformModuleKey } from '../config/platformModuleManifest';
import OrganizationComplianceSection from '../components/OrganizationComplianceSection';
import './PageStyles.css';
import './OrganizationSetupPage.css';

export interface OrgProfile {
  id: string;
  name: string;
  organization_type: string;
  parent_organization_id: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  billing_email: string | null;
  billing_address: string | null;
  legal_name: string | null;
  trading_name: string | null;
  nzbn: string | null;
  company_registration_number: string | null;
  corporate_status: string | null;
  corporate_status_as_of: string | null;
  nzbn_entity_type: string | null;
  registered_office: string | null;
  postal_address: string | null;
  website_url: string | null;
  corporate_profile_source: string | null;
  corporate_profile_verification_status: string;
  enforcement_workflow_mode: string;
  jurisdiction_verification: string;
  jurisdiction_geom: GeoJSON.GeoJsonObject | null;
  status: string;
  updated_at: string;
}

interface ModuleRow { id: string; module_key: string; enabled: boolean; }
interface BranchRow { id: string; name: string; status: string; active: boolean; contact_email: string | null; contact_phone: string | null; updated_at: string; }
interface NoticeTemplate {
  id: string;
  module_key: string;
  notice_type: string;
  version: number;
  is_active: boolean;
  issuing_authority: string | null;
  authorising_act: string;
  authorising_section: string | null;
  bylaw_reference: string | null;
  body_html: string;
  fine_amount: number | null;
  payment_url: string | null;
  footer_text: string | null;
  source_document_url: string | null;
  bob_extracted: boolean;
}
interface GeofenceConfigRow { id: string; config_key: string; config_value: number; zone_type: string | null; }
interface PrinterSettingsForm {
  paperWidth: PrinterPaperWidth;
  connectionType: PrinterConnectionType;
  configured: boolean;
}

const NOTICE_MODULES = [
  { value: 'freedom_camping', label: 'Freedom camping' },
  { value: 'parking_enforcement', label: 'Parking enforcement' },
  { value: 'noise_control', label: 'Noise control' },
  { value: 'smoke_complaints', label: 'Smoke complaints' },
  { value: 'biosecurity', label: 'Biosecurity' },
] as const;

const NOTICE_TYPES = [
  { value: 'written_warning', label: 'Written warning' },
  { value: 'notice_to_vacate', label: 'Notice to vacate' },
  { value: 'infringement', label: 'Infringement' },
  { value: 'end', label: 'Excessive Noise Direction' },
  { value: 'seizure', label: 'Seizure notice' },
] as const;

const EMPTY_NOTICE_TEMPLATE_FORM = {
  moduleKey: 'freedom_camping',
  noticeType: 'written_warning',
  issuingAuthority: '',
  authorisingAct: '',
  authorisingSection: '',
  bylawReference: '',
  bodyHtml: '',
  fineAmount: '',
  paymentUrl: '',
  footerText: '',
  sourceDocumentUrl: '',
  confirmed: false,
};

function noticeModuleLabel(key: string): string {
  return NOTICE_MODULES.find((module) => module.value === key)?.label ?? key.replaceAll('_', ' ');
}

function noticeTypeLabel(key: string): string {
  return NOTICE_TYPES.find((type) => type.value === key)?.label ?? key.replaceAll('_', ' ');
}

// public.get_org_geofence_config()'s own comment: zone-type override -> org-wide -> these platform defaults.
const GEOFENCE_KEYS: { key: string; label: string; help: string; platformDefault: number }[] = [
  { key: 'site_provisional_radius_m', label: 'On site', help: 'How close (metres) an officer must be to a site to count as on site.', platformDefault: 50 },
  { key: 'zone_provisional_radius_m', label: 'In a zone', help: 'How close (metres) to a zone boundary counts as inside the zone.', platformDefault: 100 },
  { key: 'checkpoint_radius_m', label: 'At a checkpoint', help: 'How close (metres) to a checkpoint counts as a verified visit.', platformDefault: 5 },
];

const ENFORCEMENT_MODES: { value: string; label: string; help: string }[] = [
  { value: 'officer_direct', label: 'Officers issue notices themselves', help: 'Fastest. The officer on site issues the notice and it is recorded immediately.' },
  { value: 'admin_first', label: 'An administrator checks first', help: 'Officers submit; a supervisor reviews before anything is issued.' },
  { value: 'hybrid', label: 'Depends on the notice type', help: 'Routine notices go out directly; serious ones wait for review.' },
];

// Catalog keys with no manifest entry still need a human label.
const EXTRA_MODULE_LABELS: Record<string, { label: string; description: string }> = {
  patrol: { label: 'Patrol', description: 'Patrol routes, checkpoints, visits, and run sheets' },
  invoicing: { label: 'Invoicing', description: 'Customer invoices and payment tracking' },
  client_reporting: { label: 'Client reporting', description: 'Monthly reports and the client portal' },
  ems: { label: 'Enforcement management', description: 'Cases, notices, and enforcement records' },
  ptt_radio: { label: 'Push-to-talk radio', description: 'Voice channels between officers and dispatch' },
  access_control: { label: 'Access control', description: 'Keys, gates, and site access records' },
  bob_assistant: { label: 'Bob assistant', description: 'The in-app AI assistant' },
};

function moduleLabel(key: string): { label: string; description: string } {
  const manifest = PLATFORM_MODULE_BY_KEY[key as PlatformModuleKey];
  if (manifest) return { label: manifest.label, description: manifest.description };
  if (EXTRA_MODULE_LABELS[key]) return EXTRA_MODULE_LABELS[key];
  const words = key.replaceAll('_', ' ');
  return { label: words.charAt(0).toUpperCase() + words.slice(1), description: '' };
}

const OrganizationSetupPage: React.FC = () => {
  const { profile, operatingOrganizationId, refreshOperatingOrganizations } = useAuth();
  const [org, setOrg] = useState<OrgProfile | null>(null);
  const [modules, setModules] = useState<ModuleRow[]>([]);
  const [branches, setBranches] = useState<BranchRow[]>([]);
  const [templates, setTemplates] = useState<NoticeTemplate[]>([]);
  const [showTemplateForm, setShowTemplateForm] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<NoticeTemplate | null>(null);
  const [templateForm, setTemplateForm] = useState(EMPTY_NOTICE_TEMPLATE_FORM);
  const [templateRequestId, setTemplateRequestId] = useState(() => crypto.randomUUID());
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [geofenceConfig, setGeofenceConfig] = useState<GeofenceConfigRow[]>([]);
  const [printerSettings, setPrinterSettings] = useState<PrinterSettingsForm>({
    paperWidth: '58mm',
    connectionType: 'browser_print',
    configured: false,
  });
  const [savingPrinterSettings, setSavingPrinterSettings] = useState(false);
  const [resolvedGeofenceDefaults, setResolvedGeofenceDefaults] = useState<Record<string, number>>({});
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [overrideForm, setOverrideForm] = useState({ config_key: GEOFENCE_KEYS[0].key, zone_type: '', config_value: '' });
  const [branchForm, setBranchForm] = useState({ name: '', contact_email: '', contact_phone: '' });
  const [branchRequestId, setBranchRequestId] = useState(() => crypto.randomUUID());
  const [archivingBranchId, setArchivingBranchId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [jurisdictionNames, setJurisdictionNames] = useState<string[]>([]);
  const [territorialAuthorities, setTerritorialAuthorities] = useState<string[]>([]);
  const [jurisdictionSearch, setJurisdictionSearch] = useState('');
  const [jurisdictionPreview, setJurisdictionPreview] = useState<GeoJSON.GeoJsonObject | null>(null);
  const [jurisdictionPreviewLoading, setJurisdictionPreviewLoading] = useState(false);
  const [jurisdictionPreviewMessage, setJurisdictionPreviewMessage] = useState<string | null>(null);
  const [jurisdictionProposalLoading, setJurisdictionProposalLoading] = useState(false);

  const isBranch = org?.organization_type === 'branch';

  // ATLAS READS: organizations, organization_modules, notice_templates, org_geofence_config, org_printer_settings
  const loadAll = useCallback(async () => {
    const orgId = operatingOrganizationId ?? profile?.organizationId;
    if (!orgId) {
      setLoading(false);
      setError(null);
      return;
    }

    try {
      setLoading(true);
      setError(null);

      const [orgRes, modulesRes, branchesRes, templatesRes, geofenceRes, printerRes, authoritiesRes] = await Promise.all([
        supabase
          .from('organizations')
          .select(
            'id, name, organization_type, parent_organization_id, contact_email, contact_phone, billing_email, billing_address, legal_name, trading_name, nzbn, company_registration_number, corporate_status, corporate_status_as_of, nzbn_entity_type, registered_office, postal_address, website_url, corporate_profile_source, corporate_profile_verification_status, enforcement_workflow_mode, jurisdiction_verification, jurisdiction_geom, status, updated_at'
          )
          .eq('id', orgId)
          .single(),
        supabase.from('organization_modules').select('id, module_key, enabled').eq('organization_id', orgId).order('module_key'),
        supabase.from('organizations').select('id, name, organization_type, status, active, contact_email, contact_phone, updated_at').eq('parent_organization_id', orgId).eq('organization_type', 'branch').order('name'),
        supabase
          .from('notice_templates')
          .select('id, module_key, notice_type, version, is_active, issuing_authority, authorising_act, authorising_section, bylaw_reference, body_html, fine_amount, payment_url, footer_text, source_document_url, bob_extracted')
          .eq('organization_id', orgId)
          .order('is_active', { ascending: false })
          .order('module_key')
          .order('notice_type')
          .order('version', { ascending: false }),
        supabase
          .from('org_geofence_config')
          .select('id, config_key, config_value, zone_type')
          .eq('organization_id', orgId),
        supabase
          .from('org_printer_settings')
          .select('paper_width, connection_type')
          .eq('organization_id', orgId)
          .maybeSingle(),
        supabase
          .from('canonical_ta_names')
          .select('ta_name')
          .order('ta_name'),
      ]);

      if (orgRes.error) throw orgRes.error;
      if (modulesRes.error) throw modulesRes.error;
      if (branchesRes.error) throw branchesRes.error;
      if (templatesRes.error) throw templatesRes.error;
      if (geofenceRes.error) throw geofenceRes.error;
      if (printerRes.error) throw printerRes.error;
      if (authoritiesRes.error) throw authoritiesRes.error;

      setOrg(orgRes.data as OrgProfile);
      setModules((modulesRes.data as ModuleRow[]) || []);
      setBranches(((branchesRes.data as Array<BranchRow & { organization_type: string }>) || []).filter((row) => row.organization_type === 'branch'));
      setTemplates((templatesRes.data as NoticeTemplate[]) || []);
      setGeofenceConfig((geofenceRes.data as GeofenceConfigRow[]) || []);
      setPrinterSettings(printerRes.data ? {
        paperWidth: printerRes.data.paper_width as PrinterPaperWidth,
        connectionType: printerRes.data.connection_type as PrinterConnectionType,
        configured: true,
      } : {
        paperWidth: '58mm',
        connectionType: 'browser_print',
        configured: false,
      });
      setTerritorialAuthorities((authoritiesRes.data ?? []).map((row) => String(row.ta_name)));
      const resolvedEntries = await Promise.all(GEOFENCE_KEYS.map(async (key) => {
        const { data, error: resolutionError } = await supabase.rpc('get_org_geofence_config', {
          p_org_id: orgId,
          p_config_key: key.key,
          p_zone_type: null,
          p_default: key.platformDefault,
        });
        if (resolutionError) throw resolutionError;
        return [key.key, Number(data)] as const;
      }));
      setResolvedGeofenceDefaults(Object.fromEntries(resolvedEntries));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load organisation settings');
    } finally {
      setLoading(false);
    }
  }, [operatingOrganizationId, profile?.organizationId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const enabledModuleKeys = useMemo(() => new Set(modules.filter((m) => m.enabled).map((m) => m.module_key)), [modules]);
  const activeBranches = useMemo(() => branches.filter((b) => b.status !== 'archived'), [branches]);
  const enabledNoticeModules = useMemo(() => NOTICE_MODULES.filter((module) => enabledModuleKeys.has(module.value)), [enabledModuleKeys]);
  const activeTemplates = useMemo(() => templates.filter((template) => template.is_active), [templates]);
  const filteredAuthorities = useMemo(() => {
    const q = jurisdictionSearch.trim().toLowerCase();
    if (!q) return [];
    return territorialAuthorities.filter((name) => name.toLowerCase().includes(q) && !jurisdictionNames.includes(name)).slice(0, 8);
  }, [jurisdictionNames, jurisdictionSearch, territorialAuthorities]);

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org) return;

    try {
      setSaving(true);
      setError(null);
      setNotice(null);

      const { data, error } = await supabase.rpc('update_operating_branch_profile', {
        p_operating_organization_id: org.id,
        p_expected_updated_at: org.updated_at,
        p_contact_email: org.contact_email,
        p_contact_phone: org.contact_phone,
        p_billing_email: org.billing_email,
        p_billing_address: org.billing_address,
        p_enforcement_workflow_mode: org.enforcement_workflow_mode,
      });

      if (error) throw error;
      if (data) setOrg({ ...org, ...(data as Partial<OrgProfile>) });
      setNotice('Company details saved.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save company details');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleModule = async (mod: ModuleRow) => {
    try {
      setError(null);
      setNotice(null);
      const { error } = await supabase.rpc('set_operating_branch_module', { p_operating_organization_id: org?.id, p_module_key: mod.module_key, p_enabled: !mod.enabled });

      if (error) throw error;
      setModules(modules.map((m) => (m.id === mod.id ? { ...m, enabled: !m.enabled } : m)));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update module');
    }
  };

  const handleSavePrinterSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!org) return;

    try {
      setSavingPrinterSettings(true);
      setError(null);
      setNotice(null);

      // ATLAS WRITES: manage_org_printer_settings
      const { data, error: saveError } = await supabase.rpc('manage_org_printer_settings', {
        p_organization_id: org.id,
        p_paper_width: printerSettings.paperWidth,
        p_connection_type: printerSettings.connectionType,
      });
      if (saveError) throw saveError;

      const receipt = data as { paper_width?: string; connection_type?: string } | null;
      if (receipt?.paper_width !== printerSettings.paperWidth || receipt?.connection_type !== printerSettings.connectionType) {
        throw new Error('Printer settings were not confirmed after saving.');
      }

      setPrinterSettings((current) => ({ ...current, configured: true }));
      setNotice(`Printer default saved for ${org.name}.`);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Printer settings could not be saved.');
    } finally {
      setSavingPrinterSettings(false);
    }
  };

  const handleCreateBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!org || !branchForm.name.trim()) return;
    try {
      setSaving(true);
      setError(null);
      setNotice(null);
      const { data, error } = await supabase.rpc('create_provider_branch', {
        p_client_request_id: branchRequestId,
        p_parent_organization_id: org.id,
        p_name: branchForm.name.trim(),
        p_contact_email: branchForm.contact_email.trim() || null,
        p_contact_phone: branchForm.contact_phone.trim() || null,
      });
      if (error) throw error;
      const created = data as BranchRow;
      setBranches((current) => [...current.filter((b) => b.id !== created.id), created].sort((a, b) => a.name.localeCompare(b.name)));
      setBranchForm({ name: '', contact_email: '', contact_phone: '' });
      setBranchRequestId(crypto.randomUUID());
      setNotice(`${created.name} added. Pick it from "Working in" at the top to set up its staff, customers, and prices.`);
      await refreshOperatingOrganizations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add branch');
    } finally {
      setSaving(false);
    }
  };

  const handleArchiveBranch = async (branch: BranchRow) => {
    if (!window.confirm(`Archive ${branch.name}? Its pages disappear for everyone. Records are kept.`)) return;
    try {
      setArchivingBranchId(branch.id);
      setError(null);
      setNotice(null);
      const { data, error } = await supabase.rpc('archive_provider_branch', { p_branch_organization_id: branch.id, p_expected_updated_at: branch.updated_at });
      if (error) throw error;
      const archived = data as BranchRow;
      setBranches((current) => current.map((b) => (b.id === archived.id ? archived : b)));
      setNotice(`${branch.name} archived.`);
      await refreshOperatingOrganizations();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to archive branch');
    } finally {
      setArchivingBranchId(null);
    }
  };

  const openNewTemplate = () => {
    const moduleKey = enabledNoticeModules[0]?.value ?? NOTICE_MODULES[0].value;
    setEditingTemplate(null);
    setTemplateForm({ ...EMPTY_NOTICE_TEMPLATE_FORM, moduleKey });
    setTemplateRequestId(crypto.randomUUID());
    setShowTemplateForm(true);
    setError(null);
    setNotice(null);
  };

  const openTemplateVersion = (template: NoticeTemplate) => {
    setEditingTemplate(template);
    setTemplateForm({
      moduleKey: template.module_key,
      noticeType: template.notice_type,
      issuingAuthority: template.issuing_authority ?? '',
      authorisingAct: template.authorising_act,
      authorisingSection: template.authorising_section ?? '',
      bylawReference: template.bylaw_reference ?? '',
      bodyHtml: template.body_html,
      fineAmount: template.fine_amount == null ? '' : String(template.fine_amount),
      paymentUrl: template.payment_url ?? '',
      footerText: template.footer_text ?? '',
      sourceDocumentUrl: template.source_document_url ?? '',
      confirmed: false,
    });
    setTemplateRequestId(crypto.randomUUID());
    setShowTemplateForm(true);
    setError(null);
    setNotice(null);
  };

  const closeTemplateForm = () => {
    if (savingTemplate) return;
    setShowTemplateForm(false);
    setEditingTemplate(null);
    setTemplateForm(EMPTY_NOTICE_TEMPLATE_FORM);
  };

  const saveNoticeTemplate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!org || !templateForm.confirmed) return;
    try {
      setSavingTemplate(true);
      setError(null);
      setNotice(null);
      const { data, error: saveError } = await supabase.rpc('manage_notice_template', {
        p_organization_id: org.id,
        p_client_request_id: templateRequestId,
        p_module_key: templateForm.moduleKey,
        p_notice_type: templateForm.noticeType,
        p_body_html: templateForm.bodyHtml.trim(),
        p_expected_current_id: editingTemplate?.id ?? null,
        p_expected_current_version: editingTemplate?.version ?? null,
        p_issuing_authority: templateForm.issuingAuthority.trim(),
        p_authorising_act: templateForm.authorisingAct.trim(),
        p_authorising_section: templateForm.authorisingSection.trim() || null,
        p_bylaw_reference: templateForm.bylawReference.trim() || null,
        p_fine_amount: templateForm.fineAmount === '' ? null : Number(templateForm.fineAmount),
        p_payment_url: templateForm.paymentUrl.trim() || null,
        p_footer_text: templateForm.footerText.trim() || null,
        p_source_document_url: templateForm.sourceDocumentUrl.trim(),
        p_bob_extracted: false,
      });
      if (saveError) throw saveError;
      const receipt = data as { template?: NoticeTemplate; replayed?: boolean } | null;
      if (!receipt?.template) throw new Error('The template was saved without a usable receipt');
      const saved = receipt.template;
      setTemplates((current) => [
        saved,
        ...current
          .filter((template) => template.id !== saved.id)
          .map((template) => template.module_key === saved.module_key && template.notice_type === saved.notice_type
            ? { ...template, is_active: false }
            : template),
      ]);
      setNotice(`${noticeModuleLabel(saved.module_key)} ${noticeTypeLabel(saved.notice_type).toLowerCase()} template v${saved.version} saved. Future notices use this version; earlier issued notices and template versions remain in the audit history.`);
      setShowTemplateForm(false);
      setEditingTemplate(null);
      setTemplateForm(EMPTY_NOTICE_TEMPLATE_FORM);
      setTemplateRequestId(crypto.randomUUID());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the notice template');
    } finally {
      setSavingTemplate(false);
    }
  };

  // Manual find-then-update/insert rather than upsert(onConflict): the
  // org_geofence_config unique constraint is (organization_id, config_key,
  // zone_type), but Postgres treats every NULL zone_type as distinct from
  // every other NULL for uniqueness purposes -- an upsert would silently
  // insert a duplicate org-wide row instead of updating the existing one.
  const saveGeofenceValue = async (configKey: string, zoneType: string | null, value: number) => {
    if (!org || Number.isNaN(value)) return;
    try {
      setSavingKey(`${configKey}:${zoneType ?? ''}`);
      setError(null);

      const { data, error } = await supabase.rpc('manage_operating_branch_geofence_config', { p_operating_organization_id: org.id, p_action: 'set', p_config_id: null, p_config_key: configKey, p_zone_type: zoneType, p_config_value: value });
      if (error) throw error;
      const saved = data as GeofenceConfigRow;
      setGeofenceConfig((current) => current.some((item) => item.id === saved.id) ? current.map((item) => item.id === saved.id ? saved : item) : [...current, saved]);
      if (zoneType === null) setResolvedGeofenceDefaults((current) => ({ ...current, [configKey]: value }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save distance');
    } finally {
      setSavingKey(null);
    }
  };

  const handleAddOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = Number(overrideForm.config_value);
    if (!overrideForm.zone_type.trim() || Number.isNaN(value)) return;
    await saveGeofenceValue(overrideForm.config_key, overrideForm.zone_type.trim(), value);
    setOverrideForm({ config_key: GEOFENCE_KEYS[0].key, zone_type: '', config_value: '' });
  };

  const handleDeleteOverride = async (id: string) => {
    try {
      setError(null);
      if (!org) return;
      const { error } = await supabase.rpc('manage_operating_branch_geofence_config', { p_operating_organization_id: org.id, p_action: 'remove', p_config_id: id, p_config_key: null, p_zone_type: null, p_config_value: null });
      if (error) throw error;
      setGeofenceConfig(geofenceConfig.filter((g) => g.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove the zone-type distance');
    }
  };

  const previewJurisdiction = async (event: React.FormEvent) => {
    event.preventDefault();
    if (jurisdictionNames.length === 0) return;
    setJurisdictionPreviewLoading(true);
    setJurisdictionPreviewMessage(null);
    setJurisdictionPreview(null);
    const { data, error: previewError } = await supabase.functions.invoke('bob-jurisdiction-preview', { body: { district_names: jurisdictionNames } });
    if (previewError || !data?.results?.length || data.results.some((result: { matched: boolean }) => !result.matched)) {
      const unmatched = (data?.unmatched ?? jurisdictionNames).join(', ');
      const unavailable = (data?.unavailable ?? []).join(', ');
      setJurisdictionPreviewMessage(previewError?.message ?? (unavailable ? `Boundary source unavailable for: ${unavailable}. Nothing has been saved; retry or draw the boundary manually.` : `No council boundary matched: ${unmatched}.`));
    } else {
      setJurisdictionPreview({ type: 'FeatureCollection', features: data.results.map((result: { geometry: GeoJSON.GeoJsonObject; name: string }) => ({ type: 'Feature', properties: { name: result.name }, geometry: result.geometry })) } as GeoJSON.GeoJsonObject);
      setJurisdictionPreviewMessage(`Boundary preview loaded for ${jurisdictionNames.join(', ')}. Nothing has been saved yet — Bob sends it to Approvals when you are ready.`);
    }
    setJurisdictionPreviewLoading(false);
  };

  const proposeJurisdiction = async () => {
    if (!org || !jurisdictionPreview || jurisdictionNames.length === 0) return;
    try {
      setJurisdictionProposalLoading(true);
      setError(null);
      setNotice(null);
      const { data, error: proposalError } = await supabase.functions.invoke('bob-propose-org-jurisdiction', {
        body: {
          organization_id: org.id,
          district_names: jurisdictionNames,
          reasoning: `Set ${org.name}'s service area from the previewed council boundaries: ${jurisdictionNames.join(', ')}.`,
        },
      });
      if (proposalError) throw proposalError;
      if (!data?.success) throw new Error(data?.error ?? 'The service-area proposal was not created');
      setNotice(data.note ?? 'Service area sent to Approvals.');
      setJurisdictionPreviewMessage('Boundary preview retained. The proposal is waiting in Approvals; routing will not use it until a person approves and visually verifies it.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send the service area to Approvals');
    } finally {
      setJurisdictionProposalLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="loading-state">
          <div className="spinner"></div>
          <p>Loading organisation settings...</p>
        </div>
      </div>
    );
  }

  if (!org) {
    return (
      <div className="page-container">
        <header className="page-header"><div><h1>Organisation settings</h1></div></header>
        <div className="empty-state">
          <p>{error ?? 'Your organisation could not be loaded. Pick an organisation or branch from "Working in" at the top.'}</p>
        </div>
      </div>
    );
  }

  const detailsComplete = Boolean(org.contact_email && org.contact_phone);
  const corporateProfileComplete = Boolean(
    org.legal_name
    && org.nzbn
    && org.company_registration_number
    && org.corporate_profile_verification_status === 'verified'
  );
  const zoneOverrides = geofenceConfig.filter((g) => g.zone_type !== null);
  const customDistanceCount = geofenceConfig.filter((g) => g.zone_type === null).length;

  return (
    <div className="page-container org-settings">
      <header className="page-header org-settings-header">
        <div>
          <h1>Organisation settings</h1>
          <p className="subtitle">{org.name} <span className={`status-badge status-${org.status === 'active' ? 'active' : 'inactive'}`}>{isBranch ? 'Branch' : 'Organisation'} · {org.status}</span></p>
        </div>
      </header>

      {error && (
        <div className="alert alert-error" role="alert">
          <button className="alert-close" onClick={() => setError(null)} aria-label="Close alert">×</button>
          {error}
        </div>
      )}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}

      <nav className="org-settings-checklist" aria-label="Setup overview">
        <a href="#org-details" className={detailsComplete ? 'is-done' : 'is-todo'}><Building2 size={16} /><span><strong>Company details</strong><small>{detailsComplete ? 'Complete' : 'Add a contact email and phone'}</small></span></a>
        {!isBranch && <a href="#org-compliance" className={corporateProfileComplete ? 'is-done' : 'is-todo'}><ShieldCheck size={16} /><span><strong>Legal and compliance</strong><small>{corporateProfileComplete ? 'Company identity verified' : 'Review legal identity and evidence'}</small></span></a>}
        {!isBranch && <a href="#org-branches" className={activeBranches.length ? 'is-done' : 'is-neutral'}><GitBranch size={16} /><span><strong>Branches</strong><small>{activeBranches.length ? `${activeBranches.length} active` : 'Optional'}</small></span></a>}
        <a href="#org-modules" className={enabledModuleKeys.size ? 'is-done' : 'is-todo'}><Package size={16} /><span><strong>Modules in use</strong><small>{enabledModuleKeys.size} on · {modules.length - enabledModuleKeys.size} off</small></span></a>
        <a href="#org-printing" className={printerSettings.configured ? 'is-done' : 'is-todo'}><Printer size={16} /><span><strong>Notice printing</strong><small>{printerSettings.configured ? `${printerSettings.paperWidth.toUpperCase()} · ${printerSettings.connectionType === 'bluetooth_escpos' ? 'Bluetooth' : 'browser/OS'}` : 'Confirm a printer default'}</small></span></a>
        <a href="#org-distances" className="is-neutral"><Ruler size={16} /><span><strong>Location accuracy</strong><small>{customDistanceCount ? `${customDistanceCount} custom distance${customDistanceCount === 1 ? '' : 's'}` : 'Using platform defaults'}</small></span></a>
        <a href="#org-service-area" className={org.jurisdiction_verification === 'verified' ? 'is-done' : 'is-todo'}><MapPin size={16} /><span><strong>Service area</strong><small>{org.jurisdiction_verification === 'verified' ? 'Verified' : 'Not yet verified'}</small></span></a>
        <a href="#org-templates" className={activeTemplates.length ? 'is-done' : enabledNoticeModules.length ? 'is-todo' : 'is-neutral'}><ScrollText size={16} /><span><strong>Notice templates</strong><small>{activeTemplates.length ? `${activeTemplates.length} active` : enabledNoticeModules.length ? 'Set legal wording before field use' : 'Turn on an enforcement module first'}</small></span></a>
      </nav>

      <section className="reports-section org-settings-section" id="org-details" aria-labelledby="org-details-title">
        <div className="org-settings-section-heading"><span>Who you are</span><h2 id="org-details-title">Company details</h2><p>Where customers, staff, and invoices reach you.</p></div>
        <form className="settings-form" onSubmit={handleSaveProfile}>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="org-contact-email">Contact email</label>
              <input id="org-contact-email" type="email" autoComplete="email" value={org.contact_email || ''} onChange={(e) => setOrg({ ...org, contact_email: e.target.value })} />
            </div>
            <div className="form-group">
              <label htmlFor="org-contact-phone">Contact phone</label>
              <input id="org-contact-phone" type="tel" autoComplete="tel" value={org.contact_phone || ''} onChange={(e) => setOrg({ ...org, contact_phone: e.target.value })} />
            </div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="org-billing-email">Email for invoices</label>
              <input id="org-billing-email" type="email" value={org.billing_email || ''} onChange={(e) => setOrg({ ...org, billing_email: e.target.value })} />
            </div>
            <div className="form-group">
              <label htmlFor="org-billing-address">Billing address</label>
              <input id="org-billing-address" type="text" autoComplete="street-address" value={org.billing_address || ''} onChange={(e) => setOrg({ ...org, billing_address: e.target.value })} />
            </div>
          </div>
          <fieldset className="org-settings-choice">
            <legend>How notices are issued</legend>
            {ENFORCEMENT_MODES.map((mode) => (
              <label key={mode.value} className={org.enforcement_workflow_mode === mode.value ? 'is-selected' : ''}>
                <input type="radio" name="enforcement_workflow_mode" value={mode.value} checked={org.enforcement_workflow_mode === mode.value} onChange={() => setOrg({ ...org, enforcement_workflow_mode: mode.value })} />
                <span><strong>{mode.label}</strong><small>{mode.help}</small></span>
              </label>
            ))}
          </fieldset>
          <div className="org-settings-actions">
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save details'}</button>
          </div>
        </form>
      </section>

      {!isBranch && <OrganizationComplianceSection org={org} onOrgChange={setOrg} />}

      {!isBranch && (
        <section className="reports-section org-settings-section" id="org-branches" aria-labelledby="org-branches-title">
          <div className="org-settings-section-heading"><span>Structure</span><h2 id="org-branches-title">Branches</h2><p>Add a branch for each region or team that runs its own roster, staff, and customers. Everything can also stay at the organisation level.</p></div>
          {activeBranches.length === 0 ? (
            <div className="empty-state org-settings-empty"><p>No branches yet.</p></div>
          ) : (
            <ul className="org-branch-list" aria-label="Branches">
              {activeBranches.map((branch) => (
                <li key={branch.id} className="org-branch-row">
                  <div><strong>{branch.name}</strong><small>{[branch.contact_email, branch.contact_phone].filter(Boolean).join(' · ') || 'No contact details yet'}</small></div>
                  <div className="org-branch-row-actions">
                    <span className={`status-badge status-${branch.active ? 'active' : 'inactive'}`}>{branch.status}</span>
                    <button type="button" className="btn btn-sm btn-secondary" disabled={archivingBranchId === branch.id} onClick={() => void handleArchiveBranch(branch)}>{archivingBranchId === branch.id ? 'Archiving…' : 'Archive'}</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <form className="settings-form org-branch-form" onSubmit={handleCreateBranch} aria-label="Add a branch">
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="branch-name">Branch name</label>
                <input id="branch-name" required maxLength={200} placeholder="e.g. Nelson" value={branchForm.name} onChange={(e) => setBranchForm({ ...branchForm, name: e.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="branch-email">Branch email (optional)</label>
                <input id="branch-email" type="email" value={branchForm.contact_email} onChange={(e) => setBranchForm({ ...branchForm, contact_email: e.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="branch-phone">Branch phone (optional)</label>
                <input id="branch-phone" type="tel" value={branchForm.contact_phone} onChange={(e) => setBranchForm({ ...branchForm, contact_phone: e.target.value })} />
              </div>
            </div>
            <div className="org-settings-actions">
              <button type="submit" className="btn btn-primary" disabled={saving || !branchForm.name.trim()}>{saving ? 'Adding…' : 'Add branch'}</button>
              <small>A new branch starts with the same modules as the organisation.</small>
            </div>
          </form>
        </section>
      )}

      <section className="reports-section org-settings-section" id="org-modules" aria-labelledby="org-modules-title">
        <div className="org-settings-section-heading"><span>What you use</span><h2 id="org-modules-title">Modules in use</h2><p>{isBranch ? 'A branch can only turn on modules the organisation has on. Turning one off hides its pages for this branch.' : 'Turning a module off hides its pages for everyone in the organisation. Your subscription is unchanged.'}</p></div>
        {modules.length === 0 ? (
          <div className="empty-state org-settings-empty"><p>No modules are set up for this {isBranch ? 'branch' : 'organisation'} yet.</p></div>
        ) : (
          <ul className="org-module-grid" aria-label="Modules">
            {modules.map((mod) => {
              const { label, description } = moduleLabel(mod.module_key);
              const manifest = PLATFORM_MODULE_BY_KEY[mod.module_key as PlatformModuleKey];
              const missing = manifest ? manifest.dependsOn.filter((dep) => !enabledModuleKeys.has(dep)) : [];
              const blocked = !mod.enabled && missing.length > 0;
              return (
                <li key={mod.id} className={`org-module-card ${mod.enabled ? 'is-on' : 'is-off'}`}>
                  <div><h3>{label}</h3>{description && <small>{description}</small>}{blocked && <small className="org-module-hint">Turn on {missing.map((dep) => moduleLabel(dep).label).join(', ')} first.</small>}</div>
                  <button type="button" className={`btn btn-sm ${mod.enabled ? 'btn-primary' : 'btn-secondary'}`} aria-pressed={mod.enabled} aria-label={`${label}: ${mod.enabled ? 'on' : 'off'}`} disabled={blocked} onClick={() => handleToggleModule(mod)}>
                    {mod.enabled ? 'On' : 'Off'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="reports-section org-settings-section" id="org-printing" aria-labelledby="org-printing-title">
        <div className="org-settings-section-heading"><span>Field readiness</span><h2 id="org-printing-title">Notice printing</h2><p>Choose the default officers and administrators see when printing notices for this {isBranch ? 'branch' : 'organisation'}. They can still change the paper for one print without changing this default.</p></div>
        <form className="settings-form org-printer-settings" onSubmit={handleSavePrinterSettings}>
          <fieldset className="org-settings-choice">
            <legend>Paper</legend>
            {([
              { value: '58mm', label: '58 mm thermal receipt', help: 'For compact mobile receipt printers.' },
              { value: '80mm', label: '80 mm thermal receipt', help: 'For wider receipt printers and more readable field copies.' },
              { value: 'a4', label: 'A4 page', help: 'Uses the browser or operating-system print dialog. Raw Bluetooth thermal printing is unavailable.' },
            ] as const).map((option) => (
              <label key={option.value} className={printerSettings.paperWidth === option.value ? 'is-selected' : ''}>
                <input
                  type="radio"
                  name="printer_paper_width"
                  value={option.value}
                  checked={printerSettings.paperWidth === option.value}
                  onChange={() => setPrinterSettings((current) => ({
                    ...current,
                    paperWidth: option.value,
                    connectionType: option.value === 'a4' ? 'browser_print' : current.connectionType,
                  }))}
                />
                <span><strong>{option.label}</strong><small>{option.help}</small></span>
              </label>
            ))}
          </fieldset>
          <fieldset className="org-settings-choice">
            <legend>Preferred connection</legend>
            <label className={printerSettings.connectionType === 'browser_print' ? 'is-selected' : ''}>
              <input type="radio" name="printer_connection_type" value="browser_print" checked={printerSettings.connectionType === 'browser_print'} onChange={() => setPrinterSettings((current) => ({ ...current, connectionType: 'browser_print' }))} />
              <span><strong>Browser / operating-system print</strong><small>Use for Wi-Fi, USB, AirPrint, and A4 printers already installed on the device.</small></span>
            </label>
            <label className={printerSettings.connectionType === 'bluetooth_escpos' ? 'is-selected' : ''} aria-disabled={printerSettings.paperWidth === 'a4'}>
              <input type="radio" name="printer_connection_type" value="bluetooth_escpos" disabled={printerSettings.paperWidth === 'a4'} checked={printerSettings.connectionType === 'bluetooth_escpos'} onChange={() => setPrinterSettings((current) => ({ ...current, connectionType: 'bluetooth_escpos' }))} />
              <span><strong>Bluetooth thermal printer</strong><small>Uses Web Bluetooth in Chrome or Edge with 58 mm or 80 mm ESC/POS printers.</small></span>
            </label>
          </fieldset>
          <div className="org-settings-actions">
            <button type="submit" className="btn btn-primary" disabled={savingPrinterSettings}>{savingPrinterSettings ? 'Saving…' : 'Save printer default'}</button>
            <small>{printerSettings.configured ? `Current saved default for ${org.name}.` : 'No saved default yet; printing falls back to 58 mm browser/OS print.'}</small>
          </div>
        </form>
      </section>

      <section className="reports-section org-settings-section" id="org-distances" aria-labelledby="org-distances-title">
        <div className="org-settings-section-heading"><span>Proof of attendance</span><h2 id="org-distances-title">Location accuracy</h2><p>How close an officer's phone must be before the app counts them as there. Smaller is stricter. Leave the defaults unless you know your sites need something different.</p></div>
        <ul className="org-distance-list" aria-label="Distances">
          {GEOFENCE_KEYS.map((k) => {
            const existing = geofenceConfig.find((g) => g.config_key === k.key && g.zone_type === null);
            const resolvedValue = resolvedGeofenceDefaults[k.key] ?? existing?.config_value ?? k.platformDefault;
            const inputId = `distance-${k.key}`;
            return (
              <li key={k.key} className="org-distance-row">
                <label htmlFor={inputId}><strong>{k.label}</strong><small>{k.help}</small></label>
                <div className="org-distance-input">
                  <input id={inputId} type="number" min={0} max={10000} defaultValue={resolvedValue}
                    onBlur={(e) => {
                      const value = Number(e.target.value);
                      if (!Number.isNaN(value) && value !== (existing?.config_value ?? k.platformDefault)) saveGeofenceValue(k.key, null, value);
                    }} />
                  <span>m</span>
                  <small>{savingKey === `${k.key}:` ? 'Saving…' : existing ? 'Custom' : `Default ${k.platformDefault} m`}</small>
                </div>
              </li>
            );
          })}
        </ul>
        <details className="org-settings-advanced">
          <summary>Different distance for a type of zone {zoneOverrides.length > 0 && `(${zoneOverrides.length})`}</summary>
          {zoneOverrides.length > 0 && (
            <ul className="org-distance-list" aria-label="Zone-type distances">
              {zoneOverrides.map((g) => (
                <li key={g.id} className="org-distance-row">
                  <div><strong>{GEOFENCE_KEYS.find((k) => k.key === g.config_key)?.label ?? g.config_key}</strong><small>{g.zone_type} zones · {g.config_value} m</small></div>
                  <button type="button" className="btn btn-sm btn-secondary" onClick={() => handleDeleteOverride(g.id)}>Remove</button>
                </li>
              ))}
            </ul>
          )}
          <form className="settings-form" onSubmit={handleAddOverride}>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="override-key">Which distance</label>
                <select id="override-key" value={overrideForm.config_key} onChange={(e) => setOverrideForm({ ...overrideForm, config_key: e.target.value })}>
                  {GEOFENCE_KEYS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="override-zone">Zone type</label>
                <input id="override-zone" type="text" required placeholder="e.g. freedom_camping" value={overrideForm.zone_type} onChange={(e) => setOverrideForm({ ...overrideForm, zone_type: e.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="override-value">Metres</label>
                <input id="override-value" type="number" min={0} max={10000} required value={overrideForm.config_value} onChange={(e) => setOverrideForm({ ...overrideForm, config_value: e.target.value })} />
              </div>
            </div>
            <div className="org-settings-actions"><button type="submit" className="btn btn-secondary btn-sm">Add zone-type distance</button></div>
          </form>
        </details>
      </section>

      <section className="reports-section org-settings-section" id="org-service-area" aria-labelledby="org-service-area-title">
        <div className="org-settings-section-heading"><span>Where you work</span><h2 id="org-service-area-title">Service area</h2><p>Pick the council areas you operate in and preview the boundary. {org.jurisdiction_verification === 'verified' ? 'Your current boundary is verified.' : 'Bob sends the boundary to Approvals; a person approves it before routing uses it.'}</p></div>
        <form className="settings-form org-service-area-form" onSubmit={previewJurisdiction}>
          <div className="form-group">
            <label htmlFor="service-area-search">Council area</label>
            <input id="service-area-search" type="search" placeholder="Start typing, e.g. Nelson" value={jurisdictionSearch} onChange={(e) => setJurisdictionSearch(e.target.value)} aria-autocomplete="list" aria-controls="service-area-options" />
            {filteredAuthorities.length > 0 && (
              <ul id="service-area-options" className="org-service-area-options" aria-label="Matching council areas">
                {filteredAuthorities.map((name) => (
                  <li key={name}><button type="button" onClick={() => { setJurisdictionNames((current) => [...current, name]); setJurisdictionSearch(''); }}>{name}</button></li>
                ))}
              </ul>
            )}
          </div>
          {jurisdictionNames.length > 0 && (
            <ul className="org-service-area-chips" aria-label="Selected council areas">
              {jurisdictionNames.map((name) => (
                <li key={name}><span>{name}</span><button type="button" aria-label={`Remove ${name}`} onClick={() => setJurisdictionNames((current) => current.filter((selected) => selected !== name))}>×</button></li>
              ))}
            </ul>
          )}
          <div className="org-settings-actions">
            <button type="submit" className="btn btn-secondary" disabled={jurisdictionPreviewLoading || jurisdictionNames.length === 0}>{jurisdictionPreviewLoading ? 'Loading boundary…' : 'Preview boundary'}</button>
            <button type="button" className="btn btn-primary" onClick={proposeJurisdiction} disabled={jurisdictionProposalLoading || !jurisdictionPreview}>
              {jurisdictionProposalLoading ? 'Sending to Approvals…' : 'Send to Approvals'}
            </button>
          </div>
        </form>
        {jurisdictionPreviewMessage && <div className={`organization-jurisdiction-message ${jurisdictionPreview ? 'is-success' : 'is-error'}`} role="status">{jurisdictionPreviewMessage}</div>}
        <JurisdictionPreviewMap geometry={jurisdictionPreview ?? org.jurisdiction_geom} label={jurisdictionNames.join(', ') || org.name} />
      </section>

      <section className="reports-section org-settings-section" id="org-templates" aria-labelledby="org-templates-title">
        <div className="org-settings-section-heading"><span>Field readiness</span><h2 id="org-templates-title">Notice templates</h2><p>Set the approved wording and legal source before officers or supervisors issue notices. Saving creates a new immutable version; earlier versions and issued notices remain unchanged.</p></div>
        {templates.length === 0 ? (
          <div className="empty-state org-settings-empty"><p>No notice templates are configured. Generators may require manual legal wording or use a documented fallback until an approved template is saved.</p></div>
        ) : (
          <ul className="org-branch-list" aria-label="Notice templates">
            {templates.map((t) => (
              <li key={t.id} className="org-branch-row">
                <div><strong><ScrollText size={14} /> {noticeModuleLabel(t.module_key)} · {noticeTypeLabel(t.notice_type)}</strong><small>{t.issuing_authority || 'Issuing authority missing'} · {t.authorising_act}{t.authorising_section ? ` ${t.authorising_section}` : ''} · Source: {t.source_document_url || 'not recorded'}</small></div>
                <div className="org-branch-row-actions">
                  <span className={`status-badge status-${t.is_active ? 'active' : 'inactive'}`}>v{t.version} · {t.is_active ? 'Active' : 'Historical'}</span>
                  {t.is_active && <button type="button" className="btn btn-sm btn-secondary" onClick={() => openTemplateVersion(t)}>Create new version</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
        {!showTemplateForm && (
          <div className="org-settings-actions">
            <button type="button" className="btn btn-primary" onClick={openNewTemplate} disabled={enabledNoticeModules.length === 0}><Plus size={16} /> Add notice template</button>
            {enabledNoticeModules.length === 0 && <small>Enable an enforcement module before configuring its notice wording.</small>}
          </div>
        )}
        {showTemplateForm && (
          <form className="settings-form org-notice-template-form" onSubmit={saveNoticeTemplate} aria-label={editingTemplate ? 'Create a new notice template version' : 'Add a notice template'}>
            <div className="org-notice-template-intro">
              <strong>{editingTemplate ? `Create v${editingTemplate.version + 1}` : 'Create the first version'}</strong>
              <span>Only future generated notices use the saved version. Keep the current template to exit without changing anything.</span>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="notice-module">Enforcement module</label>
                <select id="notice-module" required disabled={Boolean(editingTemplate)} value={templateForm.moduleKey} onChange={(event) => setTemplateForm({ ...templateForm, moduleKey: event.target.value })}>
                  {enabledNoticeModules.map((module) => <option key={module.value} value={module.value}>{module.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label htmlFor="notice-type">Notice type</label>
                <select id="notice-type" required disabled={Boolean(editingTemplate)} value={templateForm.noticeType} onChange={(event) => setTemplateForm({ ...templateForm, noticeType: event.target.value })}>
                  {NOTICE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="notice-authority">Issuing authority</label>
                <input id="notice-authority" required maxLength={300} value={templateForm.issuingAuthority} onChange={(event) => setTemplateForm({ ...templateForm, issuingAuthority: event.target.value })} placeholder="e.g. Nelson City Council" />
              </div>
              <div className="form-group">
                <label htmlFor="notice-act">Authorising Act</label>
                <input id="notice-act" required maxLength={300} value={templateForm.authorisingAct} onChange={(event) => setTemplateForm({ ...templateForm, authorisingAct: event.target.value })} placeholder="Enter the verified legislation" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="notice-section">Section (optional)</label>
                <input id="notice-section" maxLength={120} value={templateForm.authorisingSection} onChange={(event) => setTemplateForm({ ...templateForm, authorisingSection: event.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="notice-bylaw">Bylaw or rule reference (optional)</label>
                <input id="notice-bylaw" maxLength={300} value={templateForm.bylawReference} onChange={(event) => setTemplateForm({ ...templateForm, bylawReference: event.target.value })} />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="notice-source">Source document location</label>
              <input id="notice-source" required maxLength={1000} value={templateForm.sourceDocumentUrl} onChange={(event) => setTemplateForm({ ...templateForm, sourceDocumentUrl: event.target.value })} placeholder="Document URL, governed file path, or source register reference" />
              <small>Record where the approved wording came from. Do not paste credentials or private access links.</small>
            </div>
            <div className="form-group">
              <label htmlFor="notice-body">Notice body</label>
              <textarea id="notice-body" required rows={10} maxLength={100000} value={templateForm.bodyHtml} onChange={(event) => setTemplateForm({ ...templateForm, bodyHtml: event.target.value })} placeholder="Approved plain text or safe HTML. Keep any supported {{placeholders}} exactly as required by the generator." />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label htmlFor="notice-fine">Fine amount (optional)</label>
                <input id="notice-fine" type="number" min="0" step="0.01" value={templateForm.fineAmount} onChange={(event) => setTemplateForm({ ...templateForm, fineAmount: event.target.value })} />
              </div>
              <div className="form-group">
                <label htmlFor="notice-payment">Payment URL (optional)</label>
                <input id="notice-payment" type="url" maxLength={1000} value={templateForm.paymentUrl} onChange={(event) => setTemplateForm({ ...templateForm, paymentUrl: event.target.value })} />
              </div>
            </div>
            <div className="form-group">
              <label htmlFor="notice-footer">Footer text (optional)</label>
              <textarea id="notice-footer" rows={3} value={templateForm.footerText} onChange={(event) => setTemplateForm({ ...templateForm, footerText: event.target.value })} />
            </div>
            <label className="org-notice-template-confirmation">
              <input type="checkbox" required checked={templateForm.confirmed} onChange={(event) => setTemplateForm({ ...templateForm, confirmed: event.target.checked })} />
              <span><strong>I checked this version against the source document.</strong><small>The issuing authority, legislation, amount, wording, and source location are correct for future notices.</small></span>
            </label>
            <div className="org-settings-actions">
              <button type="submit" className="btn btn-primary" disabled={savingTemplate || !templateForm.confirmed}>{savingTemplate ? 'Saving version…' : editingTemplate ? 'Save new version' : 'Save template'}</button>
              <button type="button" className="btn btn-secondary" disabled={savingTemplate} onClick={closeTemplateForm}>Keep current template</button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
};

function JurisdictionPreviewMap({ geometry, label }: { geometry: GeoJSON.GeoJsonObject | null; label: string }) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!containerRef.current || !geometry) return;
    const map = L.map(containerRef.current, { zoomControl: true }).setView([-41.27, 173.28], 9);
    addLinzBaseLayers(map, { collapsed: false, maxZoom: 18 });
    const layer = L.geoJSON(geometry, { style: { color: '#14c8d4', weight: 2, fillColor: '#14c8d4', fillOpacity: 0.16 } }).bindTooltip(label).addTo(map);
    const bounds = layer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.08));
    const timer = window.setTimeout(() => map.invalidateSize(), 0);
    return () => { window.clearTimeout(timer); map.remove(); };
  }, [geometry, label]);
  return geometry ? <div className="organization-jurisdiction-map" ref={containerRef} aria-label={`${label} service area preview`} /> : <div className="organization-jurisdiction-map-empty">Pick a council area and preview its boundary here.</div>;
}

export default OrganizationSetupPage;
