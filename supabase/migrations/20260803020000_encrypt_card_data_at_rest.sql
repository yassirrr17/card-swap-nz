-- Encrypts card_number/pin at rest in both submissions and card_vault.
-- Previously stored as plain text -- fine for testing, a real risk once
-- genuine gift cards flow through.
--
-- Architecture: the encryption key lives in Supabase Vault, never in a
-- table, never sent to any client. BEFORE INSERT triggers on both tables
-- transparently encrypt card_number/pin on the way in -- no changes
-- needed to the actual submission flow, sellers still just submit plain
-- text through the form. Reading the real value back requires calling
-- decrypt_card_value(), which only two things are allowed to do:
-- an admin's own authenticated session (checked via is_admin()), or
-- server-side code running with the service role key (which has no real
-- auth.uid(), used to tell it apart from an ordinary seller/buyer).
--
-- IMPORTANT: run `select vault.create_secret('<random-key>',
-- 'card_encryption_key', '...')` once, manually, before this migration --
-- the key itself is deliberately not committed to the repo. Generate one
-- with e.g. `python3 -c "import secrets; print(secrets.token_urlsafe(32))"`.
--
-- Note: only NEW rows get encrypted going forward. Pre-existing rows
-- (test data from development) are not retroactively migrated.

create or replace function public.get_card_encryption_key()
returns text as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'card_encryption_key';
$$ language sql security definer set search_path = public, vault;

revoke all on function public.get_card_encryption_key() from public, anon, authenticated;

create or replace function public.encrypt_submission_card_data()
returns trigger as $$
begin
  if new.card_number is not null then
    new.card_number := encode(pgp_sym_encrypt(new.card_number, public.get_card_encryption_key()), 'base64');
  end if;
  if new.pin is not null then
    new.pin := encode(pgp_sym_encrypt(new.pin, public.get_card_encryption_key()), 'base64');
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists trg_encrypt_submission_card_data on public.submissions;
create trigger trg_encrypt_submission_card_data
  before insert on public.submissions
  for each row
  execute function public.encrypt_submission_card_data();

create or replace function public.encrypt_vault_card_data()
returns trigger as $$
begin
  if new.card_number is not null then
    new.card_number := encode(pgp_sym_encrypt(new.card_number, public.get_card_encryption_key()), 'base64');
  end if;
  if new.pin is not null then
    new.pin := encode(pgp_sym_encrypt(new.pin, public.get_card_encryption_key()), 'base64');
  end if;
  return new;
end;
$$ language plpgsql security definer set search_path = public, extensions;

drop trigger if exists trg_encrypt_vault_card_data on public.card_vault;
create trigger trg_encrypt_vault_card_data
  before insert on public.card_vault
  for each row
  execute function public.encrypt_vault_card_data();

create or replace function public.decrypt_card_value(ciphertext_base64 text)
returns text as $$
begin
  if ciphertext_base64 is null then
    return null;
  end if;

  if not (is_admin() or auth.uid() is null) then
    raise exception 'Not authorized to decrypt card data';
  end if;

  return pgp_sym_decrypt(decode(ciphertext_base64, 'base64'), public.get_card_encryption_key());
end;
$$ language plpgsql security definer set search_path = public, extensions;

revoke all on function public.decrypt_card_value(text) from public;
grant execute on function public.decrypt_card_value(text) to authenticated, service_role;
