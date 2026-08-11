# TavernSync — Developer guide

[User README (Thai)](README.md) · [User README (English)](README_EN.md)

For people changing code, running tests, or deploying the sync backend. Everyday install steps live in the user READMEs.

## Stack at a glance

- **SillyTavern UI extension** (no ST server plugin) — TypeScript + Webpack → versioned `dist/`
- **Entry:** `manifest.json` → `dist/index.<version>.js` + `dist/style.<version>.css`  
  Versioned filenames bust SillyTavern / browser ES-module cache. Bump `package.json` version + `BUILD_ID` in `src/settings.ts` + `manifest.json` together.
- **Integration:** `SillyTavern.getContext()` / `SillyTavern.libs` only — no deep `../../../script.js` imports
- **Settings:** `extensionSettings.tavernsync` (never include this subtree in the synced settings blob)
- **Bulk state:** `localforage` — base manifest, content blobs, **remembered E2EE key** (`tavernsync_e2ee_key_b64`)
- **Backend:** Cloudflare Worker + R2 + SQLite Durable Object (`worker/`)

Design notes: [`docs/TAVERNSYNC-CONTEXT.md`](docs/TAVERNSYNC-CONTEXT.md)  
ST API shapes: [`docs/st-api.md`](docs/st-api.md)

## Why `dist/` is committed

End users install via GitHub. SillyTavern never runs `npm`. Rebuild and **commit `dist/`** when you change `src/`.

## Local extension layout

```text
SillyTavern/public/scripts/extensions/third-party/st-tavernsync
```

Symlink from your clone:

```bash
mkdir -p "$ST/public/scripts/extensions/third-party"
ln -s /path/to/st-tavernsync "$ST/public/scripts/extensions/third-party/st-tavernsync"
```

```bash
npm install
npm run build   # also bump version if releasing
# hard-refresh ST until toast shows build=<version>
```

## Scripts

```bash
npm run build      # production → dist/index.<ver>.js
npm run build:dev  # unminified
npm test           # sync-core vitest
```

## Layout

```text
src/
  index.ts           # boot, panel, slash cmds, quiet drawer scan, events
  settings.ts        # schema + BUILD_ID
  sync/engine.ts     # scan → diff → conflict resolve → push/pull
  sync-core/         # pure diff/plan/apply/conflict (+ tests)
  st-adapter/        # ST /api/* read/write/scan/normalize
  backend/           # StorageAdapter + HTTP client
  crypto/            # PBKDF2 + AES-GCM (extractable derive for remember-device)
  state/store.ts     # localforage
  ui/conflict.ts     # direction-aware conflict prompts
panel.html           # settings drawer (ST template root)
worker/              # Cloudflare Worker
```

Hard rule: **`sync-core` stays pure** (no `fetch`, DOM, or `SillyTavern.*`).

## Worker deploy

```bash
cd worker
npm install
cp wrangler-example.jsonc wrangler.jsonc
# R2 bucket + KV; put real ids in wrangler.jsonc (gitignored)
npx wrangler kv namespace create USER_TOKENS
# Free plan: migrations use new_sqlite_classes (see example)
npx wrangler deploy
# optional explicit mapping:
npx wrangler kv key put --binding=USER_TOKENS --remote "<token>" "<userId>"
```

Details: [`worker/README.md`](worker/README.md)

Auth: `Authorization: Bearer <deviceToken>`. KV maps token → user id. Tokens ≥8 chars without KV fall back to `user_<prefix>` for solo demos.

**R2 object key = plaintext content hash** (HMAC blob keys were removed — per-device salts caused cross-device 404s). Body may still be AES-GCM ciphertext when E2EE is on. Account salt lives at `/v1/account` and must be shared across devices.

## Sync algorithm (short)

1. Scan local ST → content-addressed items + blobs in IndexedDB  
2. Diff local vs last-synced **base** vs remote manifest  
3. Resolve remaining conflicts in **one batch** (direction-aware defaults)  
4. Push: upload blobs, then CAS `PUT /v1/manifest` (`If-Match`)  
5. Pull: download → decrypt (plaintext fallback if hash matches) → verify → apply  
6. Chats: try fast-forward if one side is a prefix; else conflict UI  

### Conflict UX (product, not just code)

| Direction | Safe default |
|-----------|----------------|
| **Push** | **Skip** conflicts — only upload clear local-ahead / new items. Force overwrite = second confirm. |
| **Pull** | Prefer **server** for all, or choose per item. |
| **Keep both** | Local unchanged; remote saved under `(conflict DATE device)` sibling (chats work best). |

### Incomplete Pull must not poison Push

If any pull blob is missing / decrypt fails:

- Count skips  
- **Do not** adopt the full remote manifest as base  
- Only merge successfully applied ids into base  
- Toast: incomplete — don’t treat this device as Push source of truth  

This prevents: good PC Push → bad phone Pull → phone “overwrite all” → PC Pull data loss.

### E2EE session model

- Default: `e2eeEnabled: true`, `e2eeRequireSessionUnlock: false`  
- Unlock once → derive extractable key → store raw key in localforage → restore on load  
- Never store the passphrase itself  
- “Lock this device” clears remembered key  
- Honest limit: ST extensions have no secure enclave; remembered key is readable like the device token  

Never sync inside install/activate hooks (5s timeout). Use `APP_READY` + deferred timers. Block sync while generation is running.

Quiet rescan on expanding the top-level TavernSync drawer (`inline-drawer-toggle`) — no toast/loader.

## Security implementation notes

- Strip `extensionSettings.tavernsync`, `power_user.personas` / `persona_descriptions` (personas sync as `persona/*`), and secret-like keys (`st-adapter/normalize.ts`)
- E2EE: PBKDF2 ≥600k, AES-GCM (IV prepended)
- Personas: image under `User Avatars/` + metadata; apply via `/api/avatars/upload` + settings merge
- Deletion propagation is opt-in (`propagateDeletes`): Push removes from remote manifest; Pull applies `delete_local` (chats, characters, lorebooks, …). Settings are never auto-deleted. Declined/failed deletes stay in base to block `push_new` resurrection.

## Known gaps

- Themes / quick replies: scanned; apply-on-pull still incomplete  
- Character PNG import may re-encode (hash flap — open Q2)  
- `POST /v1/gc` is a stub  
- “Managed” backend mode is UI-only  
- Fast-forward may skip when remote blob decrypt fails (falls through to conflict UI)  

## Dogfood recovery recipes

| Symptom | Fix |
|---------|-----|
| Pull 404 / missing blobs | Wipe remote → Unlock → Push from the machine with real data |
| Many conflicts on Push | Prefer Skip; only Force overwrite from a complete device |
| `DOMException` on fast-forward | Usually decrypt fail / mixed plaintext era — noisy, not fatal; 0.1.8+ tries plaintext hash fallback |
| Stale extension JS | Confirm toast `build=<version>`; bump versioned `dist/` + manifest |

## License

[AGPLv3](LICENSE)
