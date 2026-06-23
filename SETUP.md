# Vision Lighting – Odoo MCP Connector Setup

Connects Claude Desktop to the Vision Lighting **live** Odoo instance as a single
server:

- **Read** anything (products, sales orders, partners, etc.)
- **Restricted writes** — products, variants, images, pricelists, project tasks,
  helpdesk tickets, and contacts (the write allowlist lives in `server.py`)
- **PDFMonkey** datasheet generation

> The old staging and separate read-only servers have been retired — there is now
> one live read-write server.

---

## Recommended: install the `.mcpb` bundle (one click)

This is the easiest way and needs no manual `pip install`.

### Prerequisites
- [Claude Desktop](https://claude.ai/download) installed
- Python 3.10+ on your PATH — install from https://www.python.org/downloads/
  and tick **"Add Python to PATH"**. Verify with `py --version` in a terminal.

### Steps
1. Download **`odoo-mcp-connector.mcpb`** from the
   [latest release](https://github.com/Vision-Lighting/odoo-mcp-connector/releases/latest).
   (Do **not** use the green "Code → Download ZIP" — that's the source, not the bundle.)
2. In Claude Desktop, open **Settings → Extensions** and drag the `.mcpb` file in
   (or **Advanced → Install Extension** and select it).
3. When prompted, enter:
   - **Odoo login email**
   - **Odoo URL** — e.g. `https://your-company.odoo.com`
   - **Database name**
   - **Odoo API key** — see *Get your API key* below
   - PDFMonkey API key + template ID are optional (only for datasheets)
4. Enable the extension. On first launch it auto-creates a private virtual
   environment and installs its dependencies — this takes a few seconds.
5. Test it: ask Claude *"Ping Odoo"*. You should get back your username and the
   server version.

### Get your API key
1. Log in to Odoo → **Settings → My Profile** (top-right menu)
2. **Account Security** tab → **API Keys** → **New Key**
3. Name it (e.g. "Claude Desktop") and copy the key — you won't see it again

---

## Alternative: manual config (advanced / Claude Code)

If you'd rather wire it up by hand (e.g. for Claude Code, or to run from source):

1. Copy this folder to your machine and install deps:
   ```
   py -m pip install -r requirements.txt
   ```
2. Find your Python path: `py -c "import sys; print(sys.executable)"`
3. Merge `claude_desktop_config.template.json` into your Claude Desktop config at
   `C:\Users\YOUR_NAME\AppData\Roaming\Claude\claude_desktop_config.json`, filling
   in the placeholders (use double backslashes `\\` in Windows paths).
4. Fully quit Claude Desktop from the system tray, then reopen it.

---

## File reference

| File | Purpose |
|---|---|
| `manifest.json` | MCPB bundle manifest (servers, install-time config prompts) |
| `_launcher.py` | First-run bootstrap — builds a private venv and installs deps |
| `build_mcpb.py` | Builds `dist/odoo-mcp-connector.mcpb` |
| `server.py` | MCP server — all tools and the write allowlist |
| `odoo_client.py` | Odoo XML-RPC client wrapper |
| `pdfmonkey_client.py` | PDFMonkey datasheet client |
| `claude_desktop_config.template.json` | Manual-config template (advanced) |
| `requirements.txt` | Python dependencies |
| `.env.example` | Alternative: set credentials via a `.env` file |
