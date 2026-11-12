# MUME Idea Submission

Discord idea submission and review pipeline for the White Council server, built as a
**Discord Activity** (an in-client iframe overlay) on a single Cloudflare Worker.
See [`../idea-board-build-spec.md`](../idea-board-build-spec.md) for the full spec.

> **Test environment.** This targets the test app/server. Moving to production is
> config-only — new secrets, re-point the Activity URL mapping + Entry Point command
> in the dev portal, recreate the forum tags/permissions. No code changes.

## Council assessment

See [ASSESSMENT.md](ASSESSMENT.md) for the native Discord review flow: shared,
1–5 score dropdowns, a named editor with backed change requests, optional issue flags, and one second on the selected checks and three distinct Council members
agreeing to the final scores before a score recommendation is recorded privately. No separate review
website or new Discord command is needed. Tests require Node 22.13+ (24 recommended).

## What it does

- Serves the two-page submission form as an Activity (`GET /`), identity via the
  Embedded App SDK OAuth handshake (`POST /api/token`).
- Validates every answer server-side (`POST /api/submit`), stores it in D1, and opens a
  forum post in `#idea-submission-2` with an embed, a status select, and a vote reaction.
- Runs the **In Proposal → Final Draft → Submitted** lifecycle, gated by the White
  Council role, with Submitted locking the post.
- Form questions live in KV and are versioned, so old ideas keep rendering with the
  labels they were submitted under.
- **Council idea review**: an off-site, Council-gated assessment surface (scoring
  rubric + gate checks + two-person seconding) at `/admin/review?idea=N`, linked from
  each idea's review copy and posting results back to Discord. See
  [`ASSESSMENT.md`](ASSESSMENT.md).

## Stack

Cloudflare Worker (TypeScript, no framework) · D1 · KV · one weekly cron. Zero runtime
dependencies in the Worker; the client bundles `@discord/embedded-app-sdk` into `/app.js`.

## Layout

```
src/
  index.ts            router (fetch + scheduled) — spec §3
  discord/            verify (Ed25519), rest, interactions (§7,§9), embed, forum
  activity/           page (server-render), css, token (§6), submit (§8)
  lib/                session, config, validate, transitions, db, encoding
client/main.ts        the Activity client → bundled to src/generated/app.client.js
migrations/           D1 schema — spec §4
seed/                 form-config.v1.json (the full question set)
scripts/              build-client, build-tests, register-commands, seed-config
test/                 pure-logic tests (node --test)
```

## Verify locally

```bash
npm install
npm run typecheck   # tsc, clean
npm test            # 11 pure-logic tests
npm run build:client
```

## Deploy (test server)

**1. Create the resources and paste their ids into `wrangler.toml`:**

```bash
npx wrangler d1 create mume_ideas
npx wrangler kv namespace create CONFIG
```

**2. Apply the schema:**

```bash
npm run db:migrate:remote
```

**3. Set the secrets** (values you provide — see "What I need from you"):

```bash
for s in DISCORD_APP_ID DISCORD_PUBLIC_KEY DISCORD_CLIENT_SECRET DISCORD_BOT_TOKEN \
         DISCORD_GUILD_ID FORUM_CHANNEL_ID COUNCIL_ROLE_ID SESSION_SIGNING_KEY ADMIN_TOKEN; do
  npx wrangler secret put "$s"
done
```

Generate the two you own yourself: `openssl rand -hex 32` for each of
`SESSION_SIGNING_KEY` and `ADMIN_TOKEN`.

**4. Deploy, then set `PUBLIC_BASE_URL`** in `wrangler.toml` to the deployed URL and
deploy once more:

```bash
npm run deploy
```

**5. Seed the form config and register the commands:**

```bash
npm run seed        # PUTs seed/form-config.v1.json -> /admin/config (version 1)
npm run register    # /idea, /idea-setup, and the Activity entry point command
```

**6. Developer portal (one-time, the Activity plumbing):**

- **General Information** → set the **Interactions Endpoint URL** to
  `https://<your-worker>/interactions`. Discord validates it on save; the Worker must be
  deployed first.
- **OAuth2** → add redirect `https://<your-worker>/` (Activities use the code flow).
- **Activities / Embedded App** → enable, and set the **URL mapping** root to your
  `PUBLIC_BASE_URL`.

**7. Forum channel setup (`#idea-submission-2`, by hand — spec §1):**

- Create three tags — **In Proposal**, **Final Draft**, **Submitted** — and mark each
  **moderated**.
- Turn off **Create Posts** for `@everyone`; leave **Send Messages in Threads** on.
- Set one **default reaction** (👍, matching the vote emoji).
- Give the app: View Channel, Send Messages, Send Messages in Threads, Create Public
  Threads, Manage Threads, Embed Links, Add Reactions.

**8. Create the pinned post:** run `/idea-setup` in the server as a White Council member.

## What I need from you (Discord references)

I can't read these — grab them from the test app/server (enable Developer Mode in
Discord for the "Copy ID" options):

| Value | Where |
|---|---|
| `DISCORD_APP_ID` | Dev portal → your app → General Information → Application ID |
| `DISCORD_PUBLIC_KEY` | same page → Public Key |
| `DISCORD_CLIENT_SECRET` | OAuth2 → Client Secret (Reset to reveal) |
| `DISCORD_BOT_TOKEN` | Bot → Reset Token |
| `DISCORD_GUILD_ID` | right-click the test server → Copy Server ID |
| `FORUM_CHANNEL_ID` | right-click `#idea-submission-2` → Copy Channel ID |
| `COUNCIL_ROLE_ID` | Server Settings → Roles → right-click White Council → Copy Role ID |

`SESSION_SIGNING_KEY` and `ADMIN_TOKEN` you generate yourself (see step 3).

## Editing the form later

Edit `seed/form-config.v1.json` (or `PUT /admin/config` directly) and run `npm run seed`.
The Worker bumps the version and keeps the old one; ideas already posted keep their
original labels.
