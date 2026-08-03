/**
 * Deciding who a memory may be shared with, without being told.
 *
 * The point of importing someone's whole agent history is that they never have
 * to label any of it. So every memory is classified on the way in: what it is
 * about, how sensitive that makes it, and a gist that is safe to say when the
 * substance is not.
 *
 * This is rules, not a model call, for three reasons. It runs over thousands of
 * memories in a sync. It has to give the same answer every time or a refusal
 * cannot be explained. And a classifier that fails open on a network error is
 * worse than no classifier at all — here the failure mode is "too strict",
 * which the human can loosen from the UI.
 *
 * A human edit pins the policy. Nothing here ever overwrites a pinned one.
 */

import {
  type AudiencePolicy,
  type MemoryKind,
  type MemoryOrigin,
  type MemorySourceKind,
  type MemoryTopic,
  type Sensitivity,
  maskNumbers,
  maxSensitivity,
} from '@ai-coworker/shared';

export interface ClassifyInput {
  title: string;
  body: string;
  tags: string[];
  kind: MemoryKind;
  sourceKind: MemorySourceKind;
  origin?: MemoryOrigin;
}

export interface Classification {
  policy: AudiencePolicy;
  /**
   * The text contains something that looks like a live credential. It is kept
   * (deleting someone's file behind their back is worse) but never recalled.
   */
  quarantine: boolean;
  quarantineReason?: string;
}

/** Ordered: the first topics to match are the ones that set the floor. */
const TOPIC_PATTERNS: { topic: MemoryTopic; pattern: RegExp; label: string }[] = [
  {
    topic: 'security',
    label: 'credentials or access',
    pattern:
      /\b(api[- _]?key|secret[- _]?key|access[- _]?token|refresh[- _]?token|password|passphrase|credential|private key|ssh key|\.env\b|keychain|oauth secret)\b/i,
  },
  {
    topic: 'finance',
    label: 'money',
    pattern:
      /\b(revenue|arr|mrr|burn rate|runway|valuation|cap table|fundrais\w*|investor|term sheet|p&l|profit|gross margin|invoice|payroll|budget|forecast|pricing|raise[ds]? a round|seed round|series [a-d]\b)\b/i,
  },
  {
    topic: 'people',
    label: 'people decisions',
    pattern:
      /\b(headcount|performance review|promotion|compensation|salary|equity grant|offer letter|hiring plan|laid off|layoffs?|fired|termination|pip\b|attrition|backfill|comp band)\b/i,
  },
  {
    topic: 'legal',
    label: 'legal exposure',
    pattern: /\b(nda\b|contract|litigation|lawsuit|counsel|liability|indemnit\w*|gdpr|compliance|subpoena|breach notice)\b/i,
  },
  {
    topic: 'personal',
    label: 'personal life',
    pattern:
      /\b(my (wife|husband|partner|kid|son|daughter|mother|father|family)|health|doctor|therapy|diagnosis|home address|personal (phone|number|email)|imessage|whatsapp|birthday)\b/i,
  },
  {
    topic: 'strategy',
    label: 'company direction',
    pattern:
      /\b(roadmap|acquisition|acqui\w*|competitor|pivot|go[- ]to[- ]market|gtm\b|launch plan|partnership|strategic|moat|positioning)\b/i,
  },
  {
    topic: 'customer',
    label: 'a customer relationship',
    pattern: /\b(customer|client|account manager|churn|renewal|escalation|support ticket|complaint|pilot|design partner)\b/i,
  },
  {
    topic: 'product',
    label: 'product work',
    pattern: /\b(feature|spec\b|user flow|onboarding|ux\b|design system|prototype|mockup|usability)\b/i,
  },
  {
    topic: 'engineering',
    label: 'engineering work',
    pattern:
      /\b(repo|repository|pull request|\bpr #?\d|branch|deploy\w*|refactor|migration|database|schema|endpoint|typescript|python|build fails?|test suite|bug\b|stack trace)\b/i,
  },
];

/** Sensitivity a topic implies on its own. */
const TOPIC_FLOOR: Partial<Record<MemoryTopic, Sensitivity>> = {
  // Deliberately absent: `security`. "The refresh-token rollout is behind" is
  // ordinary engineering, and locking down every memory that says "token"
  // would hide most of an engineer's working context. A real key is caught by
  // the credential detector, and a key that has *moved* is caught by
  // EXPOSURE below.
  finance: 'confidential',
  people: 'confidential',
  legal: 'confidential',
  strategy: 'confidential',
  personal: 'restricted',
  customer: 'internal',
};

/** Where a memory came from says something about it before any word is read. */
const KIND_FLOOR: Partial<Record<MemoryKind, Sensitivity>> = {
  identity: 'restricted',
  preference: 'internal',
  instruction: 'internal',
  session: 'internal',
  fact: 'internal',
  project: 'internal',
  reference: 'public',
};

/**
 * Security vocabulary plus something happening *to* a secret. This is the
 * difference between "we ship refresh tokens" and "the refresh token leaked".
 */
const EXPOSURE =
  /\b(leaked|exposed|hard[- ]?coded|plain ?text|committed (the|a|our)|rotate the|rotated the|revoke[d]? the|checked in|pasted (the|my)|shared the (key|token|password))\b/i;

/** Phrases people actually write when they mean "not for everyone". */
const MARKERS: { pattern: RegExp; level: Sensitivity; why: string }[] = [
  { pattern: /\b(do not share|don't share|never share|keep this between us|off the record)\b/i, level: 'restricted', why: '"do not share" in the text' },
  { pattern: /\b(confidential|internal only|need[- ]to[- ]know|under nda)\b/i, level: 'confidential', why: 'marked confidential in the text' },
  { pattern: /\b(private|personal note)\b/i, level: 'restricted', why: 'marked private in the text' },
];

/** Shapes that are almost certainly a live secret rather than a mention of one. */
const CREDENTIAL_PATTERNS: { pattern: RegExp; what: string }[] = [
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key block' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/, what: 'an API key' },
  { pattern: /\bghp_[A-Za-z0-9]{20,}/, what: 'a GitHub token' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key id' },
  { pattern: /\bAIza[0-9A-Za-z_-]{25,}/, what: 'a Google API key' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
  { pattern: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: 'a JSON web token' },
  {
    pattern: /\b(api[_ -]?key|secret|token|password)\b\s*[:=]\s*["']?[A-Za-z0-9_\-]{16,}["']?/i,
    what: 'a key assigned to a variable',
  },
];

export function detectCredential(text: string): string | null {
  for (const { pattern, what } of CREDENTIAL_PATTERNS) {
    if (pattern.test(text)) return what;
  }
  return null;
}

export function classifyMemory(input: ClassifyInput): Classification {
  const haystack = `${input.title}\n${input.body}\n${input.tags.join(' ')}`;

  const credential = detectCredential(haystack);
  if (credential) {
    return {
      quarantine: true,
      quarantineReason: `looks like ${credential}`,
      policy: {
        sensitivity: 'secret',
        topics: ['security'],
        allow: [],
        deny: [{ kind: 'anyone' }],
        pinned: false,
        rationale: `Quarantined: this text contains ${credential}. It is never recalled and never leaves this machine.`,
        gist: undefined,
      },
    };
  }

  const topics: MemoryTopic[] = [];
  const reasons: string[] = [];
  for (const { topic, pattern, label } of TOPIC_PATTERNS) {
    if (topics.length >= 3) break;
    if (pattern.test(haystack)) {
      topics.push(topic);
      reasons.push(label);
    }
  }
  if (topics.length === 0) topics.push('general');

  let sensitivity: Sensitivity = KIND_FLOOR[input.kind] ?? 'internal';
  let rationale =
    topics[0] === 'general'
      ? `A ${input.kind} imported from ${input.sourceKind}.`
      : `Reads as ${reasons[0]}.`;

  for (const [index, topic] of topics.entries()) {
    const floor = TOPIC_FLOOR[topic];
    if (!floor) continue;
    const next = maxSensitivity(sensitivity, floor);
    if (next === sensitivity) continue;
    sensitivity = next;
    rationale = `Reads as ${reasons[index] ?? topic} — ${next} by default.`;
  }

  if (topics.includes('security') && EXPOSURE.test(haystack)) {
    const next = maxSensitivity(sensitivity, 'confidential');
    if (next !== sensitivity) {
      sensitivity = next;
      rationale = 'A credential appears to have moved or been exposed — confidential until reviewed.';
    }
  }

  for (const marker of MARKERS) {
    if (!marker.pattern.test(haystack)) continue;
    const next = maxSensitivity(sensitivity, marker.level);
    if (next !== sensitivity) {
      sensitivity = next;
      rationale = `${marker.why} — raised to ${next}.`;
    }
  }

  // Anything the human said *about themselves* is theirs to release, whatever
  // subject it happens to touch.
  if (input.kind === 'identity') {
    sensitivity = maxSensitivity(sensitivity, 'restricted');
    if (!rationale.includes('raised')) rationale = 'This is about my human personally.';
  }

  return {
    quarantine: false,
    policy: {
      sensitivity,
      topics,
      allow: [],
      deny: [],
      pinned: false,
      rationale,
      gist: sensitivity === 'public' || sensitivity === 'internal' ? undefined : safeGist(input, topics),
    },
  };
}

/**
 * What the agent may say when it may not say the memory: the subject, with the
 * figures taken out. Titles leak — "ARR crossed $4.1M in June" is a title.
 */
function safeGist(input: ClassifyInput, topics: MemoryTopic[]): string {
  const subject = maskNumbers(input.title).trim();
  const topic = topics.find((t) => t !== 'general');
  if (!subject) return topic ? `something about ${topic}` : 'something on this subject';
  return topic ? `${subject} (${topic})` : subject;
}

/**
 * Re-classifying on every sync would silently undo a person's decisions, so a
 * pinned policy survives and only its gist is refreshed when the text changes.
 */
export function mergePolicy(existing: AudiencePolicy | undefined, fresh: AudiencePolicy): AudiencePolicy {
  if (!existing) return fresh;
  if (!existing.pinned) return fresh;
  return { ...existing, gist: existing.gist ?? fresh.gist };
}
