"""Freeze five approved inputs under an owned runtime, then zip the frozen files.

No live file is modified. To retire a failed attempt, leave its timestamped
directory unused and run again. The script never selects a production baseline.
"""
import argparse
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import zipfile


def load(path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def capture(source, target):
    # Check stability only while capturing this file. The rest of the
    # pipeline must use the captured bytes even when the original advances.
    for _ in range(5):
        data = source.read_bytes()
        if data == source.read_bytes():
            target.parent.mkdir(parents=True, exist_ok=True)
            with target.open("xb") as stream:
                stream.write(data)
            return
    raise ValueError(f"{source.name} changed during capture")


def run(root, dsh_home, dry_run=False):
    root = root.resolve(strict=True)
    runtime = root / "runtime"
    owner = load(root / "owner.json")["owner"]
    state = load(root / "install.json")
    service = load(runtime / "service-config.json")
    if (not owner or state["owner"] != owner or service["owner"] != owner or
            state["mode"] != "installed-not-activated" or runtime.resolve() != runtime or
            Path(service["env"]["TIDEMIND_SANDBOX_ROOT"]).resolve() != runtime):
        raise ValueError("Inactive owned installation required")
    working = runtime / "memory" / "memory.db"
    if working.resolve(strict=True) != working:
        raise ValueError("Linked replica database refused")
    aurabot = dsh_home.resolve(strict=True) / "plugins-data" / "aurabot"
    persona = load(aurabot / "config.json")["persona"]["current"]
    if not re.fullmatch(r"[A-Za-z0-9_-]+", persona):
        raise ValueError("Unexpected persona filename")
    sources = {
        "memories.json": aurabot / "memories.json",
        "sessions.json": aurabot / "sessions.json",
        f"personas/{persona}.md": aurabot / "personas" / f"{persona}.md",
        "ai-memory/ledger.jsonl": dsh_home / "ai-memory" / "ledger.jsonl",
    }
    if dry_run:
        return {"dryRun": True, "files": 5, "cutoverAuthorized": False}
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = Path(tempfile.mkdtemp(prefix=f"frozen-baseline-{stamp}-", dir=runtime))
    frozen = directory / "frozen"
    frozen.mkdir()
    for name, source in sources.items():
        capture(source, frozen / name)
    items = load(frozen / "memories.json")["items"]
    if not isinstance(items, list) or any(
        not isinstance(item, dict) or not isinstance(item.get("id"), str) for item in items
    ):
        raise ValueError("Frozen Aurabot memory has invalid items")
    if len({item["id"] for item in items}) != len(items):
        raise ValueError("Duplicate IDs in frozen Aurabot memory")
    if not isinstance(load(frozen / "sessions.json")["chats"], dict):
        raise ValueError("Frozen QQ mapping is invalid")
    db = frozen / "memory.db"
    with (
        closing(sqlite3.connect(working.as_uri() + "?mode=ro", uri=True)) as src,
        closing(sqlite3.connect(db)) as dst,
    ):
        src.execute("PRAGMA query_only=ON")
        src.backup(dst)
        revision, baseline = dst.execute(
            "SELECT revision, baseline_hash FROM tidemind_replica WHERE id=1").fetchone()
        if revision != 0 or baseline != service["env"]["TIDEMIND_BASELINE_DATA_HASH"]:
            raise ValueError("Candidate SQLite baseline differs or has advanced")
        if dst.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise ValueError("Frozen SQLite copy failed integrity check")
    names = sorted([*sources, "memory.db"])
    hashes = {name: sha(frozen / name) for name in names}
    archive = directory / "baseline.zip"
    with zipfile.ZipFile(archive, "x", zipfile.ZIP_DEFLATED) as bundle:
        for name in names:
            bundle.write(frozen / name, name)
    with zipfile.ZipFile(archive) as bundle:
        if bundle.namelist() != names or any(
            hashlib.sha256(bundle.read(name)).hexdigest() != hashes[name] for name in names
        ):
            raise ValueError("Archive differs from frozen snapshot")
    return {
        "path": str(archive), "snapshot": str(frozen), "archiveSha256": sha(archive),
        "aurabotMemorySha256": hashes["memories.json"], "files": len(names),
        "frozenVerified": True, "cutoverAuthorized": False,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--dsh-home", type=Path, required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    print(json.dumps(run(args.root, args.dsh_home, args.dry_run)))
