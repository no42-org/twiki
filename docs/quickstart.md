# twiki Quick Start

Get twiki running in **shadow mode** (reports what it *would* do, writes
nothing) and posting its per-run digest to **Slack**, **Discord**, or
**Matrix** in a few minutes. Once you trust the digests, flip to `enforce`.

> twiki authenticates as a GitHub App and uses an Anthropic model as a
> *read-only advisor*. See the [README](../README.md) for the safety model; this
> guide walks through obtaining every credential below.

---

## 1. Prerequisites

You need three credentials: a **GitHub App** (App ID + private key), an
**Anthropic API key**, and **one chat target** (Slack, Discord, or Matrix).

### 1a. Create the GitHub App and get its App ID + private key

twiki authenticates as a GitHub App so merges/tags show as `twiki[bot]`, tokens
are short-lived, and the blast radius is scoped per install.

1. Go to **org → Settings → Developer settings → GitHub Apps → New GitHub App**
   (a personal App under your user settings works too for testing).
2. Name it (e.g. `twiki`), set any homepage URL, and **uncheck *Active*** under
   *Webhook* — twiki polls, so no webhook is needed.
3. Grant these **repository permissions**:
   - **Contents:** Read & write (push tags, read workflow files, compare commits)
   - **Pull requests:** Read & write (merge)
   - **Checks:** Read-only
   - **Commit statuses:** Read-only
   - **Metadata:** Read-only (mandatory)
4. Create the App. On its settings page, note the **App ID** (a number near the
   top) — this is `TWIKI_GITHUB_APP_ID`.
5. Scroll to **Private keys → Generate a private key**. A `*.pem` downloads;
   save it as `twiki.pem`. Its path is `TWIKI_GITHUB_APP_PRIVATE_KEY_PATH`
   (or paste the PEM inline into `TWIKI_GITHUB_APP_PRIVATE_KEY`).
6. **Install App** (left sidebar) → install onto exactly the repos in your
   allowlist below.

### 1b. Get an Anthropic API key

Create a key at <https://console.anthropic.com/> → *API Keys*. This is
`ANTHROPIC_API_KEY` (read directly by the SDK).

### 1c. Define the repo allowlist

Copy the example and edit:

```sh
cp repos.example.yaml repos.yaml
```

```yaml
# repos.yaml
mode: shadow            # report-only until you trust it
repos:
  - repo: your-org/service-a
  - repo: your-org/service-b
    autoMergeMinor: false   # patch only; minor waits for a human
  - repo: your-org/legacy
    mergeOnly: true         # never cut releases here
```

## 2. Shared setup

Everything except the chat target is the same. Put the common settings in a
`.env` file (never commit it):

```sh
# .env
TWIKI_GITHUB_APP_ID=123456
TWIKI_GITHUB_APP_PRIVATE_KEY_PATH=/secrets/twiki.pem
ANTHROPIC_API_KEY=sk-ant-...
TWIKI_CONFIG=/config/repos.yaml
TWIKI_MODE=shadow
# Audit log path — must be writable by the non-root container user (uid 65532).
# Keep this comment on its own line: `docker --env-file` does NOT strip inline
# comments, so `VAR=value  # note` would make the note part of the value.
TWIKI_AUDIT_PATH=/tmp/twiki-audit.jsonl
```

We run the published image **`ghcr.io/no42-org/twiki:latest`**, mounting the
config and key read-only and using `TWIKI_ONCE=1` for a single test tick.

> **One target at a time.** twiki picks the chat target by precedence:
> **Slack** → **Discord** → **Matrix** → stdout. Set the vars for exactly one;
> if you set several, Slack wins.

---

## 3a. Slack

1. Create an **Incoming Webhook**: <https://api.slack.com/messaging/webhooks> →
   *Create App* → *Incoming Webhooks* → enable → *Add New Webhook to Workspace*,
   pick a channel. You get a URL like
   `https://hooks.slack.com/services/T000/B000/XXXX`.
2. Run a single shadow tick:

```sh
docker run --rm \
  --env-file .env \
  -e TWIKI_ONCE=1 \
  -e TWIKI_SLACK_WEBHOOK_URL='https://hooks.slack.com/services/T000/B000/XXXX' \
  -v "$PWD/repos.yaml:/config/repos.yaml:ro" \
  -v "$PWD/twiki.pem:/secrets/twiki.pem:ro" \
  ghcr.io/no42-org/twiki:latest
```

A "would merge / would release" digest should land in your Slack channel.

## 3b. Discord

1. In Discord: **Server Settings → Integrations → Webhooks → New Webhook**,
   choose a channel, **Copy Webhook URL** —
   `https://discord.com/api/webhooks/123.../XXXX`.
2. Run:

```sh
docker run --rm \
  --env-file .env \
  -e TWIKI_ONCE=1 \
  -e TWIKI_DISCORD_WEBHOOK_URL='https://discord.com/api/webhooks/123456/XXXX' \
  -v "$PWD/repos.yaml:/config/repos.yaml:ro" \
  -v "$PWD/twiki.pem:/secrets/twiki.pem:ro" \
  ghcr.io/no42-org/twiki:latest
```

## 3c. Matrix

twiki posts via the Client-Server API, so it needs a homeserver URL, an
**access token**, and the **room ID** (not the alias).

1. **Room ID** looks like `!AbCdEf:example.org` (in Element: *Room Settings →
   Advanced → Internal room ID*). Invite the bot user and make sure it has
   joined / can post.
2. **Access token** for the bot account — e.g.:

   ```sh
   curl -XPOST 'https://matrix.example.org/_matrix/client/v3/login' \
     -H 'Content-Type: application/json' \
     -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"twiki"},"password":"••••"}'
   # -> { "access_token": "syt_...", ... }
   ```
3. Run (**all three** Matrix vars are required, or Matrix is skipped):

```sh
docker run --rm \
  --env-file .env \
  -e TWIKI_ONCE=1 \
  -e TWIKI_MATRIX_HOMESERVER='https://matrix.example.org' \
  -e TWIKI_MATRIX_TOKEN='syt_your_access_token' \
  -e TWIKI_MATRIX_ROOM='!AbCdEf:example.org' \
  -v "$PWD/repos.yaml:/config/repos.yaml:ro" \
  -v "$PWD/twiki.pem:/secrets/twiki.pem:ro" \
  ghcr.io/no42-org/twiki:latest
```

> A Matrix misconfig surfaces the homeserver's `{errcode, error}` in the log
> (e.g. `M_FORBIDDEN` → the bot isn't in the room; `M_UNKNOWN_TOKEN` → bad
> token).

---

## 4. Verify

- The single-tick run above should **post a digest** to your channel and exit.
- It's **shadow mode**, so nothing was merged or released — the digest is
  labelled as what twiki *would* do.
- Re-running this `docker run --rm` example posts again each time — the
  identical-digest de-dup is kept in a file inside the container, so it only
  persists within the long-running poller (section 5), not across throwaway
  `--rm` ticks.

## 5. Go live

1. Watch the shadow digests across a few cycles and confirm they match your
   judgment.
2. Flip to enforcing — either `mode: enforce` in `repos.yaml` or
   `TWIKI_MODE=enforce`. Rollback is instant: switch back to `shadow`.
3. Deploy as a long-running poller (drop `TWIKI_ONCE`; it polls hourly, tune
   with `TWIKI_POLL_MINUTES`). Add your chosen chat-target variable (e.g.
   `TWIKI_SLACK_WEBHOOK_URL=...`) to `.env` so `env_file` passes it to the
   container, then:

   ```yaml
   # compose.yml
   services:
     twiki:
       image: ghcr.io/no42-org/twiki:latest
       restart: unless-stopped
       env_file: .env # includes the chat-target webhook/token from step 3a/b/c
       environment:
         TWIKI_MODE: enforce # override the shadow default for the live deploy
       volumes:
         - ./repos.yaml:/config/repos.yaml:ro
         - ./twiki.pem:/secrets/twiki.pem:ro
   ```

   ```sh
   docker compose up -d
   ```

For the full environment-variable reference (model selection, poll interval,
audit log, key-as-inline-string), see the [README](../README.md#environment).
