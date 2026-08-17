-- One-off cleanup: encrypt the handful of card_number/pin values that
-- predate 20260803020000_encrypt_card_data_at_rest.sql. That migration's
-- BEFORE INSERT triggers only cover NEW rows going forward -- these were
-- already sitting in the table when it ran, and were never retroactively
-- migrated.
--
-- Scope (verified by hand before writing this, not guessed):
--   submissions: 5 rows, created 2026-08-01/02, all with both card_number
--     and pin set.
--   card_vault: 4 rows, same window, same shape, all is_redeemed = false.
--
-- One submission (rejected, no card_vault row, no listing, no
-- receipt_checks row -- genuinely never went anywhere) gets deleted
-- outright rather than encrypted. card_number/pin are NOT NULL columns,
-- so nulling them out isn't an option; with zero downstream references
-- anywhere, a hard delete is safe and is what was actually asked for.
--
-- Every other affected row DOES have a downstream card_vault and/or
-- listing row, even the other two rejected submissions, so "never
-- listed" only actually holds for the one row below -- those get
-- encrypted, not deleted.
--
-- Targets exact row IDs, not a pattern match, and guards each UPDATE
-- with length(...) < 40 (real plaintext values are always well under
-- that; pgp ciphertext is 90+ chars) so accidentally re-running this
-- migration is a no-op, not a double-encryption. Wrapped in one
-- transaction: if anything here fails, nothing here changes.

begin;

-- The one clean case: rejected, never vaulted, never listed, no
-- receipt_checks row. Verified zero downstream references before
-- writing this.
delete from public.submissions
where id = '2a3f089d-0fd1-46bd-967f-79dabc5985d6';

-- The remaining 4 legacy submissions (2 approved, 2 rejected-but-vaulted)
-- get encrypted with the exact same function the live trigger uses.
update public.submissions
set card_number = encode(pgp_sym_encrypt(card_number, public.get_card_encryption_key()), 'base64'),
    pin = encode(pgp_sym_encrypt(pin, public.get_card_encryption_key()), 'base64')
where id in (
  'fcf350bc-eeb9-40c2-9709-3ac322ec3ed8',
  '980d3ec9-20ee-4463-9c6c-e19fd1188a76',
  '287f9f3b-bfbb-4bc0-b3e7-94f1392d793b',
  'bd67480f-e9cc-43da-9906-d014bd088a30'
)
  and card_number is not null
  and length(card_number) < 40;

-- All 4 legacy card_vault rows get encrypted -- none qualify for
-- deletion, since being in card_vault at all means the card went
-- through vaulting regardless of the linked submission's final status.
update public.card_vault
set card_number = encode(pgp_sym_encrypt(card_number, public.get_card_encryption_key()), 'base64'),
    pin = encode(pgp_sym_encrypt(pin, public.get_card_encryption_key()), 'base64')
where id in (
  '56bb72f8-cb71-4f9a-b55d-e7d6e7316ff3',
  '38197c1f-7ec2-4e23-a4f9-56517567c28b',
  'c86c412d-25a5-4583-9ad0-d151ecc99b21',
  '001a8514-f2f9-4e9a-9930-f7c5a5cf5d08'
)
  and card_number is not null
  and length(card_number) < 40;

commit;
