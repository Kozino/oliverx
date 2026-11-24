-- OLTREVIX BROKERAGE initial schema. Intentionally contains no seed/demo rows.
-- Apply this migration in the Supabase SQL editor or Supabase CLI.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  username text unique,
  phone text,
  country text,
  display_currency text not null default 'USD' check (display_currency in ('USD','QAR','GBP','EUR')),
  role text not null default 'investor' check (role in ('investor','admin')),
  status text not null default 'active' check (status in ('active','suspended')),
  preferences jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portfolios (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null default 'Primary portfolio',
  currency text not null default 'USD' check (currency in ('USD','QAR','GBP','EUR')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.instruments (
  id uuid primary key default gen_random_uuid(),
  symbol text not null unique check (symbol = upper(symbol)),
  name text not null,
  asset_class text not null check (asset_class in ('stocks','government_bonds','commodities')),
  issuer text,
  description text,
  currency text not null default 'USD' check (currency in ('USD','QAR','GBP','EUR')),
  quote_price numeric(24,8),
  quote_change_percent numeric(10,4),
  coupon_rate numeric(10,6),
  maturity_date date,
  indicative_yield numeric(10,6),
  is_active boolean not null default true,
  quote_source text,
  quote_timestamp timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.positions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid not null references public.portfolios(id) on delete cascade,
  instrument_id uuid not null references public.instruments(id),
  quantity numeric(24,8) not null check (quantity > 0),
  average_cost numeric(24,8),
  source text not null default 'broker',
  updated_at timestamptz not null default now(),
  unique (portfolio_id, instrument_id)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  portfolio_id uuid not null references public.portfolios(id),
  instrument_id uuid not null references public.instruments(id),
  side text not null check (side in ('buy','sell')),
  order_type text not null check (order_type in ('market','limit')),
  quantity numeric(24,8) not null check (quantity > 0),
  limit_price numeric(24,8) check (limit_price is null or limit_price > 0),
  status text not null default 'awaiting_broker' check (status in ('awaiting_broker','reviewed','rejected','cancelled','submitted','filled','partially_filled')),
  client_note text,
  external_order_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.account_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  request_type text not null check (request_type in ('funding','withdrawal','transfer')),
  amount numeric(24,8) not null check (amount > 0),
  currency text not null default 'USD' check (currency in ('USD','QAR','GBP','EUR')),
  recipient_label text,
  user_note text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  review_note text,
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  provider_reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Ledger entries are written only by trusted settlement/broker integrations.
-- The application API exposes balance reads but deliberately has no endpoint that posts cash.
create table if not exists public.account_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  amount numeric(24,8) not null check (amount <> 0),
  currency text not null default 'USD' check (currency in ('USD','QAR','GBP','EUR')),
  entry_type text not null check (entry_type in ('deposit','withdrawal','trade_settlement','fee','adjustment','transfer')),
  provider_reference text,
  description text,
  created_at timestamptz not null default now(),
  unique (provider_reference)
);

create table if not exists public.account_activity (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  event_type text not null,
  title text not null,
  description text,
  amount numeric(24,8),
  currency text not null default 'USD' check (currency in ('USD','QAR','GBP','EUR')),
  status text,
  created_at timestamptz not null default now()
);

create table if not exists public.watchlist_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  instrument_id uuid not null references public.instruments(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (user_id, instrument_id)
);

create table if not exists public.price_alerts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  instrument_id uuid not null references public.instruments(id) on delete cascade,
  condition text not null check (condition in ('above','below')),
  threshold numeric(24,8) not null check (threshold > 0),
  is_active boolean not null default true,
  triggered_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null,
  body text not null,
  category text not null default 'account',
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subject text not null,
  message text not null,
  status text not null default 'open' check (status in ('open','in_progress','resolved','closed')),
  admin_reply text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.portfolio_models (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  summary text,
  allocation jsonb not null default '{}'::jsonb,
  risk_label text,
  is_published boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.research_articles (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  summary text,
  body text,
  category text,
  is_published boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id),
  action text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  currency_value text := coalesce(meta->>'display_currency', 'USD');
begin
  if currency_value not in ('USD','QAR','GBP','EUR') then currency_value := 'USD'; end if;
  insert into public.profiles (user_id, email, full_name, username, phone, country, display_currency)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(left(meta->>'full_name', 100), ''),
    nullif(left(meta->>'username', 32), ''),
    nullif(left(meta->>'phone', 40), ''),
    nullif(left(meta->>'country', 80), ''),
    currency_value
  )
  on conflict (user_id) do nothing;
  insert into public.portfolios (user_id, name, currency)
  values (new.id, 'Primary portfolio', currency_value)
  on conflict (user_id, name) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_auth_user();

create or replace function public.is_active_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.user_id = auth.uid() and p.role = 'admin' and p.status = 'active'
  );
$$;

-- Updated timestamps.
create trigger profiles_updated_at before update on public.profiles for each row execute procedure public.set_updated_at();
create trigger portfolios_updated_at before update on public.portfolios for each row execute procedure public.set_updated_at();
create trigger instruments_updated_at before update on public.instruments for each row execute procedure public.set_updated_at();
create trigger orders_updated_at before update on public.orders for each row execute procedure public.set_updated_at();
create trigger account_requests_updated_at before update on public.account_requests for each row execute procedure public.set_updated_at();
create trigger support_tickets_updated_at before update on public.support_tickets for each row execute procedure public.set_updated_at();
create trigger portfolio_models_updated_at before update on public.portfolio_models for each row execute procedure public.set_updated_at();
create trigger research_articles_updated_at before update on public.research_articles for each row execute procedure public.set_updated_at();

-- Indexes for the common owner/status queries.
create index if not exists profiles_role_status_idx on public.profiles(role, status);
create index if not exists portfolios_user_idx on public.portfolios(user_id);
create index if not exists instruments_class_active_idx on public.instruments(asset_class, is_active);
create index if not exists positions_portfolio_idx on public.positions(portfolio_id);
create index if not exists orders_user_created_idx on public.orders(user_id, created_at desc);
create index if not exists requests_user_created_idx on public.account_requests(user_id, created_at desc);
create index if not exists requests_status_created_idx on public.account_requests(status, created_at desc);
create index if not exists ledger_user_created_idx on public.account_ledger(user_id, created_at desc);
create index if not exists activity_user_created_idx on public.account_activity(user_id, created_at desc);
create index if not exists alerts_user_active_idx on public.price_alerts(user_id, is_active);
create index if not exists notifications_user_created_idx on public.notifications(user_id, created_at desc);
create index if not exists tickets_status_created_idx on public.support_tickets(status, created_at desc);
create index if not exists audit_created_idx on public.audit_logs(created_at desc);

-- Row-level security. The Render API uses its server-only service role and also applies
-- explicit user_id filters in every user route. These policies are safe defaults if a
-- client later connects to Supabase directly; do not expose the service role key.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'profiles','portfolios','instruments','positions','orders','account_requests',
    'account_ledger','account_activity','watchlist_entries','price_alerts','notifications',
    'support_tickets','portfolio_models','research_articles','audit_logs'
  ] LOOP
    EXECUTE format('alter table public.%I enable row level security', t);
  END LOOP;
END $$;

-- Profiles: users can read their own profile; role is not editable through client policy.
create policy profiles_select_owner_or_admin on public.profiles for select to authenticated
  using (user_id = auth.uid() or public.is_active_admin());
create policy profiles_update_owner on public.profiles for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid() and role = 'investor');

create policy portfolios_select_owner_or_admin on public.portfolios for select to authenticated
  using (user_id = auth.uid() or public.is_active_admin());
create policy positions_select_owner_or_admin on public.positions for select to authenticated
  using (user_id = auth.uid() or public.is_active_admin());
create policy instruments_select_active_or_admin on public.instruments for select to authenticated
  using (is_active or public.is_active_admin());
create policy orders_select_owner_or_admin on public.orders for select to authenticated
  using (user_id = auth.uid() or public.is_active_admin());
create policy requests_select_owner_or_admin on public.account_requests for select to authenticated
  using (user_id = auth.uid() or public.is_active_admin());
create policy requests_insert_owner_pending on public.account_requests for insert to authenticated
  with check (user_id = auth.uid() and status = 'pending');
create policy ledger_select_owner_or_admin on public.account_ledger for select to authenticated
  using (user_id = auth.uid() or public.is_active_admin());
create policy activity_select_owner_or_admin on public.account_activity for select to authenticated
  using (user_id = auth.uid() or public.is_active_admin());
create policy watchlist_owner_all on public.watchlist_entries for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy alerts_owner_all on public.price_alerts for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy notifications_owner_select on public.notifications for select to authenticated
  using (user_id = auth.uid() or public.is_active_admin());
create policy notifications_owner_update on public.notifications for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy support_owner_select on public.support_tickets for select to authenticated
  using (user_id = auth.uid() or public.is_active_admin());
create policy support_owner_insert on public.support_tickets for insert to authenticated
  with check (user_id = auth.uid());
create policy portfolio_models_read_published on public.portfolio_models for select to authenticated
  using (is_published or public.is_active_admin());
create policy research_read_published on public.research_articles for select to authenticated
  using (is_published or public.is_active_admin());
create policy audit_admin_read on public.audit_logs for select to authenticated
  using (public.is_active_admin());

-- No seed rows are inserted. Add only instruments, research and portfolio models that
-- you have verified and are authorized to publish.
