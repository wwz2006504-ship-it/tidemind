# TideMind

An open-source memory / persona / autonomy framework for a long-running AI agent, built around a single-writer authority (SQLite lease with a monotonic term and fenced transactions), signed state sync between a local primary and a cloud standby, and a bounded multi-step task scheduler.

> Status: research code. Most integration tests were written against a Windows desktop host (DSH / Aurabot). Tests that need that host are marked below; they will not run without it.

## What is here
- `TideMind/` – the framework: lease/authority, reconcile, replica, deploy files, upgrade tests.
- `integration/` – integration modules and tests.
  - Task scheduler: `task-checkpoints.mjs` (observe → reflect → plan → verify, budget, rest switch, cancel), `task-handoff.mjs`, `source-quiescer.mjs`, `runtime-transfer-drain.mjs`.
  - TideMind 3.0 add-ons: `tide-goals.mjs` (persistent multi-step goals), `tide-life.mjs` (propose-only low-risk self goals, quiet hours, cooldowns, no nagging), `tide-affect.mjs` / `tide-moods.mjs` / `tide-mood-rules.mjs` (simulated, capped, decaying mood state), `tide-traits.mjs` (slow traits with owner-approved candidates, locked identity core), `tide-sense.mjs` (observed / planned / completed state snapshot).
  - `desktop-pulse.mjs` – DSH user module that mounts the above behind one owner-only tool.
- `policy/` – tool-execution policy.
- `docs/INTEGRATION-NOTES.md` – original integration notes.

## Design rules the code enforces
- Original memory, persona and credentials are never written by these modules.
- Simulated emotion/traits are not claims of subjective experience; they only colour non-critical wording and never gate safety stops.
- Autonomy is propose-only until the owner approves; changes are capped, logged with a basis, and reversible.

## Running tests
Requires Node 22+. Pure-logic tests (no host needed):
```
cd integration
TIDEMIND_FIXTURE_STORE=isolated-pinned node --test test-tide-goals.mjs test-tide-life.mjs test-tide-affect-traits.mjs test-tide-moods.mjs test-tide-mood-rules.mjs test-tide-sense.mjs
```
Run test files one at a time; running many SQLite fixtures in parallel can be heavy.

## Not included
Personal data, memory databases, personas, credentials, the third-party host sources (install DSH / Aurabot yourself), and private custom modules. Hard-coded local paths were replaced with placeholders such as `C:/Users/USERNAME`, `<DSH_APP_DIR>` and `<MEMORY_LAYERS_DIR>`; set `TIDEMIND_APP_MODULES` and the other environment variables to your own locations before using the installers.

## License
No license has been chosen yet. Add one before publishing.

## 改了 release 里的文件后为什么“重载模块”不生效（重要）
模块入口 import 的是 `releases/<hash>/integration/desktop-pulse.mjs`。Node 的 ESM 会按 URL 缓存模块：路径没变，重载模块（甚至重启模块加载器）拿到的仍是第一次的旧代码。
所以**不要原地改 release 目录里的文件**。正确做法是把改动放进源码，再生成新的 release 目录（目录名取文件内容哈希，URL 随之变化），升级脚本 `--upgrade` 就是这么做的。原地改十次，跑的都是第一次那份。

