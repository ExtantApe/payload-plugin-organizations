import type { Payload, PayloadRequest } from 'payload'

export const ORGANIZATIONS = 'organizations'
export const MEMBERS = 'organization-members'
export const EVENTS = 'organization-events'

export type Level = 'coordinator' | 'member' | 'viewer'
export const LEVELS: Level[] = ['coordinator', 'member', 'viewer']
export const RANK: Record<Level, number> = { viewer: 1, member: 2, coordinator: 3 }

export type OrganizationStatus = 'pending' | 'active' | 'closed'
export type MemberStatus = 'invited' | 'active' | 'removed'

/** An organization as the host's hooks see it. Ids are plain. The private notes are never included. */
export type Organization = {
  id?: string | number
  name: string
  kind: string
  status: OrganizationStatus
  /** The bare ROR id, such as `02mhbdp94`, or null. */
  rorId: string | null
  /** Lowercase, validated domains. */
  domains: string[]
  createdBy: string | number | null
}

export type Membership = {
  id?: string | number
  organization: string | number
  user: string | number
  level: Level
  status: MemberStatus
  invitedBy?: string | number | null
  acceptedAt?: string | null
  removedAt?: string | null
  removedBy?: string | number | null
  /** A promotion offered to the person. It takes effect when they accept it. Null for none. */
  pendingLevel?: Level | null
}

export type KindConfig = { value: string; label?: string }

/** What the plugin settled on, kept in `config.custom.organizations` so the helpers need no global state. */
export type Resolved = {
  users: string
  kinds: KindConfig[]
  rorRequiredKinds: string[]
  genericDomains: string[]
  refuseMember: RefuseMember | false
  /** False only when the host passed `allowWithoutTransactions: true`. */
  needsTransactions: boolean
}

type User = { id: string | number; collection?: string } & Record<string, unknown>

export type OrganizationArgs = {
  req: PayloadRequest
  user: User
  /** The id of the organization being changed. Absent on creation. */
  id?: string | number
  /** The organization as it is now, or for a new one what is being created. */
  organization: Partial<Organization>
  /** The fields being sent. Normalized the same way. */
  data: Partial<Organization> & { privateNotes?: string | null }
  /** The highest level the asker holds in this organization, or null. */
  actorLevel: Level | null
}

export type MemberArgs = {
  req: PayloadRequest
  user: User
  organization: Organization & { id: string | number }
  /** The id of the membership being changed. Absent when one is being created. */
  id?: string | number
  /** The membership as it is now, or for an invitation what is being created. Ids are plain, never `{ id }` objects. */
  member: Partial<Membership>
  /** The fields being sent. Normalized the same way. */
  data: Partial<Membership>
  actorLevel: Level | null
  /** For `canChangeLevel`: the level it would become. */
  to?: Level
}

export type RefuseArgs = {
  req: PayloadRequest
  organization: Organization & { id: string | number }
  /** The person's own document. */
  subject: Record<string, unknown> & { id: string | number }
  userId: string | number
  level: Level
  action: 'invite' | 'accept' | 'approve' | 'change-level' | 'reopen' | 'suggest'
  /**
   * True when nothing is being changed: the invited person is reading, and the plugin asks what accepting would answer
   * so it can hide the organization and who invited them from someone the veto would refuse. Give the same answer as
   * without it, and only skip side effects: returning `null` or nothing early here shows the details. Keep it quick; an
   * answer slower than two seconds counts as a refusal here.
   */
  preview?: true
}
export type RefuseMember = (args: RefuseArgs) => string | null | undefined | Promise<string | null | undefined>

export type EventName =
  | 'create'
  | 'activate'
  | 'close'
  | 'reopen'
  | 'change-domains'
  | 'update'
  | 'invite'
  | 'accept'
  | 'approve'
  | 'change-level'
  | 'offer-level'
  | 'cancel-level'
  | 'remove'

export type AuditEvent = {
  event: EventName
  phase: 'before' | 'after'
  organization: Organization
  membership?: Membership
  previous?: Membership | Organization
  /** The signed-in user's id, or null for server code. */
  by: string | number | null
  req: PayloadRequest
}
export type AuditHook = (event: AuditEvent) => void | Promise<void>

type Check<A> = (args: A) => boolean | Promise<boolean>

export type OrganizationsOptions = {
  /** Turn the plugin off without removing it. Default true. */
  enabled?: boolean
  /** The users collection. Default `users`. */
  users?: string
  /** The kinds of organization the host offers, such as zoo, lab or business. With none, no organization can be made. */
  kinds: KindConfig[]
  /** Kinds whose domains match people only once a ROR id is set. Default none. Put a university kind here. */
  rorRequiredKinds?: string[]
  /** Domains to add to the shipped list of public mail, school and ISP domains. An entry starting with `*.` matches the domain and everything under it. */
  genericDomains?: string[]
  /** Who may propose an organization. Only an exact `true` counts. It starts pending, and its maker is its first Coordinator, once approved. */
  canCreate?: Check<OrganizationArgs>
  /** Who may make an organization with nobody in it, to be claimed later. Only an exact `true`. Default: nobody. */
  canPrecreate?: Check<OrganizationArgs>
  /** Who may rename an organization or change its private notes. Only an exact `true`. */
  canUpdate?: Check<OrganizationArgs>
  /**
   * Who may approve: set an organization active or closed, change its ROR id or domains, and activate a person in a
   * pending organization (its first Coordinator). Only an exact `true`. Nobody approves their own.
   */
  canApprove?: Check<OrganizationArgs>
  /** Who may invite someone. Only an exact `true`. */
  canInvite?: Check<MemberArgs>
  /** Who may change a level. Only an exact `true`. Nobody raises their own. */
  canChangeLevel?: Check<MemberArgs>
  /** Who may remove someone else. Default: whoever `canChangeLevel` allows. Anyone may always leave. */
  canRemove?: Check<MemberArgs>
  /** Who may read an organization's private notes. Only an exact `true`. Default: nobody. */
  canSeePrivate?: (args: { req: PayloadRequest; user: User; organizationId?: string | number }) => boolean | Promise<boolean>
  /** Who may read every organization, membership and history row, such as staff. Only an exact `true`. Default: nobody. */
  canRead?: (args: { req: PayloadRequest; user: User }) => boolean | Promise<boolean>
  /**
   * A veto the host controls, asked on every acceptance, approval, accepted promotion and reopening, and by
   * `matchOrganizations`, even for server code that skips access. When one user invites another it is not asked, so an
   * inviter can't learn from a refusal which accounts the veto covers; the invited person is refused when they accept.
   * It is asked at invitation only when nobody else can read the answer: server code, or a person inviting themselves
   * (the maker of an organization).
   * Return `null` or nothing to go ahead, or a reason to refuse. A throw, `false` or anything else refuses with a
   * general reason. The reason is shown to whoever was refused, so never give one that reveals something private, such
   * as an age. Required: a function, or exactly `false` to say plainly that the host has no veto. Anything else
   * (`null`, `0`, an empty string, `true`) throws when the plugin is set up.
   */
  refuseMember: RefuseMember | false
  /**
   * The plugin checks at start-up that the database can run transactions, because the last-Coordinator guard, the
   * history rows and the picker depend on them, and refuses to start without. Pass `true` only for a database you know
   * is not used by more than one writer at a time. Only exactly `true` or `false` (or leaving it out) is accepted;
   * anything else stops the plugin from starting. Default false.
   */
  allowWithoutTransactions?: boolean
  /** Audit hooks for every event. A `before` hook that throws stops the change. An `after` hook that throws is logged and ignored. */
  audit?: { before?: AuditHook; after?: AuditHook }
  /** The admin group the collections sit in. Default `Organizations`. */
  adminGroup?: string
}

export type PayloadLike = Payload | { payload: Payload }
