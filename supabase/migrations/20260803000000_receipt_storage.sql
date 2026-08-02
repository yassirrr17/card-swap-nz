-- Real Supabase Storage for seller-uploaded receipts (Prompt 13 of the
-- original spec). Previously sellers just typed a filename into a text
-- field -- nothing was actually uploaded or stored anywhere.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg', 'image/png', 'application/pdf'])
on conflict (id) do nothing;

create policy "Sellers can upload their own receipts"
  on storage.objects for insert
  with check (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Sellers can view their own receipts"
  on storage.objects for select
  using (
    bucket_id = 'receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Admins can view all receipts"
  on storage.objects for select
  using (
    bucket_id = 'receipts'
    and exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
  );

alter table public.submissions
  add column receipt_storage_path text;

comment on column public.submissions.receipt_storage_path is 'Path to the actual uploaded receipt file in the receipts storage bucket. receipt_filename stays as the display name; this is what''s used to generate a signed URL for viewing.';
