import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/DispatchConsolePage.tsx'), 'utf8');

describe('dispatch agreement and creation boundary', () => {
  it('uses selected agreement sites instead of legacy client_sites organization filtering', () => {
    expect(source).toContain('activeAgreementSites.map');
    expect(source).toContain('selectedAgreementSites.filter((site) => site.active)');
    expect(source).not.toMatch(/from\('client_sites'\)[\s\S]{0,200}\.eq\('organization_id'/);
  });

  it('checks every Phase A query response', () => {
    expect(source).toContain('shiftsRes.error, jobsRes.error, resourcesRes.error');
    expect(source).toContain(".select('id, name, callsign, status, assigned_officer_id')");
    expect(source).not.toContain("status, gps_lat, gps_lng");
  });

  it('persists agreement and absolute SLA context and confirms the insert', () => {
    expect(source).toContain(".rpc('create_dispatch_job'");
    expect(source).toContain('p_service_agreement_id: selectedAgreement.id');
    expect(source).toContain('p_sla_minutes: formSlaMinutes');
    expect(source).toContain('dispatch job was not confirmed');
  });

  it('records phone or email provenance for manual alarm responses', () => {
    expect(source).toContain("type AlarmIntakeChannel = 'phone' | 'email'");
    expect(source).toContain('[Manual alarm intake: ${formAlarmIntakeChannel}; received ${new Date(formAlarmReceivedAt).toISOString()}]');
    expect(source).toContain("formJobType === 'alarm_response' && !formAlarmReceivedAt");
  });

  it('retains one client request id across retries and rotates it after success', () => {
    expect(source).toContain('p_client_request_id: formRequestId');
    expect(source).toContain('setFormRequestId(crypto.randomUUID())');
    expect(source).not.toMatch(/from\('dispatch_jobs'\)[\s\S]{0,200}\.insert\(/);
  });

  it('pairs an available resource with its assigned officer active shift', () => {
    expect(source).toContain('p_dispatch_resource_id: formResourceId || null');
    expect(source).toContain('shift.officerUserId === resource?.assignedOfficerId');
    expect(source).toContain("resource.status === 'available'");
  });

  it('resolves billing against real agreement client, site, and job dimensions', () => {
    expect(source).toContain('resolveDispatchBillingRule');
    expect(source).toContain('selectedAgreement.client_organization_id');
    expect(source).toContain('siteId: formSiteId');
    expect(source).toContain('jobType: formJobType');
    expect(source).not.toContain('r.clientOrgId === formShiftId');
  });

  it('uses agreement attribution instead of a phantom requester organization workflow', () => {
    expect(source).toContain('Client: {selectedAgreement?.client_name');
    expect(source).not.toContain('requesterOrgs');
    expect(source).not.toContain('loadPhaseC');
  });
});