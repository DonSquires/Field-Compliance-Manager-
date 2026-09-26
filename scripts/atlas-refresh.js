const fs = require('node:fs');
const path = require('node:path');

const OWNER_MARKER = '[repo-atlas-refresh:v1]';
const BATCH_SIZE = 250;
const MAX_RETIREMENTS = 100;
const ROOT_SOURCE_FILES = [
  'supabase-workflow-client.js',
  'scripts/seed-historical-patrol-roster.mjs'
];
const MANAGED_SOURCES = [
  'apps/web/src/pages/RosterOperationsPage.tsx',
  'apps/web/src/pages/OfficerSchedulePage.tsx',
  'apps/web/src/pages/RosterHRPage.tsx',
  'apps/web/src/pages/OfficerLeavePage.tsx',
  'apps/web/src/pages/OrganizationSetupPage.tsx',
  'apps/web/src/pages/UserManagementPage.tsx',
  'apps/web/src/pages/AccessControlPage.tsx',
  'apps/web/src/pages/CRMPage.tsx',
  'apps/web/src/pages/RateRulesPage.tsx',
  'apps/web/src/pages/SiteBoundaryReviewPage.tsx',
  'apps/web/src/pages/AccountOnboardingPage.tsx',
  'apps/web/src/pages/ActivationHandoffsPage.tsx',
  'apps/web/src/components/OperationalPlaceManager.tsx',
  'apps/web/src/components/FinanceControlPanel.tsx',
  'apps/web/src/pages/LocationsPage.tsx',
  'apps/web/src/pages/SiteDetailPage.tsx',
  'apps/web/src/pages/ZoneDetailPage.tsx',
  'apps/web/src/components/LocationHouseMap.tsx',
  'apps/web/src/context/ServiceRelationshipContext.tsx',
  'apps/web/src/pages/RelationshipWorkspacePage.tsx',
  'apps/web/src/components/CrmAccountWorkspace.tsx',
  'apps/web/src/components/CrmAgreementSetupDialog.tsx',
  'apps/web/src/components/CrmOperationalReadinessDialog.tsx',
  'apps/web/src/components/CrmOrganizationDialog.tsx',
  'apps/web/src/components/CrmSiteDialog.tsx',
  'apps/web/src/components/UserIdentityWorkspace.tsx',
  'apps/web/src/pages/WelfareAlertsPage.tsx',
  'apps/web/src/pages/ReportsHubPage.tsx',
  'apps/web/src/components/CustomReportBuilder.tsx',
  'apps/web/src/components/CustomReportSnapshot.tsx',
  'apps/web/src/components/ReportPackReviewPanel.tsx',
  'apps/web/src/pages/ClientPortalPage.tsx',
  'apps/web/src/pages/DispatchConsolePage.tsx',
  'apps/web/src/pages/OfficerHomePage.tsx',
  'apps/web/src/pages/FieldOperationsPage.tsx',
  'apps/web/src/pages/LiveMapPage.tsx',
  'apps/web/src/pages/OfficerDispatchPage.tsx',
  'apps/web/src/pages/OfficerMapPage.tsx',
  'apps/web/src/pages/OfficerOvernightVerificationPage.tsx',
  'apps/web/src/pages/OfficerVehicleLookupPage.tsx',
  'apps/web/src/pages/VehicleSearchPage.tsx',
  'apps/web/src/pages/OfficerParkingPage.tsx',
  'apps/web/src/pages/BreachReviewPage.tsx',
  'apps/web/src/pages/ParkingOversightPage.tsx',
  'apps/web/src/pages/NoiseControlOversightPage.tsx',
  'apps/web/src/pages/BiosecurityOversightPage.tsx',
  'apps/web/src/pages/FieldReportsPage.tsx',
  'apps/web/src/pages/OfficerFieldReportPage.tsx',
  'apps/web/src/pages/OfficerTimesheetPage.tsx',
  'apps/web/src/pages/RosterHRPage.tsx',
  'apps/web/src/lib/officerTimesheetWork.ts',
  'apps/web/src/hooks/useOfficerSafety.ts',
  'apps/mobile/src/components/OfficerScanScreen.tsx',
  'apps/mobile/src/components/OfficerSafetyBar.tsx',
  'apps/mobile/src/components/OfficerDispatchPanel.tsx',
  'apps/mobile/src/components/OfficerStopPanel.tsx',
  'apps/mobile/src/components/OfficerCheckpointScanner.tsx',
  'apps/mobile/src/components/OfficerFieldReportPanel.tsx',
  'apps/mobile/src/components/OfficerBiosecurityPanel.tsx',
  'apps/mobile/src/components/OfficerNoiseControlPanel.tsx',
  'apps/mobile/src/components/OfficerSmokeControlPanel.tsx',
  'apps/mobile/src/components/OfficerLeavePanel.tsx',
  'apps/mobile/src/components/OfficerTimesheetPanel.tsx',
  'apps/mobile/src/components/OfficerDebriefPanel.tsx',
  'apps/mobile/src/components/OfficerCredentialsPanel.tsx',
  'apps/mobile/src/components/OfficerVehicleLookup.tsx',
  'apps/mobile/src/components/NotificationInbox.tsx',
  'apps/mobile/src/lib/officerScan.ts',
  'apps/mobile/src/lib/officerSafety.ts',
  'apps/mobile/src/lib/officerBreadcrumb.ts',
  'apps/mobile/src/lib/backgroundTracking.ts',
  'apps/mobile/src/lib/officerNotifications.ts',
  'apps/mobile/src/lib/officerOfflinePackage.ts',
  'apps/mobile/src/lib/officerPtt.ts',
  'apps/mobile/src/lib/officerTimesheetWork.ts',
  'scripts/seed-historical-patrol-roster.mjs',
  'supabase/migrations/20260903180000_timesheet_work_ledger.sql',
  'supabase/functions/process-officer-scan/index.ts',
  'supabase/functions/resolve-point-context/index.ts',
  'supabase/functions/officer-route-guidance/index.ts',
  'supabase/functions/onspace-ai-chat/index.ts',
  'supabase/migrations/20260830128000_roster_work_units.sql',
  'supabase/migrations/20260830129000_materialize_roster_slots.sql',
  'supabase/migrations/20260830130500_roster_slot_response.sql',
  'supabase/migrations/20260830131000_manage_roster_slot.sql',
  'supabase/migrations/20260830132000_reassign_roster_slot.sql',
  'supabase/migrations/20260830133000_enforce_roster_availability.sql',
  'supabase/migrations/20260830134000_organization_calendar_settings.sql',
  'supabase/migrations/20260830135000_roster_commercial_readiness.sql',
  'supabase/migrations/20260830136000_govern_hr_workflows.sql',
  'supabase/migrations/20260830137000_govern_staff_readiness.sql',
  'supabase/migrations/20260830138000_govern_crm_quote_creation.sql',
  'supabase/migrations/20260830139000_govern_crm_quote_lines.sql',
  'supabase/migrations/20260830140000_govern_crm_quote_lifecycle.sql',
  'supabase/migrations/20260830141000_govern_welfare_alert_transitions.sql',
  'supabase/migrations/20260830125000_submit_officer_field_report.sql',
  'supabase/migrations/20260830142000_harden_officer_field_report_submission.sql',
  'supabase/migrations/20260830143000_govern_crm_contacts_and_activities.sql',
  'supabase/migrations/20260830144000_govern_crm_organization_spine.sql',
  'supabase/migrations/20260830145000_govern_user_identity_access.sql',
  'supabase/migrations/20260831080000_govern_crm_site_creation.sql',
  'supabase/migrations/20260831081000_govern_crm_site_boundary_review.sql',
  'supabase/migrations/20260831082000_govern_crm_agreement_setup.sql',
  'supabase/migrations/20260831083000_crm_operational_readiness.sql',
  'supabase/migrations/20260831084000_crm_onboarding_activation.sql',
  'supabase/migrations/20260831085000_scan_geofence_context.sql',
  'supabase/migrations/20260831086000_resolve_verified_site_context.sql',
  'supabase/migrations/20260831087000_authorize_resolve_context.sql',
  'supabase/migrations/20260831088000_crm_boundary_visual_review.sql',
  'supabase/migrations/20260831089000_fix_boundary_history_ambiguity.sql',
  'supabase/migrations/20260831090000_crm_onboarding_ownership_history.sql',
  'supabase/migrations/20260831091000_crm_activation_handoffs.sql',
  'supabase/migrations/20260831092000_aam_e2e_seed.sql',
  'supabase/migrations/20260831093000_crm_operational_geography.sql',
  'supabase/migrations/20260831094000_govern_operational_place_management.sql',
  'supabase/migrations/20260831095000_operational_place_editor.sql',
  'supabase/migrations/20260831096000_boundary_admin_upload_provenance.sql',
  'supabase/migrations/20260927010000_govern_custom_report_builder.sql',
  'supabase/migrations/20260927060000_dispatch_jobs_site_or_zone.sql',
  'supabase/migrations/20260927100000_project_historical_patrol_roster.sql',
  'supabase/migrations/20260901020000_resolve_contracted_operational_context.sql',
  'supabase/migrations/20260913150000_add_physical_address_to_officer_gps_evidence.sql',
  'supabase/migrations/20260913151000_include_physical_address_in_officer_timeline.sql',
  'supabase/migrations/20260913153000_import_approved_freedom_places.sql',
  'supabase/migrations/20260913153100_fix_freedom_place_import_service_execution.sql',
  'supabase/migrations/20260913154000_global_canonical_identity_spine.sql',
  'supabase/migrations/20260913154100_backfill_canonical_place_projection_links.sql',
  'supabase/migrations/20260913154200_backfill_canonical_person_projection_links.sql',
  'supabase/migrations/20260913154300_converge_operational_records_on_canonical_identity.sql',
  'supabase/migrations/20260913154400_global_vehicle_scv_source_links.sql',
  'supabase/migrations/20260905005900_govern_operating_branch_configuration.sql',
  'supabase/migrations/20260908100000_review_document_classification.sql',
  'supabase/migrations/20260908102000_document_promotion_proposals.sql',
  'supabase/schemas/public/functions/resolve_context.sql',
  'supabase/schemas/public/functions/is_zone_closed.sql'
];

function walkFiles(rootDir, relativeDir) {
  const absoluteDir = path.join(rootDir, relativeDir);
  if (!fs.existsSync(absoluteDir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git', '.bob'].includes(entry.name)) continue;
    const relativePath = path.join(relativeDir, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) files.push(...walkFiles(rootDir, relativePath));
    else files.push(relativePath);
  }
  return files;
}

function isSourceFile(file) {
  return /\.(?:[cm]?js|jsx|ts|tsx)$/.test(file)
    && !/(?:^|\/)(?:__tests__|test|tests)(?:\/|$)/.test(file)
    && !/\.(?:test|spec)\.[jt]sx?$/.test(file);
}

function sourceIdentity(file) {
  const edgeFunction = file.match(/^supabase\/functions\/([^/]+)\/index\.ts$/);
  if (edgeFunction && edgeFunction[1] !== '_shared') {
    return { source_type: 'edge_function', source_name: edgeFunction[1] };
  }
  if (file.startsWith('apps/web/src/')) {
    return {
      source_type: 'component',
      source_name: file.replace(/^apps\/web\/src\//, '').replace(/\.[jt]sx?$/, '').replace(/\/index$/, '')
    };
  }
  if (file.startsWith('apps/mobile/src/')) {
    return {
      source_type: 'component',
      source_name: `mobile/${file.replace(/^apps\/mobile\/src\//, '').replace(/\.[jt]sx?$/, '').replace(/\/index$/, '')}`
    };
  }
  return {
    source_type: 'component',
    source_name: file.replace(/^supabase\/functions\//, 'functions/').replace(/\.(?:[cm]?js|jsx|ts|tsx)$/, '').replace(/\/index$/, '')
  };
}

function edgeKey(edge) {
  return [edge.source_type, edge.source_name, edge.target_type, edge.target_name, edge.edge_kind, edge.source_file].join('\u0000');
}

function capabilityKey(capability) {
  return `${capability.entity_type}\u0000${capability.entity_name}`;
}

function fieldsMatch(existing, desired, fields) {
  return fields.every(field => (existing[field] ?? null) === (desired[field] ?? null));
}

function uniqueBy(items, keyOf) {
  return Array.from(new Map(items.map(item => [keyOf(item), item])).values());
}

function componentName(sourceFile) {
  return sourceFile.replace(/^apps\/web\/src\//, '').replace(/\.(?:[cm]?js|jsx|ts|tsx)$/, '');
}

function collectComponentEdges(sourceFile, content, inventory) {
  const source = sourceIdentity(sourceFile);
  const sourceName = source.source_name;
  const edges = [];
  const tableCalls = Array.from(content.matchAll(/(?:supabase|admin|callerClient)\s*\.\s*from\(['"]([^'"]+)['"]\)/g));
  for (const [index, match] of tableCalls.entries()) {
    const chainEnd = content.indexOf(';', match.index);
    const nextCall = tableCalls[index + 1]?.index ?? content.length;
    const segmentEnd = chainEnd === -1 ? nextCall : Math.min(chainEnd, nextCall);
    const chain = content.slice(match.index, segmentEnd);
    const edgeKind = /\.\s*(?:insert|update|delete|upsert)\s*\(/.test(chain) ? 'writes' : 'reads';
    edges.push({ ...source, target_type: 'table', target_name: match[1], edge_kind: edgeKind, evidence_class: 'live-code', source_file: sourceFile, caller_context: `Supabase table ${edgeKind === 'writes' ? 'mutation' : 'query'} in source` });
  }
  for (const match of content.matchAll(/(?:supabase|admin|callerClient)\s*\.\s*rpc\(\s*['"]([^'"]+)['"]/g)) {
    edges.push({ ...source, target_type: 'rpc', target_name: match[1], edge_kind: 'calls', evidence_class: 'live-code', source_file: sourceFile, caller_context: 'Supabase RPC call in source' });
  }
  for (const match of content.matchAll(/(?:supabase|admin|callerClient)\s*\.\s*rpc\([^;]*?\?\s*['"]([^'"]+)['"]\s*:\s*['"]([^'"]+)['"]/g)) {
    for (const rpcName of [match[1], match[2]]) {
      edges.push({ ...source, target_type: 'rpc', target_name: rpcName, edge_kind: 'calls', evidence_class: 'live-code', source_file: sourceFile, caller_context: 'Supabase RPC call in source' });
    }
  }
  for (const match of content.matchAll(/\bSELECT\s+public\.([a-zA-Z0-9_]+)\s*\(/gi)) {
    if (!inventory || inventory.rpcs.has(match[1])) {
      edges.push({ ...source, target_type: 'rpc', target_name: match[1], edge_kind: 'calls', evidence_class: 'live-code', source_file: sourceFile, caller_context: 'Management API SQL RPC call in source' });
    }
  }
  return edges;
}

function staleGeneratedEdgeIds(existingEdges, generatedEdges) {
  const generatedKeys = new Set(generatedEdges.map(edge => edgeKey(edge)));
  return existingEdges
    .filter(edge => edge.refresh_source === 'ci_generator' && edge.retirement_status === 'live' && !generatedKeys.has(edgeKey(edge)))
    .map(edge => edge.id);
}

function collectManagedRpcEdges(sourceFile, content, inventory) {
  const edges = [];
  const functionPattern = /create(?: or replace)? function public\.([a-zA-Z0-9_]+)[\s\S]*?as \$([a-zA-Z0-9_]*)\$([\s\S]*?)\$\2\$;/gi;
  for (const match of content.matchAll(functionPattern)) {
    const sourceName = match[1];
    const body = match[3];
    const writes = new Set();
    const reads = new Set();
    for (const write of body.matchAll(/(?:insert\s+into|update|delete\s+from)\s+(?:public\.)?([a-zA-Z0-9_]+)/gi)) {
      if (inventory.tables.has(write[1])) writes.add(write[1]);
    }
    for (const read of body.matchAll(/(?:from|join)\s+(?:public\.)?([a-zA-Z0-9_]+)/gi)) {
      if (inventory.tables.has(read[1])) reads.add(read[1]);
    }
    for (const table of writes) edges.push({ source_type: 'rpc', source_name: sourceName, target_type: 'table', target_name: table, edge_kind: 'writes', evidence_class: 'live-schema', source_file: sourceFile, caller_context: 'SQL mutation in RPC body' });
    for (const table of reads) edges.push({ source_type: 'rpc', source_name: sourceName, target_type: 'table', target_name: table, edge_kind: 'reads', evidence_class: 'live-schema', source_file: sourceFile, caller_context: 'SQL query in RPC body' });
    for (const call of body.matchAll(/public\.([a-zA-Z0-9_]+)\s*\(/gi)) {
      if (call[1] !== sourceName && inventory.rpcs.has(call[1])) edges.push({ source_type: 'rpc', source_name: sourceName, target_type: 'rpc', target_name: call[1], edge_kind: 'calls', evidence_class: 'live-schema', source_file: sourceFile, caller_context: 'SQL function call in RPC body' });
    }
  }
  for (const trigger of content.matchAll(/create trigger\s+[a-zA-Z0-9_]+[\s\S]*?\s+on\s+public\.([a-zA-Z0-9_]+)[\s\S]*?execute function\s+public\.([a-zA-Z0-9_]+)\s*\(/gi)) {
    edges.push({ source_type: 'table', source_name: trigger[1], target_type: 'rpc', target_name: trigger[2], edge_kind: 'triggers', evidence_class: 'live-schema', source_file: sourceFile, caller_context: 'PostgreSQL trigger execution' });
  }
  return edges;
}

function collectManagedAtlas(rootDir = process.cwd()) {
  const inventory = collectDdlEntities(rootDir);
  const edges = [];
  for (const sourceFile of MANAGED_SOURCES) {
    const filePath = path.join(rootDir, sourceFile);
    if (!fs.existsSync(filePath)) continue;
    const content = fs.readFileSync(filePath, 'utf8');
    edges.push(...(sourceFile.endsWith('.sql')
      ? collectManagedRpcEdges(sourceFile, content, inventory)
      : collectComponentEdges(sourceFile, content, inventory)));
  }
  const dedupedEdges = uniqueBy(edges, edgeKey);
  const nodes = uniqueBy(dedupedEdges.flatMap(edge => [
    ...(['table', 'rpc'].includes(edge.source_type) ? [{ entity_type: edge.source_type, entity_name: edge.source_name }] : []),
    ...(['table', 'rpc'].includes(edge.target_type) ? [{ entity_type: edge.target_type, entity_name: edge.target_name }] : [])
  ]), node => `${node.entity_type}|${node.entity_name}`);
  return { scope: 'managed_app', sources: MANAGED_SOURCES, nodes, edges: dedupedEdges };
}

function collectDdlEntities(rootDir) {
  const files = [
    'supabase/schema.sql',
    ...walkFiles(rootDir, 'supabase/migrations').filter(file => file.endsWith('.sql'))
  ];
  const tables = new Set();
  const rpcs = new Set();
  const tablePattern = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  const viewPattern = /CREATE(?:\s+OR\s+REPLACE)?\s+(?:MATERIALIZED\s+)?VIEW\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  const functionPattern = /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;

  for (const file of files) {
    const content = fs.existsSync(path.join(rootDir, file)) ? fs.readFileSync(path.join(rootDir, file), 'utf8') : '';
    for (const match of content.matchAll(tablePattern)) tables.add(match[1]);
    for (const match of content.matchAll(viewPattern)) tables.add(match[1]);
    for (const match of content.matchAll(functionPattern)) rpcs.add(match[1]);
  }
  return { tables, rpcs };
}

function collectSqlFunctionEdges(rootDir) {
  const schemaFile = 'supabase/schema.sql';
  const files = [
    schemaFile,
    ...walkFiles(rootDir, 'supabase/migrations').filter(file => file.endsWith('.sql')).sort()
  ];
  const latestFunctions = new Map();
  const functionPattern = /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:(?:"?(public|ops)"?)\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?[\s\S]*?AS\s+\$([a-zA-Z0-9_]*)\$([\s\S]*?)\$\3\$\s*;/gi;
  for (const file of files) {
    const content = fs.existsSync(path.join(rootDir, file)) ? fs.readFileSync(path.join(rootDir, file), 'utf8') : '';
    for (const match of content.matchAll(functionPattern)) {
      latestFunctions.set(match[2], { body: match[4], file });
    }
  }

  const edges = new Map();
  const add = (rpcName, targetType, targetName, kind, file, context) => {
    const edge = {
      source_type: 'rpc',
      source_name: rpcName,
      target_type: targetType,
      target_name: targetName,
      edge_kind: kind,
      evidence_class: 'live-schema',
      retirement_status: 'live',
      source_file: file,
      migration_name: file.startsWith('supabase/migrations/') ? path.basename(file, '.sql') : null,
      caller_context: `${OWNER_MARKER} ${context}`,
      refresh_source: 'ci_generator'
    };
    edges.set(edgeKey(edge), edge);
  };

  for (const [rpcName, definition] of latestFunctions) {
    for (const match of definition.body.matchAll(/\b(?:FROM|JOIN)\s+public\."?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi)) {
      const calledAsFunction = latestFunctions.has(match[1]) && /^\s*\(/.test(definition.body.slice((match.index ?? 0) + match[0].length));
      add(rpcName, calledAsFunction ? 'rpc' : 'table', match[1], calledAsFunction ? 'calls' : 'reads', definition.file, calledAsFunction ? `SQL calls public.${match[1]}` : `SQL reads public.${match[1]}`);
    }
    for (const match of definition.body.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\."?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi)) {
      add(rpcName, 'table', match[1], 'writes', definition.file, `SQL writes public.${match[1]}`);
    }
    for (const match of definition.body.matchAll(/\bpublic\."?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi)) {
      if (match[1] !== rpcName && latestFunctions.has(match[1])) {
        add(rpcName, 'rpc', match[1], 'calls', definition.file, `SQL calls public.${match[1]}`);
      }
    }
    for (const match of definition.body.matchAll(/\/functions\/v1\/([a-zA-Z0-9_-]+)/g)) {
      add(rpcName, 'edge_function', match[1], 'calls', definition.file, `SQL HTTP call to ${match[1]}`);
    }
  }
  const schema = fs.existsSync(path.join(rootDir, schemaFile)) ? fs.readFileSync(path.join(rootDir, schemaFile), 'utf8') : '';
  for (const trigger of schema.matchAll(/CREATE TRIGGER\s+[a-zA-Z0-9_]+[\s\S]*?\s+ON\s+public\."?([a-zA-Z_][a-zA-Z0-9_]*)"?[\s\S]*?EXECUTE FUNCTION\s+public\."?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi)) {
    if (latestFunctions.has(trigger[2])) {
      const edge = {
        source_type: 'table',
        source_name: trigger[1],
        target_type: 'rpc',
        target_name: trigger[2],
        edge_kind: 'triggers',
        evidence_class: 'live-schema',
        retirement_status: 'live',
        source_file: schemaFile,
        migration_name: null,
        caller_context: `${OWNER_MARKER} PostgreSQL trigger execution`,
        refresh_source: 'ci_generator'
      };
      edges.set(edgeKey(edge), edge);
    }
  }
  return [...edges.values()];
}

function collectSourceEdges(rootDir, knownEntities) {
  const sourceFiles = [
    ...walkFiles(rootDir, 'apps/web/src'),
    ...walkFiles(rootDir, 'apps/mobile/src'),
    ...walkFiles(rootDir, 'apps/sd-card-bridge/src'),
    ...walkFiles(rootDir, 'supabase/functions'),
    ...walkFiles(rootDir, 'services'),
    ...ROOT_SOURCE_FILES.filter(file => fs.existsSync(path.join(rootDir, file)))
  ].filter(isSourceFile);
  const edges = new Map();
  const add = (source, targetType, targetName, edgeKind, file, context) => {
    if (!targetName || targetName === 'if') return;
    const edge = {
      ...source,
      target_type: targetType,
      target_name: targetName,
      edge_kind: edgeKind,
      evidence_class: 'live-code',
      retirement_status: 'live',
      source_file: file,
      migration_name: null,
      caller_context: `${OWNER_MARKER} ${context}`,
      refresh_source: 'ci_generator'
    };
    edges.set(edgeKey(edge), edge);
  };

  for (const file of sourceFiles) {
    const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
    const source = sourceIdentity(file);
    const dynamicCallTargets = new Map();
    for (const assignment of content.matchAll(/\bconst\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*[^;\n]*?['"]([a-zA-Z0-9_-]+)['"][^;\n]*?['"]([a-zA-Z0-9_-]+)['"]/g)) {
      dynamicCallTargets.set(assignment[1], [assignment[2], assignment[3]].filter((name) => knownEntities.edgeFunctions.has(name)));
    }

    for (const match of content.matchAll(/\.from\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*\)/g)) {
      const segment = content.slice(match.index, Math.min(content.length, match.index + 1600)).split(';', 1)[0];
      const kind = /\.(?:insert|update|upsert|delete)\s*\(/.test(segment) ? 'writes' : 'reads';
      add(source, 'table', match[1], kind, file, `.from('${match[1]}')`);
    }
    for (const match of content.matchAll(/\.rpc\(\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)) {
      add(source, 'rpc', match[1], 'calls', file, `.rpc('${match[1]}')`);
    }
    for (const match of content.matchAll(/\.rpc\(\s*[^,\n?]+\?\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*:\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)) {
      for (const target of [match[1], match[2]]) {
        if (knownEntities.rpcs.has(target)) add(source, 'rpc', target, 'calls', file, `.rpc(conditional '${target}')`);
      }
    }
    for (const match of content.matchAll(/\.functions\.invoke(?:\s*<[^>]*>)?\(\s*['"]([a-zA-Z0-9_-]+)['"]/g)) {
      add(source, 'edge_function', match[1], 'calls', file, `.functions.invoke('${match[1]}')`);
    }
    for (const match of content.matchAll(/\bcallFn\(\s*['"]([a-zA-Z0-9_-]+)['"]/g)) {
      if (knownEntities.edgeFunctions.has(match[1])) {
        add(source, 'edge_function', match[1], 'calls', file, `callFn('${match[1]}')`);
      }
    }
    for (const match of content.matchAll(/\bcallFn\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,/g)) {
      for (const target of dynamicCallTargets.get(match[1]) || []) {
        add(source, 'edge_function', target, 'calls', file, `callFn(${match[1]})`);
      }
    }
    if (source.source_name === 'onspace-ai-chat' && /\bcallInference\(\s*\{/.test(content) && knownEntities.edgeFunctions.has('bob-inference')) {
      add(source, 'edge_function', 'bob-inference', 'calls', file, 'callInference() wrapper');
    }
    if (/\/functions\/v1\/\$\{functionName\}/.test(content)) {
      const endpointMap = content.match(/\bfunctionNames\s*=\s*\{([\s\S]*?)\s*\};/);
      for (const endpoint of endpointMap?.[1].matchAll(/:\s*['"]([a-zA-Z0-9_-]+)['"]/g) || []) {
        if (knownEntities.edgeFunctions.has(endpoint[1])) {
          add(source, 'edge_function', endpoint[1], 'calls', file, 'workflow endpoint map');
        }
      }
    }
    const functionUrlTargets = new Map();
    for (const match of content.matchAll(/\b(?:const|let)\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*=\s*(?:\([^)]*\)\s*=>\s*)?`[^`]*\/functions\/v1\/([a-zA-Z0-9_-]+)/g)) {
      if (knownEntities.edgeFunctions.has(match[2])) functionUrlTargets.set(match[1], match[2]);
    }
    for (const [variable, target] of functionUrlTargets) {
      add(source, 'edge_function', target, 'calls', file, `function endpoint URL variable (${variable})`);
    }
    for (const match of content.matchAll(/fetch\(\s*(?:`[^`]*\/functions\/v1\/|['"][^'"]*\/functions\/v1\/)([a-zA-Z0-9_-]+)/g)) {
      if (knownEntities.edgeFunctions.has(match[1])) {
        add(source, 'edge_function', match[1], 'calls', file, `fetch('/functions/v1/${match[1]}')`);
      }
    }
    for (const match of content.matchAll(/\bfetch\(\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,/g)) {
      const target = functionUrlTargets.get(match[1]);
      if (target) add(source, 'edge_function', target, 'calls', file, `fetch(${match[1]})`);
    }

    for (const match of content.matchAll(/ATLAS\s+(READS|WRITES|CALLS|INVOKES):\s*([^\n]+)/gi)) {
      const operation = match[1].toUpperCase();
      const names = match[2].split(',').map(value => value.replace(/\([^)]*\)/g, '').trim()).filter(value => /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(value));
      for (const name of names) {
        if (operation === 'READS' || operation === 'WRITES') {
          if (knownEntities.rpcs.has(name)) add(source, 'rpc', name, 'calls', file, `ATLAS ${operation}: ${name}`);
          else add(source, 'table', name, operation.toLowerCase(), file, `ATLAS ${operation}: ${name}`);
        } else {
          const targetType = knownEntities.edgeFunctions.has(name) ? 'edge_function' : 'rpc';
          add(source, targetType, name, 'calls', file, `ATLAS ${operation}: ${name}`);
        }
      }
    }
  }
  return [...edges.values()].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
}

function collectAtlasRefresh(rootDir = process.cwd()) {
  const { tables, rpcs } = collectDdlEntities(rootDir);
  const repositoryFiles = [
    ...walkFiles(rootDir, 'apps/web/src'),
    ...walkFiles(rootDir, 'apps/mobile/src'),
    ...walkFiles(rootDir, 'apps/sd-card-bridge/src'),
    ...walkFiles(rootDir, 'supabase/functions')
  ].sort();
  const edgeFunctions = new Set(
    walkFiles(rootDir, 'supabase/functions')
      .map(file => file.match(/^supabase\/functions\/([^/]+)\/index\.ts$/)?.[1])
      .filter(name => name && name !== '_shared')
  );
  const sourceEdges = collectSourceEdges(rootDir, { tables, rpcs, edgeFunctions });
  const edgesByKey = new Map();
  for (const edge of [...sourceEdges, ...collectSqlFunctionEdges(rootDir)]) edgesByKey.set(edgeKey(edge), edge);
  const addDerivedFeature = (sourceName, featureName, sourceFile, context) => {
    const edge = {
      source_type: 'rpc',
      source_name: sourceName,
      target_type: 'feature',
      target_name: featureName,
      edge_kind: 'calls',
      evidence_class: 'live-schema',
      retirement_status: 'live',
      source_file: sourceFile,
      migration_name: sourceFile.startsWith('supabase/migrations/') ? path.basename(sourceFile, '.sql') : null,
      caller_context: `${OWNER_MARKER} ${context}`,
      refresh_source: 'ci_generator'
    };
    edgesByKey.set(edgeKey(edge), edge);
  };
  const completionPayEdge = [...edgesByKey.values()].find((edge) => edge.source_type === 'rpc'
    && edge.source_name === 'advance_dispatch_job_status'
    && edge.target_type === 'rpc'
    && edge.target_name === 'resolve_dispatch_job_pay_lines');
  if (completionPayEdge) {
    addDerivedFeature('advance_dispatch_job_status', 'rate_rules_pay_resolve_pay_lines', completionPayEdge.source_file, 'derived completed-dispatch pay-line resolution');
  }
  const travelContextEdge = [...edgesByKey.values()].find((edge) => edge.source_type === 'rpc'
    && edge.source_name === 'resolve_dispatch_job_pay_lines'
    && edge.target_type === 'rpc'
    && edge.target_name === 'compute_travel_distance_km');
  if (completionPayEdge && travelContextEdge) {
    addDerivedFeature('resolve_dispatch_job_pay_lines', 'travel_km_rate_context_distance', travelContextEdge.source_file, 'derived completed-dispatch travel distance context');
  }
  const edges = [...edgesByKey.values()].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
  const callersByTarget = new Map();
  for (const edge of edges) {
    const key = `${edge.target_type}\u0000${edge.target_name}`;
    if (!callersByTarget.has(key)) callersByTarget.set(key, new Set());
    callersByTarget.get(key).add(edge.source_name);
  }
  const capabilities = [];
  const addCapabilities = (entityType, names) => {
    for (const entityName of [...names].sort()) {
      const callers = [...(callersByTarget.get(`${entityType}\u0000${entityName}`) || [])].sort();
      capabilities.push({
        entity_type: entityType,
        entity_name: entityName,
        present: true,
        wired: callers.length > 0,
        exercised: null,
        caller_summary: callers.length ? callers.join(', ') : null,
        notes: `${OWNER_MARKER} static source inventory; exercised is never inferred`,
        refresh_source: 'ci_generator',
        retirement_status: 'live'
      });
    }
  };
  addCapabilities('table', tables);
  addCapabilities('rpc', rpcs);
  addCapabilities('edge_function', edgeFunctions);
  addCapabilities('feature', new Set(edges.filter((edge) => edge.target_type === 'feature').map((edge) => edge.target_name)));

  return {
    generated_at: new Date().toISOString(),
    generator: OWNER_MARKER,
    repository_files: repositoryFiles,
    capabilities: capabilities.sort((left, right) => capabilityKey(left).localeCompare(capabilityKey(right))),
    edges
  };
}

function buildRefreshPlan(manifest, existingCapabilities, existingEdges) {
  const capabilityByKey = new Map(existingCapabilities.map(row => [capabilityKey(row), row]));
  const edgeByKey = new Map(existingEdges.map(row => [edgeKey(row), row]));
  const generatedCapabilityKeys = new Set(manifest.capabilities.map(capabilityKey));
  const generatedEdgeKeys = new Set(manifest.edges.map(edgeKey));
  const repositoryFiles = new Set(manifest.repository_files || []);
  const plan = {
    capabilityUpserts: [],
    edgeUpserts: [],
    capabilityRetireIds: [],
    edgeRetireIds: []
  };

  for (const capability of manifest.capabilities) {
    const existing = capabilityByKey.get(capabilityKey(capability));
    const desired = {
      ...capability,
      exercised: capability.entity_type === 'feature' && capability.refresh_source === 'ci_generator'
        && existing?.refresh_source !== 'runtime_telemetry'
        ? null
        : existing?.exercised ?? null,
      wired: capability.wired,
      caller_summary: capability.caller_summary,
      notes: capability.notes
    };
    if (!existing || !fieldsMatch(existing, desired, [
      'present', 'wired', 'exercised', 'caller_summary', 'notes', 'refresh_source', 'retirement_status'
    ])) {
      plan.capabilityUpserts.push(desired);
    }
  }
  for (const existing of existingCapabilities) {
    const isManual = existing.refresh_source === 'manual_seed';
    const isGeneratedType = ['table', 'rpc', 'edge_function'].includes(existing.entity_type);
    if (existing.retirement_status !== 'legacy'
        && !generatedCapabilityKeys.has(capabilityKey(existing))
        && (isManual || isGeneratedType)) {
      plan.capabilityRetireIds.push(existing.id);
    }
  }

  for (const edge of manifest.edges) {
    const existing = edgeByKey.get(edgeKey(edge));
    const desired = {
      ...edge,
      caller_context: edge.caller_context
    };
    if (!existing || !fieldsMatch(existing, desired, [
      'evidence_class', 'retirement_status', 'migration_name', 'caller_context', 'refresh_source'
    ])) {
      plan.edgeUpserts.push(desired);
    }
  }
  for (const existing of existingEdges) {
    const legacyManagedContext = MANAGED_SOURCES.includes(existing.source_file)
      && /^\.from\(['"][^'"]+['"]\)\.(?:insert|update|upsert|delete)/.test(String(existing.caller_context || ''));
    const deletedRepositorySource = repositoryFiles.size > 0
      && (String(existing.source_file || '').startsWith('apps/web/src/')
        || String(existing.source_file || '').startsWith('supabase/functions/'))
      && !repositoryFiles.has(existing.source_file);
    if ((String(existing.caller_context || '').startsWith(OWNER_MARKER) || legacyManagedContext || deletedRepositorySource || existing.refresh_source === 'manual_seed')
        && existing.retirement_status !== 'legacy'
        && !generatedEdgeKeys.has(edgeKey(existing))) {
      plan.edgeRetireIds.push(existing.id);
    }
  }
  return plan;
}

async function fetchAll(baseUrl, serviceKey, table, select) {
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const response = await fetch(`${baseUrl}/rest/v1/${table}?select=${encodeURIComponent(select)}`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Range: `${offset}-${offset + 999}`
      }
    });
    if (!response.ok) throw new Error(`Failed to read ${table}: ${response.status}`);
    const page = await response.json();
    rows.push(...page);
    if (page.length < 1000) return rows;
  }
}

async function writeBatches(baseUrl, serviceKey, table, rows, conflictColumns) {
  for (let index = 0; index < rows.length; index += BATCH_SIZE) {
    const batch = rows.slice(index, index + BATCH_SIZE).map(row => ({
      ...row,
      last_refreshed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }));
    const response = await fetch(`${baseUrl}/rest/v1/${table}?on_conflict=${encodeURIComponent(conflictColumns)}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(batch)
    });
    if (!response.ok) throw new Error(`Failed to upsert ${table}: ${response.status}`);
  }
}

async function retireRows(baseUrl, serviceKey, table, ids) {
  for (let index = 0; index < ids.length; index += BATCH_SIZE) {
    const batch = ids.slice(index, index + BATCH_SIZE);
    const filter = batch.join(',');
    const response = await fetch(`${baseUrl}/rest/v1/${table}?id=in.(${filter})`, {
      method: 'PATCH',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ retirement_status: 'legacy', updated_at: new Date().toISOString() })
    });
    if (!response.ok) throw new Error(`Failed to retire ${table}: ${response.status}`);
  }
}

async function applyAtlasRefresh(manifest, { baseUrl, serviceKey, allowLargeRetirement = false }) {
  if (!baseUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const [existingCapabilities, existingEdges] = await Promise.all([
    fetchAll(baseUrl, serviceKey, 'bob_capability_map', 'id,entity_type,entity_name,present,wired,exercised,caller_summary,notes,refresh_source,retirement_status'),
    fetchAll(baseUrl, serviceKey, 'bob_app_map_edges', 'id,source_type,source_name,target_type,target_name,edge_kind,evidence_class,source_file,migration_name,caller_context,refresh_source,retirement_status')
  ]);
  const plan = buildRefreshPlan(manifest, existingCapabilities, existingEdges);
  const retirementCount = plan.capabilityRetireIds.length + plan.edgeRetireIds.length;
  if (retirementCount > MAX_RETIREMENTS && !allowLargeRetirement) {
    throw new Error(`Refusing to retire ${retirementCount} Atlas rows without --allow-large-retirement`);
  }

  await writeBatches(baseUrl, serviceKey, 'bob_capability_map', plan.capabilityUpserts, 'entity_type,entity_name');
  await writeBatches(baseUrl, serviceKey, 'bob_app_map_edges', plan.edgeUpserts, 'source_type,source_name,target_type,target_name,edge_kind,source_file');
  await retireRows(baseUrl, serviceKey, 'bob_capability_map', plan.capabilityRetireIds);
  await retireRows(baseUrl, serviceKey, 'bob_app_map_edges', plan.edgeRetireIds);
  return plan;
}

function writeManifest(rootDir, manifest, outputDir = process.env.ATLAS_REFRESH_OUTPUT_DIR || path.join(rootDir, '.bob')) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'atlas-refresh-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const rootDir = process.cwd();
  const manifest = collectAtlasRefresh(rootDir);
  writeManifest(rootDir, manifest);
  if (!args.has('--apply')) {
    console.log(`Atlas refresh manifest: ${manifest.capabilities.length} capabilities, ${manifest.edges.length} edges (dry run)`);
    return;
  }
  const plan = await applyAtlasRefresh(manifest, {
    baseUrl: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    allowLargeRetirement: args.has('--allow-large-retirement')
  });
  console.log(`Atlas refreshed: ${plan.capabilityUpserts.length} capabilities, ${plan.edgeUpserts.length} edges, ${plan.capabilityRetireIds.length + plan.edgeRetireIds.length} retired`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Atlas refresh failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  OWNER_MARKER,
  collectComponentEdges,
  collectManagedAtlas,
  staleGeneratedEdgeIds,
  collectAtlasRefresh,
  buildRefreshPlan,
  applyAtlasRefresh
};