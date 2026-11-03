-- Brand R & M Security and Investigations report packs and organisation emails.
-- organizations.logo_url is the existing branding source read by the report
-- PDF renderer, report email, and invitation emails. Only fills an empty value.
update public.organizations
set logo_url = 'https://www.fcmanager.co.nz/assets/email/rm-security-brand-20261102.png'
where id = 'e96d71c9-28a6-4d4a-b0f3-1c4ecdaa9c13'
  and (logo_url is null or btrim(logo_url) = '');
