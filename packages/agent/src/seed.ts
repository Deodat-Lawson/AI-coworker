/**
 * Demo personas: a five-person engineering team at a fictional company.
 *
 * These exist so the product can be run end to end — five people, five
 * machines, one manager — without anyone having to hand-author a knowledge base
 * first. The desktop app also offers them during onboarding.
 */

import { DAY, HOUR, type Profile } from '@ai-coworker/shared';

import { DEFAULT_WORKING_HOURS, type KnowledgeBase } from './store.js';

export interface PersonaSeed {
  key: string;
  profile: Omit<Profile, 'workingHours'> & { workingHours?: Profile['workingHours'] };
  projects: { key: string; name: string; summary: string; status: 'planning' | 'active' | 'blocked' | 'shipped' | 'paused'; tags: string[]; repo?: string }[];
  notes: { title: string; body: string; kind: 'update' | 'decision' | 'idea' | 'blocker' | 'meeting' | 'reference'; project?: string; visibility?: 'public' | 'team' | 'private' }[];
  artifacts: {
    kind: 'pr' | 'cl' | 'demo' | 'doc' | 'metric' | 'design' | 'incident';
    title: string;
    url?: string;
    summary: string;
    status: 'draft' | 'in_review' | 'merged' | 'shipped' | 'abandoned';
    project?: string;
    stats?: Record<string, string | number>;
  }[];
  tasks: { title: string; detail: string; status: 'todo' | 'in_progress' | 'blocked'; dueInDays?: number; project?: string }[];
}

export const DOMAIN = 'northwind';

export const PERSONAS: PersonaSeed[] = [
  {
    key: 'dana',
    profile: {
      address: `dana@${DOMAIN}`,
      displayName: 'Dana Whitfield',
      title: 'Engineering Manager, Platform',
      role: 'manager',
      team: 'Platform',
      timezone: 'America/Los_Angeles',
      bio: 'Runs the platform team. Cares about shipping cadence, on-call load, and not letting migrations stall halfway.',
      focusAreas: ['roadmap', 'staffing', 'delivery risk', 'cross-team dependencies'],
      reports: [`sarah@${DOMAIN}`, `marcus@${DOMAIN}`, `priya@${DOMAIN}`, `tom@${DOMAIN}`],
      agentInstructions:
        'Be direct. When you assign work, always attach acceptance criteria. Protect focus time: never accept a meeting before 10am. If someone is blocked, name an owner before the meeting ends.',
    },
    projects: [
      {
        key: 'q3',
        name: 'Q3 Platform Roadmap',
        summary:
          'Three bets this quarter: finish the auth migration, get the new billing dashboard in front of customers, and cut p95 API latency below 200ms.',
        status: 'active',
        tags: ['roadmap', 'planning'],
      },
      {
        key: 'oncall',
        name: 'On-call Health',
        summary: 'Reduce paging volume. Currently 14 pages/week, target is under 5.',
        status: 'active',
        tags: ['reliability'],
      },
    ],
    notes: [
      {
        title: 'Auth migration is the critical path',
        body: 'Everything downstream of session handling is waiting on the auth migration landing. If it slips past the 20th, the billing dashboard launch slips with it. Sarah owns it; watch for the SSO edge cases.',
        kind: 'decision',
        project: 'q3',
      },
      {
        title: 'Headcount will not arrive this quarter',
        body: 'The two open reqs are frozen until next quarter. Plan the roadmap with the current four engineers. Do not commit to the mobile offline work.',
        kind: 'decision',
        project: 'q3',
        visibility: 'private',
      },
      {
        title: 'Paging volume trending the wrong way',
        body: 'Up from 9 to 14 pages/week over the last month. Most of it is the ingest pipeline retry storm. Priya has context.',
        kind: 'blocker',
        project: 'oncall',
      },
    ],
    artifacts: [
      {
        kind: 'doc',
        title: 'Q3 Roadmap (one-pager)',
        url: 'https://docs.northwind.dev/q3-roadmap',
        summary: 'The three bets, their owners, and the dates I have committed to leadership.',
        status: 'shipped',
        project: 'q3',
      },
      {
        kind: 'metric',
        title: 'Weekly paging volume',
        summary: '14 pages/week, up from 9 last month. 60% originate in the ingest pipeline.',
        status: 'shipped',
        project: 'oncall',
        stats: { pages_per_week: 14, target: 5, top_source: 'ingest-pipeline' },
      },
    ],
    tasks: [
      {
        title: 'Decide whether the billing launch date moves',
        detail: 'Depends on whether auth lands by the 20th.',
        status: 'in_progress',
        dueInDays: 3,
        project: 'q3',
      },
    ],
  },

  {
    key: 'sarah',
    profile: {
      address: `sarah@${DOMAIN}`,
      displayName: 'Sarah Chen',
      title: 'Senior Backend Engineer',
      role: 'ic',
      team: 'Platform',
      timezone: 'America/Los_Angeles',
      bio: 'Owns identity and session handling. Deep in the auth migration.',
      focusAreas: ['auth', 'sessions', 'API', 'backend'],
      manager: `dana@${DOMAIN}`,
      reports: [],
      agentInstructions:
        'Do not commit me to more than two new items in a meeting. If someone asks about auth timelines, be precise about what is merged versus what is in review.',
    },
    projects: [
      {
        key: 'auth',
        name: 'Auth Migration',
        summary:
          'Moving from the legacy session store to signed tokens. Core path is done; SSO and the mobile refresh flow are the remaining risk.',
        status: 'active',
        tags: ['auth', 'backend'],
        repo: 'github.com/northwind/identity',
      },
    ],
    notes: [
      {
        title: 'SSO refresh tokens are the last hard problem',
        body: 'Okta returns a refresh token with a 12-hour TTL, but our mobile clients assume 30 days. Either we proxy refresh server-side or mobile has to handle re-auth. Needs a decision from Tom before I can finish.',
        kind: 'blocker',
        project: 'auth',
      },
      {
        title: 'Core token path merged',
        body: 'Signed tokens are live behind a flag for 10% of traffic. No error-rate change over 48 hours. Ready to ramp to 50% once SSO is settled.',
        kind: 'update',
        project: 'auth',
      },
    ],
    artifacts: [
      {
        kind: 'pr',
        title: 'identity: signed token issuance + verification',
        url: 'https://github.com/northwind/identity/pull/412',
        summary:
          'Core token issuance, verification middleware, and the rollout flag. Merged and running at 10% traffic.',
        status: 'merged',
        project: 'auth',
        stats: { additions: 1840, deletions: 620, files: 34, reviewers: 2 },
      },
      {
        kind: 'pr',
        title: 'identity: SSO refresh proxy (draft)',
        url: 'https://github.com/northwind/identity/pull/419',
        summary:
          'Server-side refresh proxy so mobile clients keep long-lived sessions. Blocked on a decision about mobile re-auth UX.',
        status: 'in_review',
        project: 'auth',
        stats: { additions: 410, deletions: 30, files: 8, reviewers: 1 },
      },
      {
        kind: 'metric',
        title: 'Token rollout error rate',
        summary: '10% of traffic on signed tokens for 48h. Error rate 0.02%, unchanged from baseline.',
        status: 'shipped',
        project: 'auth',
        stats: { traffic_pct: 10, error_rate: '0.02%', hours: 48 },
      },
    ],
    tasks: [
      {
        title: 'Ramp signed tokens to 50%',
        detail: 'Gated on the SSO refresh decision.',
        status: 'blocked',
        dueInDays: 5,
        project: 'auth',
      },
      { title: 'Write the auth migration runbook', detail: '', status: 'todo', dueInDays: 9, project: 'auth' },
    ],
  },

  {
    key: 'marcus',
    profile: {
      address: `marcus@${DOMAIN}`,
      displayName: 'Marcus Rivera',
      title: 'Frontend Engineer',
      role: 'ic',
      team: 'Platform',
      timezone: 'America/New_York',
      bio: 'Building the billing dashboard. Strong on design systems and accessibility.',
      focusAreas: ['frontend', 'billing dashboard', 'design system', 'accessibility'],
      manager: `dana@${DOMAIN}`,
      reports: [],
      agentInstructions:
        'I am on the east coast — no meetings after 4pm my time. Push back if someone tries to add scope to the billing dashboard before launch.',
    },
    projects: [
      {
        key: 'billing',
        name: 'Billing Dashboard',
        summary:
          'Customer-facing usage and invoice view. Three of four screens are built; the invoice history screen needs the new API.',
        status: 'active',
        tags: ['frontend', 'billing'],
        repo: 'github.com/northwind/web',
      },
    ],
    notes: [
      {
        title: 'Invoice history screen is waiting on the API',
        body: 'The usage and plan screens are done and reviewed. Invoice history needs the paginated invoices endpoint, which is not built yet. I can stub it, but then we ship twice.',
        kind: 'blocker',
        project: 'billing',
      },
      {
        title: 'Design review passed',
        body: 'Design signed off on all four screens last Thursday. No changes requested beyond spacing on mobile breakpoints, which is already fixed.',
        kind: 'update',
        project: 'billing',
      },
    ],
    artifacts: [
      {
        kind: 'pr',
        title: 'web: billing usage + plan screens',
        url: 'https://github.com/northwind/web/pull/2210',
        summary: 'Two of the four billing screens, fully wired to the usage API, with tests.',
        status: 'merged',
        project: 'billing',
        stats: { additions: 2100, deletions: 140, files: 41, reviewers: 2 },
      },
      {
        kind: 'demo',
        title: 'Billing dashboard walkthrough',
        url: 'https://demos.northwind.dev/billing-v2',
        summary:
          'Two-minute clickthrough of the usage screen, plan switcher, and the empty state for new accounts.',
        status: 'shipped',
        project: 'billing',
        stats: { length: '2:14' },
      },
      {
        kind: 'design',
        title: 'Billing dashboard — final screens',
        url: 'https://figma.com/file/northwind-billing',
        summary: 'Approved designs for all four screens including mobile breakpoints.',
        status: 'shipped',
        project: 'billing',
      },
    ],
    tasks: [
      {
        title: 'Build invoice history screen',
        detail: 'Blocked on the paginated invoices endpoint.',
        status: 'blocked',
        dueInDays: 6,
        project: 'billing',
      },
    ],
  },

  {
    key: 'priya',
    profile: {
      address: `priya@${DOMAIN}`,
      displayName: 'Priya Nair',
      title: 'Infrastructure Engineer',
      role: 'ic',
      team: 'Platform',
      timezone: 'Europe/London',
      bio: 'Owns the data ingest pipeline and most of the on-call surface area.',
      focusAreas: ['infrastructure', 'ingest pipeline', 'on-call', 'latency', 'observability'],
      manager: `dana@${DOMAIN}`,
      reports: [],
      agentInstructions:
        'I am in London — nothing before 9am or after 6pm my time. On-call weeks are not available for new work; say so.',
    },
    projects: [
      {
        key: 'ingest',
        name: 'Ingest Pipeline Reliability',
        summary:
          'The retry storm that drives most of our paging. Root cause found; the fix is a backpressure change plus a dead-letter queue.',
        status: 'active',
        tags: ['reliability', 'infra'],
        repo: 'github.com/northwind/pipeline',
      },
      {
        key: 'latency',
        name: 'API Latency',
        summary: 'p95 is 340ms against a 200ms target. Most of it is a fan-out query in the account service.',
        status: 'active',
        tags: ['performance'],
      },
    ],
    notes: [
      {
        title: 'Retry storm root cause: no backpressure',
        body: 'When a downstream write fails, every consumer retries immediately and in lockstep. Under load that turns one failure into thousands of requests. Fix is exponential backoff with jitter plus a dead-letter queue for anything that fails three times.',
        kind: 'decision',
        project: 'ingest',
      },
      {
        title: 'p95 latency is one bad query',
        body: 'Traced it: the account service fans out one query per permission check instead of batching. Fixing it is maybe a day of work but it touches the permission cache, which nobody wants to touch before the auth migration is done.',
        kind: 'blocker',
        project: 'latency',
      },
    ],
    artifacts: [
      {
        kind: 'pr',
        title: 'pipeline: backoff with jitter + dead-letter queue',
        url: 'https://github.com/northwind/pipeline/pull/88',
        summary:
          'Exponential backoff with jitter on consumer retries, plus a DLQ after three failures. In review.',
        status: 'in_review',
        project: 'ingest',
        stats: { additions: 620, deletions: 95, files: 14, reviewers: 1 },
      },
      {
        kind: 'metric',
        title: 'API p95 latency',
        summary: 'p95 340ms against a 200ms target. Account service fan-out is 190ms of that.',
        status: 'shipped',
        project: 'latency',
        stats: { p95_ms: 340, target_ms: 200, worst_endpoint: '/v1/accounts' },
      },
      {
        kind: 'incident',
        title: 'INC-241: ingest backlog, 3h customer-visible delay',
        summary: 'Retry storm filled the queue. Same root cause as the paging volume.',
        status: 'shipped',
        project: 'ingest',
        stats: { duration: '3h12m', severity: 'SEV2' },
      },
    ],
    tasks: [
      { title: 'Land the backpressure fix', detail: 'In review.', status: 'in_progress', dueInDays: 3, project: 'ingest' },
      {
        title: 'Batch the account-service permission query',
        detail: 'Waiting until auth migration settles.',
        status: 'blocked',
        dueInDays: 12,
        project: 'latency',
      },
    ],
  },

  {
    key: 'tom',
    profile: {
      address: `tom@${DOMAIN}`,
      displayName: 'Tom Okafor',
      title: 'Mobile Engineer',
      role: 'ic',
      team: 'Platform',
      timezone: 'America/Chicago',
      bio: 'iOS and Android client. Owns the mobile session and offline behaviour.',
      focusAreas: ['mobile', 'iOS', 'Android', 'offline', 'session refresh'],
      manager: `dana@${DOMAIN}`,
      reports: [],
      agentInstructions:
        'Do not agree to offline-mode work this quarter — it is not staffed. If auth comes up, I need a decision on refresh tokens, not a discussion.',
    },
    projects: [
      {
        key: 'mobile',
        name: 'Mobile Client 4.2',
        summary:
          'Next mobile release. Blocked on the auth refresh decision: if sessions drop to 12 hours, users get logged out daily and that is a support problem.',
        status: 'blocked',
        tags: ['mobile'],
        repo: 'github.com/northwind/mobile',
      },
    ],
    notes: [
      {
        title: 'A 12-hour session is not shippable on mobile',
        body: 'Our users open the app a few times a week, not daily. A 12-hour refresh window means most sessions expire between uses and every open becomes a login. Either the backend proxies refresh, or we need biometric re-auth, which is two weeks I do not have.',
        kind: 'blocker',
        project: 'mobile',
      },
      {
        title: '4.2 is otherwise ready',
        body: 'Everything except session handling is done and on TestFlight. 200 internal testers, no new crashes in a week.',
        kind: 'update',
        project: 'mobile',
      },
    ],
    artifacts: [
      {
        kind: 'demo',
        title: 'Mobile 4.2 on TestFlight',
        url: 'https://testflight.apple.com/join/northwind42',
        summary: '200 internal testers, crash-free rate 99.8% over the last week.',
        status: 'shipped',
        project: 'mobile',
        stats: { testers: 200, crash_free: '99.8%' },
      },
      {
        kind: 'pr',
        title: 'mobile: session refresh handling (blocked)',
        url: 'https://github.com/northwind/mobile/pull/531',
        summary: 'Client-side refresh flow. Cannot finish until the token TTL question is decided.',
        status: 'draft',
        project: 'mobile',
        stats: { additions: 180, deletions: 20, files: 6 },
      },
    ],
    tasks: [
      {
        title: 'Ship 4.2',
        detail: 'Blocked on the auth refresh decision.',
        status: 'blocked',
        dueInDays: 8,
        project: 'mobile',
      },
    ],
  },
];

export function findPersona(key: string): PersonaSeed | undefined {
  const lower = key.toLowerCase();
  return PERSONAS.find((p) => p.key === lower || p.profile.address === key || p.profile.displayName.toLowerCase() === lower);
}

/** Populate a fresh knowledge base with a persona's world. Idempotent by project name. */
export async function seedKnowledgeBase(ws: KnowledgeBase, persona: PersonaSeed, now = Date.now()): Promise<void> {
  await ws.updateProfile({
    ...persona.profile,
    workingHours: persona.profile.workingHours ?? { ...DEFAULT_WORKING_HOURS },
  });

  const projectIds = new Map<string, string>();
  for (const p of persona.projects) {
    const existing = ws.projects.find((x) => x.name === p.name);
    const project = await ws.upsertProject({
      id: existing?.id,
      name: p.name,
      summary: p.summary,
      status: p.status,
      visibility: 'team',
      tags: p.tags,
      repo: p.repo,
      stakeholders: persona.profile.manager ? [persona.profile.manager] : [],
    });
    projectIds.set(p.key, project.id);
  }

  for (const n of persona.notes) {
    if (ws.notes.some((x) => x.title === n.title)) continue;
    await ws.upsertNote({
      title: n.title,
      body: n.body,
      kind: n.kind,
      visibility: n.visibility ?? 'team',
      projectId: n.project ? projectIds.get(n.project) : undefined,
      tags: [],
    });
  }

  for (const a of persona.artifacts) {
    if (ws.artifacts.some((x) => x.title === a.title)) continue;
    await ws.upsertArtifact({
      kind: a.kind,
      title: a.title,
      url: a.url,
      summary: a.summary,
      status: a.status,
      visibility: 'team',
      stats: a.stats ?? {},
      projectId: a.project ? projectIds.get(a.project) : undefined,
    });
  }

  for (const t of persona.tasks) {
    if (ws.tasks.some((x) => x.title === t.title)) continue;
    await ws.upsertTask({
      title: t.title,
      detail: t.detail,
      status: t.status,
      assignee: persona.profile.address,
      assignedBy: persona.profile.manager ?? persona.profile.address,
      dueDate: t.dueInDays ? now + t.dueInDays * DAY : undefined,
      projectId: t.project ? projectIds.get(t.project) : undefined,
      acceptanceCriteria: [],
    });
  }

  // A couple of standing calendar commitments, so scheduling has something real
  // to negotiate around rather than every slot being free.
  const tomorrow = new Date(now + DAY);
  tomorrow.setHours(11, 0, 0, 0);
  if (!ws.calendar.some((c) => c.title === 'Focus block')) {
    await ws.addCalendarBlock({
      title: 'Focus block',
      start: tomorrow.getTime(),
      end: tomorrow.getTime() + 2 * HOUR,
      kind: 'focus',
    });
  }
}
