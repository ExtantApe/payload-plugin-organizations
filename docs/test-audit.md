# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-28: plain field names, invitations and duplicated records

- Promises added: every collection and global refuses a save with a top-level key that isn't a plain field name, or with data that isn't an object, for every caller; a `pendingLevel` sent with a new invitation is dropped; the picker checks a duplicated record as it checks a new one.
- Covered: the 211 tests in this repo pass. The promises above are untested by this repo's suite. 13 further tests, not in this repo, passed locally along with it.
- Not tested: a live site.

## 2026-11-27: approvers and read access (0.3.0)

- Promise documented: with access checks on, `canApprove` alone isn't enough to activate, approve, close, reopen or change a ROR id or domains. The person also needs read access to the organization, or to the membership row when they activate a person.
- Before: staff, who can read everything in the test site, were shown approving. No test had an approver without read access.
- Added: `test/write-limits.test.ts`, "an approver and read access" (18 tests, 211 in all). One approver who isn't staff or a member, with only `canRead` changing. Activating a first Coordinator, approving, closing, reopening, a ROR id and domains: refused on every update path with nothing changed, then allowed once they can read. All 18 fail when run against the 0.2.0 source.
- Gaps skipped: an approver whose read access comes from their own membership (the existing tests of Coordinators and members cover that read rule); a host that scopes read access to some organizations only (the existing narrower and wider read rule tests cover how the two rules combine); the admin screens; a live site.

## 2026-11-27: read limits on writes

- Promises added: an access-checked update of an organization or membership needs read access under the plugin's rule and the host's; a person can decline, or try to accept, their own hidden invitation by sending that status alone, and gets no document back.
- Covered: `test/write-limits.test.ts` (38 tests, 193 in all). A stranger and a refused minor across Local (depth 0 to 2), REST and GraphQL updates, plus duplicate and delete, with GraphQL refusals checked to come from execution and not the schema. Server code that passes a user with access checks off. Decline and accept on a hidden row, including a veto whose quiet answer refuses while the real one allows. Extra fields, other people's rows, organizations, declined, active and removed rows. Create answers for people who can't read the result. Coordinators, staff and members who may write. Host read rules that are wider, narrower, throwing or returning odd values.
- Changed: `test/guard.test.ts` leaves the quiet veto question out of its silent-log check, because access rules ask it before the transaction guard runs. It still expects no audit hook and no real veto call.
- Gaps skipped: join fields (the plugin adds none); versions and restore (no collection has them); the admin screens (no browser test yet); host collections that populate memberships through their own writes; a live site.

## 2026-11-27: what an invited account can read

- Promises added: until a person accepts, the organization, its name and who invited them are shown only if the veto would let them accept, in reads and in what their own writes send back; they can still decline; anything but a clear allow in two seconds hides them; the inviter's side is unchanged; Payload's document locks are off for the plugin's collections.
- Covered: `test/invited-view.test.ts` (18 tests, 155 in all). Writes to their own row: a no-op change, a decline (which still takes effect) and a no-op on a declined or withdrawn invitation, over the Local API and REST at depth 0 and 1 and over GraphQL, with the allowed invitee and the inviter still getting the full row. Lock settings on all three collections. Every read path an invited account has with `overrideAccess: false`: find and findByID at depth 0 to 2 on organizations, memberships and history, sorting on name and inviter, a nested name filter, `select`, populated relationships from a host collection, REST lists, single documents and counts, GraphQL, `levelIn` and `organizationsOf`, and the picker. Filters with right and wrong guesses count the same. Withdrawn and declined invitations. Accept still refused, decline still works. Allowed invitee, inviter (same shapes over the Local API and REST, no veto call), Coordinator, active member, staff and a pending organization's maker. Fail closed on throw, rejection, wrong answers, timeout and a veto reading the same collections.
- Gaps skipped: versions and drafts (none of the plugin's collections has them); `matchOrganizations` (it already runs the veto and needs no invitation); the admin screens (no browser test yet); timing on the inviter's side (no veto call on that path, so no clock test); `refuseMember: false` (the test site has one config; that branch shows the details, as before); a veto that answers differently on `preview` (a host contract in the README, which code can't check); a separate test for each write field such as `pendingLevel` (one rule on every returned document covers them, and the tests prove it on three kinds of write).

## 2026-11-23: the row lock as an oracle

- Promise added: a refused change never touches a membership row, and the lock write comes only after every refusal and the veto, so a Coordinator's changes can't show whether a vetoed minor is accepting at the same moment. The conflict matcher maps only the database's write-conflict code to the someone-else refusal.
- Covered: `test/offer-race.test.ts` (10 tests, 136 in all). Matcher negatives: the `TransientTransactionError` label alone, message only, a wrong-type code. Refused changes (a vetoed accept over the Local API and REST, an unknown level, a bad status, an organization change) make no lock write and leave the row, `updatedAt` included, as it was; an allowed change makes exactly one lock write. A Coordinator's no-op change while a vetoed minor accepts is compared with the same change with nothing running, 12 rounds each over the Local API and REST. Four of the five new tests fail on the previous code; the fifth is the positive control.
- Gaps skipped: `allowWithoutTransactions: true` run end to end (the updatedAt bump came from the lock write, which the call counts and unchanged row cover); GraphQL (same hook).

## 2026-11-23: withdraw and accept at the same moment

- Promise added: when a withdraw and an accept (or any two changes) meet on one membership row, one wins and the other gets a plain 403, with no raw database error and no 500.
- Covered: `test/offer-race.test.ts` (5 tests, 131 in all): the conflict matcher on the error shapes the driver gives (code 112, `WriteConflict`, the `TransientTransactionError` label, nested causes, a loop that must end); a row held by another open transaction, refused cleanly over the Local API and over REST with the row unchanged; eight rounds of a real withdraw and accept at once on a replica set over the Local API and over REST, each with at least one success, any failure a plain 403, and a final row that is either accepted or withdrawn. The first four fail when the row-lock write is removed.
- Gaps skipped: forcing the timing of the two-at-once rounds (they may run one after the other, and then both succeed; the held-row tests cover the conflict itself); GraphQL (it takes the same hook as REST and the Local API).

## 2026-11-23: level-change oracle and transaction-guard gaps

- Promises added: a promotion is only an offer, and the one who promotes sees the same status, body, row, history rows, counts and audit calls for any person; the veto runs when the person accepts and answers only them; a demotion is immediate and never asks the veto; the pending level can't be set directly; `allowWithoutTransactions` must be `true`, `false` or unset; `allowWithoutTransactions: true` lets writes through; audit hooks stay silent on a refusal; `disableTransaction` is refused on update (delete is refused by the never-delete rule).
- Covered: `test/promotion.test.ts` (9 tests; adult against vetoed minor, field by field, over the Local API, REST and GraphQL; accept, refused accept, decline, withdraw, direct set, demotion and removal clearing the offer, server-code promotion), `test/guard.test.ts` (2 new), `test/transactions.test.ts` (3 new), `test/members.test.ts` (3 changed for the new flow). 126 tests in all.
- Test databases: every replica set is stopped with its temp folder removed in a `finally`, even if closing the adapter throws.
- Gaps skipped: timing, measured (the veto is never called on the promoter's path, so there is no work for a difference to come from; no clock test); a person's own answer to the veto still differs by design.

## 2026-11-23: transaction guard

- Promise added: a write that relies on a transaction is refused, with nothing written, when the adapter answers with no transaction after start-up or server code disables it.
- Covered: `test/guard.test.ts` (6 tests, 112 in all) with `beginTransaction` stubbed to null: invite, accept, level change, removal, last-Coordinator leave, new organization, edit, close, direct history row, server-code writes and `disableTransaction`; row, organization and event counts are unchanged, and writes work again once transactions return.
- Gaps skipped: a real adapter losing its connection mid-run (the stub answers the same way the adapter does); the level-dependent veto tell for a promoting Coordinator (now closed, see the entry above).

## 2026-11-23: after the review fixes

- Promises added: no approving through a second account; the veto is not asked at invitation, so inviters see one answer; `refuseMember` is a function or exactly `false`; no start without transactions unless opted out; no bulk update or delete; public suffixes refused; matcher needs a verified email and runs the veto; the picker respects read access; history keeps values and one row per change.
- Covered: each, in `test/members.test.ts`, `test/organizations.test.ts`, `test/doors.test.ts`, `test/plugin.test.ts` and the new `test/transactions.test.ts` (105 tests in all), including the exact second-account sequence.
- Added after the second review: level change on an invited row, unknown-id and unseen-duplicate invitations, reopening with invited people, and leaving then approving.
- Gaps skipped: the early-exit message for a stranger on a closed organization when the host's `canInvite` allows them (the host chose to allow it).

## 2026-11-22: first version

- Promises: organizations start pending and go live only when an approver activates the first Coordinator; nobody approves themselves or raises their own level; hooks fail closed (exact `true`); the veto applies to server code and on invite, accept, approve, level change and reopen; an organization always keeps a Coordinator, also under two changes at once; no duplicate live rows and no duplicate ROR ids; no deletes; closed organizations can't change; only approvers set ROR ids and domains; generic domains are refused; the matcher suggests and never grants, and finds only active organizations; private notes are hidden from members; the picker refuses inactive or wrong-kind organizations; a user from another sign-in collection is nobody.
- Covered: each of those, in `test/*.test.ts` (77 tests), including refusals over REST, GraphQL and bulk update, server-code revive and widen attempts, plain ids to hooks, the history, and repeated two-at-once runs for the last-Coordinator, invite and ROR rules.
- Gaps skipped (and why): admin screens (no browser test yet); a database without transactions (documented as unsupported); large numbers of members (no promise made); real ROR data (nothing here calls ROR).

## 2026-11-22: first audit (starter kit)

- Promises: none yet.
- Covered: none yet.
- Gaps added: none.
- Gaps skipped (and why): none.
