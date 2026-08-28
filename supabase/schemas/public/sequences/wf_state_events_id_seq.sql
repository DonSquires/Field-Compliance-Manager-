create sequence "public"."wf_state_events_id_seq" as bigint increment by 1 minvalue 1 maxvalue 9223372036854775807 START with 1 cache 1 no cycle;

alter sequence "public"."wf_state_events_id_seq" owned by "public"."wf_state_events"."id";

grant select, update, usage on sequence "public"."wf_state_events_id_seq" to "anon", "authenticated", "postgres", "service_role";
