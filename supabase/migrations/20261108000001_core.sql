-- Detour: campus errand marketplace — core schema.
-- Money is stored as integer token units (USDC, 6 decimals): $1.00 = 1_000_000.
-- All mutations go through the server (service connection). Browser clients using the
-- anon key get read-only, row-scoped access through the RLS policies at the bottom.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- profiles
create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete cascade,
  is_demo boolean not null default false,
  is_resolver boolean not null default false,
  display_name text not null check (char_length(display_name) between 1 and 60),
  campus text not null default 'purdue' check (campus in ('purdue')),
  -- Only ever written from auth.users (confirmed email + campus domain). Never from user input.
  campus_email text,
  campus_email_verified_at timestamptz,
  home_zone text not null,
  transport text not null check (transport in ('walk','bike','bus','car')),
  capacity text not null check (capacity in ('small','medium','large')),
  min_fee_units bigint not null default 3000000 check (min_fee_units >= 0),
  max_detour_min int not null default 20 check (max_detour_min between 0 and 240),
  default_budget_units bigint not null default 8000000 check (default_budget_units >= 0),
  default_deadline_buffer_min int not null default 60 check (default_deadline_buffer_min between 0 and 1440),
  availability jsonb not null default '[]'::jsonb,
  payout_address text check (payout_address is null or payout_address ~ '^0x[0-9a-fA-F]{40}$'),
  onboarded boolean not null default false,
  created_at timestamptz not null default now(),
  check (not (is_demo and auth_user_id is not null))
);

-- ---------------------------------------------------------------- trips
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.profiles(id) on delete cascade,
  origin_zone text not null,
  store_id text not null,
  return_zone text not null,
  depart_at timestamptz not null,
  return_by timestamptz not null,
  transport text not null check (transport in ('walk','bike','bus','car')),
  capacity text not null check (capacity in ('small','medium','large')),
  notes text check (char_length(notes) <= 280),
  status text not null default 'planned' check (status in ('planned','cancelled','completed')),
  created_at timestamptz not null default now(),
  check (return_by > depart_at)
);
create index trips_store_time on public.trips(store_id, depart_at) where status = 'planned';

-- ---------------------------------------------------------------- tasks (pickup requests)
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  category text not null default 'prepaid_pickup' check (category = 'prepaid_pickup'),
  store_id text not null,
  delivery_zone text not null,
  -- Exact drop-off detail and order reference: shown only to the assigned worker. Never on-chain.
  delivery_detail text check (char_length(delivery_detail) <= 200),
  order_reference text check (char_length(order_reference) <= 80),
  pickup_window_start timestamptz not null,
  pickup_window_end timestamptz not null,
  delivery_deadline timestamptz not null,
  package_size text not null check (package_size in ('small','medium','large')),
  prepaid_confirmed boolean not null check (prepaid_confirmed),
  offered_fee_units bigint not null check (offered_fee_units > 0),
  max_fee_units bigint not null check (max_fee_units >= offered_fee_units),
  instructions text check (char_length(instructions) <= 500),
  raw_text text check (char_length(raw_text) <= 1000),
  status text not null default 'open'
    check (status in ('open','negotiating','agreed','picked_up','handed_off','completed','cancelled','disputed')),
  terms_version int not null default 1,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  check (pickup_window_end > pickup_window_start),
  check (delivery_deadline > pickup_window_start)
);
create index tasks_requester on public.tasks(requester_id);

-- ---------------------------------------------------------------- offers (bounded negotiation)
create table public.offers (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  worker_id uuid not null references public.profiles(id) on delete cascade,
  trip_id uuid not null references public.trips(id) on delete cascade,
  task_terms_version int not null,
  decision text not null check (decision in ('accept','counter','reject')),
  fee_units bigint not null check (fee_units > 0),
  effort_low_min int not null,
  effort_high_min int not null,
  trip_total_min int not null,
  eta_delivery timestamptz,
  score numeric,
  factors jsonb not null default '{}'::jsonb,
  summary text not null,
  agent_source text not null check (agent_source in ('llm','rules')),
  status text not null default 'proposed'
    check (status in ('proposed','selected','declined','expired','superseded')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (worker_id is not null)
);
create index offers_task on public.offers(task_id);

create table public.match_runs (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  candidates jsonb not null,
  recommendation jsonb,
  agent_source text not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- agreements
create table public.agreements (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  offer_id uuid not null references public.offers(id),
  requester_id uuid not null references public.profiles(id),
  worker_id uuid not null references public.profiles(id),
  trip_id uuid not null references public.trips(id),
  current_version int not null default 1,
  status text not null default 'pending' check (status in ('pending','approved','cancelled')),
  created_at timestamptz not null default now(),
  check (requester_id <> worker_id)
);
-- At most one live agreement per task.
create unique index agreements_one_live_per_task on public.agreements(task_id) where status in ('pending','approved');

create table public.agreement_versions (
  agreement_id uuid not null references public.agreements(id) on delete cascade,
  version int not null,
  terms jsonb not null,
  terms_hash text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),
  primary key (agreement_id, version)
);

create table public.agreement_approvals (
  agreement_id uuid not null,
  version int not null,
  profile_id uuid not null references public.profiles(id),
  terms_hash text not null,
  approved_at timestamptz not null default now(),
  primary key (agreement_id, version, profile_id),
  foreign key (agreement_id, version) references public.agreement_versions(agreement_id, version) on delete cascade
);

-- ---------------------------------------------------------------- assignments
create table public.assignments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  agreement_id uuid not null unique references public.agreements(id),
  worker_id uuid not null references public.profiles(id),
  trip_id uuid not null references public.trips(id),
  active boolean not null default true,
  window_start timestamptz not null,
  window_end timestamptz not null,
  created_at timestamptz not null default now()
);
-- MVP: one active task per trip (bundling is roadmap item 1).
create unique index assignments_one_active_per_trip on public.assignments(trip_id) where active;
create unique index assignments_one_active_per_task on public.assignments(task_id) where active;

-- ---------------------------------------------------------------- task timeline
create table public.task_events (
  id bigserial primary key,
  task_id uuid not null references public.tasks(id) on delete cascade,
  actor_id uuid references public.profiles(id),
  type text not null,
  message text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index task_events_task on public.task_events(task_id, id);

-- ---------------------------------------------------------------- payments (separate from task status)
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  agreement_id uuid not null unique references public.agreements(id),
  mode text not null check (mode in ('simulated','arc_testnet')),
  amount_units bigint not null check (amount_units > 0),
  -- Confirmed state only. Changes only on a confirmed escrow event.
  status text not null default 'awaiting_funding'
    check (status in ('awaiting_funding','funded','released','refunded','disputed','cancelled')),
  resolved_by_resolver boolean not null default false,
  -- A submitted-but-unconfirmed action. Not a payment state.
  pending_action text check (pending_action in ('fund','release','refund','dispute','resolve_worker','resolve_requester')),
  pending_tx text,
  pending_since timestamptz,
  escrow_id text not null unique, -- bytes32 hex; derived from payment id, contains no personal data
  chain_id int,
  contract_address text,
  payer_address text,
  worker_address text,
  fund_tx text, release_tx text, refund_tx text,
  refund_reason text check (refund_reason in ('requester_cancel','worker_cancel','deadline','dispute')),
  refund_after timestamptz,
  release_due_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create unique index payments_one_live_per_task on public.payments(task_id) where status not in ('cancelled','refunded');

create table public.payment_events (
  id bigserial primary key,
  payment_id uuid references public.payments(id) on delete cascade,
  source text not null check (source in ('quicknode_stream','simulated_stream','reconcile','app')),
  event_type text not null,
  dedupe_key text not null unique,
  tx_hash text,
  block_number bigint,
  block_hash text,
  log_index int,
  applied boolean not null,
  note text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.stream_deliveries (
  id bigserial primary key,
  nonce text not null unique,
  source text not null,
  signature_ok boolean not null,
  event_count int not null default 0,
  received_at timestamptz not null default now()
);

create table public.chain_cursor (
  id text primary key,
  last_block bigint not null default 0,
  updated_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- handoff codes
create table public.handoff_codes (
  task_id uuid primary key references public.tasks(id) on delete cascade,
  salt text not null,
  code_hash text not null,         -- HMAC-SHA256(server secret, task_id:code). The code itself is never stored.
  attempts int not null default 0,
  locked_until timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- disputes
create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  opened_by uuid not null references public.profiles(id),
  reason text not null check (char_length(reason) between 5 and 1000),
  status text not null default 'open' check (status in ('open','resolved_worker','resolved_requester','timed_out')),
  resolver_label text not null,
  resolution_note text,
  respond_by timestamptz not null,
  opened_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index disputes_one_open_per_task on public.disputes(task_id) where status = 'open';

-- ---------------------------------------------------------------- reviews
create table public.reviews (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.tasks(id) on delete cascade,
  reviewer_id uuid not null references public.profiles(id),
  reviewee_id uuid not null references public.profiles(id),
  reviewee_role text not null check (reviewee_role in ('requester','worker')),
  rating int not null check (rating between 1 and 5),
  comment text check (char_length(comment) <= 500),
  created_at timestamptz not null default now(),
  unique (task_id, reviewer_id),
  check (reviewer_id <> reviewee_id)
);

-- ---------------------------------------------------------------- notifications
create table public.notifications (
  id bigserial primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete cascade,
  title text not null,
  body text not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_profile on public.notifications(profile_id, id desc);

-- ---------------------------------------------------------------- reputation (derived, not stored)
create view public.reputation as
with worker_stats as (
  select a.worker_id as profile_id,
    count(*) filter (where t.status = 'completed') as completed_as_worker,
    count(*) filter (where t.status = 'completed' and (t.data_on_time)) as on_time
  from public.assignments a
  join lateral (
    select tt.status,
      exists (select 1 from public.task_events e where e.task_id = tt.id and e.type = 'handed_off'
              and e.created_at <= tt.delivery_deadline) as data_on_time
    from public.tasks tt where tt.id = a.task_id
  ) t on true
  where a.active
  group by a.worker_id
),
req_stats as (
  select requester_id as profile_id, count(*) filter (where status = 'completed') as completed_as_requester
  from public.tasks group by requester_id
),
cancels as (
  select actor_id as profile_id, count(*) as cancellations_after_acceptance
  from public.task_events where type = 'cancelled_after_acceptance' group by actor_id
),
resp as (
  -- Minutes from verified handoff to the requester authorizing release.
  select t.requester_id as profile_id,
    avg(extract(epoch from (r.created_at - h.created_at)) / 60.0) as avg_confirm_minutes
  from public.tasks t
  join public.task_events h on h.task_id = t.id and h.type = 'handed_off'
  join public.task_events r on r.task_id = t.id and r.type = 'release_authorized'
  group by t.requester_id
),
revs as (
  select r.reviewee_id as profile_id, r.reviewee_role,
    count(*) as review_count, avg(r.rating)::numeric(3,2) as avg_rating
  from public.reviews r
  join public.tasks t on t.id = r.task_id
  where (select count(*) from public.reviews r2 where r2.task_id = r.task_id) >= 2
     or t.completed_at < now() - interval '72 hours'
  group by r.reviewee_id, r.reviewee_role
)
select p.id as profile_id,
  coalesce(w.completed_as_worker, 0)::int as completed_as_worker,
  coalesce(w.on_time, 0)::int as on_time_deliveries,
  coalesce(q.completed_as_requester, 0)::int as completed_as_requester,
  coalesce(c.cancellations_after_acceptance, 0)::int as cancellations_after_acceptance,
  rs.avg_confirm_minutes,
  coalesce(rw.review_count, 0)::int as worker_review_count, rw.avg_rating as worker_avg_rating,
  coalesce(rr.review_count, 0)::int as requester_review_count, rr.avg_rating as requester_avg_rating
from public.profiles p
left join worker_stats w on w.profile_id = p.id
left join req_stats q on q.profile_id = p.id
left join cancels c on c.profile_id = p.id
left join resp rs on rs.profile_id = p.id
left join revs rw on rw.profile_id = p.id and rw.reviewee_role = 'worker'
left join revs rr on rr.profile_id = p.id and rr.reviewee_role = 'requester';

-- ================================================================ access control
-- Helper: the profile id of the signed-in Supabase user.
create or replace function public.current_profile_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.profiles where auth_user_id = auth.uid()
$$;

alter table public.profiles enable row level security;
alter table public.trips enable row level security;
alter table public.tasks enable row level security;
alter table public.offers enable row level security;
alter table public.match_runs enable row level security;
alter table public.agreements enable row level security;
alter table public.agreement_versions enable row level security;
alter table public.agreement_approvals enable row level security;
alter table public.assignments enable row level security;
alter table public.task_events enable row level security;
alter table public.payments enable row level security;
alter table public.payment_events enable row level security;
alter table public.stream_deliveries enable row level security;
alter table public.chain_cursor enable row level security;
alter table public.handoff_codes enable row level security;
alter table public.disputes enable row level security;
alter table public.reviews enable row level security;
alter table public.notifications enable row level security;

-- Read-only, row-scoped policies for the authenticated role. No insert/update/delete
-- policies exist, so browser clients cannot mutate anything directly.
create policy own_profile on public.profiles for select to authenticated using (auth_user_id = auth.uid());
create policy own_trips on public.trips for select to authenticated using (worker_id = public.current_profile_id());
create policy task_parties on public.tasks for select to authenticated using (
  requester_id = public.current_profile_id()
  or exists (select 1 from public.assignments a where a.task_id = tasks.id and a.worker_id = public.current_profile_id())
);
create policy offer_parties on public.offers for select to authenticated using (
  worker_id = public.current_profile_id()
  or exists (select 1 from public.tasks t where t.id = offers.task_id and t.requester_id = public.current_profile_id())
);
create policy agreement_parties on public.agreements for select to authenticated using (
  requester_id = public.current_profile_id() or worker_id = public.current_profile_id());
create policy agreement_version_parties on public.agreement_versions for select to authenticated using (
  exists (select 1 from public.agreements a where a.id = agreement_id
          and public.current_profile_id() in (a.requester_id, a.worker_id)));
create policy approval_parties on public.agreement_approvals for select to authenticated using (
  exists (select 1 from public.agreements a where a.id = agreement_id
          and public.current_profile_id() in (a.requester_id, a.worker_id)));
create policy assignment_parties on public.assignments for select to authenticated using (
  worker_id = public.current_profile_id()
  or exists (select 1 from public.tasks t where t.id = task_id and t.requester_id = public.current_profile_id()));
create policy event_parties on public.task_events for select to authenticated using (
  exists (select 1 from public.tasks t where t.id = task_id and (t.requester_id = public.current_profile_id()
    or exists (select 1 from public.assignments a where a.task_id = t.id and a.worker_id = public.current_profile_id()))));
create policy payment_parties on public.payments for select to authenticated using (
  exists (select 1 from public.agreements a where a.id = agreement_id
          and public.current_profile_id() in (a.requester_id, a.worker_id)));
create policy own_notifications on public.notifications for select to authenticated using (profile_id = public.current_profile_id());
create policy dispute_parties on public.disputes for select to authenticated using (
  exists (select 1 from public.agreements a where a.task_id = disputes.task_id and a.status = 'approved'
          and public.current_profile_id() in (a.requester_id, a.worker_id)));
-- handoff_codes, payment_events, stream_deliveries, chain_cursor, match_runs, reviews: no client policies (server only).

revoke all on all tables in schema public from anon;
revoke insert, update, delete, truncate on all tables in schema public from authenticated;
revoke all on public.reputation from anon;
