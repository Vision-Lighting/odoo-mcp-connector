# Vision Lighting – Odoo MCP Connector Setup

Connects Claude Desktop to the Vision Lighting **live** Odoo instance as a single
server:

- **Read** anything (products, sales orders, partners, etc.)
- **Restricted writes** — products, variants, images, pricelists, project tasks,
  helpdesk tickets, contacts, and quote-stage sales orders (the write allowlist
  lives in `server/index.js`)
- **PDFMonkey** datasheet generation

The server is a single zero-dependency Node.js script that runs on the Node
runtime **bundled with Claude Desktop** — you do **not** need Python, Node, or
anything else installed.

---

## Install (one file, no prerequisites)

1. Install [Claude Desktop](https://claude.ai/download) if you haven't already.
2. Download **`odoo-mcp-connector.mcpb`** from the
   [latest release](https://github.com/Vision-Lighting/odoo-mcp-connector/releases/latest).
   (Do **not** use the green "Code → Download ZIP" — that's the source, not the bundle.)
3. In Claude Desktop, open **Settings → Extensions** and drag the `.mcpb` file in
   (or **Advanced settings → Install Extension** and select it). It also appears
   under **Settings → Connectors** once installed.
4. When prompted, enter:
   - **Odoo login email**
   - **Odoo URL** — e.g. `https://your-company.odoo.com`
   - **Database name**
   - **Odoo API key** — see *Get your API key* below
   - PDFMonkey API key + template ID are optional (only for datasheets)
5. Enable the extension.
6. Test it: ask Claude *"Ping Odoo"*. You should get back your username and the
   server version.

### Get your API key
1. Log in to Odoo → **Settings → My Profile** (top-right menu)
2. **Account Security** tab → **API Keys** → **New Key**
3. Name it (e.g. "Claude Desktop") and copy the key — you won't see it again

---

## Building the bundle (maintainers)

```
py build_mcpb.py
```

produces `dist/odoo-mcp-connector.mcpb`. Attach it to a GitHub release.
Validate with `npx -y @anthropic-ai/mcpb@latest info dist/odoo-mcp-connector.mcpb`.

## Running from source (advanced / Claude Code)

The server is plain Node (>=18) with no npm dependencies:

```
node server/index.js
```

with these environment variables set: `ODOO_URL`, `ODOO_DB`, `ODOO_USERNAME`,
`ODOO_API_KEY`, and optionally `ODOO_MODE` (`staging` | `live_ro` | `live_rw`,
default `live_rw`), `PDFMONKEY_API_KEY`, `PDFMONKEY_TEMPLATE_ID`.

For Claude Code, add it as a local MCP server:

```
claude mcp add odoo-live-rw -e ODOO_URL=... -e ODOO_DB=... -e ODOO_USERNAME=... -e ODOO_API_KEY=... -- node "<path>/server/index.js"
```

---

## File reference

| File | Purpose |
|---|---|
| `manifest.json` | MCPB bundle manifest (server config, install-time config prompts) |
| `server/index.js` | The whole server — MCP stdio transport, Odoo JSON-RPC client, all tools, write allowlist, PDFMonkey datasheet generation |
| `build_mcpb.py` | Builds `dist/odoo-mcp-connector.mcpb` |

### History

v3.0.0 rewrote the server from Python to zero-dependency Node.js so the bundle
runs on Claude Desktop's built-in runtime (colleagues no longer need Python).
The staging-only `delivery_split_from_excel` tool was retired in the rewrite
(it needed the `openpyxl` Python package); everything else was ported 1:1.
