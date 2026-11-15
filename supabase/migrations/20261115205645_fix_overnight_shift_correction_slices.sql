CREATE OR REPLACE FUNCTION ops.shift_payable_period_slice(
  p_start timestamptz,p_end timestamptz,p_unpaid integer,p_period_start date,p_period_end date)
RETURNS TABLE(window_start timestamptz,window_end timestamptz,calculated_minutes integer,deduction integer)
LANGUAGE sql IMMUTABLE SET search_path TO 'pg_catalog'
AS $function$
  WITH bounds AS (
    SELECT greatest(p_start,p_period_start::timestamp AT TIME ZONE 'Pacific/Auckland') AS lo,
      least(p_end,(p_period_end+1)::timestamp AT TIME ZONE 'Pacific/Auckland') AS hi,
      floor(extract(epoch FROM(p_end-p_start))/60)::integer AS total
  ), progress AS (
    SELECT *,floor(extract(epoch FROM(lo-p_start))/60)::integer AS first_minute,
      floor(extract(epoch FROM(hi-p_start))/60)::integer AS last_minute
    FROM bounds WHERE hi>lo
  ), allocated AS (
    SELECT *,CASE WHEN total=0 THEN 0 ELSE round(p_unpaid*last_minute::numeric/total)::integer
      -round(p_unpaid*first_minute::numeric/total)::integer END AS unpaid
    FROM progress
  )
  SELECT lo,hi,last_minute-first_minute-unpaid,unpaid FROM allocated;
$function$;
COMMENT ON FUNCTION ops.shift_payable_period_slice(timestamptz,timestamptz,integer,date,date) IS
  'NZ-period share of a whole corrected shift. Cumulative gross and unpaid minutes conserve totals across adjacent periods.';
REVOKE ALL ON FUNCTION ops.shift_payable_period_slice(timestamptz,timestamptz,integer,date,date)
  FROM PUBLIC,anon,authenticated,service_role;

DO $repair$
DECLARE
  v_patch record;
  v_definition text;
BEGIN
  FOR v_patch IN SELECT * FROM (VALUES
    ('public.correct_timesheet_shift_hours(uuid,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz,integer,text)',
$old$  v_previous_summaries jsonb := '[]'::jsonb;$old$,
$new$  v_previous_summaries jsonb := '[]'::jsonb;
  v_slice record;$new$),
    ('public.correct_timesheet_shift_hours(uuid,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz,integer,text)',
$old$    IF p_payable_start<(v_sheet.period_start::timestamp AT TIME ZONE 'Pacific/Auckland')
      OR p_payable_end>((v_sheet.period_end+1)::timestamp AT TIME ZONE 'Pacific/Auckland') THEN
      RAISE EXCEPTION 'Payable dates must remain inside the submitted timesheet period';
    END IF;$old$,
$new$    IF v_sheet.work_summary->>'evidence_kind'='manual_admin' THEN
      IF p_payable_start<(v_sheet.period_start::timestamp AT TIME ZONE 'Pacific/Auckland')
        OR p_payable_end>((v_sheet.period_end+1)::timestamp AT TIME ZONE 'Pacific/Auckland') THEN
        RAISE EXCEPTION 'Manual payable dates must remain inside the submitted timesheet period';
      END IF;
    ELSE
      SELECT * INTO v_slice FROM ops.shift_payable_period_slice(
        p_payable_start,p_payable_end,p_unpaid_minutes,v_sheet.period_start,v_sheet.period_end);
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Corrected shift does not overlap a linked timesheet period; reconcile the source period first';
      END IF;
    END IF;$new$),
    ('public.correct_timesheet_shift_hours(uuid,uuid,timestamptz,timestamptz,uuid,timestamptz,timestamptz,integer,text)',
$old$    UPDATE public.timesheet_work_entries SET started_at=p_payable_start,ended_at=p_payable_end,
      calculated_minutes=floor(extract(epoch FROM(p_payable_end-p_payable_start))/60)::integer-p_unpaid_minutes,
      metadata=metadata||jsonb_build_object('manual_correction',true,'correction_reason',btrim(p_reason),
        'unpaid_break_minutes',p_unpaid_minutes,'hours_review_status','review')$old$,
$new$    UPDATE public.timesheet_work_entries SET started_at=v_slice.window_start,ended_at=v_slice.window_end,
      calculated_minutes=v_slice.calculated_minutes,
      metadata=metadata||jsonb_build_object('manual_correction',true,'correction_reason',btrim(p_reason),
        'unpaid_break_minutes',v_slice.deduction,'hours_review_status','review')$new$),
    ('public.get_officer_timesheet_work(date,date)',
$old$      greatest(0,floor(extract(epoch FROM(window_end-window_start)))::integer/60-deduction),$old$,
$new$      slice.calculated_minutes,$new$),
    ('public.get_officer_timesheet_work(date,date)',
$old$    CROSS JOIN LATERAL (SELECT greatest(c.payable_start,p_period_start::timestamptz) AS window_start,
      least(c.payable_end,(p_period_end+1)::timestamptz) AS window_end) bounds
    CROSS JOIN LATERAL (SELECT (round(c.unpaid_minutes*greatest(0,extract(epoch FROM(window_end-c.payable_start)))
      /extract(epoch FROM(c.payable_end-c.payable_start)))-round(c.unpaid_minutes*greatest(0,
        extract(epoch FROM(window_start-c.payable_start)))/extract(epoch FROM(c.payable_end-c.payable_start))))::integer AS deduction) breaks$old$,
$new$    CROSS JOIN LATERAL ops.shift_payable_period_slice(
      c.payable_start,c.payable_end,c.unpaid_minutes,p_period_start,p_period_end) slice$new$)
  ) patches(signature,before_text,after_text)
  LOOP
    v_definition:=replace(pg_get_functiondef(v_patch.signature::regprocedure),E'\r\n',E'\n');
    v_patch.before_text:=replace(v_patch.before_text,E'\r\n',E'\n');
    v_patch.after_text:=replace(v_patch.after_text,E'\r\n',E'\n');
    IF strpos(v_definition,v_patch.after_text)>0 THEN CONTINUE; END IF;
    IF strpos(v_definition,v_patch.before_text)=0 THEN
      RAISE EXCEPTION 'Unexpected function definition for %; period-slice repair not applied',v_patch.signature;
    END IF;
    EXECUTE replace(v_definition,v_patch.before_text,v_patch.after_text);
  END LOOP;
END;
$repair$;