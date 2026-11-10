# TideMind

Memory, persona and bounded-autonomy framework for a long-running local agent — built around a single-writer authority (SQLite lease with a monotonic term and fenced transactions), layered memory with time-based fading, and a task scheduler whose every autonomous move needs the owner's approval.

> **Status: research code, version 3.0.0.** The deadline/penalty free parts are usable today; cloud standby, full round drain and production cutover are **not** validated. Nothing here is a claim of subjective experience: the mood and trait meters are simulated, capped and decaying by design.

## Requirements

- **Windows** for the desktop add-on (`integration/desktop-pulse.mjs` refuses to mount on other platforms and requires a real, non-symlinked runtime path).
- **Node.js 22+** (this release was tested on 24.17.0) and **Python 3.9+** for the installers.
- A host: **DSH** (the desktop agent runtime) with **Aurabot** installed. The add-on mounts through Aurabot's user-module loader, so plain `dsh plugin add` does not apply — see below.

## Install

```bash
python integration/install-desktop-pulse.py --dry-run   # prints the plan, writes nothing
python integration/install-desktop-pulse.py            # installs and mounts
python integration/install-desktop-pulse.py --rollback  # unloads, keeps data
```

What it does, in order:

1. Creates a private runtime root (`pulse-owner.json` + `runtime/tasks.db`) outside the host's own databases.
2. Writes one module wrapper to `~/.dsh/plugins-data/aurabot/modules/tidemind3-pulse/index.mjs` that imports `integration/desktop-pulse.mjs` from the release directory.
3. Mounts at rest: the task engine starts paused, chat is untouched.

The module also ships a panel (`integration/panel.js`, registered as `panel.js`): on Aurabot's
Extensions page it shows the live affect / moods / traits / life values, read from the add-on's own
`api.route('/state')` endpoint. Without it the numbers only exist inside the owner-only tool.

It refuses to run if Aurabot is in `safeMode`, if the target module directory already differs from the wrapper it recorded, or if the runtime root is a link.

## What it actually does

One owner-only tool, `tidemind3_control`, 22 actions, available **only** in the owner's private chat:

| Area | Behaviour | Hard caps |
|---|---|---|
| Task scheduler | observe → reflect → plan → verify, budget, rest switch | rest by default; owner resumes with a budget in units |
| Goals (`tide_goals`) | multi-round goals; finishing a round never finishes the goal | only an explicit `DONE:` verdict completes; `BLOCKED:` stops and keeps the reason; max 1–50 steps |
| Life (`tide_life`) | **propose-only** self goals | low-risk kinds only (memory summary, reading, reflection, planning, tidy notes); quiet 23:00–08:00; 6 h cooldown; max 3 pending; an unanswered message blocks the next one until the owner replies |
| Affect (`tide_affect`) | 8 short-lived states, simulated | half-life 3 h, one event moves a state by at most 0.25, every change needs a basis |
| Moods (`tide_moods`) | 7 independent meters scored from dialogue | owner private chat only; rule table is plain data; ≤0.1 per event, ≤0.3 per day, 72 h half-life; a sustained high only opens **one review notice** |
| Traits (`tide_traits`) | slow-moving tendencies, owner-approved candidates only | 5 reliable events + 7-day cooldown to propose; approval moves 0.02; identity core is locked and versioned |
| Sense (`tide_sense`) | observed / planned / completed snapshot | a completion must cite a fresh observation; stale evidence is refused |

Mood and trait values never gate a safety stop, never ask the owner for comfort, and never rewrite the identity core: a sustained high level only queues a review the owner decides on.

## Privacy boundary

- The lease authority and the read-only retrieval service bind `127.0.0.1` only; the client refuses non-loopback targets.
- These modules never write the host's memory database, persona, or QQ credentials: the lease database is a separate file, fenced by the sandbox check, and the store is opened read-only.
- No telemetry, no default outbound calls. Sync modules contact only the host you configure explicitly.

## Retrieval note

`TideMind/deploy/existing/tidemind-api.mjs` answers for exactly one agent id: `TIDEMIND_AGENT_ID` is **required** and has no default. Queries run against an FTS5 **trigram** index: tokens shorter than 3 characters cannot match, so CJK input is expanded into 3-character windows (a long Chinese sentence would otherwise only match when quoted verbatim).

## Repository layout

- `TideMind/` — lease/authority, reconcile, replica, deploy files, upgrade tests.
- `integration/` — the engine modules and their tests, plus `desktop-pulse.mjs` (the add-on entry).
- `host/` — source-only clones of the host packages these modules integrate with (`plugin`, `aurabot`, `aurabot-upstream`, `heartbeat`, `ai-memory`) with their SOURCE-MANIFEST hashes. No personas, configuration or credentials.
- `policy/`, `docs/` — execution policy and original integration notes.

## Running the tests

Three tiers of tests exist (see `docs/TEST-MATRIX.md` for the full split and what was verified).

Pure-logic tests (no host, no network):

```bash
node --test integration/test-tide-goals.mjs integration/test-tide-life.mjs integration/test-tide-affect-traits.mjs integration/test-tide-moods.mjs integration/test-tide-mood-rules.mjs integration/test-tide-sense.mjs integration/test-desktop-pulse.mjs integration/test-desktop-pulse-goals.mjs integration/test-lease-prefix.mjs
```

Entry-level tests against the shipped originals (these exercise `lease.mjs serve`, the retrieval API and the reconcile pass):

```bash
cd TideMind && python -m unittest test_entries -v && node --test test_upgrade.mjs
```

`integration/acceptance.py` is the author's full-host acceptance runner. It needs a **private host clone** (including the author's custom modules) that is deliberately not shipped here; without it the runner prints `{"skipped": true, ...}`, exits 0 for `--dry-run` and lists exactly which inputs are missing.

## Why editing a file inside a release directory does nothing

The module wrapper imports `releases/<hash>/integration/desktop-pulse.mjs`. Node caches ES modules by URL, so if the path stays the same, reloading the module (or restarting the loader) hands back the code from the first evaluation. Do not edit files in place: change the source, then generate a new release directory (its name is derived from the content hash, so the URL changes). Editing in place ten times runs the first version ten times.

## Versioning

`3.0.0` is the version this package installs. The wrapper written by the installer uses the same string; tag releases `v3.0.0`.

## License

MIT — see `LICENSE`. Third-party notices for the derived host sources are in `NOTICE.md`.

## 中文摘要

- 这是 TideMind 3.0：单写者租约 + 分层记忆 + 有闸门的自主任务；情绪与特质刻度是模拟值，有上限、会衰减，只改措辞，不碰安全闸门。
- 安装走 Aurabot 用户模块：`python integration/install-desktop-pulse.py`（先 `--dry-run` 看计划），回滚加 `--rollback`。
- 默认停在 rest，不会自己开活；要它动得由主人给预算。
- 不随包发布作者私有的 host 克隆与自定义模块，所以 `acceptance.py` 在别人机器上会明确报 skipped，而不是伪装通过。

---

*(Historical integration log: `docs/INTEGRATION-NOTES.md` — kept for traceability, its per-step report links are not part of this release.)*

See [DISCLAIMER.md](DISCLAIMER.md) for the project disclaimer.

简体中文：声明见 [DISCLAIMER.md](DISCLAIMER.md)。
