-- Fix disputes.notice_id NOT NULL, which contradicted the historical
-- data model. notice_id is nullable for imports and internal records; public
-- submissions must still resolve a valid infringement notice number so the
-- edge function derives organization_id rather than accepting tenant-less input.
--
-- Also fixes disputes_notice_id_fkey, which pointed at notices(id) while
-- submit-dispute resolves notice_id from infringement_notices(id) -- a
-- completely different id space. Every dispute where the notice_number DID
-- resolve would have failed the insert with a foreign-key violation.

alter table public.disputes alter column notice_id drop not null;

alter table public.disputes drop constraint if exists disputes_notice_id_fkey;
alter table public.disputes add constraint disputes_notice_id_fkey foreign key (notice_id) references public.infringement_notices(id);

comment on column public.disputes.notice_id is 'Match to infringement_notices via the submitter-entered notice_number. Nullable for internal/import records; public submissions require a resolved notice so organization ownership is derived server-side.';
