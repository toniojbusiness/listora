-- Test mode access (docs/features/test-mode.md, "Who has it"): besides the deployment owner's
-- account, an account the owner grants Test mode to with the operator CLI
-- (`npm run admin -- test-mode-access grant`). Null: no grant. Revoking clears it and turns the
-- account's switch off.
alter table account add column test_mode_granted_at timestamptz;
