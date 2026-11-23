# Decisions

Dated decisions for this repo, newest last.

- 2026-11-22: created from the ops starter kit, area `co-plugins`.
- 2026-11-22: first version built for Captive Origins K5227 (account model T4), following Captive Origins D5228 (organizations with Coordinator, Member and Viewer levels; a pending organization's first Coordinator approved by admins) and D5239 (a domain list ships in the plugin and the host can extend it; a university groups people only after staff set it up from ROR; a pending organization has no time limit; a minor never joins any organization). The plugin stays agnostic: the minors rule is the host's `refuseMember` veto, not built in.
- 2026-11-22: following EXTANT APE's review of the positions and sharing PRs: hooks fail closed on anything but an exact `true`, `refuseMember` is required (`false` opts out), re-activation and widening go back through the approver gate and the veto, nobody approves themselves, deletes always throw, changes go to an append-only `organization-events` history, ids are keyed by collection, text has length limits, and private notes are hidden from members.
- 2026-11-22: the plan in the package description (importers, suggestions) is cut to this first version: collections, levels, the domain list and matcher, and the picker. Importers and user suggestions are later pull requests.
