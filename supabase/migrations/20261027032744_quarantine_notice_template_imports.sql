-- Owner-approved correction, 2026-10-27: two unfinished source templates were
-- imported as warnings. Preserve provenance and audit; they were never issued
-- notices and must not imply a real person's identity or an entry restriction.
DO $quarantine$
DECLARE
  v_source record;
  v_notice public.notices%rowtype;
  v_record public.person_records%rowtype;
  v_person public.canonical_people%rowtype;
  v_fk record;
  v_used boolean;
  v_notifications integer;
  v_actor constant uuid := 'f1c00000-0000-4000-8000-000000000001';
  v_provider constant uuid := 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13';
  v_client constant uuid := 'c48c1aaf-236b-417c-bbce-938c151662d6';
  v_code constant text := 'unfinished_notice_template_20261027';
  v_correction jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sweep_notice_expiry_alerts'));
  FOR v_source IN
    SELECT * FROM (VALUES
      ('rm-notice:9bcc6af59d3d7a57e42986c47d1f61ee',
       '0be8293cf1e5df70ece00a8f69ce23f97c1e8fd26f9e0c0685e23b4b74049475', 'Name And Address'),
      ('rm-notice:f34fcba400280ac347fd4b2f57c81b26',
       '42debee90dd07c6a17eb3b06b159ac837c656a351035a46a1eaf38f60478186f', 'Tanuname And Address')
    ) AS source(import_key, source_sha256, subject_name)
  LOOP
    SELECT * INTO v_notice FROM public.notices
    WHERE organization_id = v_client AND import_key = v_source.import_key FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;
    IF v_notice.metadata->'import_quarantine'->>'code' = v_code AND v_notice.status = 'draft' THEN
      CONTINUE;
    END IF;
    IF v_notice.source_sha256 IS DISTINCT FROM v_source.source_sha256
       OR v_notice.status <> 'issued' OR v_notice.notice_type <> 'warning'
       OR v_notice.metadata->>'match_basis' IS DISTINCT FROM 'created_from_notice'
       OR v_notice.metadata->>'subject_name_on_notice' IS DISTINCT FROM v_source.subject_name THEN
      RAISE EXCEPTION 'Template quarantine refused: notice no longer matches approved source';
    END IF;

    SELECT * INTO v_record FROM public.person_records
    WHERE id = (v_notice.metadata->>'created_person_record_id')::uuid AND organization_id = v_provider FOR UPDATE;
    IF NOT FOUND OR v_record.display_name IS DISTINCT FROM v_source.subject_name
       OR v_record.metadata->>'notice_import_key' IS DISTINCT FROM v_source.import_key
       OR v_record.metadata->>'source_sha256' IS DISTINCT FROM v_source.source_sha256
       OR v_record.metadata->>'created_from' IS DISTINCT FROM 'person_notice' THEN
      RAISE EXCEPTION 'Template quarantine refused: source person was changed';
    END IF;
    SELECT * INTO v_person FROM public.canonical_people WHERE id = v_notice.person_id FOR UPDATE;
    IF NOT FOUND OR v_person.display_name IS DISTINCT FROM v_source.subject_name OR v_person.status <> 'active'
       OR (SELECT count(*) FROM public.canonical_person_links WHERE canonical_person_id = v_person.id) <> 1
       OR NOT EXISTS (SELECT 1 FROM public.canonical_person_links WHERE canonical_person_id = v_person.id
         AND source_table = 'person_records' AND source_id = v_record.id AND organization_id = v_provider)
       OR EXISTS (SELECT 1 FROM public.notices WHERE person_id = v_person.id AND id <> v_notice.id)
       OR EXISTS (SELECT 1 FROM public.entity_links WHERE
         (from_type = 'person' AND from_id = v_person.id) OR (to_type = 'person' AND to_id = v_person.id)) THEN
      RAISE EXCEPTION 'Template quarantine refused: person has other uses';
    END IF;

    -- Check other FK-backed consumers before retiring either isolated identity.
    FOR v_fk IN
      SELECT c.conrelid::regclass AS target_table, a.attname AS target_column,
        CASE c.confrelid WHEN 'public.person_records'::regclass THEN v_record.id ELSE v_person.id END AS target_id
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND cardinality(c.conkey) = 1
        AND c.confrelid IN ('public.person_records'::regclass, 'public.canonical_people'::regclass)
        AND c.conrelid NOT IN ('public.notices'::regclass, 'public.canonical_person_links'::regclass)
    LOOP
      EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s WHERE %I = $1)', v_fk.target_table, v_fk.target_column)
        INTO v_used USING v_fk.target_id;
      IF v_used THEN RAISE EXCEPTION 'Template quarantine refused: identity has dependent records'; END IF;
    END LOOP;

    v_correction := jsonb_build_object('code', v_code, 'at', clock_timestamp(), 'actor', v_actor,
      'reason', 'Owner-approved quarantine: unfinished addressee template, not an issued warning or a real person',
      'previous_status', v_notice.status, 'previous_person_status', v_person.status,
      'previous_review_state', v_record.review_state);
    UPDATE public.notices SET status = 'draft',
      metadata = metadata || jsonb_build_object('import_quarantine', v_correction)
    WHERE id = v_notice.id;
    UPDATE public.person_records SET review_state = 'rejected',
      metadata = metadata || jsonb_build_object('import_quarantine', v_correction)
    WHERE id = v_record.id;
    UPDATE public.canonical_people SET status = 'retired', review_state = 'rejected', updated_at = clock_timestamp()
    WHERE id = v_person.id;

    UPDATE public.notifications SET severity = 'info', title = 'Notice import correction - no warning issued',
      body = 'An unfinished source template was imported in error and has been quarantined. No entry restriction applies.',
      link_payload = link_payload || jsonb_build_object('import_quarantine', v_correction)
    WHERE category = 'notice_expiry' AND organization_id IN (v_client, v_provider)
      AND link_payload->>'notice_id' = v_notice.id::text;
    GET DIAGNOSTICS v_notifications = ROW_COUNT;
    INSERT INTO public.audit_log (organization_id, actor_user_id, action, target_table, target_id, metadata)
    VALUES (v_client, v_actor, 'notice_import_quarantined', 'notices', v_notice.id,
      v_correction || jsonb_build_object('import_key', v_source.import_key, 'source_sha256', v_source.source_sha256,
        'person_record_id', v_record.id, 'canonical_person_id', v_person.id, 'corrected_notifications', v_notifications));
  END LOOP;
END;
$quarantine$;