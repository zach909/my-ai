# Hosted mode: run the full AI for other people

A server for other people, built on accounts. A guest's NeuroClaw (a phone, a laptop) hands its big jobs to
yours when its own chooser (`models && skills/core/engine-chooser.ts`) decides the job is too big for the device.

## Turn it on (the person running the server)

1. Make the admin account and let people sign up (`/accounts`). `Signup: open` lets anyone; `invite` means only you.
2. Set a passphrase of 12+ characters before starting the server: `NEUROCLAW_VAULT_PASSPHRASE`. Without it hosted mode
   refuses everything. There is no unencrypted mode.
3. Switch it on and set the limits (admin only): `POST /api/hosted/settings`, for example `{"enabled": true, "dailyCu": 30}`.
4. Reach the server over https. Put it behind a reverse proxy you trust; the server does not read forwarded headers, so
   per-address limits then see only the proxy.

## Use it (a guest)

1. Sign up on the server. `POST /api/hosted/tokens {"label": "my phone"}` returns a token starting `nch_`, once.
2. In your own NeuroClaw, add the server as a peer (`/sharing`): its address and that token. Nothing else changes: it is
   the same compute route a lease holder uses.
3. With `NEUROCLAW_CHOOSER=1` your device decides per message whether to answer itself or send it there.

## Limits (all set by the admin, all enforced per account)

| Limit | Default | What happens |
|---|---|---|
| Daily compute (CU, UTC day) | 30 | 429 until 00:00 UTC |
| Requests a minute | 10 | 429 |
| Jobs at once / waiting | 2 / 8 | 429 when full |
| Prompt size | 16,000 characters | 400 |
| Tokens per account | 5 | revoke one first |
| Unknown tokens from one address | 20 per 10 minutes | that address is refused for the window |

A job gets at most two minutes and is charged for the time it used, even if it failed. A job that outlives its budget is
abandoned, not killed (JavaScript cannot), and keeps its slot until the engine is really done with it.

## What guests can and cannot do

Text answers only. The guest route uses the engine's text path (`generateText`), never a plugin: a guest's message cannot
run a terminal command, read a file or send mail on your computer. (Before hosted mode, lease guests could, because that
route used the path plugins listen to. It no longer does.)

## What is protected, and what is not

- Hosted records (token hashes, usage, limits) are in `hosted.vault`: AES-256-GCM, key from your passphrase through
  scrypt, header authenticated, padded to 4 KiB blocks, plain file name. A wrong passphrase, a changed byte or a damaged file
  means an error and a refusal to serve; it never starts over with an empty vault, and never runs unmetered.
- **Not detected:** deleting `hosted.vault`, or putting back an older valid copy, resets everyone's day. Keep a copy elsewhere.
- **Not protected:** the passphrase is in the server's environment, so anyone who can read that process can read the vault.
  This is a software key, not a hardware-sealed one. The rest of the app's files (accounts, compute ledger, chats) are
  **not encrypted yet**; only the hosted records are.
- The computer that runs a job can read it. Say so wherever you offer hosting. Everyone talks to the same brain: it does
  not learn from guests unless the admin turns `learnFromUsers` on, but what it already knows is shared.
- Rate and bad-token counters live in memory and reset on restart. The daily compute used is saved.
