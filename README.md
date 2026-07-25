> 한국어 버전: [README_ko.md](README_ko.md)

# Dropbox Sync for Obsidian

Sync your Obsidian vault with Dropbox — across desktop and mobile, automatically.

## What it does

- **Keeps your vault in sync** across all your devices via Dropbox
- **Detects changes instantly** — edits, deletions, and renames sync within seconds
- **Handles conflicts safely** — when the same file is edited on two devices, you choose what to keep
- **Protects against accidental deletion** — three safety layers prevent data loss
- **Opens unsynced files on demand** — click a link, and the plugin downloads from Dropbox before opening

## Getting started

### 1. Install the plugin

Open Obsidian, go to **Settings > Community plugins**, search for **"Dropbox Sync"**, and click **Install**, then **Enable**.

<details>
<summary>Manual install (advanced)</summary>

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/zeakd/obsidian-dropbox-sync/releases/latest). Place them in your vault's `.obsidian/plugins/dropbox-sync/` folder and restart Obsidian.

</details>

### 2. Connect to Dropbox

Open **Settings > Dropbox Sync** and click **Connect to Dropbox**.

- **Desktop**: your browser opens automatically. Authorize and you're done.
- **Mobile**: tap "Open Dropbox", authorize, copy the code, and paste it back.

### 3. Set your Vault ID

Choose a name for your Dropbox folder (e.g., `my-notes`). This is where your vault files will be stored on Dropbox.

### 4. Turn on sync

Toggle **Enable sync** on. Your vault will sync immediately.

From now on, any file you edit, create, or delete will automatically sync to Dropbox. Changes from other devices are picked up in real time.

## Daily use

### Syncing

| Action | What happens |
|--------|-------------|
| **Edit a file** | Syncs to Dropbox after 5 seconds |
| **Delete or rename a file** | Syncs to Dropbox after 5 seconds |
| **Click the sync icon** (left sidebar) | Syncs immediately |
| **Someone edits on another device** | Changes appear here within seconds |

The status bar at the bottom shows the current state: syncing, synced, or error.

### When there's a conflict

If the same file was edited on two devices before syncing, the plugin needs to decide which version to keep. You can choose your preferred strategy in Settings:

| Strategy | What happens |
|----------|-------------|
| **Keep both** (default) | Both versions are saved. The other device's version gets a `.conflict` suffix. |
| **Keep newest** | The more recently edited version wins automatically. |
| **Ask me** | A side-by-side comparison opens so you can pick what to keep. |

Read more: [How conflict resolution works](docs/conflict-resolution.md)

### Opening files via link

Use a URL to open a file directly — if it hasn't synced yet, the plugin downloads it first.

Read more: [Deep link: sync & open](docs/deep-link.md)

### Excluding files from sync

Don't want to sync PDFs, images, or certain folders? Go to **Settings > Exclude patterns** and add patterns like:

```
*.pdf
attachments/
.obsidian/workspace*
```

The settings panel shows how many files are currently excluded.

## Settings reference

| Setting | Default | What it does |
|---------|---------|-------------|
| **Vault ID** | — | Your Dropbox folder name. Required to start syncing. |
| **Enable sync** | Off | Turns automatic syncing on or off. |
| **Conflict strategy** | Keep both | How to handle files edited on multiple devices. [Details](docs/conflict-resolution.md) |
| **Exclude patterns** | `.obsidian/workspace*` | Files matching these patterns won't sync. |
| **Sync on file create** | Off | Also sync when new files are created (edits and deletions always sync). |
| **Sync interval** | 60 seconds | How often to check for changes as a fallback. Usually not needed — changes are detected in real time. |
| **Delete protection** | On | Ask for confirmation before deleting many files at once. [Details](docs/sync-safety.md) |
| **Delete threshold** | 5 | How many deletions trigger the confirmation. |
| **Custom App Key** | Off | Use your own Dropbox app instead of the built-in one. [Setup guide](docs/custom-app-key.md) |

## Safety

Your data is protected by three independent layers. Even if one fails, the others catch it.

| Layer | Protection |
|-------|-----------|
| **Delete tracking** | Only files you delete are removed from Dropbox. The plugin detects deletions reliably across desktop and mobile. |
| **Bulk delete guard** | If a sync would delete more than 5 files, you see a confirmation first. |
| **Dropbox trash** | Deleted files stay in Dropbox's trash for 30–180 days and can be restored anytime. |

Read more: [How sync safety works](docs/sync-safety.md)

## Need help?

See the [Troubleshooting guide](docs/troubleshooting.md) for common issues, or check the logs:

- **Command palette** > "Dropbox Sync: View sync logs"
- **Settings** > Dropbox Sync > Troubleshooting → enable **Debug logging** if needed → **View Logs**

For live Cursor Debug ingest from mobile (Wi‑Fi), see [Cursor Debug ingest](docs/cursor-debug-ingest.md).

---

<details>
<summary>For developers</summary>

```bash
bun install
bun run build      # Production build
bun run dev        # Watch mode
bun run typecheck  # TypeScript check
bun test           # Run tests
```

Mobile / agent live logs: [Cursor Debug ingest](docs/cursor-debug-ingest.md) (`/debug-ingest`, `scripts/ingest-lan-relay.sh`).

</details>

## License

[MIT](LICENSE)
