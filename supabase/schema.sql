create extension if not exists "pgcrypto";

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(10, 2) not null check (amount >= 0),
  category text not null check (category in ('volute', 'dovute', 'necessarie')),
  note text,
  date date not null,
  created_at timestamp with time zone default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'expenses_note_length'
  ) then
    alter table public.expenses
      add constraint expenses_note_length
      check (note is null or char_length(note) <= 180);
  end if;
end;
$$;

create index if not exists expenses_user_date_idx
  on public.expenses (user_id, date);

alter table public.expenses enable row level security;

drop policy if exists "Users can view own expenses" on public.expenses;
drop policy if exists "Users can insert own expenses" on public.expenses;
drop policy if exists "Users can update own expenses" on public.expenses;
drop policy if exists "Users can delete own expenses" on public.expenses;

create policy "Users can view own expenses"
  on public.expenses
  for select
  using (auth.uid() = user_id);

create policy "Users can insert own expenses"
  on public.expenses
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update own expenses"
  on public.expenses
  for update
  using (auth.uid() = user_id);

create policy "Users can delete own expenses"
  on public.expenses
  for delete
  using (auth.uid() = user_id);

create table if not exists public.deadlines (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  note text,
  date date not null,
  last_notified_at timestamp with time zone,
  created_at timestamp with time zone default now()
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'deadlines_note_length'
  ) then
    alter table public.deadlines
      add constraint deadlines_note_length
      check (note is null or char_length(note) <= 180);
  end if;
end;
$$;

create index if not exists deadlines_user_date_idx
  on public.deadlines (user_id, date);

alter table public.deadlines enable row level security;

drop policy if exists "Users can view own deadlines" on public.deadlines;
drop policy if exists "Users can insert own deadlines" on public.deadlines;
drop policy if exists "Users can update own deadlines" on public.deadlines;
drop policy if exists "Users can delete own deadlines" on public.deadlines;

create policy "Users can view own deadlines"
  on public.deadlines
  for select
  using (auth.uid() = user_id);

create policy "Users can insert own deadlines"
  on public.deadlines
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update own deadlines"
  on public.deadlines
  for update
  using (auth.uid() = user_id);

create policy "Users can delete own deadlines"
  on public.deadlines
  for delete
  using (auth.uid() = user_id);

create table if not exists public.audit_logs (
  id bigserial primary key,
  user_id uuid,
  table_name text not null,
  action text not null,
  record_id uuid,
  created_at timestamp with time zone default now(),
  data jsonb
);

create index if not exists audit_logs_user_idx
  on public.audit_logs (user_id, created_at desc);

alter table public.audit_logs enable row level security;

drop policy if exists "Users can view own audit logs" on public.audit_logs;
create policy "Users can view own audit logs"
  on public.audit_logs
  for select
  using (auth.uid() = user_id);

create or replace function public.log_audit()
returns trigger
language plpgsql
as $$
begin
  insert into public.audit_logs (user_id, table_name, action, record_id, data)
  values (
    coalesce(new.user_id, old.user_id),
    tg_table_name,
    tg_op,
    coalesce(new.id, old.id),
    to_jsonb(coalesce(new, old))
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists expenses_audit on public.expenses;
create trigger expenses_audit
  after insert or update or delete on public.expenses
  for each row execute function public.log_audit();

drop trigger if exists deadlines_audit on public.deadlines;
create trigger deadlines_audit
  after insert or update or delete on public.deadlines
  for each row execute function public.log_audit();

create table if not exists public.rate_limits (
  user_id uuid not null,
  action text not null,
  window_start timestamp with time zone not null,
  counter int not null,
  primary key (user_id, action)
);

create or replace function public.check_rate_limit(
  p_user uuid,
  p_action text,
  p_limit int,
  p_window_seconds int
)
returns void
language plpgsql
as $$
declare
  current_window timestamp with time zone := date_trunc('second', now());
  existing record;
begin
  select * into existing
  from public.rate_limits
  where user_id = p_user and action = p_action;

  if existing is null or existing.window_start < (current_window - make_interval(secs => p_window_seconds)) then
    insert into public.rate_limits (user_id, action, window_start, counter)
    values (p_user, p_action, current_window, 1)
    on conflict (user_id, action)
    do update set window_start = excluded.window_start, counter = 1;
    return;
  end if;

  if existing.counter + 1 > p_limit then
    raise exception 'Rate limit exceeded for %', p_action;
  end if;

  update public.rate_limits
  set counter = counter + 1
  where user_id = p_user and action = p_action;
end;
$$;

create or replace function public.enforce_rate_limit()
returns trigger
language plpgsql
as $$
begin
  perform public.check_rate_limit(new.user_id, tg_table_name || '_write', 120, 3600);
  return new;
end;
$$;

drop trigger if exists expenses_rate_limit on public.expenses;
create trigger expenses_rate_limit
  before insert on public.expenses
  for each row execute function public.enforce_rate_limit();

drop trigger if exists deadlines_rate_limit on public.deadlines;
create trigger deadlines_rate_limit
  before insert on public.deadlines
  for each row execute function public.enforce_rate_limit();

create or replace function public.get_month_totals(
  p_user uuid,
  p_start date,
  p_end date
)
returns table (category text, total numeric)
language sql
stable
as $$
  select category, coalesce(sum(amount), 0) as total
  from public.expenses
  where user_id = p_user
    and date >= p_start
    and date <= p_end
  group by category;
$$;

create or replace function public.get_year_month_totals(
  p_user uuid,
  p_year int
)
returns table (month text, total numeric)
language sql
stable
as $$
  select to_char(date, 'YYYY-MM') as month,
         coalesce(sum(amount), 0) as total
  from public.expenses
  where user_id = p_user
    and extract(year from date) = p_year
  group by 1;
$$;
