# Changelog

## 3.0.0 — 2026-11-09

First public packaging of TideMind 3.0.

### Added
- `integration/panel.js` + `api.route('/state')`: the add-on now ships a panel that renders the
  real affect / moods / traits / life values on Aurabot's Extensions page.
- `LICENSE` (MIT), root `package.json` (version, engines, test scripts), `docs/TEST-MATRIX.md`,
  CI workflow (`Tier A` on Linux, `Tier B` on Windows).
- `TIDEMIND_AGENT_ID` (required), `TIDEMIND_PROTECTED_DIRS`, `TIDEMIND_DESKTOP_ROOT`,
  `TIDEMIND_LIVE_STORE`, `TIDEMIND_SOURCE` / `TIDEMIND_QQ_SOURCE` / `TIDEMIND_ORIGINALS`.

### Fixed
- `host/aurabot`, `host/aurabot-upstream`, `host/heartbeat`, `host/ai-memory` are shipped again.
  Without them `lease.mjs serve` and `test_upgrade.mjs` crashed with `ERR_MODULE_NOT_FOUND`.
- Installer base directory, live-store path and the diagnose inputs no longer point at
  `C:\Users\USERNAME\...` placeholders.
- The retrieval service no longer hard-codes an agent id; it fails closed when `TIDEMIND_AGENT_ID` is unset.
- CJK recall: queries are expanded into 3-character windows, since the FTS5 trigram index cannot match
  a whole Chinese sentence as a single token.
- `lease.mjs` / `tide-replica.mjs`: the "never write a live directory" guard was literal placeholders
  and never matched anything. It now reads `TIDEMIND_PROTECTED_DIRS`.
- `integration/acceptance.py` reports `{"skipped": true, ...}` and lists missing host inputs instead of
  crashing on a placeholder path.

### Changed
- The module wrapper is generated with a cache-busting dynamic import, so editing the release and
  reloading the module actually takes effect (Node caches ES modules by URL).
- Personal references were removed from the shipped sources: household form of address, private
  example strings, persona id and avatar filename, machine paths. Code logic unchanged; each
  manifest carries both the pristine `originalSha256` and the shipped `isolatedSha256`.
- `host/custom-modules` is intentionally not shipped (private modules with machine-specific paths).
