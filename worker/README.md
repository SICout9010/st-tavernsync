# TavernSync sync backend (Cloudflare Worker + R2 + Durable Object)

## Routes

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/v1/manifest` | DO reads manifest; `ETag` = version |
| PUT | `/v1/manifest` | CAS via `If-Match`; bumps version |
| POST | `/v1/blobs/check` | `{hashes}` → `{missing}` |
| PUT | `/v1/blobs/{hash}` | R2 put `u/{userId}/b/{hash}` |
| GET | `/v1/blobs/{hash}` | R2 get, immutable |
| GET | `/v1/quota` | used / limit / itemCount |
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
3. `npm install && npx wrangler deploy`
4. In TavernSync UI: Backend = Custom, Endpoint = `https://<worker>.workers.dev`, paste a device token  
   (`npx wrangler kv key put --binding=USER_TOKENS --remote <token> <userId>`).

`wrangler.jsonc` is gitignored so your namespace ids stay off GitHub. Commit only `wrangler-example.jsonc`.

## Limits

- Blob ≤ 25 MB, manifest ≤ 2 MB
- Default quota 500 MB (override `DEFAULT_QUOTA_BYTES`)
