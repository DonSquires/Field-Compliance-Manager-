alter table public.smoke_assessments
  add column if not exists smoke_ai_analysis jsonb,
  add column if not exists smoke_ai_analyzed_at timestamptz;

create or replace function public.finalize_smoke_photo_inference(p_assessment_id uuid,p_actor_user_id uuid,p_analysis jsonb,p_summary text,p_confidence real,p_recommendation text)
returns public.smoke_assessments language plpgsql security definer set search_path=public as $$
declare v_assessment public.smoke_assessments%rowtype;v_actor public.user_profiles%rowtype;
begin
  if auth.role() <> 'service_role' then raise exception 'Service identity required';end if;
  select * into v_actor from public.user_profiles where id=p_actor_user_id and deactivated_at is null;
  if not found or v_actor.role not in('grand_master','master','admin','admin_officer','officer') then raise exception 'Authorized actor required';end if;
  select * into v_assessment from public.smoke_assessments where id=p_assessment_id for update;
  if not found or v_assessment.organization_id is distinct from v_actor.organization_id then raise exception 'Assessment not found';end if;
  if v_actor.role='officer' and v_assessment.officer_user_id is distinct from p_actor_user_id then raise exception 'Officer does not own assessment';end if;
  if v_assessment.status<>'open' then raise exception 'Only open Smoke assessments can be classified';end if;
  if jsonb_typeof(p_analysis) is distinct from 'object' or coalesce((p_analysis->>'schema_version')::integer,0)<>1 or coalesce((p_analysis->>'images_analyzed')::integer,0) not between 1 and 3 or jsonb_typeof(p_analysis->'confidence_by_field') is distinct from 'object' or nullif(p_analysis->>'legal_use_boundary','') is null then raise exception 'Invalid Smoke inference analysis';end if;
  if p_confidence is null or p_confidence<0 or p_confidence>1 then raise exception 'Invalid inference confidence';end if;
  if v_assessment.smoke_ai_analysis is not null then return v_assessment;end if;
  update public.smoke_assessments set bob_classification=nullif(btrim(p_summary),''),bob_confidence=p_confidence,bob_recommendation=nullif(btrim(p_recommendation),''),smoke_ai_analysis=p_analysis,smoke_ai_analyzed_at=clock_timestamp() where id=v_assessment.id returning * into v_assessment;
  insert into public.audit_log(organization_id,actor_user_id,action,target_table,target_id,metadata) values(v_assessment.organization_id,p_actor_user_id,'smoke.photo_classified','smoke_assessments',v_assessment.id,jsonb_build_object('model',p_analysis->>'model','confidence',p_confidence,'manual_review_required',coalesce((p_analysis->>'manual_review_required')::boolean,true),'images_analyzed',(p_analysis->>'images_analyzed')::integer));
  return v_assessment;
end;$$;

revoke all on function public.finalize_smoke_photo_inference(uuid,uuid,jsonb,text,real,text) from public,anon,authenticated;
grant execute on function public.finalize_smoke_photo_inference(uuid,uuid,jsonb,text,real,text) to service_role;
comment on function public.finalize_smoke_photo_inference(uuid,uuid,jsonb,text,real,text) is 'Atomically stores advisory visible-image Smoke analysis and audit. Service identity only; never determines legal breach or action.';