# Browser automation (decision D1)

How Listora acts on marketplaces without an API (Poshmark, Mercari, and Depop until its partner
API is granted). The assisted adapters that run until the browser runner lands are in
[marketplaces.md](marketplaces.md#adapter-model).

**Decision D1, revised 2026-10-24.** D1 (the Poshmark and Mercari posture) was "assisted
only". The marketplaces granted the product owner permission to automate where no API exists,
Listora is for the product owner's personal use, and everything runs in the cloud. So
Poshmark, Mercari, and Depop (until its partner API is granted) use cloud browser automation:
the headless-Chromium browser runner (`browserRunner` in `infra/src/config.ts`) acts on
sessions the user logs into from the iPhone app.

- Session cookies are stored encrypted with the token key, by the same KMS envelope
  encryption as OAuth tokens. Passwords never are.
- Actions are human-paced.
- The runner never solves or bypasses a CAPTCHA or bot check: it pauses and falls back to an
  assisted task.
- Every action is still confirmed by read-back ([operations.md](operations.md)), never reported
  as a false success.

The runner, its adapter mode, and session storage are later tasks; until they land, these
marketplaces run assisted. [costs.md](costs.md#browser-automation) sizes and prices the runner.
Assisted adapters implement `execute` by creating a `user_task` (deep link plus copy-assist
payload) and returning `pendingUser`. An assisted operation can finish only through a user
confirmation event. A listing the user posted themselves is linked to its item by sharing it to
the Listora Share Extension (`importListings: 'share_sheet'`), which records it as confirmed by
the user, never by the marketplace.
