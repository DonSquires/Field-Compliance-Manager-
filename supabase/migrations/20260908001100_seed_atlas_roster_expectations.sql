-- First authored Atlas intent assertions: protect the governed roster site-induction write path.

insert into public.app_map_expectations (
  spine,
  from_type,
  from_name,
  to_type,
  to_name,
  assertion_kind,
  rationale,
  authored_by,
  status
)
values
  (
    'roster_site_induction',
    'component',
    'pages/RosterHRPage',
    'table',
    'site_induction_requirements',
    'must_reach',
    'Roster HR must retain a live path to site induction requirements.',
    'atlas_seed',
    'active'
  ),
  (
    'roster_site_induction',
    'component',
    'pages/RosterHRPage',
    'table',
    'site_induction_requirements',
    'must_pass_through',
    'Site induction requirement changes must use the governed management RPC.',
    'atlas_seed',
    'active'
  )
on conflict (spine, from_type, from_name, to_type, to_name, assertion_kind)
do update set
  rationale = excluded.rationale,
  authored_by = excluded.authored_by,
  status = excluded.status,
  updated_at = now();

update public.app_map_expectations
set
  via_type = 'rpc',
  via_name = 'manage_site_induction_requirement',
  updated_at = now()
where spine = 'roster_site_induction'
  and from_type = 'component'
  and from_name = 'pages/RosterHRPage'
  and to_type = 'table'
  and to_name = 'site_induction_requirements'
  and assertion_kind = 'must_pass_through';
