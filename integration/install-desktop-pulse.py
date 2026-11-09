"""Install the TideMind 3.0 desktop add-on via Aurabot's user-module loader.

Preview: python install-desktop-pulse.py --dry-run
Rollback: python install-desktop-pulse.py --rollback
"""
import argparse
import importlib.util
import json
import shutil
import sqlite3
from pathlib import Path
import time
import uuid


module_spec = importlib.util.spec_from_file_location(
    "tidemind_local_install", Path(__file__).with_name("local-install.py")
)
installer = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(installer)
MODULE = "tidemind3-pulse"


def install(dry_run=False, rollback=False):
    aurabot = Path.home() / ".dsh/plugins-data/aurabot"
    modules = aurabot / "modules"
    root = installer.checked(installer.BASE / "TideMind3-desktop")
    target = modules / MODULE
    disabled = modules / ("_" + MODULE + ".disabled")
    if modules.resolve(strict=True) != modules or any(
        item.resolve() != item for item in (target, disabled)
    ):
        raise ValueError("Aurabot module directories must not be linked")
    owner_file = root / "pulse-owner.json"
    if rollback:
        if not target.exists():
            return {"removedFromLoader": True, "replayed": True, "dryRun": dry_run}
        owner = installer.load(owner_file)
        wrapper = target / "index.mjs"
        if not wrapper.is_file() or wrapper.resolve() != wrapper or wrapper.read_text(encoding="utf-8") != owner["wrapper"]:
            raise ValueError("Installed module changed; preserve it for review")
        if disabled.exists():
            raise ValueError("Disabled module already exists; preserve both")
        if not dry_run:
            target.rename(disabled)
            for _ in range(35):
                report = read_receipt(root, owner["installId"])
                if report and not report["mounted"]:
                    break
                time.sleep(0.25)
        return {"removedFromLoader": not dry_run, "dryRun": dry_run, "dataPreserved": True,
                "unloaded": not dry_run and bool(report and not report["mounted"])}
    if installer.load(aurabot / "config.json").get("safeMode"):
        raise ValueError("Aurabot safe mode disables user modules")
    if dry_run:
        return {"dryRun": True, "target": str(target), "startupRest": True, "profileWritten": False}
    if owner_file.exists():
        owner = installer.load(owner_file)
    else:
        if target.exists() or disabled.exists() or (root.exists() and any(root.iterdir())):
            raise ValueError("Existing unowned target refused")
        root.mkdir(exist_ok=True)
        installer.restrict(root)
        runtime = root / "runtime"
        runtime.mkdir(exist_ok=True)
        release, code = installer.stage_release(root, launcher=False)
        install_id = uuid.uuid4().hex
        entry = (code / "integration/desktop-pulse.mjs").as_uri()
        config = json.dumps({"root": str(runtime), "installId": install_id})
        wrapper = (
            f"import {{mountDesktopPulse}} from {json.dumps(entry)};\n"
            f"export default {{id:{json.dumps(MODULE)},name:'TideMind 3.0',"
            f"version:'3.0.0',api:1,setup:api=>mountDesktopPulse(api,{config})}};\n"
        )
        owner = {"installId": install_id, "release": release, "wrapper": wrapper}
        installer.save(owner_file, owner)
    if target.exists():
        if (target / "index.mjs").read_text(encoding="utf-8") != owner["wrapper"]:
            raise ValueError("Existing module differs")
    elif disabled.exists():
        raise ValueError("Module was rolled back; preserve the disabled copy")
    else:
        temp = modules / ("." + MODULE + "-" + uuid.uuid4().hex)
        temp.mkdir()
        (temp / "index.mjs").write_text(owner["wrapper"], encoding="utf-8")
        temp.rename(target)
    for _ in range(50):
        receipt = read_receipt(root, owner["installId"])
        if receipt and receipt["mounted"]:
            return {"installed": True, "mounted": True, "module": str(target),
                    "release": owner["release"], "startupRest": receipt["rest"], "pid": receipt["pid"]}
        time.sleep(0.25)
    raise ValueError("Module files installed, but the live Aurabot loader did not confirm mounting")


def _wait(root, install_id, mounted, tries=40):
    for _ in range(tries):
        report = read_receipt(root, install_id)
        if report and bool(report["mounted"]) == mounted:
            return True
        time.sleep(0.25)
    return False


def _restore_db(db, backup):
    for suffix in ("-wal", "-shm"):
        Path(str(db) + suffix).unlink(missing_ok=True)
    shutil.copy2(backup, db)


def upgrade(dry_run=False, revert=False):
    """Swap an installed module to the newest staged release; revert on any failure."""
    modules = Path.home() / ".dsh/plugins-data/aurabot/modules"
    root = installer.checked(installer.BASE / "TideMind3-desktop")
    target = modules / MODULE
    owner_file = root / "pulse-owner.json"
    if not owner_file.exists() or not target.exists():
        raise ValueError("Not installed; run the normal install first")
    owner = installer.load(owner_file)
    wrapper = target / "index.mjs"
    if not wrapper.is_file() or wrapper.read_text(encoding="utf-8") != owner["wrapper"]:
        raise ValueError("Installed module changed; preserve it for review")
    install_id = owner["installId"]
    db = root / "runtime/tasks.db"
    if revert:
        prev = owner.get("previous")
        old_dir = modules / ("_" + MODULE + ".prev-" + prev["release"]) if prev else None
        if not prev or not old_dir.is_dir() or not Path(prev["backup"]).is_file():
            raise ValueError("No previous release to return to")
        if dry_run:
            return {"dryRun": True, "revertTo": prev["release"], "tasksRestoredFrom": prev["backup"]}
        failed = modules / ("_" + MODULE + ".failed-" + owner["release"])
        if failed.exists():
            raise ValueError("Preserved copy already exists: " + str(failed))
        target.rename(failed)
        if not _wait(root, install_id, False):
            failed.rename(target)
            raise ValueError("Loader did not unload the module; nothing changed")
        _restore_db(db, prev["backup"])
        old_dir.rename(target)
        if not _wait(root, install_id, True):
            raise ValueError("Old release restored but loader has not confirmed mounting yet")
        installer.save(owner_file, {"installId": install_id, "release": prev["release"], "wrapper": prev["wrapper"]})
        return {"reverted": True, "release": prev["release"], "preserved": str(failed)}
    release, code = installer.stage_release(root, launcher=False)
    if release == owner["release"]:
        return {"upToDate": True, "release": release}
    if dry_run:
        return {"dryRun": True, "from": owner["release"], "to": release}
    prev_dir = modules / ("_" + MODULE + ".prev-" + owner["release"])
    failed = modules / ("_" + MODULE + ".failed-" + release)
    if prev_dir.exists() or failed.exists():
        raise ValueError("Earlier upgrade leftovers exist; preserve them and review")
    backup = root / ("runtime/tasks.db.before-" + owner["release"])
    if db.exists():
        src = sqlite3.connect(str(db))
        dst = sqlite3.connect(str(backup))
        with dst:
            src.backup(dst)
        src.close()
        dst.close()
    else:
        backup.write_bytes(b"")
    entry = (code / "integration/desktop-pulse.mjs").as_uri()
    config = json.dumps({"root": str(root / "runtime"), "installId": install_id})
    new_wrapper = (
        f"import {{mountDesktopPulse}} from {json.dumps(entry)};\n"
        f"export default {{id:{json.dumps(MODULE)},name:'TideMind 3.0',"
        f"version:'3.0.0',api:1,setup:api=>mountDesktopPulse(api,{config})}};\n"
    )
    target.rename(prev_dir)
    if not _wait(root, install_id, False):
        prev_dir.rename(target)
        raise ValueError("Loader did not unload the module; nothing changed")
    temp = modules / ("." + MODULE + "-" + uuid.uuid4().hex)
    temp.mkdir()
    (temp / "index.mjs").write_text(new_wrapper, encoding="utf-8")
    temp.rename(target)
    if not _wait(root, install_id, True, 60):
        target.rename(failed)
        _wait(root, install_id, False, 20)
        if backup.stat().st_size:
            _restore_db(db, backup)
        prev_dir.rename(target)
        ok = _wait(root, install_id, True, 60)
        raise ValueError("New release did not mount; old release restored"
                         + ("" if ok else " (mount not yet confirmed)") + ". Copy kept at " + str(failed))
    installer.save(owner_file, {"installId": install_id, "release": release, "wrapper": new_wrapper,
                                "previous": {"release": owner["release"], "wrapper": owner["wrapper"],
                                             "backup": str(backup)}})
    return {"upgraded": True, "from": owner["release"], "to": release, "mounted": True}


def read_receipt(root, install_id):
    path = root / "runtime/mounted.json"
    if not path.is_file():
        return None
    receipt = installer.load(path)
    return receipt if receipt.get("installId") == install_id else None


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--rollback", action="store_true")
    parser.add_argument("--upgrade", action="store_true")
    parser.add_argument("--revert-upgrade", action="store_true")
    args = parser.parse_args()
    if args.upgrade or args.revert_upgrade:
        print(json.dumps(upgrade(args.dry_run, args.revert_upgrade)))
    else:
        print(json.dumps(install(args.dry_run, args.rollback)))
