# payload-plugin-organizations

Organizations for Payload: places people work or belong, with Coordinator, Member and Viewer levels, pending organizations a host approves, a shipped list of public mail domains, and a picker field. Access rules are the host's.

**Status:** first version, 0.x, not on npm yet. It is tested against real Payload 3.92 with an in-memory MongoDB replica set (77 tests, including two requests at once and refusals over REST, GraphQL and bulk update). It has not been used in a live site yet, the admin screens have not been checked in a browser, and the ROR and domain data are entered by hand: nothing here calls ROR. It needs a database that supports transactions (a MongoDB replica set), because the last-Coordinator rule relies on one.

## What it does

Three collections.

- **`organizations`**: a name, a kind you define (zoo, lab, business and so on), a status of pending, active or closed, an optional ROR id, a list of email domains and private notes for staff.
- **`organization-members`**: who is in which organization, at which level (Coordinator, Member or Viewer), with a status of invited, active or removed.
- **`organization-events`**: an append-only history of every change. Nothing edits or deletes it.

Rules the plugin enforces itself, for server code as well as for clients:

- A new organization is always pending, whatever the client sends. Its maker waits as first Coordinator. An approver activates that Coordinator, which makes the organization active. A pending organization has no time limit and gives its people nothing.
- Nobody approves themselves, or an organization they made or belong to. Nobody raises their own level.
- An organization always keeps an active Coordinator. The last one can't leave or be demoted, and two Coordinators leaving at the same moment leave one.
- A closed organization can't be changed, joined or accepted into. Reopening it needs an approver and asks your veto again about everyone in it. Anyone the veto refuses is ended.
- Only an approver sets a ROR id or domains, because they decide who an organization suggests. A proposer's domains and ROR id are dropped.
- Public mail, school and internet provider domains can't be put on an organization.
- A removed member is final, and a person can't hold two live rows in one organization. Nothing is deleted, not even by server code that skips access.
- Organization kind and maker are fixed. On a membership only level and status change.

Everything else is the host's call, and every host hook fails closed: only an exact `true` allows. With no hooks, nobody can do anything.

## Install and set up

```
npm install @extantape/payload-plugin-organizations
```

```ts
import { organizations, organizationField } from '@extantape/payload-plugin-organizations'

export default buildConfig({
  plugins: [
    organizations({
      kinds: [{ value: 'zoo' }, { value: 'lab' }, { value: 'university' }],
      rorRequiredKinds: ['university'],
      genericDomains: ['*.my-isp.example'],
      canCreate: ({ user }) => user.verified === true,
      canApprove: ({ user }) => user.role === 'staff',
      canUpdate: ({ user, actorLevel }) => user.role === 'staff' || actorLevel === 'coordinator',
      canInvite: ({ user, actorLevel }) => user.role === 'staff' || actorLevel === 'coordinator',
      canChangeLevel: ({ user, actorLevel }) => user.role === 'staff' || actorLevel === 'coordinator',
      canSeePrivate: ({ user }) => user.role === 'staff',
      canRead: ({ user }) => user.role === 'staff',
      refuseMember: ({ subject }) => (subject.minor ? 'Not available for this account.' : null),
    }),
  ],
  collections: [{ slug: 'animals', fields: [organizationField({ name: 'owner' })] }],
})
```

### Options

- `kinds`: the kinds of organization. With none, none can be made.
- `canCreate`: who may propose an organization. `canPrecreate`: who may make one with nobody in it, to be claimed later (default nobody).
- `canUpdate`: who may rename it or change its private notes. `canApprove`: who may approve, close or reopen it, change its ROR id or domains, and activate a person in a pending organization.
- `canInvite`, `canChangeLevel` and `canRemove` (default: `canChangeLevel`): who may add, change or remove people. Each gets the organization, the membership, the `id` and `data` of the change and `actorLevel`, the asker's own level there. Anyone can leave for themselves, and a person accepts their own invitation.
- `refuseMember`: required. A veto asked on every invitation, acceptance, approval, level change and reopening, even from server code. Return `null` to go ahead, or a reason to refuse. Anything else refuses with a general message. Pass `refuseMember: false` to say plainly that you have no veto. A host keeps minors out of every organization with it.
  **Warning:** the reason is shown to whoever was refused. Don't write a reason that gives away something private, such as an age. Return a general one like `Not available for this account.`
- `canSeePrivate`: who reads or writes private notes. Default nobody, so members never see them.
- `canRead`: who reads every organization, membership and history row, such as staff. Everyone else sees their own organizations. A member sees the Coordinators and their own row. A Coordinator sees everyone in theirs and reads its history.
- `rorRequiredKinds`: kinds that match people by domain only once they have a ROR id. Put universities here.
- `genericDomains`: more domains for the shipped list. An entry starting with `*.` covers everything under it.
- `audit`: `before` and `after` hooks for every event. A `before` hook that throws stops the change.
- `users`: the users collection, default `users`. A person from any other sign-in collection counts as nobody.

### Helpers

- `levelIn(req, organizationId)`: the highest level the signed-in user holds in an active organization, or null.
- `organizationsOf(req, { atLeast? })`: the active organizations they are in, with levels.
- `organizationField({ name?, hasMany?, kinds?, required? })`: a picker for host collections. It offers only active organizations, and the server refuses a newly chosen pending, closed or wrong-kind one. One chosen earlier stays even after it closes.
- `matchOrganizations(payloadOrReq, email)`: the active organizations an address suggests, by its domain or a parent domain. It is a hint. It never adds anyone, it reads without access rules, and it has no route, so show the result only to the person it is about. Don't call it for a minor.
- `GENERIC_DOMAINS`, `isGenericDomain`, `normalizeDomain`, `domainOf` and `normalizeRor`.

`levelIn` and `organizationsOf` throw on a read error. Wrap them in your own access functions so an error means no.

## Limits

- Invitations are rows. The plugin sends no email.
- No importer for ROR or Wikidata, and no live check of a domain.
- A host collection can point at an organization. Records don't inherit from parent organizations.
- Working groups inside an organization are not here.

## Build and test

```
npm install
npm test
npm run build
```

## License

MIT. Copyright (c) 2026 EXTANT APE. See `LICENSE`.

Contributions arrive as pull requests from `co/` branches in this repo. Only the owner merges.
