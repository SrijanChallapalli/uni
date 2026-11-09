-- Fix: policies on tasks <-> assignments referenced each other (42P17 infinite recursion).
-- Party checks now go through SECURITY DEFINER helpers that read the base tables without RLS.

create or replace function public.is_task_requester(tid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from tasks where id = tid and requester_id = public.current_profile_id())
$$;

create or replace function public.is_task_worker(tid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from assignments where task_id = tid and worker_id = public.current_profile_id())
$$;

revoke all on function public.is_task_requester(uuid), public.is_task_worker(uuid), public.current_profile_id() from anon;

drop policy task_parties on public.tasks;
create policy task_parties on public.tasks for select to authenticated
  using (requester_id = public.current_profile_id() or public.is_task_worker(id));

drop policy offer_parties on public.offers;
create policy offer_parties on public.offers for select to authenticated
  using (worker_id = public.current_profile_id() or public.is_task_requester(task_id));

drop policy assignment_parties on public.assignments;
create policy assignment_parties on public.assignments for select to authenticated
  using (worker_id = public.current_profile_id() or public.is_task_requester(task_id));

drop policy event_parties on public.task_events;
create policy event_parties on public.task_events for select to authenticated
  using (public.is_task_requester(task_id) or public.is_task_worker(task_id));
