begin;
set local role postgres;
set local search_path to public, extensions, pg_catalog;

create or replace function pg_temp.check(p_label text, p_ok boolean) returns void language plpgsql as $$
begin if not coalesce(p_ok,false) then raise exception 'FAIL [%]',p_label; end if; raise notice 'ok [%]',p_label; end $$;

do $$
declare
  v_org uuid:=gen_random_uuid(); v_location uuid; v_place uuid; v_import uuid:=gen_random_uuid();
  v_evidence uuid:=gen_random_uuid(); v_job uuid:=gen_random_uuid(); v_observation uuid:=gen_random_uuid();
  v_count int; v_failed boolean:=false; v_source_thumbnail text:='data:image/jpeg;base64,YQ==';
begin
  insert into public.organizations(id,name,organization_type) values(v_org,'T_DERIVATIVE_ORG','service_provider');
  insert into public.locations(organization_id,name,address) values(v_org,'T Derivative Place','993 Test Camera Road') returning id,canonical_place_id into v_location,v_place;
  insert into public.cctv_imports(id,organization_id,location_id,canonical_place_id,camera_label,camera_key) values(v_import,v_org,v_location,v_place,'T Camera','t-camera');
  insert into public.evidence_items(id,organization_id,module_key,evidence_kind,storage_path,cctv_import_id,sha256_hash) values(v_evidence,v_org,'cctv_review','video','org/'||v_org||'/cctv/test.mp4',v_import,repeat('a',64));
  insert into public.inference_jobs(id,organization_id,evidence_item_id,domain,status) values(v_job,v_org,v_evidence,'video_motion','processing');
  insert into public.cctv_entity_observations(id,organization_id,inference_job_id,evidence_item_id,source_event_id,entity_kind,observed_at,cctv_import_id,thumbnail,frame_sha256)
    values(v_observation,v_org,v_job,v_evidence,'vehicle-1','vehicle',clock_timestamp(),v_import,v_source_thumbnail,repeat('b',64));

  perform set_config('request.jwt.claims',json_build_object('role','service_role')::text,true); set local role service_role;
  v_count:=public.record_cctv_observation_derivatives(v_job,jsonb_build_array(jsonb_build_object(
    'source_event_id','vehicle-1','entity_kind','vehicle','original_bucket','bob-uploads',
    'original_path','org/'||v_org||'/cctv-derivatives/'||v_evidence||'/vehicle-1/original.jpg','original_sha256',repeat('c',64),
    'enhanced_bucket','bob-uploads','enhanced_path','org/'||v_org||'/cctv-derivatives/'||v_evidence||'/vehicle-1/enhanced.jpg','enhanced_sha256',repeat('d',64),
    'provider','laptop_gpu','source_frame_hash',repeat('b',64),'source_frames',jsonb_build_array(repeat('b',64)),
    'fusion',jsonb_build_object('profile','aligned_temporal_median_v1','frames_aligned',5),
    'enhancement',jsonb_build_object('profile','realesrgan_x4plus_onnx_v1','generative',true,'model','RealESRGAN_x4plus'),
    'recognition',jsonb_build_object('source',jsonb_build_object('alpr',jsonb_build_object('plate','ABC123')),'enhanced',jsonb_build_object('alpr',jsonb_build_object('plate','ABC123'))),
    'recognition_comparison',jsonb_build_object('alpr',jsonb_build_object('agreement',true),'authority','provisional_human_review_required')
  )));
  set local role postgres;

  perform pg_temp.check('one derivative saved',v_count=1 and exists(select 1 from public.cctv_observation_derivatives where observation_id=v_observation and provider='laptop_gpu' and generative));
  perform pg_temp.check('observation carries compact storage receipt',(select attributes#>>'{capture_recognition,enhanced_storage_path}'='org/'||v_org||'/cctv-derivatives/'||v_evidence||'/vehicle-1/enhanced.jpg' and (attributes#>>'{capture_recognition,enhancement,generative}')::boolean from public.cctv_entity_observations where id=v_observation));
  perform pg_temp.check('source evidence remains untouched',(select thumbnail=v_source_thumbnail and frame_sha256=repeat('b',64) from public.cctv_entity_observations where id=v_observation));
  perform pg_temp.check('browser roles cannot execute derivative writer',not has_function_privilege('authenticated','public.record_cctv_observation_derivatives(uuid,jsonb)','EXECUTE'));

  perform set_config('request.jwt.claims',json_build_object('role','service_role')::text,true); set local role service_role;
  begin
    perform public.record_cctv_observation_derivatives(v_job,jsonb_build_array(jsonb_build_object(
      'source_event_id','vehicle-1','entity_kind','vehicle','original_bucket','bob-uploads','original_path','wrong/path.jpg','original_sha256',repeat('c',64),
      'enhanced_bucket','bob-uploads','enhanced_path','wrong/enhanced.jpg','enhanced_sha256',repeat('d',64),'provider','laptop_gpu',
      'enhancement',jsonb_build_object('profile','bad','generative',true))));
  exception when others then v_failed:=true; end;
  set local role postgres;
  perform pg_temp.check('cross-evidence derivative paths rejected',v_failed);
end $$;

rollback;