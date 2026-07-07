"""Build the installable MCPB bundle.

Produces dist/odoo-mcp-connector.mcpb — an MCP Bundle (a zip with manifest.json
at the root) that installs into Claude Desktop via Settings > Extensions (or by
dragging the file in). The server is a zero-dependency Node.js script, so it
runs on the Node runtime bundled with Claude Desktop — users need nothing
installed.

    py build_mcpb.py

Validate/inspect the result with the official CLI:
    npx -y @anthropic-ai/mcpb@latest info dist/odoo-mcp-connector.mcpb
"""

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
OUT = DIST / "odoo-mcp-connector.mcpb"

# Files shipped inside the bundle. manifest.json MUST be at the zip root.
INCLUDE = [
    "manifest.json",
    "server/index.js",
]


def main() -> None:
    DIST.mkdir(exist_ok=True)
    missing = [f for f in INCLUDE if not (ROOT / f).exists()]
    if missing:
        raise SystemExit(f"Missing files, cannot build: {missing}")

    if OUT.exists():
        OUT.unlink()

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in INCLUDE:
            z.write(ROOT / rel, arcname=rel)

    print(f"Built {OUT} ({OUT.stat().st_size:,} bytes)")
    with zipfile.ZipFile(OUT) as z:
        for name in z.namelist():
            print(f"  {name}")


if __name__ == "__main__":
    main()
