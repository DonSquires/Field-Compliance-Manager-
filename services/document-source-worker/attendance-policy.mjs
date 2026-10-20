export function completionPatrolRoutes(policy, providerOrganizationId, performerIds) {
  if (policy?.provider_organization_id !== providerOrganizationId
    || policy.attendance_mode !== 'as_attended' || !Array.isArray(policy.performer_routes)
    || !Array.isArray(performerIds)) {
    throw new Error('A provider-scoped attendance policy and resolved performer identities are required');
  }
  const routes = new Map();
  const performers = new Set(performerIds);
  const mappings = new Map();
  for (const mapping of policy.performer_routes) {
    if (!mapping.performer_id || !mapping.patrol_route_id || !mapping.patrol_route_name
      || mappings.has(mapping.performer_id)) throw new Error('Attendance performer mappings must be unique and complete');
    mappings.set(mapping.performer_id, mapping.patrol_route_id);
    if (!performers.has(mapping.performer_id)) continue;
    routes.set(mapping.patrol_route_id, { id: mapping.patrol_route_id, name: mapping.patrol_route_name,
      attendance_mode: 'as_attended' });
  }
  return [...routes.values()];
}