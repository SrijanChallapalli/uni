-- Autopilot: users give their agent instructions; agents negotiate with each other and act
-- inside limits the user set. Every commitment still traces back to an explicit instruction.

-- Worker standing instruction for one trip: "accept jobs that meet my minimum fee and detour limits".
alter table public.trips add column auto_accept boolean not null default false;

-- Requester's explicit "hire them and fund escrow" authorization, capped at an exact amount.
-- Auto-funding happens only if the agreed fee is <= this amount.
alter table public.tasks add column fund_authorized_units bigint check (fund_authorized_units is null or fund_authorized_units > 0);

-- Agent-to-agent negotiation transcript for each offer (rounds of offer / counter / accept).
alter table public.offers add column transcript jsonb not null default '[]'::jsonb;

-- Whether an approval was clicked by the person or applied by their agent under a standing instruction.
alter table public.agreement_approvals add column via text not null default 'user' check (via in ('user','mandate'));

-- One conversation per person with their own agent.
create table public.agent_messages (
  id bigserial primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  task_id uuid references public.tasks(id) on delete set null,
  role text not null check (role in ('user','agent')),
  body text not null check (char_length(body) <= 2000),
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index agent_messages_profile on public.agent_messages(profile_id, id desc);
alter table public.agent_messages enable row level security;
create policy own_agent_messages on public.agent_messages for select to authenticated using (profile_id = public.current_profile_id());
revoke all on public.agent_messages from anon;
revoke insert, update, delete, truncate on public.agent_messages from authenticated;
