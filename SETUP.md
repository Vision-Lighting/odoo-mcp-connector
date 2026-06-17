# Vision Lighting – Odoo MCP Connector Setup

Connects Claude Desktop to the Vision Lighting Odoo instances with three access modes:

| Server | Mode | What you can do |
|---|---|---|
| `odoo-staging` | 🧪 Staging | Everything — safe to experiment |
| `odoo-live-ro` | 🔵 Live read-only | Search and read anything, zero writes |
| `odoo-live-rw` | 🟠 Live restricted | Read everything + edit products/variants/images + create/edit project tasks + update pricelists |

---

## Prerequisites

- [Claude Desktop](https://claude.ai/download) installed
- Python 3.10+ installed — download from https://www.python.org/downloads/

---

## Step 1 — Copy the files

Copy this entire `Odoo Connector` folder to your machine, e.g.:
```
C:\Users\YOUR_NAME\Odoo Connector\
```

---

## Step 2 — Install Python dependencies

Open a terminal (Command Prompt or PowerShell) in the folder and run:

```
py -m pip install mcp python-dotenv openpyxl requests
```

---

## Step 3 — Get your Odoo API key

You need a separate API key for staging and live (or you can use one key for both).

1. Log in to the Odoo instance (staging or live)
2. Go to **Settings → My Profile** (top-right menu)
3. Click the **Account Security** tab
4. Under **API Keys**, click **New Key**
5. Give it a name (e.g. "Claude Desktop") and copy the key — you won't see it again

Repeat for the other instance if you want both modes.

---

## Step 4 — Find your Python path

In a terminal, run:
```
py -c "import sys; print(sys.executable)"
```
Copy the output — you'll need it in the next step.

---

## Step 5 — Configure Claude Desktop

Open (or create) the Claude Desktop config file at:
```
C:\Users\YOUR_NAME\AppData\Roaming\Claude\claude_desktop_config.json
```

Copy the contents of `claude_desktop_config.template.json` and merge the `mcpServers` block into your config. Then replace:

| Placeholder | Replace with |
|---|---|
| `C:\\PATH\\TO\\python.exe` | Your Python path from Step 4 |
| `C:\\PATH\\TO\\Odoo Connector\\server.py` | Full path to `server.py` in this folder |
| `YOUR_STAGING_INSTANCE` | Your staging subdomain (the part before `.dev.odoo.com`) |
| `YOUR_STAGING_DB` | Your staging database name (usually same as the subdomain) |
| `YOUR_LIVE_INSTANCE` | Your live subdomain (the part before `.odoo.com`) |
| `YOUR_LIVE_DB` | Your live database name (ask your Odoo admin if unsure) |
| `YOUR_EMAIL@yourcompany.com` | Your Odoo login email |
| `YOUR_STAGING_API_KEY` | API key from the staging instance |
| `YOUR_LIVE_API_KEY` | API key from the live instance |

> **Note:** Use double backslashes `\\` in all Windows paths inside the JSON.

---

## Step 6 — Restart Claude Desktop

Fully quit Claude Desktop via the **system tray** (bottom-right `^` → right-click Claude → **Quit**), then reopen it.

You should see three Odoo tools appear in Claude with a 🔨 icon.

---

## Step 7 — Test the connection

In Claude Desktop, ask:
> "Ping odoo-staging"

You should get back your username and server version confirming the connection.

---

## File reference

| File | Purpose |
|---|---|
| `server.py` | MCP server — all tools and access control logic |
| `odoo_client.py` | Odoo XML-RPC client wrapper |
| `claude_desktop_config.template.json` | Config template (fill in your details) |
| `requirements.txt` | Python dependencies |
| `.env.example` | Alternative: set credentials via .env file |
