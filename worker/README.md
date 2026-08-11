# TavernSync sync backend (Cloudflare Worker + R2 + Durable Object)

## Routes

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/v1/manifest` | DO reads manifest; `ETag` = version |
| PUT | `/v1/manifest` | CAS via `If-Match`; bumps version |
| POST | `/v1/blobs/check` | `{hashes}` → `{missing}` (counts Class B heads) |
| PUT | `/v1/blobs/{hash}` | R2 put `u/{userId}/b/{hash}` (Class A + storage) |
| GET | `/v1/blobs/{hash}` | R2 get (Class B) |
| GET | `/v1/quota` | usage snapshot (storage + monthly Class A/B); soft limits never block |
| GET/PUT | `/v1/account` | shared E2EE salt (`e2eeSalt`) for HMAC blob keys |
| POST | `/v1/gc` | stub |

Auth: `Authorization: Bearer <deviceToken>`. Map tokens → user ids in KV `USER_TOKENS`, or tokens ≥8 chars auto-map to `user_<prefix>` for self-host demos.

## Setup

1. Copy the example config and fill in your KV id (and bucket name if different):

```bash
cd worker
cp wrangler-example.jsonc wrangler.jsonc
# edit wrangler.jsonc — paste id from: npx wrangler kv namespace create USER_TOKENS
```

2. Create R2 bucket `tavernsync-blobs` (or rename to match `bucket_name` in the config).
3. Set soft budgets in `vars` (see below) and optionally the Discord webhook secret:

```bash
npx wrangler secret put DISCORD_WEBHOOK_URL
# paste your Discord channel webhook URL — never commit it
```

4. `npm install && npx wrangler deploy`
5. In TavernSync UI: Backend = Custom, Endpoint = `https://<worker>.workers.dev`, paste a device token  
   (`npx wrangler kv key put --binding=USER_TOKENS --remote <token> <userId>`).

`wrangler.jsonc` is gitignored so your namespace ids stay off GitHub. Commit only `wrangler-example.jsonc`.

## Soft R2 budgets (operator)

Per sync account (`userId`), the Worker tracks approximate R2 cost drivers:

| Meter | What counts | Soft ceiling env |
|-------|-------------|------------------|
| **Storage** | Sum of blob sizes referenced by the manifest | `SOFT_STORAGE_BYTES` (default 50 GiB) |
| **Class A** | Blob PUTs / month (UTC) | `SOFT_CLASS_A_MONTHLY` (default 100_000) |
| **Class B** | Blob GETs + each `head` in `/blobs/check` / month | `SOFT_CLASS_B_MONTHLY` (default 1_000_000) |

Crossing **70% / 90% / 100%** of a soft ceiling posts a Discord embed to `DISCORD_WEBHOOK_URL` (deduped per account + UTC month + meter so you get at most one alert per band). **Sync is never blocked** — soft limits are for your bill, not the ST user.

Fallback: if only legacy `DEFAULT_QUOTA_BYTES` is set, it is used as the storage soft ceiling.

## Other limits

- Blob ≤ 25 MB, manifest ≤ 2 MB
