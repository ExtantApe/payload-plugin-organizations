# payload-plugin-organizations

Organizations for Payload: a curated list of zoos, labs, museums and other institutions, with ROR and Wikidata importers, a picker field, user suggestions a curator merges, and an email-domain hint that never grants access.

**Status:** a skeleton. The plugin does nothing yet; the pieces below land as separate pull requests. One test checks the empty plugin leaves a config alone.

## What it does

Planned, in this order:

- **An organizations collection,** curated: name, other names, type, country, website and email domains.
- **Importers for ROR and Wikidata.** Both are CC0. Wikidata also says which zoos hold accreditation, such as AZA.
- **A picker field** other collections use to point at an organization.
- **Suggestions from users,** which a curator merges into an existing organization or accepts as a new one.
- **A domain hint:** an email address's domain suggests an organization. It only suggests. It never grants a role, a membership or access.

The plugin holds no roles. Who can read, suggest, curate and import is whatever the host passes in, and each defaults to nobody.

## Install or build

Not on npm yet. To work on it:

```
npm install
npm test
npm run build
```

## License

MIT. Copyright (c) 2026 EXTANT APE. See `LICENSE`.
