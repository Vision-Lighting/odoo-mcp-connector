"""Bootstrap launcher for the Odoo MCP plugin.

Claude runs this with whatever `python` is on PATH. On first run it creates a
private virtual environment (under CLAUDE_PLUGIN_DATA so it survives plugin
updates), installs requirements.txt into it, then hands over to server.py.
On every later run, if the venv already matches requirements.txt, it skips
straight to launching the server — no install, no delay.

This means a colleague only needs Python installed and on PATH; they do NOT
need to run `pip install` themselves.
"""

import hashlib
import os
import subprocess
import sys
import time
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parent
REQUIREMENTS = PLUGIN_ROOT / "requirements.txt"
SERVER = PLUGIN_ROOT / "server.py"

# Persist the venv outside the plugin dir so it survives plugin updates.
_data = os.environ.get("CLAUDE_PLUGIN_DATA", "").strip()
DATA_DIR = Path(_data) if _data else (PLUGIN_ROOT / ".data")
VENV_DIR = DATA_DIR / "venv"


def _venv_python(venv: Path) -> Path:
    if os.name == "nt":
        return venv / "Scripts" / "python.exe"
    return venv / "bin" / "python"


def _requirements_hash() -> str:
    if not REQUIREMENTS.exists():
        return ""
    return hashlib.sha256(REQUIREMENTS.read_bytes()).hexdigest()


def _is_ready(py: Path, stamp: Path, want: str) -> bool:
    return (
        py.exists()
        and stamp.exists()
        and stamp.read_text(encoding="utf-8").strip() == want
    )


def _acquire_lock(lock: Path):
    """Cross-platform, dependency-free exclusive lock via O_CREAT|O_EXCL.

    All three MCP servers launch this file at once and share one venv dir, so
    setup must be serialized — otherwise concurrent venv/pip runs corrupt it.
    Returns the lock fd on success, or None if another process holds it.
    """
    try:
        return os.open(str(lock), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        return None


def _ensure_venv() -> Path:
    """Return the path to a Python interpreter that has the deps installed."""
    py = _venv_python(VENV_DIR)
    stamp = VENV_DIR / ".requirements.sha256"
    want = _requirements_hash()

    if _is_ready(py, stamp, want):
        return py  # venv already up to date — fast path

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    lock = DATA_DIR / ".venv.lock"
    fd = _acquire_lock(lock)

    # Another server is already building the venv — wait for it to finish.
    if fd is None:
        for _ in range(600):  # up to ~5 min
            if _is_ready(py, stamp, want):
                return py
            time.sleep(0.5)
        # Lock holder seems stuck; fall through and try the build ourselves.
        fd = _acquire_lock(lock)

    try:
        # Re-check under the lock in case the winner finished while we waited.
        if _is_ready(py, stamp, want):
            return py

        if not py.exists():
            subprocess.run([sys.executable, "-m", "venv", str(VENV_DIR)], check=True)

        if REQUIREMENTS.exists():
            subprocess.run(
                [str(py), "-m", "pip", "install", "--quiet",
                 "--disable-pip-version-check", "-r", str(REQUIREMENTS)],
                check=True,
            )
        stamp.write_text(want, encoding="utf-8")
        return py
    finally:
        if fd is not None:
            os.close(fd)
            try:
                lock.unlink()
            except OSError:
                pass


def main() -> None:
    try:
        py = _ensure_venv()
    except Exception as exc:  # noqa: BLE001 — never let bootstrap kill startup silently
        sys.stderr.write(
            f"[odoo-plugin] venv setup failed ({exc}); "
            f"falling back to the current interpreter.\n"
        )
        py = Path(sys.executable)

    # Replace this process with the server so stdin/stdout pipe straight through.
    os.execv(str(py), [str(py), str(SERVER)])


if __name__ == "__main__":
    main()
