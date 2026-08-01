-- Admin moderation system: audit logging, seller suspension/verification,
-- submission rejection reasons + soft delete, listing suspend/remove,
-- disputes, and an email notification queue with retry support.

create table public.admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  admin_id uuid references public.profiles(id),
  admin_name text not null,
  action_type text not null,
  target_type text not null,
  target_id uuid,
  brand text,
  details jsonb,
  created_at timestamptz not null default now()
);
create index idx_audit_log_admin on public.admin_audit_log(admin_id);
create index idx_audit_log_action on public.admin_audit_log(action_type);
create index idx_audit_log_created on public.admin_audit_log(created_at desc);
create index idx_audit_log_brand on public.admin_audit_log(brand);

alter table public.admin_audit_log enable row level security;
create policy "Admins can read audit log" on public.admin_audit_log for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
create policy "Admins can insert audit log" on public.admin_audit_log for insert
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

alter table public.profiles
  add column suspended boolean not null default false,
  add column suspended_reason text,
  add column suspended_at timestamptz,
  add column verification_status text not null default 'unverified' check (verification_status in ('unverified', 'verified', 'flagged', 'suspended'));

-- Never hard-delete a financial record -- conflicts with the audit/
-- accountability goal elsewhere in this system. "Delete" is soft.
alter table public.submissions
  add column rejection_reason text,
  add column paid_at timestamptz,
  add column deleted_at timestamptz,
  add column deleted_by uuid references public.profiles(id);

alter table public.listings
  add column suspended boolean not null default false,
  add column suspended_reason text,
  add column suspended_at timestamptz,
  add column suspended_by uuid references public.profiles(id),
  add column removed_at timestamptz,
  add column removed_by uuid references public.profiles(id);

create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  public_id text unique not null,
  order_id uuid references public.orders(id),
  buyer_id uuid references public.profiles(id),
  seller_id uuid references public.profiles(id),
  listing_id uuid references public.listings(id),
  buyer_message text not null,
  status text not null default 'open' check (status in ('open', 'investigating', 'resolved', 'refunded', 'closed')),
  admin_notes text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index idx_disputes_status on public.disputes(status);

create table public.dispute_messages (
  id uuid primary key default gen_random_uuid(),
  dispute_id uuid not null references public.disputes(id) on delete cascade,
  sender_type text not null check (sender_type in ('admin', 'buyer', 'seller')),
  sender_name text not null,
  message text not null,
  created_at timestamptz not null default now()
);

alter table public.disputes enable row level security;
alter table public.dispute_messages enable row level security;
create policy "Admins manage disputes" on public.disputes for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
create policy "Buyers and sellers can view their own disputes" on public.disputes for select
  using (buyer_id = auth.uid() or seller_id = auth.uid());
create policy "Admins manage dispute messages" on public.dispute_messages for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'))
  with check (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create table public.email_queue (
  id uuid primary key default gen_random_uuid(),
  to_email text not null,
  subject text not null,
  body_html text not null,
  event_type text not null,
  related_id uuid,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed')),
  attempts integer not null default 0,
  last_error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index idx_email_queue_status on public.email_queue(status);

alter table public.email_queue enable row level security;
create policy "Admins can read email queue" on public.email_queue for select
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));
