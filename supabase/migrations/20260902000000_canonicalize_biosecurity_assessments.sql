update public.biosecurity_assessments
set action_taken=action
where action_taken is null
  and action in('no_action','advisory_notice','notice_of_direction','infringement_notice','mpi_referral');

update public.biosecurity_assessments
set officer_user_id=officer_id
where officer_user_id is null
  and officer_id is not null;
