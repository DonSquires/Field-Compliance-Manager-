import { isAdminTierRole } from '../lib/roles';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useHref, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import type { AppRole } from '../context/AuthContext';
import { supabase } from '../lib/supabase';
import { StaffBranchAccessPanel } from '../components/StaffBranchAccessPanel';
import { credentialExpiryWords, credentialTypeLabel } from '../lib/credentialWords';
import { getAssignableRoles, IDENTITY_ROLE_LABEL } from '../lib/identityRoles';
import { plainWords } from '../lib/rosterWords';
import { edgeFunctionErrorMessage } from '../lib/edgeFunctionError';
import './PageStyles.css';
import './StaffProfilePage.css';

type ProfileTab = 'overview' | 'onboarding' | 'employment' | 'credentials' | 'skills-training' | 'documents' | 'rostering' | 'health-safety' | 'assets' | 'history';
type RecordKind = 'credential' | 'skill' | 'training' | 'document' | 'induction' | 'asset' | 'timesheet' | 'leave' | 'case';

interface StaffProfile {
  id: string;
  organization_id: string;
  user_id: string | null;
  employee_number: string | null;
  employment_type: string;
  start_date: string | null;
  end_date: string | null;
  work_ready: boolean;
  role_code: string | null;
  payroll_id: string | null;
  seniority_date: string | null;
  overtime_eligible: boolean;
}

interface UserProfile {
  id: string;
  display_name: string | null;
  email: string | null;
  phone: string | null;
  role: string;
  updated_at: string;
}

interface ManagerOption {
  id: string;
  display_name: string | null;
  email: string | null;
  role: string;
}

interface SignInState { sign_in_state: 'no_login' | 'invited' | 'signed_in'; last_sign_in_at: string | null; invited_at: string | null; }
interface RoleCode { code: string; name: string; }
interface SkillCatalogRow { id: string; skill_name: string; skill_category: string | null; }
interface RecordRow { id: string; [key: string]: unknown; }

const PROFILE_TABS: Array<{ id: ProfileTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'employment', label: 'Employment & pay' },
  { id: 'credentials', label: 'Credentials' },
  { id: 'skills-training', label: 'Skills & training' },
  { id: 'documents', label: 'Documents' },
  { id: 'rostering', label: 'Rostering' },
  { id: 'health-safety', label: 'H&S' },
  { id: 'assets', label: 'Assets' },
  { id: 'history', label: 'History' },
];

const isProfileTab = (value: string | null): value is ProfileTab => PROFILE_TABS.some((tab) => tab.id === value);
const text = (value: unknown, fallback = 'Not recorded') => typeof value === 'string' && value.trim() ? value : fallback;
const dateWords = (value: unknown, fallback = 'Not recorded') => typeof value === 'string' && value ? new Date(value).toLocaleDateString('en-NZ') : fallback;
const ONBOARDING_STAGES = ['identity', 'employment', 'evidence', 'supervision', 'induction', 'review', 'ready'];
const STAFF_DOCUMENT_BUCKET = 'staff-documents';
const STAFF_DOCUMENT_LIMIT = 10 * 1024 * 1024;
const STAFF_DOCUMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const StaffProfilePage: React.FC = () => {
  const mainWorkspaceHref = useHref('/admin/people-hr?tab=staff');
  const location = useLocation();
  const navigate = useNavigate();
  const { profile: actor, operatingOrganizations } = useAuth();
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const staffId = params.get('profile');
  const requestedTab = params.get('profileTab');
  const recordKind = params.get('recordKind') as RecordKind | null;
  const recordId = params.get('record');
  const [activeTab, setActiveTab] = useState<ProfileTab>(isProfileTab(requestedTab) ? requestedTab : 'overview');
  const [staffProfile, setStaffProfile] = useState<StaffProfile | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [roleCodes, setRoleCodes] = useState<RoleCode[]>([]);
  const [credentials, setCredentials] = useState<RecordRow[]>([]);
  const [skills, setSkills] = useState<RecordRow[]>([]);
  const [training, setTraining] = useState<RecordRow[]>([]);
  const [documents, setDocuments] = useState<RecordRow[]>([]);
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogRow[]>([]);
  const [managerUsers, setManagerUsers] = useState<ManagerOption[]>([]);
  const [inductions, setInductions] = useState<RecordRow[]>([]);
  const [inductionRequirements, setInductionRequirements] = useState<RecordRow[]>([]);
  const [assets, setAssets] = useState<RecordRow[]>([]);
  const [timesheets, setTimesheets] = useState<RecordRow[]>([]);
  const [leave, setLeave] = useState<RecordRow[]>([]);
  const [cases, setCases] = useState<RecordRow[]>([]);
  const [availability, setAvailability] = useState<RecordRow[]>([]);
  const [readiness, setReadiness] = useState<RecordRow | null>(null);
  const [onboarding, setOnboarding] = useState<RecordRow | null>(null);
  const [employmentDraft, setEmploymentDraft] = useState({ employmentType: 'permanent', startDate: '', endDate: '', roleCode: '', reason: '' });
  const [identityDraft, setIdentityDraft] = useState({ displayName: '', phone: '', role: 'officer' as AppRole });
  const [identityReason, setIdentityReason] = useState('');
  const [emailDraft, setEmailDraft] = useState('');
  const [emailReason, setEmailReason] = useState('');
  const [signIn, setSignIn] = useState<SignInState | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [onboardingNote, setOnboardingNote] = useState('');
  const [managerId, setManagerId] = useState('');
  const [credentialDraft, setCredentialDraft] = useState({ mode: 'new' as 'new' | 'renew', sourceId: '', credentialType: 'security_licence', credentialNumber: '', issuingAuthority: '', issuedDate: '', expiryDate: '', verified: true, notes: '' });
  const [skillDraft, setSkillDraft] = useState({ skillId: '', proficiency: 'competent', certified: false, certificationExpiry: '', notes: '' });
  const [trainingDraft, setTrainingDraft] = useState({ trainingName: '', trainingType: 'internal', provider: '', completedDate: '', expiryDate: '', passed: 'passed', score: '', notes: '', supersedesId: '' });
  const [inductionDraft, setInductionDraft] = useState({ requirementId: '', expiresAt: '', notes: '' });
  const [documentDraft, setDocumentDraft] = useState({ documentType: 'credential_evidence', description: '', expiryDate: '' });
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [documentInputKey, setDocumentInputKey] = useState(0);
  const [readinessReview, setReadinessReview] = useState<{ next: boolean; note: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const canManagePay = isAdminTierRole(actor?.role);

  const loadProfile = useCallback(async () => {
    if (!staffId) {
      setError('No staff profile was selected.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const { data: staffData, error: staffError } = await supabase
      .from('staff_profiles')
      .select('id,organization_id,user_id,employee_number,employment_type,start_date,end_date,work_ready,role_code,payroll_id,seniority_date,overtime_eligible')
      .eq('id', staffId)
      .limit(1);
    if (staffError || !staffData?.[0]) {
      setError(staffError?.message ?? 'The staff profile is unavailable or you do not have permission to view it.');
      setLoading(false);
      return;
    }
    const staff = (staffData as StaffProfile[]).find((item) => item.id === staffId) ?? staffData[0] as StaffProfile;
    const organizationId = staff.organization_id ?? actor?.organizationId;
    if (!organizationId) {
      setError('The staff profile is not attached to an organization.');
      setLoading(false);
      return;
    }
    staff.organization_id = organizationId;
    const userPromise = staff.user_id
      ? supabase.from('user_profiles').select('id,display_name,email,phone,role,updated_at').eq('id', staff.user_id).limit(1)
      : Promise.resolve({ data: null, error: null });
    const [
      userResult, roleResult, credentialResult, skillResult, trainingResult, documentResult,
      inductionResult, inductionRequirementResult, skillCatalogResult, managerResult, assetResult, timesheetResult, leaveResult,
      caseResult, availabilityResult, readinessResult,
      onboardingResult,
    ] = await Promise.all([
      userPromise,
      supabase.from('reference_codes').select('code,name').eq('organization_id', staff.organization_id).eq('code_type', 'role_code').eq('is_active', true).order('sort_order').order('code'),
      supabase.from('staff_credentials').select('id,credential_type,credential_number,issuing_authority,issued_date,expiry_date,verified,verified_at,notes').eq('staff_id', staff.id).order('expiry_date'),
      supabase.from('staff_skills').select('id,skill_name,skill_category,proficiency_level,certified,certification_expiry,notes,updated_at').eq('staff_id', staff.id).order('skill_name'),
      supabase.from('staff_training_records').select('id,training_name,training_type,provider,completed_date,expiry_date,passed,score,notes,created_at').eq('staff_id', staff.id).order('completed_date', { ascending: false }),
      supabase.from('staff_documents').select('id,document_type,file_name,storage_path,file_size_bytes,mime_type,description,notes,expiry_date,uploaded_at').eq('staff_id', staff.id).order('uploaded_at', { ascending: false }),
      supabase.from('staff_site_inductions').select('id,requirement_id,completed_at,expires_at,evidence_notes,verified_by').eq('staff_id', staff.id).order('completed_at', { ascending: false }),
      supabase.from('site_induction_requirements').select('id,induction_name,version,required,expires_after_days,active').eq('organization_id', staff.organization_id).order('induction_name'),
      supabase.from('roster_skill_catalog').select('id,skill_name,skill_category').eq('organization_id', staff.organization_id).eq('active', true).order('skill_name'),
      supabase.from('user_profiles').select('id,display_name,email,role').eq('organization_id', staff.organization_id).is('deactivated_at', null).order('display_name'),
      staff.user_id
        ? supabase.from('assets').select('id,asset_type,name,serial_number,registration,status,last_inspection_date,next_inspection_date,notes,updated_at').eq('organization_id', staff.organization_id).eq('assigned_to', staff.user_id).order('name')
        : Promise.resolve({ data: [], error: null }),
      supabase.from('timesheets').select('id,period_start,period_end,scheduled_hours,actual_hours,overtime_hours,adjustment_hours,status,created_at').eq('staff_id', staff.id).order('period_start', { ascending: false }).limit(52),
      supabase.from('leave_requests').select('id,leave_type,starts_on,ends_on,status,reason,created_at').eq('staff_id', staff.id).order('starts_on', { ascending: false }).limit(50),
      supabase.from('hr_cases').select('id,case_type,severity,status,subject,opened_at,resolved_at').eq('staff_id', staff.id).order('opened_at', { ascending: false }).limit(50),
      supabase.from('staff_availability').select('id,day_of_week,specific_date,available_from,available_to,all_day,availability_type,notes').eq('staff_id', staff.id).order('specific_date'),
      supabase.rpc('get_staff_readiness_assessment', { p_organization_id: staff.organization_id }),
      supabase.rpc('get_staff_onboarding_readiness', { p_organization_id: staff.organization_id }),
    ]);
    const results = [
      userResult, roleResult, credentialResult, skillResult, trainingResult, documentResult,
      inductionResult, inductionRequirementResult, skillCatalogResult, managerResult, assetResult, timesheetResult, leaveResult,
      caseResult, availabilityResult, readinessResult,
      onboardingResult,
    ];
    const panelErrors = results.flatMap((result) => result.error ? [result.error.message] : []);
    setStaffProfile(staff);
    const users = (userResult.data ?? []) as UserProfile[];
    const user = users.find((item) => item.id === staff.user_id) ?? users[0] ?? null;
    setUserProfile(user);
    if (user) {
      setIdentityDraft({ displayName: user.display_name ?? '', phone: user.phone ?? '', role: user.role as AppRole });
      setEmailDraft(user.email ?? '');
    }
    setRoleCodes((roleResult.data ?? []) as RoleCode[]);
    setCredentials((credentialResult.data ?? []) as RecordRow[]);
    setSkills((skillResult.data ?? []) as RecordRow[]);
    setTraining((trainingResult.data ?? []) as RecordRow[]);
    setDocuments((documentResult.data ?? []) as RecordRow[]);
    setSkillCatalog((skillCatalogResult.data ?? []) as SkillCatalogRow[]);
    setManagerUsers((managerResult.data ?? []) as ManagerOption[]);
    setInductions((inductionResult.data ?? []) as RecordRow[]);
    setInductionRequirements((inductionRequirementResult.data ?? []) as RecordRow[]);
    setAssets((assetResult.data ?? []) as RecordRow[]);
    setTimesheets((timesheetResult.data ?? []) as RecordRow[]);
    setLeave((leaveResult.data ?? []) as RecordRow[]);
    setCases((caseResult.data ?? []) as RecordRow[]);
    setAvailability((availabilityResult.data ?? []) as RecordRow[]);
    setReadiness(((readinessResult.data ?? []) as RecordRow[]).find((item) => item.staff_id === staff.id) ?? null);
    setOnboarding(((onboardingResult.data ?? []) as RecordRow[]).find((item) => item.staff_id === staff.id) ?? null);
    setEmploymentDraft({
      employmentType: staff.employment_type || 'permanent',
      startDate: staff.start_date ?? '',
      endDate: staff.end_date ?? '',
      roleCode: staff.role_code ?? '',
      reason: '',
    });
    if (panelErrors.length > 0) setError(`Some profile sections could not be loaded: ${[...new Set(panelErrors)].join(' · ')}`);
    setLoading(false);
  }, [actor?.organizationId, staffId]);

  useEffect(() => { void loadProfile(); }, [loadProfile]);

  const loadSignIn = useCallback(async (userId: string) => {
    setSignInError(null);
    const { data, error: stateError } = await supabase.rpc('get_user_sign_in_states', { p_user_ids: [userId] });
    const row = ((data ?? []) as Array<SignInState & { user_id: string }>).find((item) => item.user_id === userId) ?? null;
    if (stateError) setSignInError(stateError.message);
    else if (!row) setSignInError('You cannot manage sign-in for this person.');
    setSignIn(row);
  }, []);

  useEffect(() => {
    if (userProfile?.id && canManagePay) void loadSignIn(userProfile.id);
    else setSignIn(null);
  }, [canManagePay, loadSignIn, userProfile?.id, userProfile?.updated_at]);
  useEffect(() => { if (isProfileTab(requestedTab)) setActiveTab(requestedTab); }, [requestedTab]);
  useEffect(() => {
    const state = location.state as { notice?: unknown } | null;
    if (typeof state?.notice === 'string') setNotice(state.notice);
  }, [location.state]);

  const setTab = (next: ProfileTab) => {
    setActiveTab(next);
    const nextParams = new URLSearchParams(location.search);
    nextParams.set('profileTab', next);
    nextParams.delete('recordKind');
    nextParams.delete('record');
    navigate({ pathname: location.pathname, search: nextParams.toString() }, { replace: true });
  };

  const saveIdentity = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!userProfile || !identityDraft.displayName.trim() || !identityReason.trim()) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { data, error: identityError } = await supabase.rpc('manage_user_identity_access', {
      p_user_id: userProfile.id,
      p_expected_updated_at: userProfile.updated_at,
      p_action: 'update_identity',
      p_display_name: identityDraft.displayName.trim(),
      p_phone: identityDraft.phone.trim() || null,
      p_role: identityDraft.role,
      p_preset_id: null,
      p_assignment_id: null,
      p_grant_id: null,
      p_reason: identityReason.trim(),
    });
    const receipt = data as { updated_at?: string } | null;
    if (identityError) setError(identityError.message);
    else if (!receipt?.updated_at) setError('Identity update was not confirmed by the server.');
    else {
      setNotice('Identity and role updated with audit history.');
      setIdentityReason('');
      await loadProfile();
    }
    setSaving(false);
  };

  const saveEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!userProfile || !emailDraft.trim() || !emailReason.trim()) return;
    const provisioning = signIn?.sign_in_state === 'no_login';
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: emailError } = await supabase.functions.invoke('update-user-email', {
        body: { user_id: userProfile.id, email: emailDraft.trim(), reason: emailReason.trim(), provision_existing_staff: provisioning },
      });
      if (emailError) throw new Error(await edgeFunctionErrorMessage(emailError, provisioning ? 'The sign-in invitation could not be sent.' : 'The email update failed.'));
      const receipt = data as { error?: string; success?: boolean; email?: string; pending_email?: string; requires_confirmation?: boolean; invitation_resent?: boolean } | null;
      if (!receipt?.success) throw new Error(receipt?.error ?? 'The server did not confirm this change. Refresh before trying again.');
      if (receipt.requires_confirmation) {
        setNotice(`Email change is pending confirmation at ${receipt.pending_email ?? emailDraft.trim()}. The current sign-in address remains active until confirmation.`);
      } else if (provisioning) {
        setNotice(`Sign-in invitation sent to ${receipt.email ?? emailDraft.trim()}. ${userProfile.display_name ?? 'They'} choose their own password from the email.`);
      } else {
        setNotice(receipt.invitation_resent
          ? `Email corrected to ${receipt.email ?? emailDraft.trim()}; the unclaimed invitation was re-sent.`
          : `Sign-in email updated to ${receipt.email ?? emailDraft.trim()}.`);
      }
      setEmailReason('');
      await loadProfile();
      await loadSignIn(userProfile.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The email update failed.');
    } finally {
      setSaving(false);
    }
  };

  const resendInvitation = async () => {
    if (!userProfile) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const { data, error: resendError } = await supabase.functions.invoke('resend-invite', { body: { user_id: userProfile.id } });
      if (resendError) throw new Error(await edgeFunctionErrorMessage(resendError, 'The invitation could not be resent.'));
      const receipt = data as { success?: boolean; email?: string; error?: string } | null;
      if (!receipt?.success) throw new Error(receipt?.error ?? 'The server did not confirm the invitation.');
      setNotice(`Invitation sent again to ${receipt.email ?? userProfile.email ?? 'their email'}.`);
      await loadSignIn(userProfile.id);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The invitation could not be resent.');
    } finally {
      setSaving(false);
    }
  };

  const openRecord = (kind: RecordKind, id: string, tab: ProfileTab) => {
    const next = new URLSearchParams(location.search);
    next.set('profileTab', tab);
    next.set('recordKind', kind);
    next.set('record', id);
    next.delete('popout');
    navigate({ pathname: location.pathname, search: next.toString() }, { replace: true });
  };

  const saveEmployment = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!staffProfile || !employmentDraft.startDate || !employmentDraft.roleCode || !employmentDraft.reason.trim()) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: saveError } = await supabase.rpc('set_staff_employment_setup', {
      p_staff_id: staffProfile.id,
      p_expected_employment_type: staffProfile.employment_type,
      p_expected_start_date: staffProfile.start_date,
      p_expected_end_date: staffProfile.end_date,
      p_expected_role_code: staffProfile.role_code,
      p_employment_type: employmentDraft.employmentType,
      p_start_date: employmentDraft.startDate,
      p_end_date: employmentDraft.endDate || null,
      p_role_code: employmentDraft.roleCode,
      p_reason: employmentDraft.reason.trim(),
    });
    if (saveError) setError(saveError.message);
    else {
      setNotice(`Employment details saved for ${userProfile?.display_name ?? 'staff member'}.`);
      await loadProfile();
    }
    setSaving(false);
  };

  const saveOnboarding = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!staffProfile || !onboardingNote.trim()) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const response = onboarding
      ? (() => {
        const currentStage = String(onboarding.current_stage ?? '');
        const nextIndex = ONBOARDING_STAGES.indexOf(currentStage) + 1;
        const nextStage = ONBOARDING_STAGES[nextIndex];
        if (!nextStage || !onboarding.ledger_id || typeof onboarding.version !== 'number') {
          setError('Onboarding is already at its final stage or its current version is unavailable.');
          return null;
        }
        return supabase.rpc('manage_staff_onboarding', {
          p_ledger_id: String(onboarding.ledger_id),
          p_expected_version: onboarding.version,
          p_action: 'advance',
          p_stage: nextStage,
          p_note: onboardingNote.trim(),
          p_assigned_to: null,
          p_target_start: null,
        });
      })()
      : supabase.rpc('start_staff_onboarding', {
        p_client_request_id: crypto.randomUUID(),
        p_staff_id: staffProfile.id,
        p_assigned_to: null,
        p_target_start: staffProfile.start_date,
        p_note: onboardingNote.trim(),
      });
    if (!response) {
      setSaving(false);
      return;
    }
    const { error: onboardingError } = await response;
    if (onboardingError) setError(onboardingError.message);
    else {
      setNotice(onboarding ? 'Onboarding advanced one governed stage.' : 'Staff onboarding started.');
      setOnboardingNote('');
      await loadProfile();
    }
    setSaving(false);
  };

  const saveCredential = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!staffProfile) return;
    const source = credentials.find((item) => item.id === credentialDraft.sourceId);
    if (credentialDraft.mode === 'renew' && !source) {
      setError('Choose the existing credential to renew.');
      return;
    }
    const expectedExpiry = typeof source?.expiry_date === 'string' ? source.expiry_date : null;
    if (credentialDraft.mode === 'renew' && !expectedExpiry) {
      setError('The selected credential has no recorded expiry date and cannot be renewed through this workflow.');
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    const response = credentialDraft.mode === 'renew' && source
      ? await supabase.rpc('renew_staff_credential', {
        p_client_request_id: crypto.randomUUID(),
        p_source_credential_id: source.id,
        p_expected_expiry_date: expectedExpiry,
        p_credential_number: credentialDraft.credentialNumber.trim(),
        p_issuing_authority: credentialDraft.issuingAuthority.trim(),
        p_issued_date: credentialDraft.issuedDate || null,
        p_expiry_date: credentialDraft.expiryDate || null,
        p_evidence_notes: credentialDraft.notes.trim(),
      })
      : await supabase.rpc('record_staff_credential', {
        p_client_request_id: crypto.randomUUID(),
        p_staff_id: staffProfile.id,
        p_credential_type: credentialDraft.credentialType,
        p_credential_number: credentialDraft.credentialNumber.trim() || null,
        p_issuing_authority: credentialDraft.issuingAuthority.trim() || null,
        p_issued_date: credentialDraft.issuedDate || null,
        p_expiry_date: credentialDraft.expiryDate || null,
        p_authorized_activities: [],
        p_verified: credentialDraft.verified,
        p_evidence_notes: credentialDraft.notes.trim() || null,
      });
    if (response.error) setError(response.error.message);
    else {
      setNotice(credentialDraft.mode === 'renew' ? 'Credential renewal saved and audited.' : 'Credential recorded and audited.');
      setCredentialDraft({ mode: 'new', sourceId: '', credentialType: 'security_licence', credentialNumber: '', issuingAuthority: '', issuedDate: '', expiryDate: '', verified: true, notes: '' });
      await loadProfile();
    }
    setSaving(false);
  };

  const saveSkill = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!staffProfile || !skillDraft.skillId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: skillError } = await supabase.rpc('assign_roster_skill_to_staff', {
      p_staff_id: staffProfile.id,
      p_skill_id: skillDraft.skillId,
      p_proficiency_level: skillDraft.proficiency,
      p_certified: skillDraft.certified,
      p_certification_expiry: skillDraft.certificationExpiry || null,
      p_notes: skillDraft.notes.trim() || null,
    });
    if (skillError) setError(skillError.message);
    else {
      setNotice('Staff skill saved and audited.');
      setSkillDraft({ skillId: '', proficiency: 'competent', certified: false, certificationExpiry: '', notes: '' });
      await loadProfile();
    }
    setSaving(false);
  };

  const saveTraining = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!staffProfile || !trainingDraft.trainingName.trim() || !trainingDraft.completedDate) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: trainingError } = await supabase.rpc('record_staff_training', {
      p_client_request_id: crypto.randomUUID(),
      p_staff_id: staffProfile.id,
      p_training_name: trainingDraft.trainingName.trim(),
      p_training_type: trainingDraft.trainingType,
      p_provider: trainingDraft.provider.trim() || null,
      p_completed_date: trainingDraft.completedDate,
      p_expiry_date: trainingDraft.expiryDate || null,
      p_passed: trainingDraft.passed === 'not_assessed' ? null : trainingDraft.passed === 'passed',
      p_score: trainingDraft.score ? Number(trainingDraft.score) : null,
      p_notes: trainingDraft.notes.trim() || null,
      p_supersedes_training_record_id: trainingDraft.supersedesId || null,
    });
    if (trainingError) setError(trainingError.message);
    else {
      setNotice('Training record saved and audited.');
      setTrainingDraft({ trainingName: '', trainingType: 'internal', provider: '', completedDate: '', expiryDate: '', passed: 'passed', score: '', notes: '', supersedesId: '' });
      await loadProfile();
    }
    setSaving(false);
  };

  const saveInduction = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!staffProfile || !inductionDraft.requirementId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: inductionError } = await supabase.rpc('record_staff_site_induction', {
      p_staff_id: staffProfile.id,
      p_requirement_id: inductionDraft.requirementId,
      p_expires_at: inductionDraft.expiresAt ? new Date(`${inductionDraft.expiresAt}T00:00:00Z`).toISOString() : null,
      p_evidence_notes: inductionDraft.notes.trim() || null,
    });
    if (inductionError) setError(inductionError.message);
    else {
      setNotice('Site induction saved and audited.');
      setInductionDraft({ requirementId: '', expiresAt: '', notes: '' });
      await loadProfile();
    }
    setSaving(false);
  };

  const assignManager = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!staffProfile || !managerId) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: managerError } = await supabase.rpc('manage_staff_onboarding_evidence', {
      p_client_request_id: crypto.randomUUID(),
      p_staff_id: staffProfile.id,
      p_action: 'assign_line_manager',
      p_reports_to_user_id: managerId,
      p_notes: null,
    });
    if (managerError) setError(managerError.message);
    else {
      setNotice('Line manager assigned and audited.');
      setManagerId('');
      await loadProfile();
    }
    setSaving(false);
  };

  const uploadDocument = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!staffProfile || !documentFile) return;
    if (!STAFF_DOCUMENT_TYPES.has(documentFile.type)) {
      setError('Choose a PDF, JPEG, PNG, WebP, plain-text, or DOCX file.');
      return;
    }
    if (documentFile.size < 1 || documentFile.size > STAFF_DOCUMENT_LIMIT) {
      setError('Staff documents must be between 1 byte and 10 MB.');
      return;
    }
    const fileName = documentFile.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
    if (!fileName || fileName.length > 255) {
      setError('The file name must contain 1–255 letters, numbers, dots, underscores, or hyphens.');
      return;
    }
    const requestId = crypto.randomUUID();
    const storagePath = `${staffProfile.organization_id}/staff/${staffProfile.id}/${requestId}/${fileName}`;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: uploadError } = await supabase.storage.from(STAFF_DOCUMENT_BUCKET).upload(storagePath, documentFile, {
      contentType: documentFile.type,
      upsert: false,
    });
    if (uploadError) {
      setError(`Document upload failed: ${uploadError.message}`);
      setSaving(false);
      return;
    }
    const { data: document, error: documentError } = await supabase.rpc('record_staff_document_upload', {
      p_client_request_id: requestId,
      p_staff_id: staffProfile.id,
      p_document_type: documentDraft.documentType,
      p_file_name: fileName,
      p_storage_path: storagePath,
      p_description: documentDraft.description.trim() || null,
      p_expiry_date: documentDraft.expiryDate || null,
    });
    if (documentError || !document) {
      const { error: cleanupError } = await supabase.storage.from(STAFF_DOCUMENT_BUCKET).remove([storagePath]);
      setError(cleanupError
        ? `Document registration failed: ${documentError?.message ?? 'No metadata receipt was returned.'} The uploaded file could not be removed: ${cleanupError.message}`
        : `Document registration failed: ${documentError?.message ?? 'No metadata receipt was returned.'}`);
    } else {
      setNotice('Private staff document uploaded, registered, and audited.');
      setDocumentDraft({ documentType: 'credential_evidence', description: '', expiryDate: '' });
      setDocumentFile(null);
      setDocumentInputKey((key) => key + 1);
      await loadProfile();
    }
    setSaving(false);
  };

  const downloadDocument = async (document: RecordRow) => {
    const storagePath = typeof document.storage_path === 'string' ? document.storage_path : '';
    const fileName = typeof document.file_name === 'string' ? document.file_name : 'staff-document';
    if (!storagePath) {
      setError('The document has no registered private storage path.');
      return;
    }
    setError(null);
    const { data, error: signedUrlError } = await supabase.storage
      .from(STAFF_DOCUMENT_BUCKET)
      .createSignedUrl(storagePath, 60, { download: fileName });
    if (signedUrlError) setError(`Document download could not be prepared: ${signedUrlError.message}`);
    else if (!data?.signedUrl) setError('Document download did not return a signed URL.');
    else {
      const link = window.document.createElement('a');
      link.href = data.signedUrl;
      link.download = fileName;
      link.rel = 'noopener noreferrer';
      link.click();
    }
  };

  const saveReadiness = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!staffProfile || !readinessReview?.note.trim()) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { error: saveError } = await supabase.rpc('set_staff_work_readiness', {
      p_staff_id: staffProfile.id,
      p_expected_work_ready: staffProfile.work_ready,
      p_work_ready: readinessReview.next,
      p_review_notes: readinessReview.note.trim(),
    });
    if (saveError) setError(saveError.message);
    else {
      setStaffProfile({ ...staffProfile, work_ready: readinessReview.next });
      setNotice(`${displayName} readiness updated and audited.`);
      setReadinessReview(null);
    }
    setSaving(false);
  };

  const requirementName = (id: unknown) => text(inductionRequirements.find((item) => item.id === id)?.induction_name, 'Site induction');
  const recordCollections: Record<RecordKind, RecordRow[]> = { credential: credentials, skill: skills, training, document: documents, induction: inductions, asset: assets, timesheet: timesheets, leave, case: cases };
  const selectedRecord = recordKind && recordId ? recordCollections[recordKind]?.find((item) => item.id === recordId) ?? null : null;
  const displayName = userProfile?.display_name || userProfile?.email || 'Staff member';
  const nextOnboardingStage = onboarding
    ? ONBOARDING_STAGES[ONBOARDING_STAGES.indexOf(String(onboarding.current_stage ?? '')) + 1] ?? null
    : null;

  if (loading) return <div className="staff-profile-loading" role="status">Loading staff profile…</div>;
  if (error && !staffProfile) return <div className="staff-profile-loading" role="alert">{error}</div>;
  if (!staffProfile) return null;

  const recordList = (rows: RecordRow[], kind: RecordKind, tab: ProfileTab, render: (row: RecordRow) => React.ReactNode, empty: string) => (
    <div className="staff-profile-record-list">
      {rows.length === 0 ? <div className="staff-profile-empty">{empty}</div> : rows.map((row) => (
        <button type="button" className="staff-profile-record-row" key={row.id} onClick={() => openRecord(kind, row.id, tab)}>
          {render(row)}
          <span className="staff-profile-row-action">Open details ↗</span>
        </button>
      ))}
    </div>
  );

  return (
    <div className="staff-profile-page">
      <header className="staff-profile-header">
        <div>
          <span className="staff-profile-kicker">Staff profile · {staffProfile.employee_number ?? 'No employee number'}</span>
          <h1>{displayName}</h1>
          <p>{text(userProfile?.email)} · {text(userProfile?.phone)} · {plainWords(staffProfile.employment_type)} · {staffProfile.role_code ?? 'Payroll role not assigned'}</p>
        </div>
        <div className="staff-profile-header-actions">
          <span className={`status-badge ${staffProfile.work_ready ? 'status-active' : 'status-pending'}`}>{staffProfile.work_ready ? 'Work ready' : 'Not work ready'}</span>
          <a className="btn btn-secondary" href={mainWorkspaceHref}>Back to staff directory</a>
        </div>
      </header>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {notice && <div className="alert alert-success" role="status">{notice}</div>}
      <nav className="staff-profile-tabs" aria-label="Staff profile sections">
        {PROFILE_TABS.map((tab) => <button type="button" key={tab.id} className={activeTab === tab.id ? 'is-active' : ''} onClick={() => setTab(tab.id)}>{tab.label}</button>)}
      </nav>

      <main className="staff-profile-workspace">
        <section className="staff-profile-content">
          {activeTab === 'overview' && <>
            <div className="staff-profile-summary-grid">
              <article><span>Employment</span><strong>{plainWords(staffProfile.employment_type)}</strong><small>{staffProfile.start_date ? `Started ${dateWords(staffProfile.start_date)}` : 'Start date not recorded'}</small></article>
              <article><span>Payroll role</span><strong>{staffProfile.role_code ?? 'Not assigned'}</strong><small>{staffProfile.payroll_id ? `Payroll ID ${staffProfile.payroll_id}` : 'Payroll ID not recorded'}</small></article>
              <article><span>Credentials</span><strong>{credentials.length}</strong><small>{credentials.filter((item) => item.verified).length} verified</small></article>
              <article><span>Skills & training</span><strong>{skills.length + training.length}</strong><small>{skills.length} skills · {training.length} training records</small></article>
              <article><span>H&S evidence</span><strong>{inductions.length}</strong><small>Site induction records</small></article>
              <article><span>Assigned assets</span><strong>{assets.length}</strong><small>Current register assignments</small></article>
            </div>
            <section className="staff-profile-panel">
              <h2>Identity and contact</h2>
              {userProfile ? <>
                {canManagePay ? <form className="staff-profile-action-form staff-profile-form-grid" onSubmit={saveIdentity}>
                  <label><span>Display name</span><input required value={identityDraft.displayName} onChange={(event) => setIdentityDraft({ ...identityDraft, displayName: event.target.value })} /></label>
                  <label><span>Phone</span><input type="tel" value={identityDraft.phone} onChange={(event) => setIdentityDraft({ ...identityDraft, phone: event.target.value })} /></label>
                  <label><span>Application role</span><select value={identityDraft.role} onChange={(event) => setIdentityDraft({ ...identityDraft, role: event.target.value as AppRole })}>{getAssignableRoles(actor?.role ?? 'unknown').map((role) => <option value={role} key={role}>{IDENTITY_ROLE_LABEL[role]}</option>)}</select></label>
                  <label className="staff-profile-form-wide"><span>Reason for identity or role change</span><textarea required rows={2} value={identityReason} onChange={(event) => setIdentityReason(event.target.value)} /></label>
                  <div className="staff-profile-form-wide"><button type="submit" className="btn btn-primary" disabled={saving || !identityDraft.displayName.trim() || !identityReason.trim()}>{saving ? 'Saving…' : 'Save identity'}</button></div>
                </form> : <p>You do not have permission to change identity or role details.</p>}
                {canManagePay && (() => {
                  const state = signIn?.sign_in_state;
                  const provisioning = state === 'no_login';
                  const blockedProvision = provisioning && userProfile.role !== 'officer';
                  const sameEmail = emailDraft.trim().toLowerCase() === (userProfile.email ?? '').toLowerCase();
                  return <form className="staff-profile-action-form staff-profile-form-grid" onSubmit={saveEmail} aria-label="App sign-in">
                    <h3 className="staff-profile-form-wide">App sign-in</h3>
                    <p className="staff-profile-form-wide" data-testid="staff-sign-in-state">
                      {state === 'signed_in' && <><span className="staff-profile-chip is-ok">Signed in</span> Last sign-in {signIn?.last_sign_in_at ? new Date(signIn.last_sign_in_at).toLocaleString('en-NZ') : 'not recorded'}.</>}
                      {state === 'invited' && <><span className="staff-profile-chip is-warn">Invitation pending</span> Invited {signIn?.invited_at ? dateWords(signIn.invited_at) : ''} — they have not signed in yet.</>}
                      {provisioning && <><span className="staff-profile-chip is-warn">No app login</span> {blockedProvision ? 'Only officers can be given a login from their profile. Use User management for other roles.' : 'Enter their email to send a sign-in invitation. They choose their own password.'}</>}
                      {!state && (signInError ? <span className="staff-profile-warning">{signInError}</span> : 'Checking sign-in…')}
                    </p>
                    <label><span>Email address</span><input type="email" required value={emailDraft} onChange={(event) => setEmailDraft(event.target.value)} disabled={!state || blockedProvision} /></label>
                    <label><span>{provisioning ? 'Reason for giving access' : 'Reason for email change'}</span><input required value={emailReason} onChange={(event) => setEmailReason(event.target.value)} disabled={!state || blockedProvision} /></label>
                    {!provisioning && <p className="staff-profile-form-wide">A claimed account must confirm a new address before it replaces the current sign-in. Unclaimed invitations are re-sent to the corrected address.</p>}
                    <div className="staff-profile-form-wide staff-profile-panel-actions">
                      <button type="submit" className={`btn ${provisioning ? 'btn-primary' : 'btn-secondary'}`} disabled={saving || !state || blockedProvision || !emailDraft.trim() || !emailReason.trim() || (!provisioning && sameEmail)}>{saving ? 'Saving…' : provisioning ? 'Send sign-in invitation' : 'Update sign-in email'}</button>
                      {state === 'invited' && <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => void resendInvitation()}>Resend invitation</button>}
                    </div>
                  </form>;
                })()}
              </> : <div className="staff-profile-empty">No user account is linked to this staff record. Identity and invitation actions are not available here.</div>}
            </section>
            <section className="staff-profile-panel"><h2>Readiness</h2>{readiness ? <dl className="staff-profile-facts"><div><dt>Identity</dt><dd>{plainWords(String(readiness.identity_status ?? 'unknown'))}</dd></div><div><dt>Employment</dt><dd>{plainWords(String(readiness.employment_status ?? 'unknown'))}</dd></div><div><dt>Credentials</dt><dd>{plainWords(String(readiness.credential_status ?? 'unknown'))}</dd></div><div><dt>Training</dt><dd>{plainWords(String(readiness.training_status ?? 'unknown'))}</dd></div></dl> : <p>No readiness assessment is available.</p>}{Array.isArray(readiness?.blockers) && readiness.blockers.length > 0 && <p className="staff-profile-warning">Holding this person back: {(readiness.blockers as string[]).join(' · ')}</p>}<div className="staff-profile-panel-actions"><button type="button" className={`btn ${staffProfile.work_ready ? 'btn-danger' : 'btn-primary'}`} onClick={() => setReadinessReview({ next: !staffProfile.work_ready, note: '' })}>{staffProfile.work_ready ? 'Remove work readiness' : 'Mark work ready'}</button><button type="button" className="btn btn-secondary" onClick={() => setTab('credentials')}>Manage credentials</button></div></section>
          </>}

          {activeTab === 'onboarding' && <section className="staff-profile-panel">
            <h2>Onboarding</h2>
            {onboarding ? <>
              <dl className="staff-profile-facts">
                <div><dt>Stage</dt><dd>{plainWords(String(onboarding.current_stage ?? 'not started'))}</dd></div>
                <div><dt>Status</dt><dd>{plainWords(String(onboarding.status ?? 'not started'))}</dd></div>
                <div><dt>Target start</dt><dd>{dateWords(onboarding.target_start, 'Not set')}</dd></div>
                <div><dt>Next action</dt><dd>{text(onboarding.next_action, 'Review onboarding')}</dd></div>
              </dl>
              {Array.isArray(onboarding.blockers) && onboarding.blockers.length > 0 && <p className="staff-profile-warning">Holding this person up: {(onboarding.blockers as string[]).join(' · ')}</p>}
            </> : <div className="staff-profile-empty">No onboarding ledger is recorded for this person.</div>}
            {canManagePay && <form className="staff-profile-action-form" onSubmit={saveOnboarding}>
              <label><span>{onboarding ? 'Stage note' : 'Start note'}</span><textarea required rows={3} value={onboardingNote} onChange={(event) => setOnboardingNote(event.target.value)} placeholder="Record the reason or evidence for this onboarding action" /></label>
              <button type="submit" className="btn btn-primary" disabled={saving || !onboardingNote.trim() || Boolean(onboarding && !nextOnboardingStage)}>{saving ? 'Saving…' : onboarding ? `Advance to ${plainWords(nextOnboardingStage ?? '')}` : 'Start onboarding'}</button>
            </form>}
            {canManagePay && <form className="staff-profile-action-form staff-profile-form-grid" onSubmit={assignManager}>
              <h3 className="staff-profile-form-wide">Line manager</h3>
              <label className="staff-profile-form-wide"><span>Assign manager</span><select required value={managerId} onChange={(event) => setManagerId(event.target.value)}><option value="">Choose an active organisation member</option>{managerUsers.filter((item) => item.id !== staffProfile.user_id).map((item) => <option key={item.id} value={item.id}>{item.display_name || item.email || item.id} · {plainWords(item.role)}</option>)}</select></label>
              <div className="staff-profile-form-wide"><button type="submit" className="btn btn-secondary" disabled={saving || !managerId}>{saving ? 'Saving…' : 'Assign line manager'}</button></div>
            </form>}
          </section>}

          {activeTab === 'employment' && <>
            <section className="staff-profile-panel">
              <h2>Employment and payroll</h2>
              <dl className="staff-profile-facts"><div><dt>Employment type</dt><dd>{plainWords(staffProfile.employment_type)}</dd></div><div><dt>Start date</dt><dd>{dateWords(staffProfile.start_date)}</dd></div><div><dt>End date</dt><dd>{dateWords(staffProfile.end_date, 'No end date')}</dd></div><div><dt>Seniority date</dt><dd>{dateWords(staffProfile.seniority_date)}</dd></div><div><dt>Overtime</dt><dd>{staffProfile.overtime_eligible ? 'Eligible' : 'Not eligible'}</dd></div></dl>
              {canManagePay ? <form className="staff-profile-action-form staff-profile-form-grid" onSubmit={saveEmployment}>
                <label><span>Employment type</span><select value={employmentDraft.employmentType} onChange={(event) => setEmploymentDraft({ ...employmentDraft, employmentType: event.target.value })}><option value="permanent">Permanent</option><option value="part_time">Part time</option><option value="casual">Casual</option><option value="contractor">Contractor</option><option value="volunteer">Volunteer</option></select></label>
                <label><span>Start date</span><input type="date" required value={employmentDraft.startDate} onChange={(event) => setEmploymentDraft({ ...employmentDraft, startDate: event.target.value })} /></label>
                <label><span>End date</span><input type="date" min={employmentDraft.startDate || undefined} value={employmentDraft.endDate} onChange={(event) => setEmploymentDraft({ ...employmentDraft, endDate: event.target.value })} /></label>
                <label><span>Payroll role</span><select required value={employmentDraft.roleCode} onChange={(event) => setEmploymentDraft({ ...employmentDraft, roleCode: event.target.value })}><option value="">Choose a payroll role</option>{roleCodes.map((role) => <option value={role.code} key={role.code}>{role.code} · {role.name}</option>)}</select></label>
                <label className="staff-profile-form-wide"><span>Reason for change</span><textarea required rows={3} value={employmentDraft.reason} onChange={(event) => setEmploymentDraft({ ...employmentDraft, reason: event.target.value })} /></label>
                <div className="staff-profile-form-wide"><button type="submit" className="btn btn-primary" disabled={saving || !employmentDraft.startDate || !employmentDraft.roleCode || !employmentDraft.reason.trim()}>{saving ? 'Saving…' : 'Save employment details'}</button></div>
                {roleCodes.length === 0 && <p className="staff-profile-warning staff-profile-form-wide">No active payroll roles are configured for this organisation.</p>}
              </form> : <p>You do not have permission to change employment or payroll details.</p>}
            </section>
            {staffProfile.user_id && <StaffBranchAccessPanel userId={staffProfile.user_id} branches={operatingOrganizations} onChanged={loadProfile} />}
          </>}

          {activeTab === 'credentials' && <section className="staff-profile-panel">
            <h2>Credentials</h2><p>Verified, current credentials feed work readiness and roster eligibility.</p>
            {canManagePay && <form className="staff-profile-action-form staff-profile-form-grid" onSubmit={saveCredential}>
              <label><span>Action</span><select value={credentialDraft.mode} onChange={(event) => setCredentialDraft({ ...credentialDraft, mode: event.target.value as 'new' | 'renew', sourceId: '' })}><option value="new">Record credential</option><option value="renew">Renew existing credential</option></select></label>
              {credentialDraft.mode === 'renew'
                ? <label><span>Credential to renew</span><select required value={credentialDraft.sourceId} onChange={(event) => { const source = credentials.find((item) => item.id === event.target.value); setCredentialDraft({ ...credentialDraft, sourceId: event.target.value, credentialType: String(source?.credential_type ?? credentialDraft.credentialType) }); }}><option value="">Choose an expiring credential</option>{credentials.filter((item) => item.expiry_date).map((item) => <option key={item.id} value={item.id}>{credentialTypeLabel(String(item.credential_type))} · {text(item.credential_number, 'No number')} · {dateWords(item.expiry_date)}</option>)}</select></label>
                : <label><span>Credential type</span><select value={credentialDraft.credentialType} onChange={(event) => setCredentialDraft({ ...credentialDraft, credentialType: event.target.value })}>{[['certificate_of_authority','Certificate of Authority'],['warrant_of_authority','Warrant of Authority'],['drivers_licence','Driver licence'],['first_aid','First aid'],['security_licence','Security licence'],['firearms_licence','Firearms licence'],['noise_control_warrant','Noise control warrant'],['biosecurity_warrant','Biosecurity warrant'],['other','Other']].map(([value,label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
              <label><span>Credential number</span><input required={credentialDraft.verified || credentialDraft.mode === 'renew'} value={credentialDraft.credentialNumber} onChange={(event) => setCredentialDraft({ ...credentialDraft, credentialNumber: event.target.value })} /></label>
              <label><span>Issuing authority</span><input required={credentialDraft.verified || credentialDraft.mode === 'renew'} value={credentialDraft.issuingAuthority} onChange={(event) => setCredentialDraft({ ...credentialDraft, issuingAuthority: event.target.value })} /></label>
              <label><span>Issue date</span><input type="date" required={credentialDraft.mode === 'renew'} value={credentialDraft.issuedDate} onChange={(event) => setCredentialDraft({ ...credentialDraft, issuedDate: event.target.value })} /></label>
              <label><span>Expiry date</span><input type="date" min={credentialDraft.issuedDate || undefined} required={credentialDraft.mode === 'renew'} value={credentialDraft.expiryDate} onChange={(event) => setCredentialDraft({ ...credentialDraft, expiryDate: event.target.value })} /></label>
              {credentialDraft.mode === 'new' && <label className="staff-profile-checkbox"><input type="checkbox" checked={credentialDraft.verified} onChange={(event) => setCredentialDraft({ ...credentialDraft, verified: event.target.checked })} /><span>Evidence reviewed and verified</span></label>}
              <label className="staff-profile-form-wide"><span>Evidence notes (10+ characters when verified)</span><textarea required={credentialDraft.verified || credentialDraft.mode === 'renew'} minLength={credentialDraft.verified || credentialDraft.mode === 'renew' ? 10 : undefined} rows={3} value={credentialDraft.notes} onChange={(event) => setCredentialDraft({ ...credentialDraft, notes: event.target.value })} /></label>
              <div className="staff-profile-form-wide"><button type="submit" className="btn btn-primary" disabled={saving || (credentialDraft.mode === 'renew' && !credentialDraft.sourceId)}>{saving ? 'Saving…' : credentialDraft.mode === 'renew' ? 'Save credential renewal' : 'Record credential'}</button></div>
            </form>}
            {recordList(credentials, 'credential', 'credentials', (row) => <><strong>{credentialTypeLabel(String(row.credential_type))}</strong><span>{text(row.credential_number, 'No number')}</span><span>{credentialExpiryWords(row.expiry_date as string | null)}</span><span>{row.verified ? 'Verified' : 'Not verified'}</span></>, 'No credentials are recorded for this person.')}
          </section>}

          {activeTab === 'skills-training' && <>
            <section className="staff-profile-panel">
              <h2>Skills</h2>
              {canManagePay && <form className="staff-profile-action-form staff-profile-form-grid" onSubmit={saveSkill}>
                <label className="staff-profile-form-wide"><span>Skill</span><select required value={skillDraft.skillId} onChange={(event) => setSkillDraft({ ...skillDraft, skillId: event.target.value })}><option value="">Choose a skill from the organisation catalogue</option>{skillCatalog.map((skill) => <option key={skill.id} value={skill.id}>{skill.skill_name}{skill.skill_category ? ` · ${plainWords(skill.skill_category)}` : ''}</option>)}</select></label>
                <label><span>Proficiency</span><select value={skillDraft.proficiency} onChange={(event) => setSkillDraft({ ...skillDraft, proficiency: event.target.value })}><option value="basic">Basic</option><option value="competent">Competent</option><option value="proficient">Proficient</option><option value="expert">Expert</option></select></label>
                <label><span>Certification expiry</span><input type="date" value={skillDraft.certificationExpiry} onChange={(event) => setSkillDraft({ ...skillDraft, certificationExpiry: event.target.value })} /></label>
                <label className="staff-profile-checkbox"><input type="checkbox" checked={skillDraft.certified} onChange={(event) => setSkillDraft({ ...skillDraft, certified: event.target.checked })} /><span>Skill is certified</span></label>
                <label className="staff-profile-form-wide"><span>Notes</span><textarea rows={2} value={skillDraft.notes} onChange={(event) => setSkillDraft({ ...skillDraft, notes: event.target.value })} /></label>
                <div className="staff-profile-form-wide"><button type="submit" className="btn btn-primary" disabled={saving || !skillDraft.skillId || skillCatalog.length === 0}>{saving ? 'Saving…' : 'Assign skill'}</button>{skillCatalog.length === 0 && <p className="staff-profile-warning">No active roster skills are configured for this organisation.</p>}</div>
              </form>}
              {recordList(skills, 'skill', 'skills-training', (row) => <><strong>{text(row.skill_name)}</strong><span>{plainWords(String(row.proficiency_level ?? 'not assessed'))}</span><span>{row.certified ? 'Certified' : 'Not certified'}</span><span>{dateWords(row.certification_expiry, 'No expiry')}</span></>, 'No skills are assigned to this person.')}
            </section>
            <section className="staff-profile-panel">
              <h2>Training</h2>
              {canManagePay && <form className="staff-profile-action-form staff-profile-form-grid" onSubmit={saveTraining}>
                <label className="staff-profile-form-wide"><span>Training name</span><input required value={trainingDraft.trainingName} onChange={(event) => setTrainingDraft({ ...trainingDraft, trainingName: event.target.value })} /></label>
                <label><span>Training type</span><select value={trainingDraft.trainingType} onChange={(event) => setTrainingDraft({ ...trainingDraft, trainingType: event.target.value })}><option value="induction">Induction</option><option value="internal">Internal</option><option value="external">External</option><option value="refresher">Refresher</option><option value="assessment">Assessment</option></select></label>
                <label><span>Provider</span><input value={trainingDraft.provider} onChange={(event) => setTrainingDraft({ ...trainingDraft, provider: event.target.value })} /></label>
                <label><span>Completed date</span><input type="date" required value={trainingDraft.completedDate} onChange={(event) => setTrainingDraft({ ...trainingDraft, completedDate: event.target.value })} /></label>
                <label><span>Expiry date</span><input type="date" min={trainingDraft.completedDate || undefined} value={trainingDraft.expiryDate} onChange={(event) => setTrainingDraft({ ...trainingDraft, expiryDate: event.target.value })} /></label>
                <label><span>Result</span><select value={trainingDraft.passed} onChange={(event) => setTrainingDraft({ ...trainingDraft, passed: event.target.value })}><option value="passed">Passed</option><option value="failed">Not passed</option><option value="not_assessed">Not assessed</option></select></label>
                <label><span>Score (0–100)</span><input type="number" min={0} max={100} step="0.1" value={trainingDraft.score} onChange={(event) => setTrainingDraft({ ...trainingDraft, score: event.target.value })} /></label>
                <label className="staff-profile-form-wide"><span>Supersedes previous training record</span><select value={trainingDraft.supersedesId} onChange={(event) => setTrainingDraft({ ...trainingDraft, supersedesId: event.target.value })}><option value="">No — new training record</option>{training.map((item) => <option key={item.id} value={item.id}>{text(item.training_name)} · {dateWords(item.completed_date)}</option>)}</select></label>
                <label className="staff-profile-form-wide"><span>Notes</span><textarea rows={2} value={trainingDraft.notes} onChange={(event) => setTrainingDraft({ ...trainingDraft, notes: event.target.value })} /></label>
                <div className="staff-profile-form-wide"><button type="submit" className="btn btn-primary" disabled={saving || !trainingDraft.trainingName.trim() || !trainingDraft.completedDate}>{saving ? 'Saving…' : 'Record training'}</button></div>
              </form>}
              {recordList(training, 'training', 'skills-training', (row) => <><strong>{text(row.training_name)}</strong><span>{text(row.provider, 'Provider not recorded')}</span><span>{dateWords(row.completed_date)}</span><span>{dateWords(row.expiry_date, 'No expiry')}</span></>, 'No training records are recorded for this person.')}
            </section>
          </>}

          {activeTab === 'documents' && <section className="staff-profile-panel">
            <h2>Documents</h2><p>Documents are stored privately and downloaded through short-lived links. Only metadata is shown here.</p>
            {canManagePay && <form className="staff-profile-action-form staff-profile-form-grid" onSubmit={uploadDocument}>
              <label><span>Document type</span><select value={documentDraft.documentType} onChange={(event) => setDocumentDraft({ ...documentDraft, documentType: event.target.value })}><option value="credential_evidence">Credential evidence</option><option value="contract">Employment contract</option><option value="certificate">Certificate</option><option value="policy_acknowledgement">Policy acknowledgement</option><option value="other">Other</option></select></label>
              <label><span>Expiry date (optional)</span><input type="date" value={documentDraft.expiryDate} onChange={(event) => setDocumentDraft({ ...documentDraft, expiryDate: event.target.value })} /></label>
              <label className="staff-profile-form-wide"><span>File (PDF, image, text, or DOCX · 10 MB maximum)</span><input key={documentInputKey} type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.txt,.docx,application/pdf,image/jpeg,image/png,image/webp,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required onChange={(event) => setDocumentFile(event.target.files?.[0] ?? null)} /></label>
              <label className="staff-profile-form-wide"><span>Description</span><textarea rows={2} maxLength={500} value={documentDraft.description} onChange={(event) => setDocumentDraft({ ...documentDraft, description: event.target.value })} /></label>
              <div className="staff-profile-form-wide"><button type="submit" className="btn btn-primary" disabled={saving || !documentFile}>{saving ? 'Uploading…' : 'Upload private document'}</button></div>
            </form>}
            {documents.length === 0 ? <div className="staff-profile-empty">No documents are registered for this person.</div> : <div className="staff-profile-document-list">{documents.map((row) => <article className="staff-profile-document-row" key={row.id}><button type="button" className="staff-profile-record-row" onClick={() => openRecord('document', row.id, 'documents')}><strong>{text(row.file_name)}</strong><span>{plainWords(String(row.document_type ?? 'document'))}</span><span>{text(row.mime_type, 'Type not recorded')}</span><span>{dateWords(row.expiry_date, 'No expiry')}</span></button><button type="button" className="btn btn-secondary" onClick={() => void downloadDocument(row)}>Download</button></article>)}</div>}
          </section>}

          {activeTab === 'rostering' && <><section className="staff-profile-panel"><h2>Availability</h2>{availability.length === 0 ? <div className="staff-profile-empty">No standing or date-specific availability is recorded.</div> : <div className="staff-profile-record-list">{availability.map((row) => <div className="staff-profile-record-row is-static" key={row.id}><strong>{row.specific_date ? dateWords(row.specific_date) : `Weekday ${Number(row.day_of_week) + 1}`}</strong><span>{row.all_day ? 'All day' : `${text(row.available_from)}–${text(row.available_to)}`}</span><span>{plainWords(String(row.availability_type ?? 'available'))}</span></div>)}</div>}</section><section className="staff-profile-panel"><h2>Timesheets</h2>{recordList(timesheets, 'timesheet', 'rostering', (row) => <><strong>{dateWords(row.period_start)} – {dateWords(row.period_end)}</strong><span>{Number(row.actual_hours ?? 0).toFixed(2)} actual hours</span><span>{Number(row.overtime_hours ?? 0).toFixed(2)} overtime</span><span>{plainWords(String(row.status))}</span></>, 'No timesheets are available for this person.')}</section></>}

          {activeTab === 'health-safety' && <><section className="staff-profile-panel"><h2>Site inductions</h2><p>Inductions are the current staff-specific H&amp;S readiness evidence. Operational incidents and place hazards remain on their owning work and place records.</p>{canManagePay && <form className="staff-profile-action-form staff-profile-form-grid" onSubmit={saveInduction}><label className="staff-profile-form-wide"><span>Induction requirement</span><select required value={inductionDraft.requirementId} onChange={(event) => setInductionDraft({ ...inductionDraft, requirementId: event.target.value })}><option value="">Choose an active requirement</option>{inductionRequirements.filter((item) => item.active).map((item) => <option key={item.id} value={String(item.id)}>{text(item.induction_name)} · v{String(item.version ?? '')}</option>)}</select></label><label><span>Expiry date (optional)</span><input type="date" value={inductionDraft.expiresAt} onChange={(event) => setInductionDraft({ ...inductionDraft, expiresAt: event.target.value })} /></label><label className="staff-profile-form-wide"><span>Evidence notes</span><textarea rows={2} value={inductionDraft.notes} onChange={(event) => setInductionDraft({ ...inductionDraft, notes: event.target.value })} /></label><div className="staff-profile-form-wide"><button type="submit" className="btn btn-primary" disabled={saving || !inductionDraft.requirementId}>{saving ? 'Saving…' : 'Record site induction'}</button></div></form>}{recordList(inductions, 'induction', 'health-safety', (row) => <><strong>{requirementName(row.requirement_id)}</strong><span>Completed {dateWords(row.completed_at)}</span><span>{dateWords(row.expires_at, 'No expiry')}</span><span>{text(row.evidence_notes, 'No evidence note')}</span></>, 'No site induction evidence is recorded for this person.')}</section><section className="staff-profile-panel"><h2>Personnel H&amp;S records</h2><div className="staff-profile-empty">No dedicated staff injury or wellbeing record pathway is present in the current workforce schema. Do not record clinical details in general HR notes.</div></section></>}

          {activeTab === 'assets' && <section className="staff-profile-panel"><h2>Assigned assets</h2>{recordList(assets, 'asset', 'assets', (row) => <><strong>{text(row.name)}</strong><span>{plainWords(String(row.asset_type ?? 'asset'))}</span><span>{text(row.registration ?? row.serial_number, 'No identifier')}</span><span>{plainWords(String(row.status))}</span></>, 'No assets are currently assigned to this person.')}</section>}

          {activeTab === 'history' && <><section className="staff-profile-panel"><h2>Leave history</h2>{recordList(leave, 'leave', 'history', (row) => <><strong>{plainWords(String(row.leave_type))}</strong><span>{dateWords(row.starts_on)} – {dateWords(row.ends_on)}</span><span>{plainWords(String(row.status))}</span></>, 'No leave records are available.')}</section><section className="staff-profile-panel"><h2>Private HR cases</h2>{recordList(cases, 'case', 'history', (row) => <><strong>{text(row.subject)}</strong><span>{plainWords(String(row.case_type))}</span><span>{plainWords(String(row.severity))}</span><span>{plainWords(String(row.status))}</span></>, 'No HR cases are available.')}</section></>}
        </section>

        {recordKind && recordId && <aside className="staff-profile-detail" aria-label="Selected record details">
          <header><div><span>{plainWords(recordKind)}</span><h2>Record details</h2></div><button type="button" onClick={() => { const next = new URLSearchParams(location.search); next.delete('recordKind'); next.delete('record'); navigate({ pathname: location.pathname, search: next.toString() }, { replace: true }); }} aria-label="Close record details">×</button></header>
          {selectedRecord ? <dl>{Object.entries(selectedRecord).filter(([key]) => !['id', 'storage_path'].includes(key)).map(([key, value]) => <div key={key}><dt>{plainWords(key)}</dt><dd>{value == null || value === '' ? 'Not recorded' : typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value)}</dd></div>)}</dl> : <p role="alert">This record is unavailable or you do not have permission to view it.</p>}
        </aside>}
      </main>
      {readinessReview && <div className="staff-profile-dialog-backdrop"><form className="staff-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="staff-readiness-title" onSubmit={saveReadiness}><header><div><span>Roster eligibility</span><h2 id="staff-readiness-title">{readinessReview.next ? 'Mark work ready?' : 'Remove work readiness?'}</h2></div><button type="button" onClick={() => setReadinessReview(null)} aria-label="Close readiness review">×</button></header><p>{readinessReview.next ? 'The server will recheck identity, employment, credentials and readiness blockers before allowing roster work.' : 'Removing readiness blocks new roster assignment without deleting employment or evidence records.'}</p><label><span>Readiness review notes</span><textarea required rows={4} value={readinessReview.note} onChange={(event) => setReadinessReview({ ...readinessReview, note: event.target.value })} /></label><footer><button type="button" className="btn btn-secondary" onClick={() => setReadinessReview(null)}>Cancel</button><button type="submit" className="btn btn-primary" disabled={saving || !readinessReview.note.trim()}>{saving ? 'Saving…' : 'Confirm readiness'}</button></footer></form></div>}
    </div>
  );
};

export default StaffProfilePage;
