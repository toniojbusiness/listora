-- The seller's profile in Settings (docs/features/profile.md): their own name is the existing
-- `app_user.display_name`, and the business they sell as is the account's. `account.name` stays
-- the internal label (the owner's email at sign-up) that operator reports use; `business_name`
-- is what the seller typed, absent until they do.
alter table account
  add column business_name text check (char_length(business_name) between 1 and 200);
