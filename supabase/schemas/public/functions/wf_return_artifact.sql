create or replace function public.wf_return_artifact (
  _job_id      uuid,
  _run_id      uuid,
  _kind        public.wf_artifact_kind,
  _bucket_id   text,
  _object_path text,
  _sha256      text                    default null::text,
  _size_bytes  bigint                  default null::bigint
)
  returns public.wf_artifacts
  language plpgsql
  security definer
  set search_path to 'public'
  AS $function$
declare
  _uid uuid := (select auth.uid());
  _artifact public.wf_artifacts%rowtype;
begin
  if _uid is null then
    raise exception 'Not authenticated';
  end if;

  insert into public.wf_artifacts (
    job_id, run_id, kind, bucket_id, object_path, sha256, size_bytes, created_by
  )
  values (
    _job_id, _run_id, _kind, _bucket_id, _object_path, _sha256, _size_bytes, _uid
  )
  returning * into _artifact;

  return _artifact;
end;
$function$;

grant execute on function "public"."wf_return_artifact"(uuid, uuid, public.wf_artifact_kind, text, text, text, bigint) to "anon", "authenticated", "postgres", "service_role";

revoke all on function "public"."wf_return_artifact"(uuid, uuid, public.wf_artifact_kind, text, text, text, bigint) from public;
