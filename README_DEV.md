# TavernSync — Developer guide

[User README (Thai)](README.md) · [User README (English)](README_EN.md)

This page is for people changing code, running tests, or deploying the sync backend. Everyday install steps live in the user READMEs.

## Stack at a glance

- **SillyTavern UI extension** (no ST server plugin) — TypeScript + Webpack → `dist/`
- **Entry:** `manifest.json` → `dist/index.js` + `dist/style.css`
- **Integration style:** `SillyTavern.getContext()` / `SillyTavern.libs` only — no deep `../../../script.js` imports ([ST docs](https://docs.sillytavern.app/for-contributors/writing-extensions/))
- **Settings:** `extensionSettings.tavernsync`
- **Bulk state:** `localforage` (base manifest, blobs, chat meta cache)
- **Backend:** Cloudflare Worker + R2 + SQLite Durable Object (`worker/`)

Design / ADRs: [`docs/TAVERNSYNC-CONTEXT.md`](docs/TAVERNSYNC-CONTEXT.md)  
ST API shapes: [`docs/st-api.md`](docs/st-api.md)  
Session notes: [`handoff.md`](handoff.md)

## Why `dist/` is committed

End users install via GitHub / clone. SillyTavern never runs `npm`. Always rebuild and **commit `dist/`** when you change `src/`.

## Local extension layout

Preferred path (matches `EXTENSION_FOLDER`):

```text
SillyTavern/public/scripts/extensions/third-party/st-tavernsync
```

Symlink from your clone:

```bash
mkdir -p "$ST/public/scripts/extensions/third-party"
ln -s /path/to/st-tavernsync "$ST/public/scripts/extensions/third-party/st-tavernsync"
```

After TS changes:

```bash
npm install
npm run build
# reload SillyTavern
```

## Scripts

```bash
npm run build      # production bundle → dist/
npm run build:dev  # unminified
npm test           # sync-core unit tests (vitest)
```

## Layout

```text
src/
  index.ts           # boot, UI, slash cmds, events
  settings.ts        # extensionSettings schema
  sync/engine.ts     # scan → diff → push/pull orchestration
  sync-core/         # pure diff/plan/apply/conflict (+ tests)
  st-adapter/        # ST /api/* read/write/scan only
  backend/           # StorageAdapter + HTTP client
  crypto/            # PBKDF2 + AES-GCM + HMAC blob keys
  state/             # localforage helpers
  ui/                # conflict prompts
panel.html           # settings drawer (extension root — required by ST templates)
worker/              # Cloudflare Worker deployable
```

Hard rule: **`sync-core` stays pure** (no `fetch`, DOM, or `SillyTavern.*`). ST knowledge stays in `st-adapter`.

## Worker deploy

```bash
cd worker
npm install
cp wrangler-example.jsonc wrangler.jsonc
# Create R2 bucket + KV namespace; put real ids in wrangler.jsonc (gitignored)
npx wrangler kv namespace create USER_TOKENS
# Free plan: migrations must use new_sqlite_classes (already set in the example)
npx wrangler deploy
npx wrangler kv key put --binding=USER_TOKENS --remote "<token>" "<userId>"
```

Details: [`worker/README.md`](worker/README.md)

Auth: `Authorization: Bearer <deviceToken>`. KV maps token → user id. Tokens ≥8 chars without a KV entry fall back to `user_<prefix>` for solo demos.

## Sync algorithm (short)

1. Scan local ST → content-addressed items + blobs in IndexedDB  
2. Diff local vs last-synced **base** vs remote manifest  
3. Push missing blobs, then CAS `PUT /v1/manifest` (`If-Match`)  
4. Pull: download → decrypt → verify hash → apply in dependency order (settings last)  
5. Chat conflicts: fast-forward if one side is a prefix; else keep both under a suffixed name  

Never sync inside install/activate hooks (5s timeout). Use `APP_READY` + deferred timers. Block sync while generation is running.

## Security implementation notes

- Strip `extensionSettings.tavernsync` and secret-like keys before hashing settings (`st-adapter/normalize.ts`)
- E2EE: PBKDF2 ≥600k iterations, AES-GCM (IV prepended); passphrase not persisted — only salt + in-memory session key
- With E2EE on, R2 object keys are `HMAC(salt, plaintextHash)` so the server can’t fingerprint known cards easily
- Deletion propagation is opt-in; remote deletes are not auto-applied in v1

## Known gaps

- Themes / quick replies / personas: scanned; apply-on-pull still incomplete  
- Character PNG import may re-encode (hash stability — open Q2)  
- `POST /v1/gc` is a stub  
- “Managed” backend mode is UI-only  

## License

[AGPLv3](LICENSE)
