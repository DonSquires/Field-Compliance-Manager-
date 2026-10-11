do $$
declare
  v_source public.bob_messages%rowtype;
  v_correction_id uuid;
begin
  select *
    into v_source
    from public.bob_messages
   where role = 'assistant'
     and content ilike '%11739%'
     and created_at = '2026-10-11T10:19:15.878946+13:00'::timestamptz
   order by created_at
   limit 1
   for update;

  if not found then
    return;
  end if;

  select id
    into v_correction_id
    from public.bob_messages
   where conversation_id = v_source.conversation_id
     and metadata ->> 'correction_of_message_id' = v_source.id::text
   limit 1;

  if v_correction_id is null then
    insert into public.bob_messages (
      organization_id,
      conversation_id,
      role,
      content,
      confidence,
      flagged,
      metadata
    )
    values (
      v_source.organization_id,
      v_source.conversation_id,
      'assistant',
      'Correction to the earlier Bob reply: the plate shown in the supplied NZTA source is **JJJ739**, not **11739**. The earlier plate result and its verified/confident presentation were incorrect. The original reply remains visible for audit history; compare this correction with the source image before promoting any identity record.',
      null,
      false,
      jsonb_build_object(
        'outcome', 'correction',
        'correction_kind', 'source_grounded_identifier_correction',
        'correction_of_message_id', v_source.id,
        'expected_value', 'JJJ739',
        'rejected_value', '11739',
        'audit_basis', 'Owner-directed correction after source comparison',
        'corrected_at', clock_timestamp()
      )
    )
    returning id into v_correction_id;
  end if;

  update public.bob_messages
     set flagged = true,
         metadata = metadata || jsonb_build_object(
           'superseded_by_message_id', v_correction_id,
           'superseded_reason', 'Incorrect plate identifier contradicted the supplied NZTA source',
           'superseded_at', clock_timestamp()
         )
   where id = v_source.id;
end
$$;