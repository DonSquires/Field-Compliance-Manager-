const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { extractCronOperations, extractScheduledRpcName } = require('./lib/atlas-cron.cjs');

const OWNER_MARKER = '[repo-atlas-refresh:v1]';
const BATCH_SIZE = 250;
const MAX_RETIREMENTS = 100;
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
  'scripts/seed-rm-forestry-roster-history.mjs',
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
  'supabase/migrations/20260927140000_fix_historical_forestry_roster_rpc.sql',
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

function rootSourceFiles(rootDir) {
  return fs.readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && isSourceFile(entry.name))
    .map(entry => entry.name)
    .sort();
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

function isRefreshOwnedEdge(edge) {
  return edge.refresh_source === 'ci_generator'
    && String(edge.caller_context || '').startsWith(OWNER_MARKER);
}

function staleGeneratedEdgeIds(existingEdges, generatedEdges) {
  const generatedKeys = new Set(generatedEdges.map(edge => edgeKey(edge)));
  return existingEdges
    .filter(edge => isRefreshOwnedEdge(edge)
      && edge.retirement_status === 'live'
      && !generatedKeys.has(edgeKey(edge)))
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
  const files = ['supabase/schema.sql'];
  const tables = new Set();
  const rpcs = new Set();
  const tablePattern = /(?:^|;)[ \t]*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?)"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gim;
  const viewPattern = /(?:^|;)[ \t]*CREATE(?:\s+OR\s+REPLACE)?\s+(?:MATERIALIZED\s+)?VIEW\s+(?:(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?)"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gim;
  const functionPattern = /(?:^|;)[ \t]*CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?)"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gim;
  const collectPublicNames = (content, pattern, target) => {
    for (const match of content.matchAll(pattern)) {
      const schema = match[1]?.toLowerCase();
      if (!schema || schema === 'public') target.add(match[2]);
    }
  };

  for (const file of files) {
    const content = fs.existsSync(path.join(rootDir, file)) ? fs.readFileSync(path.join(rootDir, file), 'utf8') : '';
    collectPublicNames(content, tablePattern, tables);
    collectPublicNames(content, viewPattern, tables);
    collectPublicNames(content, functionPattern, rpcs);
  }
  return { tables, rpcs };
}

function splitSqlArguments(argumentsSql) {
  const argumentsList = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (let index = 0; index < argumentsSql.length; index += 1) {
    const character = argumentsSql[index];
    if (quote) {
      current += character;
      if (character === quote && argumentsSql[index + 1] === quote) {
        current += argumentsSql[index + 1];
        index += 1;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
    } else if (character === '(' || character === '[') {
      depth += 1;
      current += character;
    } else if (character === ')' || character === ']') {
      depth = Math.max(0, depth - 1);
      current += character;
    } else if (character === ',' && depth === 0) {
      argumentsList.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim()) argumentsList.push(current.trim());
  return argumentsList;
}

function normalizedArgumentType(argument) {
  let value = argument
    .replace(/\s+DEFAULT\s+[\s\S]*$/i, '')
    .replace(/\s*=\s*[\s\S]*$/, '')
    .trim()
    .replace(/\s+/g, ' ');
  const mode = /^(INOUT|IN|OUT|VARIADIC)\s+/i.exec(value);
  if (mode) {
    if (mode[1].toUpperCase() === 'OUT') return null;
    value = value.slice(mode[0].length).trim();
  }
  const firstSpace = value.indexOf(' ');
  if (firstSpace !== -1) {
    const firstToken = value.slice(0, firstSpace).replaceAll('"', '').toLowerCase();
    const typeStarters = new Set([
      'bigint', 'bigserial', 'bit', 'boolean', 'bytea', 'character', 'date', 'decimal',
      'double', 'inet', 'integer', 'interval', 'json', 'jsonb', 'numeric', 'real',
      'record', 'smallint', 'smallserial', 'serial', 'text', 'time', 'timestamp',
      'timetz', 'timestamptz', 'uuid', 'varchar', 'xml'
    ]);
    if (!typeStarters.has(firstToken) && !firstToken.includes('.') && !firstToken.endsWith('[]')) {
      value = value.slice(firstSpace + 1).trim();
    }
  }
  return value
    .replace(/\btimestamp\s+with\s+time\s+zone\b/gi, 'timestamptz')
    .replace(/\btimestamp\s+without\s+time\s+zone\b/gi, 'timestamp')
    .replace(/\btime\s+with\s+time\s+zone\b/gi, 'timetz')
    .replace(/\btime\s+without\s+time\s+zone\b/gi, 'time')
    .replace(/\bcharacter\s+varying\b/gi, 'varchar')
    .replace(/\bdouble\s+precision\b/gi, 'float8')
    .replace(/\bsmallint\b/gi, 'int2')
    .replace(/\bbigint\b/gi, 'int8')
    .replace(/\binteger\b/gi, 'int4')
    .replace(/\bboolean\b/gi, 'bool')
    .replace(/\breal\b/gi, 'float4')
    .replaceAll('"', '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizedFunctionSignature(functionName, argumentsSql) {
  const argumentTypes = splitSqlArguments(argumentsSql)
    .map(normalizedArgumentType)
    .filter(Boolean);
  return `${functionName.toLowerCase()}(${argumentTypes.join(',')})`;
}

function collectSqlFunctionEdges(rootDir) {
  const schemaFile = 'supabase/schema.sql';
  const schemaExists = fs.existsSync(path.join(rootDir, schemaFile));
  const files = schemaExists
    ? [
      ...walkFiles(rootDir, 'supabase/schemas').filter(file => file.endsWith('.sql')).sort(),
      schemaFile
    ]
    : walkFiles(rootDir, 'supabase/migrations').filter(file => file.endsWith('.sql')).sort();
  const latestFunctions = new Map();
  const functionPattern = /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+(?:(?:"?(public|ops)"?)\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(([\s\S]*?)\)\s*RETURNS[\s\S]*?AS\s+\$([a-zA-Z0-9_]*)\$([\s\S]*?)\$\4\$\s*;/gi;
  // The live snapshot only dumps the public schema, so ops-schema scheduler
  // functions exist nowhere but their migrations. Collect those first and only
  // when ops-qualified: an unqualified sweep of every migration would resurrect
  // public functions that have since been dropped, and schema.sql must stay the
  // authority for anything it does contain.
  for (const file of walkFiles(rootDir, 'supabase/migrations').filter(file => file.endsWith('.sql')).sort()) {
    const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
    for (const match of content.matchAll(functionPattern)) {
      if (match[1]?.toLowerCase() !== 'ops') continue;
      const signature = normalizedFunctionSignature(match[2], match[3]);
      latestFunctions.set(`ops.${signature}`, { name: match[2], body: match[5], file });
    }
  }
  for (const file of files) {
    const content = fs.existsSync(path.join(rootDir, file)) ? fs.readFileSync(path.join(rootDir, file), 'utf8') : '';
    for (const match of content.matchAll(functionPattern)) {
      const schemaName = match[1]?.toLowerCase() ?? 'public';
      const signature = normalizedFunctionSignature(match[2], match[3]);
      latestFunctions.set(`${schemaName}.${signature}`, { name: match[2], body: match[5], file });
    }
  }
  const functionNames = new Set([...latestFunctions.values()].map((definition) => definition.name));

  const edges = new Map();
  const add = (sourceName, targetType, targetName, kind, file, context, sourceType = 'rpc') => {
    const edge = {
      source_type: sourceType,
      source_name: sourceName,
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

  for (const definition of latestFunctions.values()) {
    const rpcName = definition.name;
    for (const match of definition.body.matchAll(/\b(?:FROM|JOIN)\s+public\."?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi)) {
      const calledAsFunction = functionNames.has(match[1]) && /^\s*\(/.test(definition.body.slice((match.index ?? 0) + match[0].length));
      add(rpcName, calledAsFunction ? 'rpc' : 'table', match[1], calledAsFunction ? 'calls' : 'reads', definition.file, calledAsFunction ? `SQL calls public.${match[1]}` : `SQL reads public.${match[1]}`);
    }
    for (const match of definition.body.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\."?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi)) {
      add(rpcName, 'table', match[1], 'writes', definition.file, `SQL writes public.${match[1]}`);
    }
    for (const match of definition.body.matchAll(/\bpublic\."?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi)) {
      if (match[1] !== rpcName && functionNames.has(match[1])) {
        add(rpcName, 'rpc', match[1], 'calls', definition.file, `SQL calls public.${match[1]}`);
      }
    }
    for (const match of definition.body.matchAll(/(?:^|[^\w.])"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/g)) {
      if (match[1] !== rpcName && functionNames.has(match[1])) {
        add(rpcName, 'rpc', match[1], 'calls', definition.file, `SQL calls ${match[1]} through function search_path`);
      }
    }
    for (const match of definition.body.matchAll(/\/functions\/v1\/([a-zA-Z0-9_-]+)/g)) {
      add(rpcName, 'edge_function', match[1], 'calls', definition.file, `SQL HTTP call to ${match[1]}`);
    }
  }
  const schema = fs.existsSync(path.join(rootDir, schemaFile)) ? fs.readFileSync(path.join(rootDir, schemaFile), 'utf8') : '';
  for (const trigger of schema.matchAll(/CREATE TRIGGER\s+"?[a-zA-Z0-9_]+"?[\s\S]*?\s+ON\s+(?:"?public"?\.)"?([a-zA-Z_][a-zA-Z0-9_]*)"?[\s\S]*?EXECUTE FUNCTION\s+(?:"?public"?\.)"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi)) {
    if (functionNames.has(trigger[2])) {
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
  const addReferencedFunctions = (tableName, definition, edgeKind, context, sourceFile = schemaFile) => {
    const referenced = new Set();
    for (const match of definition.matchAll(/\bpublic\."?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi)) referenced.add(match[1]);
    for (const match of definition.matchAll(/(?<![\w.])"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/g)) referenced.add(match[1]);
    for (const functionName of referenced) {
      if (!functionNames.has(functionName)) continue;
      add(tableName, 'rpc', functionName, edgeKind, sourceFile, context, 'table');
    }
  };
  const schemaStatements = schema.split(/;\s*(?:\r?\n|$)/);
  for (const statement of schemaStatements) {
    const policy = statement.match(/^\s*CREATE POLICY\s+(?:"[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)\s+ON\s+(?:"?public"?\.)"?([a-zA-Z_][a-zA-Z0-9_]*)"?([\s\S]*)$/i);
    if (policy) addReferencedFunctions(policy[1], policy[2], 'secured_by', 'PostgreSQL row-level security policy');
    const constraint = statement.match(/^\s*ALTER TABLE(?:\s+ONLY)?\s+(?:"?public"?\.)"?([a-zA-Z_][a-zA-Z0-9_]*)"?([\s\S]*\bADD CONSTRAINT\b[\s\S]*\bCHECK\s*\([\s\S]*\))\s*$/i);
    if (constraint) addReferencedFunctions(constraint[1], constraint[2], 'calls', 'PostgreSQL check constraint');
  }

  // The live snapshot intentionally includes only public, so current policies
  // on managed schemas such as storage exist only in migrations. Replay policy
  // create/drop events in migration order and retain only the latest definition.
  const externalPolicies = new Map();
  const policyEventPattern = /(DROP|CREATE)\s+POLICY(?:\s+IF\s+EXISTS)?\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+ON\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\."?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi;
  for (const file of walkFiles(rootDir, 'supabase/migrations').filter(file => file.endsWith('.sql')).sort()) {
    const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
    for (const event of content.matchAll(policyEventPattern)) {
      if (event[3].toLowerCase() === 'public') continue;
      const key = `${event[3].toLowerCase()}.${event[4].toLowerCase()}:${event[2].toLowerCase()}`;
      if (event[1].toUpperCase() === 'DROP') {
        externalPolicies.delete(key);
        continue;
      }
      const tail = content.slice(event.index ?? 0);
      const boundary = tail.match(/\$[a-zA-Z0-9_]+\$\s*;|;\s*(?:\r?\n|$)/);
      externalPolicies.set(key, {
        tableName: `${event[3]}.${event[4]}`,
        definition: boundary?.index == null ? tail.slice(0, 6000) : tail.slice(0, boundary.index),
        file
      });
    }
  }
  for (const policy of externalPolicies.values()) {
    addReferencedFunctions(
      policy.tableName,
      policy.definition,
      'secured_by',
      `PostgreSQL row-level security policy on ${policy.tableName}`,
      policy.file
    );
  }
  return [...edges.values()];
}

function maskSqlLiterals(content) {
  const preserveLines = (value) => value.replace(/[^\r\n]/g, ' ');
  return content
    .replace(/\$([a-zA-Z0-9_]*)\$[\s\S]*?\$\1\$/g, preserveLines)
    .replace(/'(?:''|[^'])*'/g, preserveLines)
    .replace(/\/\*[\s\S]*?\*\//g, preserveLines)
    .replace(/--[^\r\n]*/g, preserveLines);
}

function collectSchemaViewEdges(rootDir, inventory = collectDdlEntities(rootDir)) {
  const schemaFile = 'supabase/schema.sql';
  const schemaPath = path.join(rootDir, schemaFile);
  if (!fs.existsSync(schemaPath)) return [];
  const schema = maskSqlLiterals(fs.readFileSync(schemaPath, 'utf8'));
  const edges = new Map();
  const viewPattern = /(?:^|\n)\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?VIEW\s+(?:(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?)"?([a-zA-Z_][a-zA-Z0-9_]*)"?(?:\s+WITH\s*\([^;]*?\))?\s+AS\s+([\s\S]*?)\s*;/gim;

  for (const view of schema.matchAll(viewPattern)) {
    const schemaName = view[1]?.toLowerCase();
    if (schemaName && schemaName !== 'public') continue;
    const viewName = view[2];
    const body = view[3];
    const cteNames = new Set();
    for (const cte of body.matchAll(/(?:\bWITH(?:\s+RECURSIVE)?|,)\s*"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+AS\s+(?:(?:NOT\s+)?MATERIALIZED\s+)?\(/gi)) {
      cteNames.add(cte[1].toLowerCase());
    }
    for (const dependency of body.matchAll(/\b(?:FROM|JOIN)\s+(?:LATERAL\s+)?(?:(?:"?([a-zA-Z_][a-zA-Z0-9_]*)"?\.)?)"?([a-zA-Z_][a-zA-Z0-9_]*)"?/gi)) {
      const dependencySchema = dependency[1]?.toLowerCase();
      const dependencyName = dependency[2];
      if (dependencySchema && dependencySchema !== 'public') continue;
      if (dependencyName === viewName || cteNames.has(dependencyName.toLowerCase()) || !inventory.tables.has(dependencyName)) continue;
      const edge = {
        source_type: 'table',
        source_name: viewName,
        target_type: 'table',
        target_name: dependencyName,
        edge_kind: 'reads',
        evidence_class: 'live-schema',
        retirement_status: 'live',
        source_file: schemaFile,
        migration_name: null,
        caller_context: `${OWNER_MARKER} SQL view reads public.${dependencyName}`,
        refresh_source: 'ci_generator'
      };
      edges.set(edgeKey(edge), edge);
    }
  }
  return [...edges.values()];
}

function collectCronSchedulerEdges(rootDir, inventory) {
  const files = [
    ...walkFiles(rootDir, 'supabase/migrations').filter(file => file.endsWith('.sql')).sort(),
    ...walkFiles(rootDir, 'supabase/schemas/_cluster').filter(file => file.endsWith('.sql')).sort(),
  ];
  const activeSchedules = new Map();

  for (const file of files) {
    const content = fs.readFileSync(path.join(rootDir, file), 'utf8');
    for (const operation of extractCronOperations(content)) {
      if (operation.kind === 'unschedule') {
        activeSchedules.delete(operation.jobName);
      } else {
        activeSchedules.set(operation.jobName, { ...operation, file });
      }
    }
  }

  const edges = [];
  for (const schedule of activeSchedules.values()) {
    const rpcName = extractScheduledRpcName(schedule.command);
    if (!rpcName || !inventory.rpcs.has(rpcName)) continue;
    edges.push({
      source_type: 'feature',
      source_name: `scheduler/${schedule.jobName}`,
      target_type: 'rpc',
      target_name: rpcName,
      edge_kind: 'calls',
      evidence_class: 'live-schema',
      retirement_status: 'live',
      source_file: schedule.file,
      migration_name: schedule.file.startsWith('supabase/migrations/')
        ? path.basename(schedule.file, '.sql')
        : null,
      caller_context: `${OWNER_MARKER} pg_cron schedule ${schedule.schedule} calls public.${rpcName}`,
      refresh_source: 'ci_generator',
    });
  }
  return edges;
}

function collectSchemaForeignKeyEdges(rootDir) {
  const schemaFile = 'supabase/schema.sql';
  const schemaPath = path.join(rootDir, schemaFile);
  if (!fs.existsSync(schemaPath)) return [];
  const schema = fs.readFileSync(schemaPath, 'utf8');
  const edges = new Map();
  const add = (sourceName, targetName, context) => {
    if (!sourceName || !targetName) return;
    const edge = {
      source_type: 'table',
      source_name: sourceName,
      target_type: 'table',
      target_name: targetName,
      edge_kind: 'fk_references',
      evidence_class: 'live-schema',
      retirement_status: 'live',
      source_file: schemaFile,
      migration_name: null,
      caller_context: `${OWNER_MARKER} ${context}`,
      refresh_source: 'ci_generator'
    };
    edges.set(edgeKey(edge), edge);
  };

  for (const match of schema.matchAll(/ALTER TABLE ONLY\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?[\s\S]*?ADD CONSTRAINT\s+"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s+FOREIGN KEY\s*\([^)]*\)\s+REFERENCES\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi)) {
    add(match[1], match[3], `schema foreign key ${match[2]}`);
  }
  for (const match of schema.matchAll(/CREATE TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(([\s\S]*?)\)\s*;/gi)) {
    for (const reference of match[2].matchAll(/(?:FOREIGN KEY\s*\([^)]*\)\s+)?REFERENCES\s+(?:"?public"?\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi)) {
      add(match[1], reference[1], 'inline schema foreign key');
    }
  }
  return [...edges.values()];
}

function collectSourceEdges(rootDir, knownEntities) {
  const sourceFiles = [
    ...walkFiles(rootDir, 'apps/web/src'),
    ...walkFiles(rootDir, 'apps/mobile/src'),
    ...walkFiles(rootDir, 'apps/sd-card-bridge-v2/src'),
    ...walkFiles(rootDir, 'supabase/functions'),
    ...walkFiles(rootDir, 'services'),
    ...rootSourceFiles(rootDir),
    ...walkFiles(rootDir, 'scripts')
  ].filter(isSourceFile);
  const edges = new Map();
  const add = (source, targetType, targetName, edgeKind, file, context, evidenceClass = 'live-code') => {
    if (!targetName || targetName === 'if') return;
    const edge = {
      ...source,
      target_type: targetType,
      target_name: targetName,
      edge_kind: edgeKind,
      evidence_class: evidenceClass,
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
    if (source.source_type === 'edge_function') {
      for (const match of content.matchAll(/ATLAS\s+EXTERNAL\s+CALLER:\s*([a-zA-Z0-9_-]+)/gi)) {
        add(
          { source_type: 'feature', source_name: match[1] },
          'edge_function',
          source.source_name,
          'invokes',
          file,
          `declared external caller: ${match[1]}`,
          'declared-external-contract'
        );
      }
    }
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
    for (const match of content.matchAll(/\b(?:SELECT|PERFORM|LATERAL)\s+(?:public\.)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?\s*\(/gi)) {
      if (knownEntities.rpcs.has(match[1])) add(source, 'rpc', match[1], 'calls', file, `SQL call public.${match[1]}(...)`);
    }
    for (const match of content.matchAll(/\.rpc\(\s*[^,?]*\?\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]\s*:\s*['"]([a-zA-Z_][a-zA-Z0-9_]*)['"]/g)) {
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
    for (const match of content.matchAll(/new URL\(\s*(?:`[^`]*\/functions\/v1\/|['"][^'"]*\/functions\/v1\/)([a-zA-Z0-9_-]+)/g)) {
      if (knownEntities.edgeFunctions.has(match[1])) {
        add(source, 'edge_function', match[1], 'calls', file, `new URL('/functions/v1/${match[1]}')`);
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

function resolveSourceRevision(rootDir = process.cwd()) {
  const read = (args) => {
    try {
      const value = execFileSync('git', args, { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return value || null;
    } catch {
      return null;
    }
  };
  const explicitCommit = process.env.ATLAS_REFRESH_SOURCE_COMMIT;
  const dirty = !explicitCommit && Boolean(read(['status', '--porcelain', '--untracked-files=no']));
  const commit = explicitCommit || (dirty ? null : read(['rev-parse', 'HEAD']));
  const branch = process.env.ATLAS_REFRESH_SOURCE_BRANCH || read(['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    source_commit: commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit : null,
    source_branch: branch && branch !== 'HEAD' ? branch : null
  };
}

function collectAtlasRefresh(rootDir = process.cwd()) {
  const { tables, rpcs } = collectDdlEntities(rootDir);
  const repositoryFiles = [
    ...walkFiles(rootDir, 'apps/web/src'),
    ...walkFiles(rootDir, 'apps/mobile/src'),
    ...walkFiles(rootDir, 'apps/sd-card-bridge-v2/src'),
    ...walkFiles(rootDir, 'supabase/functions'),
    ...walkFiles(rootDir, 'services'),
    ...rootSourceFiles(rootDir),
    ...walkFiles(rootDir, 'scripts')
  ].sort();
  const edgeFunctions = new Set(
    walkFiles(rootDir, 'supabase/functions')
      .map(file => file.match(/^supabase\/functions\/([^/]+)\/index\.ts$/)?.[1])
      .filter(name => name && name !== '_shared')
  );
  const sourceEdges = collectSourceEdges(rootDir, { tables, rpcs, edgeFunctions });
  const edgesByKey = new Map();
  for (const edge of [
    ...sourceEdges,
    ...collectSqlFunctionEdges(rootDir),
    ...collectSchemaViewEdges(rootDir, { tables, rpcs }),
    ...collectCronSchedulerEdges(rootDir, { tables, rpcs }),
    ...collectSchemaForeignKeyEdges(rootDir),
  ]) {
    edgesByKey.set(edgeKey(edge), edge);
  }
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
  const featureSourceCallers = new Map();
  const addFeatureSourceCaller = (featureName, caller) => {
    if (!featureSourceCallers.has(featureName)) featureSourceCallers.set(featureName, new Set());
    featureSourceCallers.get(featureName).add(caller);
  };
  for (const edge of edges) {
    const key = `${edge.target_type}\u0000${edge.target_name}`;
    if (!callersByTarget.has(key)) callersByTarget.set(key, new Set());
    callersByTarget.get(key).add(edge.source_name);
    if (edge.source_type === 'feature' && edge.evidence_class === 'declared-external-contract') {
      addFeatureSourceCaller(edge.source_name, 'declared external contract');
    }
    if (edge.source_type === 'feature'
        && edge.source_name.startsWith('scheduler/')
        && edge.evidence_class === 'live-schema') {
      addFeatureSourceCaller(edge.source_name, 'active pg_cron schedule');
    }
  }
  const capabilities = [];
  const addCapabilities = (entityType, names) => {
    for (const entityName of [...names].sort()) {
      const callers = [...(callersByTarget.get(`${entityType}\u0000${entityName}`) || [])];
      if (entityType === 'feature') {
        callers.push(...(featureSourceCallers.get(entityName) || []));
      }
      callers.sort();
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
  addCapabilities('feature', new Set(edges.flatMap((edge) => [
    ...(edge.source_type === 'feature' ? [edge.source_name] : []),
    ...(edge.target_type === 'feature' ? [edge.target_name] : [])
  ])));

  const revision = resolveSourceRevision(rootDir);
  return {
    generated_at: new Date().toISOString(),
    generator: OWNER_MARKER,
    source_commit: revision.source_commit,
    source_branch: revision.source_branch,
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
  const plan = {
    capabilityUpserts: [],
    edgeUpserts: [],
    capabilityRetireIds: [],
    edgeRetireIds: []
  };

  for (const capability of manifest.capabilities) {
    const existing = capabilityByKey.get(capabilityKey(capability));
    const refreshesDerivedFeature = existing?.entity_type === 'feature'
      && capability.entity_type === 'feature'
      && existing.exercised !== null
      && existing.exercised !== undefined;
    if ((existing?.refresh_source === 'manual_seed' || existing?.refresh_source === 'schema_fk')
        && !refreshesDerivedFeature) continue;
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
    if (existing.retirement_status !== 'legacy'
        && !generatedCapabilityKeys.has(capabilityKey(existing))
        && existing.refresh_source === 'ci_generator'
        && String(existing.notes || '').startsWith(OWNER_MARKER)) {
      plan.capabilityRetireIds.push(existing.id);
    }
  }

  for (const edge of manifest.edges) {
    const existing = edgeByKey.get(edgeKey(edge));
    if (existing?.refresh_source === 'manual_seed' || existing?.refresh_source === 'schema_fk') continue;
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
    if (isRefreshOwnedEdge(existing)
        && existing.retirement_status !== 'legacy'
        && !generatedEdgeKeys.has(edgeKey(existing))) {
      plan.edgeRetireIds.push(existing.id);
    }
  }
  return plan;
}

function scopeRefreshPlan(plan, existingCapabilities, existingEdges, entityNames) {
  const names = new Set(entityNames);
  if (!names.size) return plan;
  const scopedCapabilityIds = new Set(existingCapabilities
    .filter(row => names.has(row.entity_name))
    .map(row => row.id));
  const scopedEdgeIds = new Set(existingEdges
    .filter(row => names.has(row.source_name) || names.has(row.target_name))
    .map(row => row.id));
  return {
    capabilityUpserts: plan.capabilityUpserts.filter(row => names.has(row.entity_name)),
    edgeUpserts: plan.edgeUpserts.filter(row => names.has(row.source_name) || names.has(row.target_name)),
    capabilityRetireIds: plan.capabilityRetireIds.filter(id => scopedCapabilityIds.has(id)),
    edgeRetireIds: plan.edgeRetireIds.filter(id => scopedEdgeIds.has(id))
  };
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

async function recordRefreshRun(baseUrl, serviceKey, manifest, plan) {
  const row = {
    source_commit: manifest.source_commit ?? null,
    source_branch: manifest.source_branch ?? null,
    generated_at: manifest.generated_at ?? new Date().toISOString(),
    capability_total: manifest.capabilities.length,
    edge_total: manifest.edges.length,
    capability_upserts: plan.capabilityUpserts.length,
    edge_upserts: plan.edgeUpserts.length,
    retired_total: plan.capabilityRetireIds.length + plan.edgeRetireIds.length,
    refresh_source: 'ci_generator'
  };
  const response = await fetch(`${baseUrl}/rest/v1/bob_atlas_refresh_runs`, {
    method: 'POST',
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify([row])
  });
  if (!response.ok) {
    // Provenance is additive: never fail a truthful map refresh because the
    // ledger migration has not been applied to this environment yet.
    console.warn(`Atlas refresh provenance not recorded (${response.status}); apply the bob_atlas_refresh_runs migration so Bob can see map freshness.`);
    return false;
  }
  return true;
}

async function applyAtlasRefresh(manifest, {
  baseUrl,
  serviceKey,
  allowLargeRetirement = false,
  retireStale = true,
  scopeEntityNames = []
}) {
  if (!baseUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  const [existingCapabilities, existingEdges] = await Promise.all([
    fetchAll(baseUrl, serviceKey, 'bob_capability_map', 'id,entity_type,entity_name,present,wired,exercised,caller_summary,notes,refresh_source,retirement_status'),
    fetchAll(baseUrl, serviceKey, 'bob_app_map_edges', 'id,source_type,source_name,target_type,target_name,edge_kind,evidence_class,source_file,migration_name,caller_context,refresh_source,retirement_status')
  ]);
  const plan = scopeRefreshPlan(
    buildRefreshPlan(manifest, existingCapabilities, existingEdges),
    existingCapabilities,
    existingEdges,
    scopeEntityNames
  );
  const retirementCount = plan.capabilityRetireIds.length + plan.edgeRetireIds.length;
  if (retireStale && retirementCount > MAX_RETIREMENTS && !allowLargeRetirement) {
    throw new Error(`Refusing to retire ${retirementCount} Atlas rows without --allow-large-retirement`);
  }

  await writeBatches(baseUrl, serviceKey, 'bob_capability_map', plan.capabilityUpserts, 'entity_type,entity_name');
  await writeBatches(baseUrl, serviceKey, 'bob_app_map_edges', plan.edgeUpserts, 'source_type,source_name,target_type,target_name,edge_kind,source_file');
  if (retireStale) {
    await retireRows(baseUrl, serviceKey, 'bob_capability_map', plan.capabilityRetireIds);
    await retireRows(baseUrl, serviceKey, 'bob_app_map_edges', plan.edgeRetireIds);
  } else {
    plan.skippedRetirements = retirementCount;
    plan.capabilityRetireIds = [];
    plan.edgeRetireIds = [];
  }
  plan.runRecorded = await recordRefreshRun(baseUrl, serviceKey, manifest, plan);
  return plan;
}

function writeManifest(rootDir, manifest, outputDir = process.env.ATLAS_REFRESH_OUTPUT_DIR || path.join(rootDir, '.bob')) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, 'atlas-refresh-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const scopeArg = [...args].find(arg => arg.startsWith('--scope-entities='));
  const scopeEntityNames = scopeArg
    ? scopeArg.slice('--scope-entities='.length).split(',').map(value => value.trim()).filter(Boolean)
    : [];
  const rootDir = process.cwd();
  const manifest = collectAtlasRefresh(rootDir);
  writeManifest(rootDir, manifest);
  if (!args.has('--apply')) {
    console.log(`Atlas refresh manifest: ${manifest.capabilities.length} capabilities, ${manifest.edges.length} edges (dry run) @ ${manifest.source_commit ?? 'unknown commit'}`);
    return;
  }
  const plan = await applyAtlasRefresh(manifest, {
    baseUrl: process.env.SUPABASE_URL,
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    allowLargeRetirement: args.has('--allow-large-retirement'),
    retireStale: !args.has('--upsert-only'),
    scopeEntityNames
  });
  const skipped = plan.skippedRetirements ? `, ${plan.skippedRetirements} stale rows left unchanged` : '';
  console.log(`Atlas refreshed: ${plan.capabilityUpserts.length} capabilities, ${plan.edgeUpserts.length} edges, ${plan.capabilityRetireIds.length + plan.edgeRetireIds.length} retired${skipped} @ ${manifest.source_commit ?? 'unknown commit'}${plan.runRecorded ? '' : ' (provenance not recorded)'}`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Atlas refresh failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  OWNER_MARKER,
  normalizedFunctionSignature,
  collectComponentEdges,
  collectManagedAtlas,
  collectSqlFunctionEdges,
  collectSchemaViewEdges,
  collectSchemaForeignKeyEdges,
  collectCronSchedulerEdges,
  staleGeneratedEdgeIds,
  collectAtlasRefresh,
  resolveSourceRevision,
  buildRefreshPlan,
  scopeRefreshPlan,
  applyAtlasRefresh
};