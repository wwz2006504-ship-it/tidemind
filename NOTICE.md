# Third-party notices

This package is an isolated derivative of two MIT-licensed host packages. Original upstream files
are unchanged; the isolated copies and their hashes live in the matching `SOURCE-MANIFEST.json`.

- `host/plugin` — isolated derivative of the installed `dsh-memory-layers 0.1.1` (MIT).
  - package name is deliberately left as-is; **do not install this folder** — it is a source copy
    used for hashing and tests, not a replacement plugin.
- `host/aurabot`, `host/aurabot-upstream` — isolated source subset of `dsh-aurabot-qq 1.0.1` (MIT).
- `host/heartbeat`, `host/ai-memory` — isolated source subsets of the same host (MIT).

No original personas, configuration, credentials, chat logs or memory databases are included.

`host/custom-modules` is **not** shipped: those modules carry machine-specific paths and are private
to the author. `integration/acceptance.py` therefore reports `skipped` until you supply your own
host clone (see README).

The derived host sources are provided for reference and for running the isolated tests. If you
redistribute this package, keep this notice and the upstream MIT terms.

This package's own license: MIT (see `LICENSE`).

## Neutralisation applied to the host copies

Before packaging, personal references in these source copies were removed: the author's household
form of address, private catchphrases used as default example strings, the agent's persona id and
avatar filename, and machine-specific paths. **Code logic is unchanged** — only comments, default
example strings, display names and one asset filename differ.

Each manifest keeps both hashes:

- `originalSha256` / `sha256` — the pristine file as installed on the author's machine;
- `isolatedSha256` — the neutralised copy actually shipped here.

If you regenerate `host/` from your own host clone, both will match again.

## Not included
The default avatar image that the upstream host package ships (`assets/avatar-default.jpg`) is intentionally removed from this
repository; the host source copies still reference that filename, so supply your own image if you run the host.
