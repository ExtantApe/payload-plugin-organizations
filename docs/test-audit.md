# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

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
