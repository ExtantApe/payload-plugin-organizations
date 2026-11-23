# payload-plugin-organizations

Organizations for Payload: places people work or belong, with Coordinator, Member and Viewer levels, pending organizations a host approves, a shipped list of public mail domains, and a picker field. Access rules are the host's.

**Status:** first version, 0.x, not on npm yet. It is tested against real Payload 3.92 with an in-memory MongoDB replica set (105 tests, including two requests at once, a database without transactions, and refusals over REST, GraphQL and bulk update). It has not been used in a live site yet, the admin screens have not been checked in a browser, and the ROR and domain data are entered by hand: nothing here calls ROR. It needs a database that supports transactions (a MongoDB replica set), because the last-Coordinator rule and the history rows rely on them. At start-up the plugin opens and rolls back one transaction, and refuses to run if the database hands none back, as db-mongodb does with `transactionOptions: false`. `allowWithoutTransactions: true` turns that check off, at your own risk.

## What it does

Three collections.

- **`organizations`**: a name, a kind you define (zoo, lab, business and so on), a status of pending, active or closed, an optional ROR id, a list of email domains and private notes for staff.
- **`organization-members`**: who is in which organization, at which level (Coordinator, Member or Viewer), with a status of invited, active or removed.
- **`organization-events`**: an append-only history of every change. Nothing edits or deletes it.

Rules the plugin enforces itself, for server code as well as for clients:

- A new organization is always pending, whatever the client sends. Its maker waits as first Coordinator. An approver activates that Coordinator, which makes the organization active. A pending organization has no time limit and gives its people nothing.
- Nobody approves themselves, or approves, reopens or changes the ROR id or domains of an organization they made or have accepted a place in, even if they have since left. An invitation never accepted doesn't count, so an invitation can't lock approvers out. Closing skips this check, because it takes access away. Nobody raises their own level.
- An organization always keeps an active Coordinator. The last one can't leave or be demoted, and two Coordinators leaving at the same moment leave one.
- A closed organization can't be changed, joined or accepted into. Reopening it needs an approver and asks your veto again about everyone active in it, and anyone the veto refuses is ended. People who are only invited are checked when they accept. Reopening visibly ends active people the veto now refuses, with a remove event.
- Only an approver sets a ROR id or domains, because they decide who an organization suggests, and never one who made it or belongs to it. A proposer's domains and ROR id are dropped, an approver's own proposal included. Server code keeps them.
- Public mail, school and internet provider domains, and public suffixes such as `co.uk` and `github.io`, can't be put on an organization. The suffix check uses the Public Suffix List through the `tldts` package. A domain already on an organization stays even if you later add it to `genericDomains`; only added domains are checked.
- A listed domain also matches every subdomain. If `zoo.org` is listed, `mail.zoo.org` and `a.b.zoo.org` match it. List only domains whose whole name space belongs to the organization.
- Bulk updates and deletes on the plugin's collections are refused, even from server code, because a bulk update can commit a document whose later hook failed. Change one document at a time.
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
- `refuseMember`: required. A veto asked on every acceptance, approval, level change and reopening, and by `matchOrganizations`, even from server code. It is not asked when one user invites another, so an inviter sees the same answer for every account and can't tell which ones the veto covers; the person is refused when they accept, and the row stays invited. A level change that the veto refuses on an active row reads the same to the changer as any change they aren't allowed to make; only server code sees the reason. A level can't be changed on a row that is still invited (invite again), because the veto would answer. It is asked at invitation only for server code and for someone inviting themselves, such as the maker of an organization, where nobody else can read the answer. Return `null` to go ahead, or a reason to refuse. Anything else refuses with a general message. It must be a function, or exactly `false` to say plainly that you have no veto; `null`, `0`, an empty string and `true` throw when the plugin is set up. A host keeps minors out of every organization with it. An approver activating a person sees the reason too, so the host's approvers are people you trust with it.
  **Warning:** the reason is shown to whoever was refused. Don't write a reason that gives away something private, such as an age. Return a general one like `Not available for this account.`
- `canSeePrivate`: who reads or writes private notes. Default nobody, so members never see them.
- `canRead`: who reads every organization, membership and history row, such as staff. Everyone else sees their own organizations. A member sees the Coordinators and their own row. A Coordinator sees everyone in theirs and reads its history.
- `rorRequiredKinds`: kinds that match people by domain only once they have a ROR id. Put universities here.
- `genericDomains`: more domains for the shipped list. An entry starting with `*.` covers everything under it.
- `allowWithoutTransactions`: default false. See the status note.
- `audit`: `before` and `after` hooks for every event. A `before` hook that throws stops the change.
- `users`: the users collection, default `users`. A person from any other sign-in collection counts as nobody.

### Helpers

- `levelIn(req, organizationId)`: the highest level the signed-in user holds in an active organization, or null.
- `organizationsOf(req, { atLeast? })`: the active organizations they are in, with levels.
- `organizationField({ name?, hasMany?, kinds?, required? })`: a picker for host collections. It offers only active organizations, and the server refuses a newly chosen pending, closed, unreadable or wrong-kind one. The editor's own read access applies, so someone can't attach an organization they can't see, and every refusal reads the same. Server code that skips access skips this check too. One chosen earlier stays even after it closes.
- `matchOrganizations(payloadOrReq, user, { assumeVerified? })`: the active organizations a user's address suggests, by its domain or a parent domain. It is a hint. It never adds anyone, it reads without access rules, and it has no route, so show the result only to the person it is about. It reads the user again from the database, so pass only the id. It returns nothing until the user's `_verified` is `true` (or you pass `assumeVerified: true` because you checked the address another way), and it runs your veto itself (action `suggest`), dropping any organization the veto refuses. Payload 3.92 doesn't clear `_verified` when a user changes their email, so reset it yourself in that case.
- `GENERIC_DOMAINS`, `isGenericDomain`, `isPublicSuffix`, `normalizeDomain`, `domainOf` and `normalizeRor`.

`levelIn` and `organizationsOf` throw on a read error. Wrap them in your own access functions so an error means no.

## Limits

- Invitations are rows. The plugin sends no email.
- An invitation to an id that doesn't exist is refused with the same words as any refused invitation, and one to an existing account succeeds, so a caller can tell the two apart. Use user ids nobody can guess (database object ids are fine; small counting numbers are not). Someone who can't see a row that already exists is given the same refusal, not a message saying the person is already in.
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
