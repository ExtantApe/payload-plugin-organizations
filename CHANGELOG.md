# Changelog

## Unreleased

- The repo, with the standard Payload plugin kit. Public since 2026-11-22.
- The first version of the plugin (Captive Origins K5227, account model T4; follows D5228, D5234 and D5239):
  - `organizations`, `organization-members` and an append-only `organization-events` history. Organizations have a host-defined kind, a status of pending, active or closed, a ROR id, domains and private notes. People join at Coordinator, Member or Viewer.
  - A new organization is always pending, and its first Coordinator is approved by an approver the host names, with no time limit. Nobody approves themselves, and nobody raises their own level. Closing and reopening go through the same gate, and a reopening asks the veto again about everyone in it.
  - Only an approver sets a ROR id or domains. The shipped list of public mail, school and internet provider domains can't be put on an organization, and the host can add to it. A university matches people by domain only once it has a ROR id.
  - A last-Coordinator rule: the last active Coordinator can't leave or be demoted, also under two changes at once and from server code.
  - Host hooks `canCreate`, `canPrecreate`, `canUpdate`, `canApprove`, `canInvite`, `canChangeLevel`, `canRemove`, `canSeePrivate` and `canRead`, all failing closed on anything but an exact `true`.
  - A required `refuseMember` veto (or an explicit `false`), applied to server code too. The README warns that its reason is shown and can leak an age.
  - Deletes always throw, even with `overrideAccess`. Hooks get plain ids and the `id` and `data` of the change. A user from another sign-in collection counts as nobody. Names, notes and domain lists have length limits. Private notes are hidden from members.
  - `levelIn`, `organizationsOf`, `organizationField`, `matchOrganizations` and the domain helpers.
- Tested: 77 tests against real Payload 3.92 with an in-memory MongoDB replica set: each rule above, refusals over REST, GraphQL and bulk update, server-code attempts to revive or widen a membership, repeated two-at-once runs for the last-Coordinator, duplicate-invitation and unique-ROR rules, the picker, the domain matcher, and clean-up of the database and server at the end.
- Not tested: a database without transactions (the last-Coordinator guard needs a replica set), a live site, the admin screens in a browser, a very large number of members or domains, and any real ROR data.
