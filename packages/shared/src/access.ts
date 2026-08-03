/**
 * Who may hear what.
 *
 * The knowledge base already has a blunt `visibility` flag: private never
 * leaves the machine, everything else does. That is not how a person actually
 * shares. A manager's agent asked about revenue by an engineer's agent should
 * not answer "here is everything I know" — but it should not pretend the
 * subject does not exist either. It should say *that* it knows and decline the
 * number.
 *
 * So every memory carries an `AudiencePolicy`: how sensitive it is, what it is
 * about, and any explicit allow/deny the human pinned onto it. The decision is
 * a pure function of that policy plus the relationship between the owner and
 * whoever is asking — no model call, so the same question always gets the same
 * answer and a refusal can be explained.
 */

import type { AgentAddress, Profile, PublicProfile, Role } from './domain.js';

/** How much damage sharing this does, in ascending order. */
export type Sensitivity = 'public' | 'internal' | 'confidential' | 'restricted' | 'secret';

export const SENSITIVITY_ORDER: readonly Sensitivity[] = [
  'public',
  'internal',
  'confidential',
  'restricted',
  'secret',
] as const;

export function sensitivityRank(level: Sensitivity): number {
  const idx = SENSITIVITY_ORDER.indexOf(level);
  return idx === -1 ? SENSITIVITY_ORDER.indexOf('confidential') : idx;
}

/** The stricter of two levels. Used when several signals fire on one memory. */
export function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return sensitivityRank(a) >= sensitivityRank(b) ? a : b;
}

/**
 * What a memory is *about*. Topic drives the automatic sensitivity floor —
 * "finance" is confidential by default no matter how casually it was written
 * down, which is the CEO-and-revenue case.
 */
export type MemoryTopic =
  | 'finance'
  | 'legal'
  | 'people'
  | 'security'
  | 'strategy'
  | 'customer'
  | 'product'
  | 'engineering'
  | 'personal'
  | 'general';

export const MEMORY_TOPICS: readonly MemoryTopic[] = [
  'finance',
  'legal',
  'people',
  'security',
  'strategy',
  'customer',
  'product',
  'engineering',
  'personal',
  'general',
] as const;

/** A group of people, named in the way a human would name them. */
export type AudienceSelector =
  | { kind: 'anyone' }
  | { kind: 'org' }
  | { kind: 'team'; value: string }
  | { kind: 'role'; value: Role }
  | { kind: 'address'; value: AgentAddress }
  | { kind: 'manager' }
  | { kind: 'reports' }
  | { kind: 'self' };

export interface AudiencePolicy {
  sensitivity: Sensitivity;
  topics: MemoryTopic[];
  /** Explicit "yes, this person/group may hear it", overriding the default. */
  allow: AudienceSelector[];
  /** Explicit "never", which beats every allow including `anyone`. */
  deny: AudienceSelector[];
  /** True once a human edited the policy; the classifier must not overwrite it. */
  pinned: boolean;
  /** Why the classifier landed here. Shown in the UI and in refusals. */
  rationale: string;
  /**
   * A sentence that is safe to say when the body is not — "I have figures for
   * Q3 revenue". Lets the agent acknowledge a gap instead of stonewalling.
   */
  gist?: string;
}

export function defaultPolicy(sensitivity: Sensitivity = 'internal'): AudiencePolicy {
  return { sensitivity, topics: ['general'], allow: [], deny: [], pinned: false, rationale: '' };
}

/** How the asker stands to the owner of the memory. */
export type Relation = 'self' | 'manager' | 'report' | 'teammate' | 'colleague' | 'external';

export interface RequesterContext {
  address: AgentAddress;
  role?: Role;
  team?: string;
  /** The asker's own manager, when the directory knows it. */
  manager?: AgentAddress;
  /** Override the derived relationship (tests, or a relay that knows better). */
  relation?: Relation;
}

export type AccessLevel = 'full' | 'gist' | 'none';

export interface AccessDecision {
  level: AccessLevel;
  /** Convenience: `level !== 'none'`. Something may be said. */
  allowed: boolean;
  /** Sentence the agent can use to explain itself, in the first person. */
  reason: string;
  /** Which rule fired, for the permissions UI and for debugging. */
  rule: string;
  relation: Relation;
}

export function domainOf(address: AgentAddress): string {
  const at = address.indexOf('@');
  return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

/**
 * Work out the relationship from the two profiles. `manager` means *the asker
 * is my manager*; `report` means the asker reports to me. Direction matters:
 * work flows down, sensitive context flows up.
 */
export function deriveRelation(
  owner: Pick<Profile, 'address' | 'team' | 'manager' | 'reports'>,
  requester: RequesterContext,
): Relation {
  if (requester.relation) return requester.relation;
  const them = requester.address.toLowerCase();
  const me = owner.address.toLowerCase();
  if (!them || them === me) return 'self';
  if (owner.manager && owner.manager.toLowerCase() === them) return 'manager';
  if ((owner.reports ?? []).some((r) => r.toLowerCase() === them)) return 'report';
  if (requester.manager && requester.manager.toLowerCase() === me) return 'report';
  const sameOrg = domainOf(owner.address) !== '' && domainOf(owner.address) === domainOf(requester.address);
  if (!sameOrg) return 'external';
  const ownerTeam = (owner.team ?? '').trim().toLowerCase();
  const theirTeam = (requester.team ?? '').trim().toLowerCase();
  if (ownerTeam && ownerTeam === theirTeam) return 'teammate';
  return 'colleague';
}

/** Build a requester context out of whatever the directory published. */
export function requesterFromProfile(profile: PublicProfile): RequesterContext {
  return {
    address: profile.address,
    role: profile.role,
    team: profile.team,
    manager: profile.manager,
  };
}

function selectorMatches(
  selector: AudienceSelector,
  relation: Relation,
  requester: RequesterContext,
  owner: Pick<Profile, 'address' | 'team'>,
): boolean {
  switch (selector.kind) {
    case 'anyone':
      return true;
    case 'org':
      return relation !== 'external';
    case 'self':
      return relation === 'self';
    case 'manager':
      return relation === 'manager';
    case 'reports':
      return relation === 'report';
    case 'role':
      return requester.role === selector.value;
    case 'team': {
      const want = selector.value.trim().toLowerCase();
      return want !== '' && (requester.team ?? '').trim().toLowerCase() === want;
    }
    case 'address':
      return selector.value.toLowerCase() === requester.address.toLowerCase();
    default:
      return false;
  }
}

export function formatSelector(selector: AudienceSelector): string {
  return 'value' in selector ? `${selector.kind}:${selector.value}` : selector.kind;
}

/** Parse `team:platform`, `role:manager`, `dana@northwind`, `anyone`, … */
export function parseSelector(input: string): AudienceSelector | null {
  const text = input.trim();
  if (!text) return null;
  const colon = text.indexOf(':');
  const head = (colon === -1 ? text : text.slice(0, colon)).toLowerCase();
  const tail = colon === -1 ? '' : text.slice(colon + 1).trim();

  switch (head) {
    case 'anyone':
    case 'everyone':
      return { kind: 'anyone' };
    case 'org':
    case 'company':
      return { kind: 'org' };
    case 'self':
    case 'me':
      return { kind: 'self' };
    case 'manager':
      return tail ? { kind: 'address', value: tail } : { kind: 'manager' };
    case 'reports':
      return { kind: 'reports' };
    case 'team':
      return tail ? { kind: 'team', value: tail } : null;
    case 'role':
      return tail === 'manager' || tail === 'ic' ? { kind: 'role', value: tail } : null;
    case 'address':
      return tail ? { kind: 'address', value: tail } : null;
    default:
      // Bare agent addresses are the common case in a grant.
      return text.includes('@') ? { kind: 'address', value: text } : null;
  }
}

/**
 * Default reach of each sensitivity level, before allow/deny. `gist` means the
 * agent may confirm the subject exists but not the substance — that is what
 * keeps a refusal honest rather than evasive.
 */
const BASELINE: Record<Sensitivity, Partial<Record<Relation, AccessLevel>>> = {
  public: { self: 'full', manager: 'full', report: 'full', teammate: 'full', colleague: 'full', external: 'full' },
  internal: { self: 'full', manager: 'full', report: 'full', teammate: 'full', colleague: 'full', external: 'none' },
  confidential: { self: 'full', manager: 'full', report: 'gist', teammate: 'gist', colleague: 'gist', external: 'none' },
  restricted: { self: 'full', manager: 'gist', report: 'none', teammate: 'none', colleague: 'none', external: 'none' },
  secret: { self: 'full', manager: 'none', report: 'none', teammate: 'none', colleague: 'none', external: 'none' },
};

const RELATION_WORD: Record<Relation, string> = {
  self: 'me',
  manager: 'my manager',
  report: 'someone who reports to me',
  teammate: 'a teammate',
  colleague: 'a colleague',
  external: 'someone outside the company',
};

export interface AccessInput {
  owner: Pick<Profile, 'address' | 'team' | 'manager' | 'reports'>;
  requester: RequesterContext;
}

/**
 * The whole access decision, as one pure function.
 *
 * Order matters: deny beats everything (that is what makes it usable as a
 * safety valve), then an explicit allow, then the sensitivity baseline.
 */
export function decideAccess(policy: AudiencePolicy, input: AccessInput): AccessDecision {
  const relation = deriveRelation(input.owner, input.requester);
  const who = RELATION_WORD[relation];

  if (relation === 'self') {
    return { level: 'full', allowed: true, reason: 'This is my own knowledge base.', rule: 'self', relation };
  }

  for (const selector of policy.deny) {
    if (selectorMatches(selector, relation, input.requester, input.owner)) {
      return {
        level: 'none',
        allowed: false,
        reason: `Withheld: my human explicitly told me not to share this with ${formatSelector(selector)}.`,
        rule: `deny:${formatSelector(selector)}`,
        relation,
      };
    }
  }

  for (const selector of policy.allow) {
    if (selectorMatches(selector, relation, input.requester, input.owner)) {
      return {
        level: 'full',
        allowed: true,
        reason: `Shared: my human cleared this for ${formatSelector(selector)}.`,
        rule: `allow:${formatSelector(selector)}`,
        relation,
      };
    }
  }

  const level = BASELINE[policy.sensitivity][relation] ?? 'none';
  const rule = `baseline:${policy.sensitivity}:${relation}`;
  if (level === 'full') {
    return {
      level,
      allowed: true,
      reason: `${policy.sensitivity} material is shareable with ${who}.`,
      rule,
      relation,
    };
  }
  if (level === 'gist') {
    return {
      level,
      allowed: true,
      reason: `This is ${policy.sensitivity}${topicPhrase(policy)}. I can say that it exists, not what it says — ${who} would need my human to release the detail.`,
      rule,
      relation,
    };
  }
  return {
    level,
    allowed: false,
    reason: `This is ${policy.sensitivity}${topicPhrase(policy)} and not something I share with ${who}.`,
    rule,
    relation,
  };
}

function topicPhrase(policy: AudiencePolicy): string {
  const topics = policy.topics.filter((t) => t !== 'general');
  return topics.length ? ` ${topics.join('/')} material` : '';
}

/**
 * A meeting has a *room*, not one asker. Anything said is heard by everyone
 * present, so the room gets the strictest of the individual answers.
 */
export function decideAccessForRoom(
  policy: AudiencePolicy,
  owner: AccessInput['owner'],
  room: RequesterContext[],
): AccessDecision {
  const others = room.filter((r) => r.address.toLowerCase() !== owner.address.toLowerCase());
  if (others.length === 0) {
    return { level: 'full', allowed: true, reason: 'Nobody else is in the room.', rule: 'self', relation: 'self' };
  }
  let worst: AccessDecision | null = null;
  for (const requester of others) {
    const decision = decideAccess(policy, { owner, requester });
    if (!worst || levelRank(decision.level) < levelRank(worst.level)) worst = decision;
  }
  return worst!;
}

function levelRank(level: AccessLevel): number {
  return level === 'full' ? 2 : level === 'gist' ? 1 : 0;
}

/** What actually leaves the machine once the decision is applied. */
export interface SharedProjection {
  level: AccessLevel;
  title: string;
  /** Present only at `full`. */
  body?: string;
  /** Present at `gist` — a safe acknowledgement, never the substance. */
  gist?: string;
  reason: string;
}

export function projectForAudience(
  memory: { title: string; body: string; policy: AudiencePolicy },
  decision: AccessDecision,
): SharedProjection | null {
  if (decision.level === 'full') {
    return { level: 'full', title: memory.title, body: memory.body, reason: decision.reason };
  }
  if (decision.level === 'gist') {
    return {
      level: 'gist',
      title: maskNumbers(memory.title),
      gist: memory.policy.gist ?? maskNumbers(memory.title),
      reason: decision.reason,
    };
  }
  return null;
}

/**
 * Titles leak. "Q3 revenue is $4.1M" is a title, and it is the number we are
 * trying not to say — so a gist has its figures masked even though the title
 * itself was judged safe enough to acknowledge.
 */
export function maskNumbers(text: string): string {
  return (
    text
      .replace(/[$€£]\s?\d[\d,._]*\s*(k|m|bn?|million|billion)?/gi, '[amount]')
      .replace(/\b\d[\d,._]*\s?(%|percent)/gi, '[percent]')
      .replace(/\b\d[\d,._]*\s?(k|m|bn|mrr|arr)\b/gi, '[amount]')
      // Five digits and up: long enough to be an account, a phone number or a
      // headcount, while a year in a date stays readable.
      .replace(/\b\d{5,}\b/g, '[number]')
  );
}
