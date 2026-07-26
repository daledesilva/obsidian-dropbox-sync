# Using Your Own Dropbox App Key

By default, this plugin uses a built-in App Key (`SHIPPED_APP_KEY` / bake-in from `.env` `DROPBOX_APP_KEY`) to connect to Dropbox. That key is a **public client id** — safe to ship in the plugin and in git. The Dropbox **App secret** must never be embedded (this plugin uses OAuth PKCE and does not need it). The built-in key works out of the box for most users.

However, you may want to use your own Dropbox App Key if:

- The built-in key has reached its user limit
- You want full control over the Dropbox app permissions
- You're using this plugin in an organization with strict security policies

## How to set up your own App Key

### 1. Create a Dropbox app

Go to [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) and click **Create app**.

Choose the following settings:

| Option | Value |
|--------|-------|
| **API** | Scoped access |
| **Access type** | App folder |
| **Name** | Anything you like (e.g., "My Obsidian Sync") |

> **Why App folder?** With App folder access, the plugin can only read and write files inside its own folder (`Apps/YourAppName/` in your Dropbox). It cannot access any other files in your Dropbox. This is the safest option.

### 2. Set permissions

After creating the app, go to the **Permissions** tab and enable:

- `files.metadata.read`
- `files.metadata.write`
- `files.content.read`
- `files.content.write`

Click **Submit** to save.

### 3. Add the redirect URI (desktop only)

Go to the **Settings** tab of your app and add this redirect URI under **OAuth 2 > Redirect URIs**:

```
obsidian://dropbox-sync
```

This allows the desktop one-click login to work. Mobile uses a code-based flow and doesn't need this.

### 4. Copy your App Key

On the same **Settings** tab, find your **App key** (not the App secret) and copy it.

### 5. Enter the key in the plugin

In Obsidian, go to **Settings > Dropbox Sync > Connection**:

1. If you're already connected, click **Disconnect** first
2. Toggle **Use custom App Key** on
3. Paste your App Key
4. Click **Connect to Dropbox**

## FAQ

**Can I switch back to the built-in key?**
Yes. Disconnect, toggle off "Use custom App Key", and reconnect.

**Does this affect my synced files?**
No. Changing the App Key only changes how the plugin authenticates with Dropbox. Your files and sync state are preserved.

**Do I need to do this on every device?**
Yes. Each device needs to connect using the same App Key. The Vault ID and files stay the same.
