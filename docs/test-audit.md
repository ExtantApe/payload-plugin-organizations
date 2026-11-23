# Test audit

Kept by this repo's owning session, per `~/Code/CLAUDE.md`, "Test self-audits". Newest first.

## 2026-11-22: first version (K5227)

- Promises: organizations start pending and go live only when an approver activates the first Coordinator; nobody approves themselves or raises their own level; hooks fail closed (exact `true`); the veto applies to server code and on invite, accept, approve, level change and reopen; an organization always keeps a Coordinator, also under two changes at once; no duplicate live rows and no duplicate ROR ids; no deletes; closed organizations can't change; only approvers set ROR ids and domains; generic domains are refused; the matcher suggests and never grants, and finds only active organizations; private notes are hidden from members; the picker refuses inactive or wrong-kind organizations; a user from another sign-in collection is nobody.
- Covered: each of those, in `test/*.test.ts` (77 tests), including refusals over REST, GraphQL and bulk update, server-code revive and widen attempts, plain ids to hooks, the history, and repeated two-at-once runs for the last-Coordinator, invite and ROR rules.
- Gaps skipped (and why): admin screens (no browser test yet); a database without transactions (documented as unsupported); large numbers of members (no promise made); real ROR data (nothing here calls ROR).

## 2026-11-22: first audit (starter kit)

- Promises: none yet.
- Covered: none yet.
- Gaps added: none.
- Gaps skipped (and why): none.
