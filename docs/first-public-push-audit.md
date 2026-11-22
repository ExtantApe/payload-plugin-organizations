# First public push audit

2026-11-22, before the repo went public (owner's yes, D256, relayed).

- **Leak check:** `scripts/leak-check.sh` passed on 18 files.
- **Secrets:** no keys, passwords, tokens or private addresses in any commit's files or diffs. The only "token" words are npm package names in the lockfile and the release notes' "no stored token".
- **Private terms:** none in any file or diff. The commit author address is the GitHub noreply address, which is allowed.
- **Build output:** `dist/` and `node_modules/` are ignored and not committed.
- **License:** MIT, Copyright (c) 2026 EXTANT APE.
- **Content:** an empty plugin skeleton. No data, no fixtures, no player or member data.
