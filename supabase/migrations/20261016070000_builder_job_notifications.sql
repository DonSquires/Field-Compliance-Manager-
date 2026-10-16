ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_category_check;

ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_category_check
  CHECK (category = ANY (ARRAY[
    'credential_expiry'::text,
    'sla_breach'::text,
    'report_ready'::text,
    'report_reviewed'::text,
    'leave_decision'::text,
    'timesheet_decision'::text,
    'breach_decision'::text,
    'debrief_followup'::text,
    'noise_review'::text,
    'biosecurity_review'::text,
    'document_review'::text,
    'welfare'::text,
    'dispatch'::text,
    'roster'::text,
    'open_job'::text,
    'video_review'::text,
    'system'::text,
    'schema_change_request'::text,
    'bob_conversation'::text,
    'bob_self_memory'::text,
    'crm_client'::text,
    'builder_job'::text
  ]));

CREATE OR REPLACE FUNCTION public.notify_builder_job_terminal()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_recipient uuid;
  v_outcome text;
  v_severity text;
BEGIN
  IF NEW.status NOT IN ('deployed', 'failed', 'cancelled')
     AND COALESCE(NEW.autopilot_state, '') NOT IN ('done', 'blocked', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF OLD.status IN ('deployed', 'failed', 'cancelled')
     OR COALESCE(OLD.autopilot_state, '') IN ('done', 'blocked', 'cancelled') THEN
    RETURN NEW;
  END IF;

  v_recipient := COALESCE(NEW.autopilot_requested_by, NEW.created_by);
  IF v_recipient IS NULL THEN
    RETURN NEW;
  END IF;

  v_outcome := CASE
    WHEN NEW.status IN ('deployed', 'failed', 'cancelled') THEN NEW.status
    ELSE COALESCE(NULLIF(NEW.autopilot_state, ''), NEW.status)
  END;
  v_severity := CASE
    WHEN NEW.status = 'failed' OR NEW.autopilot_state = 'blocked' THEN 'warning'
    ELSE 'info'
  END;

  PERFORM public.enqueue_notification(
    p_organization_id => NEW.organization_id,
    p_category => 'builder_job',
    p_title => 'Bob Builder job finished: ' || left(NEW.title, 140),
    p_body => 'Outcome: ' || v_outcome || '. Open Builder to review the job receipt.',
    p_severity => v_severity,
    p_recipient_user_id => v_recipient,
    p_recipient_role => NULL,
    p_link_page => 'builder',
    p_link_payload => jsonb_build_object('job_id', NEW.id, 'status', NEW.status, 'autopilot_state', NEW.autopilot_state),
    p_dedup_key => 'builder_job_terminal:' || NEW.id::text || ':' || v_outcome
  );

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.notify_builder_job_terminal() FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS builder_job_terminal_notification ON public.builder_jobs;
CREATE TRIGGER builder_job_terminal_notification
AFTER UPDATE ON public.builder_jobs
FOR EACH ROW
EXECUTE FUNCTION public.notify_builder_job_terminal();

CREATE OR REPLACE FUNCTION public.sweep_slow_builder_job_notifications(
  p_now timestamptz DEFAULT clock_timestamp(),
  p_after_minutes integer DEFAULT 45
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  r record;
  v_notified integer := 0;
  v_dedup_key text;
BEGIN
  IF session_user NOT IN ('postgres', 'supabase_admin')
     AND COALESCE(current_setting('request.jwt.claim.role', true), '') <> 'service_role' THEN
    RAISE EXCEPTION 'Service identity required';
  END IF;
  IF p_after_minutes < 1 OR p_after_minutes > 1440 THEN
    RAISE EXCEPTION 'p_after_minutes must be between 1 and 1440';
  END IF;

  FOR r IN
    SELECT
      j.id,
      j.organization_id,
      j.title,
      j.status,
      j.current_step_name,
      COALESCE(j.autopilot_requested_by, j.created_by) AS recipient_user_id,
      GREATEST(
        j.updated_at,
        COALESCE(steps.last_updated_at, j.updated_at),
        COALESCE(models.last_updated_at, j.updated_at),
        COALESCE(workers.last_updated_at, j.updated_at)
      ) AS last_progress_at
    FROM public.builder_jobs j
    LEFT JOIN LATERAL (
      SELECT max(s.updated_at) AS last_updated_at
      FROM public.builder_job_steps s
      WHERE s.job_id = j.id
    ) steps ON true
    LEFT JOIN LATERAL (
      SELECT max(m.updated_at) AS last_updated_at
      FROM public.builder_model_runs m
      WHERE m.job_id = j.id
    ) models ON true
    LEFT JOIN LATERAL (
      SELECT max(w.updated_at) AS last_updated_at
      FROM public.builder_worker_runs w
      WHERE w.job_id = j.id
    ) workers ON true
    WHERE j.status IN (
      'intake', 'analysis_pending', 'specification_ready', 'design_pending',
      'implementation_pending', 'building', 'testing', 'security_review'
    )
      AND COALESCE(j.autopilot_state, '') NOT IN ('awaiting_human', 'done', 'blocked', 'cancelled')
      AND COALESCE(j.autopilot_requested_by, j.created_by) IS NOT NULL
  LOOP
    IF r.last_progress_at > p_now - make_interval(mins => p_after_minutes) THEN
      CONTINUE;
    END IF;

    v_dedup_key := 'builder_job_slow:' || r.id::text;
    IF EXISTS (
      SELECT 1
      FROM public.notifications n
      WHERE n.organization_id = r.organization_id
        AND n.dedup_key = v_dedup_key
    ) THEN
      CONTINUE;
    END IF;

    PERFORM public.enqueue_notification(
      p_organization_id => r.organization_id,
      p_category => 'builder_job',
      p_title => 'Bob Builder job taking longer than expected',
      p_body => left(r.title, 140) || ' has had no recorded progress for at least '
        || p_after_minutes::text || ' minutes'
        || COALESCE(' (stage: ' || NULLIF(r.current_step_name, '') || ')', '')
        || '. This is a warning only; the job has not been cancelled.',
      p_severity => 'warning',
      p_recipient_user_id => r.recipient_user_id,
      p_recipient_role => NULL,
      p_link_page => 'builder',
      p_link_payload => jsonb_build_object(
        'job_id', r.id,
        'status', r.status,
        'current_step_name', r.current_step_name,
        'last_progress_at', r.last_progress_at
      ),
      p_dedup_key => v_dedup_key
    );
    v_notified := v_notified + 1;
  END LOOP;

  RETURN v_notified;
END;
$function$;

REVOKE ALL ON FUNCTION public.sweep_slow_builder_job_notifications(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_slow_builder_job_notifications(timestamptz, integer) TO postgres, service_role;

DO $schedule$
DECLARE
  v_job_id bigint;
BEGIN
  IF to_regnamespace('cron') IS NULL THEN
    RAISE EXCEPTION 'pg_cron is required to schedule Builder job alerts';
  END IF;

  SELECT jobid INTO v_job_id
  FROM cron.job
  WHERE jobname = 'builder-slow-job-notifications-every-5m'
  LIMIT 1;
  IF v_job_id IS NOT NULL THEN
    PERFORM cron.unschedule(v_job_id);
  END IF;

  PERFORM cron.schedule_in_database(
    'builder-slow-job-notifications-every-5m',
    '*/5 * * * *',
    'select public.sweep_slow_builder_job_notifications();',
    'postgres',
    NULL,
    TRUE
  );
END;
$schedule$;
