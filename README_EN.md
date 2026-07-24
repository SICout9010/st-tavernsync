# TavernSync

[ภาษาไทย](README.md) · [For developers](README_DEV.md)

Sync SillyTavern characters, chats, lorebooks, presets, personas, and settings **across devices** — Push from one machine, Pull on another, on a server you control.

**End-to-end encryption (E2EE) is on by default** so a server operator can’t easily read your content. That privacy comes with real setup and conflict-handling tradeoffs (see below).

## Who this is for

If you already use **one** SillyTavern from every device (phone, laptop, tunnel, etc.), you probably **don’t need this**.

TavernSync is for when you run SillyTavern in more than one place — home PC ↔ travel laptop, offline trips, or you don’t want your stories living only on someone else’s host.

## Install

No Node, no build. Just install the extension.

1. In SillyTavern open **Extensions** → **Install extension**
2. Paste: `https://github.com/SICout9010/st-tavernsync`  
   (if you see **Install for all users**, pick that)
3. Enable **TavernSync**
4. Open the Extensions settings panel (right side) and find **TavernSync**

## Getting started

### 1) You need a sync server

Right now you host your own backend (Cloudflare Worker in [`worker/`](worker/)). There is no Managed “click and go” option yet.  
Deploy steps: [README_DEV.md](README_DEV.md) and [`worker/README.md`](worker/README.md).

### 2) Fill in the panel (every device)

| Field | What to put |
|-------|-------------|
| **Server URL** | Your worker URL, e.g. `https://xxxx.workers.dev` — **no trailing slash** |
| **Device name** | A label for this machine, e.g. `home-pc` / `phone` (different per device) |
| **Sync token** | Shared secret for this sync account — **not** your SillyTavern login password |

Click **Test** to confirm the connection.

### 3) Unlock encryption (once per device)

E2EE is **on by default**.

1. Pick a **passphrase** (same on every device) and write it down somewhere safe  
2. Enter it → check **I've saved my passphrase** → click **Unlock**  
3. After that, this browser remembers the derived key (no unlock on every refresh)  
4. Optional: enable **Ask for passphrase after every refresh** if you want the paranoid mode  

**Lose the passphrase and the encrypted copy on the server is basically gone.** Keep local backups.

### 4) First sync (recommended)

Assume the **PC has the complete library**:

1. On the source device → **↑ Push**  
2. On the other device → same URL / token / passphrase → Unlock → **↓ Pull**  
3. If it asks to reload after settings/personas — reload  

Chat shortcuts: `/sync-push` · `/sync-pull` · `/sync-status`

## Main buttons

| Button | Meaning |
|--------|---------|
| **Push** | Upload this device to the server |
| **Pull** | Download from the server to this device |
| **Check status** | Compare with the server (runs a scan) |
| **Rescan this device** | Manual full local scan |
| **Lock this device** | Forget the remembered key; unlock again to sync |
| **Wipe server sync data** | Clear the server index (does not delete your local ST files) |

Opening the TavernSync drawer runs a **quiet** background scan (no toast spam).

## Conflicts — what to click

A conflict means both this device and the server changed the same item (or the sync baseline drifted).

On **Push**, if many items conflict:

1. **OK = Skip conflicts (safe)** — only upload non-conflicting items; do **not** mass-overwrite the server  
2. Cancel → optional **Force overwrite** — only if you are sure **this device is the complete source of truth**  
3. Or choose per item: this device / server / keep both / skip  

**Never force-overwrite from a device that just had an incomplete Pull.**  
Bad path: PC Push (good) → phone Pull misses blobs → phone Push overwrites server → PC Pull → data loss.

If Pull skips items or can’t decrypt them, you’ll get a warning that the baseline is incomplete — **don’t treat that device as Push source of truth** until a clean Pull works, or Wipe the server and Push from the good machine.

**Keep both** (especially chats) keeps your local copy and saves the server copy under a sibling name like `(conflict DATE device)`.

## The E2EE tradeoff (honest)

Community feedback prefers privacy by default. That means more moving parts:

| You get | You pay |
|---------|---------|
| Server operator can’t easily read chats | Passphrase + unlock at least once per device |
| Blobs on R2 are ciphertext | Lost passphrase ≈ lost server copy |
| Remembered device key (no unlock every refresh) | Derived key lives in the browser — protects against the **server/network**, not other extensions on the same profile |

You can turn encryption off for simpler self-hosted use, knowing the host can read stored content.

## What syncs

Settings · Characters · Chats · Lorebooks · Presets · Personas · Groups · (Themes / Quick replies apply path still incomplete)

**Model API keys are never synced** — on purpose.

**Delete on other devices too** stays **off** by default.

## If something breaks

1. Before a big Pull, back up your SillyTavern data folder  
2. Lost passphrase → rely on local backups  
3. **Reset sync on this device** clears browser sync bookkeeping only — not your ST library  
4. Corrupt remote index / missing blobs → **Wipe server sync data**, then Push from the machine that has the real data  
5. Browser console lines prefixed `[TavernSync]`

## License

[AGPLv3](LICENSE)

---

Coding, tests, or deploying the backend → [README_DEV.md](README_DEV.md)
