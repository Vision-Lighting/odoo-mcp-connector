"""Build the uploadable plugin zip.

Produces dist/odoo-mcp-connector.zip with the layout the Claude plugin
uploader requires: `.claude-plugin/plugin.json` at the ZIP ROOT (no wrapper
folder). Run this after editing any plugin file:

    py build_plugin.py

Then upload dist/odoo-mcp-connector.zip via Claude > Customize > Personal
plugins > Create plugin > Upload plugin (or attach it to a GitHub Release).
"""

import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "dist"
OUT = DIST / "odoo-mcp-connector.zip"

# Files shipped inside the plugin, mapped to their path within the zip.
INCLUDE = [
    ".claude-plugin/plugin.json",
    "_launcher.py",
    "server.py",
    "odoo_client.py",
    "pdfmonkey_client.py",
    "requirements.txt",
    "SETUP.md",
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
