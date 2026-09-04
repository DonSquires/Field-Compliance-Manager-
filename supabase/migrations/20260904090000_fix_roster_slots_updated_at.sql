-- Hotfix: roster_slots has no updated_at column.
-- complete_officer_shift hit this in 20260901018000; the same defect was
-- reintroduced by 20260903220000 in batch_publish_roster_slots,
-- unpublish_roster_slot, and review_shift_swap. PL/pgSQL does not bind column
-- references at CREATE time, so those functions deployed cleanly and would
-- only fail on execution. Add the column so every roster mutation records
-- modification time instead of removing the assignment again.

ALTER TABLE "public"."roster_slots"
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz DEFAULT now() NOT NULL;

DROP TRIGGER IF EXISTS "trg_roster_slots_touch" ON "public"."roster_slots";
CREATE TRIGGER "trg_roster_slots_touch"
  BEFORE UPDATE ON "public"."roster_slots"
  FOR EACH ROW EXECUTE FUNCTION "public"."tg_touch_updated_at"();
