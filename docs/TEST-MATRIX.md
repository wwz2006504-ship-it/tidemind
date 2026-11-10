# Test matrix — what runs where

This package ships 88 test files. They do **not** all run in the same environment, and pretending
otherwise is how a release looks broken. Here is the honest split, with what was verified for 3.0.0.

## Tier A — no host, no network (run these first)

```bash
node --test integration/test-tide-goals.mjs integration/test-tide-life.mjs \
  integration/test-tide-affect-traits.mjs integration/test-tide-moods.mjs \
  integration/test-tide-mood-rules.mjs integration/test-tide-sense.mjs \
  integration/test-desktop-pulse.mjs integration/test-desktop-pulse-goals.mjs \
  integration/test-lease-prefix.mjs
```

Verified on 3.0.0: **30 tests, 30 pass.** These cover the goal engine, propose-only life module,
capped/decaying affect and mood meters, trait candidates, the sense snapshot, the desktop add-on
mount and the lease `tide_`-prefix guard.

## Tier B — needs the shipped originals only

```bash
cd TideMind && python -m unittest test_entries -v && node --test test_upgrade.mjs
```

Verified on 3.0.0: **6 + 17 tests, all pass.** These start the real authority process
(`lease.mjs serve`), exercise the read-only retrieval API against a synthetic trigram FTS database,
run the reconcile pass, and cover the upgrade path. They need `node` and `python` on PATH and nothing else.

## Tier C — needs the DSH application tree

Some integration tests resolve modules from the DSH app itself (`cordis`,
`dsh-system-prompt`, `dsh-tools`, session storage). Point `TIDEMIND_APP_MODULES` at your install:

```bash
export TIDEMIND_APP_MODULES="/path/to/dsh/resources/app/node_modules/@deepseek-ai"
node --test integration/test-identity-memory.mjs integration/test-session-history.mjs \
  integration/test-session-history-transfer.mjs
```

Without it they fail with `ERR_MODULE_NOT_FOUND` on `<DSH_APP_DIR>` — that is a missing environment,
not a regression. Example on a machine without the app tree: `test-identity-memory.mjs` = 7 pass / 6 fail,
all six for this reason.

## Tier D — needs a private host clone (not shipped)

```bash
python integration/acceptance.py --dry-run
```

`acceptance.py` fingerprints the *installed* host packages and the author's custom modules. Those
inputs are private and are deliberately not in this package, so on your machine it prints:

```json
{"skipped": true, "reason": "host inputs unavailable; ...", "missing": ["host/custom-modules/SOURCE-MANIFEST.json"], ...}
```

and exits 0 for `--dry-run` (2 for a real run). To actually run it, restore `host/custom-modules`
from your own clone and set `TIDEMIND_SOURCE`, `TIDEMIND_QQ_SOURCE`, `TIDEMIND_ORIGINALS` and
`TIDEMIND_APP_MODULES`.

## Rule of thumb

If a test prints `UserWarning`/fails on a path containing a literal `<...>` placeholder, you are missing
an environment variable — set it, or accept that the tier is unavailable here. Never treat a Tier C/D
failure as a code failure without checking the path first.
