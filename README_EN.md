# TavernSync

[ภาษาไทย](README.md) · [For developers](README_DEV.md)

Sync your SillyTavern characters, chats, lorebooks, and settings across computers — upload from one machine, download on another, on your terms.

## Who this is for

If you already use **one** SillyTavern from every device (phone, laptop, whatever), you probably **don’t need this**. That’s the simpler setup.

TavernSync is for when you actually run SillyTavern in more than one place — home PC and travel laptop, offline trips, or you just don’t want your stories living only on someone else’s server.

## Install

No Node, no build steps. Just install the extension.

1. In SillyTavern open **Extensions** → **Install extension**
2. Paste: `https://github.com/SICout9010/st-tavernsync`  
   (if you see **Install for all users**, pick that)
3. Enable **TavernSync** in the extension list
4. Open the Extensions settings panel (right side) and find **TavernSync**

## What to fill in

You need a place for the synced data to live (see the next section). Then fill in:

| Field | What to put |
|-------|-------------|
| **Endpoint** | The URL of your sync server (for example your deployed Worker URL). No slash at the end. |
| **Device name** | A nickname for this computer, like `home-pc` or `laptop`. Use a different name on each machine. |
| **Device token** | A secret password this machine uses to talk to the server. Machines that should share the same data use the **same** token. |

If encryption is on (it is by default):

1. Choose a passphrase you’ll actually keep safe
2. Check the “I’ve saved it” box
3. Click **Unlock**
4. Click **Connect** to make sure it works
5. Click **Rebuild local index** once
6. Then **Push** (send up) or **Pull** (bring down)

Chat shortcuts: `/sync-status` · `/sync-push` · `/sync-pull`

## Where the data goes

The extension doesn’t keep your full library by itself — it talks to a sync server you point it at.

Right now the main option is hosting the included Cloudflare backend yourself (see [`worker/`](worker/README.md) and the [developer guide](README_DEV.md)). Someone else’s compatible server works too, if you have one.

Without an Endpoint you can still open the settings panel, but Push / Pull won’t work yet.

## Safety, in plain words

- **Model API keys are never synced** — on purpose.
- End-to-end encryption means the server host shouldn’t be able to read your chats easily. **Lose the passphrase and the copy on the server is basically gone.**
- Your device token lives on your machine — don’t post it publicly.
- “Propagate deletions” stays **off** by default so a sync bug doesn’t wipe stories on other devices.

## If something goes wrong

1. Before a big Pull, back up your local SillyTavern data folder
2. Lost passphrase → rely on a local backup, not the server copy alone
3. **Reset sync state** only clears sync bookkeeping in the browser — it doesn’t delete your characters or chats in SillyTavern
4. After pulling settings, if it asks you to reload the page — do it

## License

[AGPLv3](LICENSE)

---

Hacking on the code, fixing bugs, or deploying the backend? See [README_DEV.md](README_DEV.md).
