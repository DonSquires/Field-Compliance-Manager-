-- notifications_category_check: two more producers write categories the constraint rejects.
-- Found by test/notification-categories.test.js (which pins every enqueue_notification category in
-- the snapshot to the constraint) and confirmed against the live catalog on 2026-09-16:
--   manage_biosecurity_assessment_review -> 'biosecurity_review' (Biosecurity Oversight page)
--   submit_bob_document_for_review / review_bob_document_draft -> 'document_review'
-- Until now each of these failed on its notification insert the first time it was used.

ALTER TABLE public.notifications DROP CONSTRAINT IF EXISTS notifications_category_check;
ALTER TABLE public.notifications ADD CONSTRAINT notifications_category_check
  CHECK (category = ANY (ARRAY[
    'credential_expiry'::text, 'sla_breach'::text, 'report_ready'::text,
    'report_reviewed'::text, 'leave_decision'::text, 'timesheet_decision'::text,
    'breach_decision'::text, 'debrief_followup'::text, 'noise_review'::text,
    'biosecurity_review'::text, 'document_review'::text,
    'welfare'::text, 'dispatch'::text, 'roster'::text, 'open_job'::text,
    'video_review'::text, 'system'::text, 'schema_change_request'::text,
    'bob_conversation'::text, 'bob_self_memory'::text
  ]));
