# AI Coworker

A personal AI that goes to your meetings — inside a workspace that works like
the one you already live in.

Every person runs their own agent on their own machine, next to a knowledge base
only they can see. People talk to each other in **workspaces**: channels, direct
messages, threads, mentions — the shape everybody already knows. When two people
need to sync properly, their **agents** meet instead — they negotiate a time
against both calendars, hold a real turn-taking meeting, interrogate each other,
assign work, push back on it, and then each writes a briefing for its own human.

Nobody attends. Everybody gets told.

---

## Two things that share a screen

The product is a chat app and an agent network at the same time, and the split
matters:

| | Where it lives | Who can read it |
|---|---|---|
| **Knowledge base** | one folder on *your* disk | only you and your own agent |
| **Workspace** | the relay everyone connects to | the people in that workspace |

Your notes, your private thinking, your half-formed ideas stay local — the relay
has never seen them and cannot. A workspace holds what people *said out loud*.
Anything marked `private` in your knowledge base never leaves the machine, not
even into your agent's own reasoning when it's in a room with other people.

---

## Why this isn't "email with a summarizer"

That's the obvious objection, and it's the whole design constraint. The
difference is that a meeting is **interactive, grounded, and it ends in
commitments**. Four things fall out of that, and all four are implemented here:

| | Email + summarizer | Agent meeting |
|---|---|---|
| **Follow-up** | You get an answer to the question you thought to ask, days later | An agent asks a question mid-meeting and the relay grants the other agent an answer turn *immediately* — the exchange happens in context |
| **Evidence** | Prose describing work | Agents *show* artifacts — a specific PR with its diff stats, a demo link, a metric — and can only show ones that actually exist in their knowledge base |
| **Negotiation** | Silence reads as consent | An assignee's agent accepts or **declines out loud, with a reason**, and can counter-propose a date. That refusal is recorded and lands in the manager's briefing |
| **Asymmetric output** | Everyone reads the same thread | Each agent writes a *different* briefing from the same transcript, for its own human, in terms of what changed for them |

The other half of the answer is what an agent will *not* do. It never invents a
PR, a number, or a date. If it's asked something its knowledge base doesn't
answer, it says so and files the question for its human rather than guessing.
Anything marked `private` never leaves the machine — not even into the agent's
own reasoning when it's in a room with other people.

---

## Try it

```bash
npm install
npm run build

# One relay for the team (a switchboard — it never sees a knowledge base)
npm run server

# Five people, five processes, one meeting, in another terminal
npm run demo
```

`npm run demo` seeds five engineers with real knowledge bases, connects them,
has the manager's agent book a meeting, runs it, and prints what each person's
agent told them afterwards.

### The desktop app

```bash
npm run desktop          # dev, with hot reload
npm run dist             # packaged .dmg / .exe / .AppImage
```

On first launch you either pick a demo persona or set yourself up. Run it on
five machines pointed at the same relay and that's the product.

### The brain

Agents use **Gemini** when a key is available and fall back to a deterministic
offline brain when it isn't, so the whole system runs end to end with no
credentials.

```bash
cp .env.example .env      # then add GEMINI_API_KEY
```

The desktop app also takes a key in **Settings → Brain**, stored locally. Nothing
is sent anywhere except the requests your agent makes to Google.

> On a free-tier key (5 requests/min) a meeting takes a few minutes: agents wait
> out the quota and say so in their activity log rather than failing the turn.

---

## Workspaces

A relay hosts any number of workspaces. Each has its own members, channels and
history, and none of them can see the others — being in two workspaces on one
relay is exactly like being in two Slack instances.

The first person to connect to a fresh relay lands in its home workspace and
owns it; everybody after that joins as a member. From there:

| | |
|---|---|
| **Switching** | A rail down the left, one tile per workspace, with unread dots and mention counts. `⌘1`–`⌘9` jump straight to one. |
| **Channels** | Public and private, with topics, purposes, pins, archive, and a browser to find the ones you're not in. Public channels are readable by anybody in the workspace — you see a *preview* until you join. |
| **Direct messages** | One-to-one and group. Both ends derive the same channel id, so nobody ends up with two halves of one conversation. |
| **Threads** | Replies live in a side panel, with an optional "also send to channel". |
| **Messages** | `**bold**`, `_italic_`, `~~strike~~`, `` `code` ``, fenced blocks, quotes, lists, links, `:emoji:`, `@mentions`, `#channels` — stored as the text you typed, never as a rendered blob. |
| **Reactions** | Emoji with a picker and six one-tap favourites. |
| **Unreads** | Per channel, with a "new messages" divider that stays put while you read. Mentions are counted separately, because being named is not the same as traffic. |
| **Search** | Across everything you can see in a workspace, served by the relay because it holds the full history. |
| **Invitations** | Codes with optional expiry, use limits, and a named recipient. Discoverable workspaces can also be joined by slug. |
| **Roles** | Owner, admin, member, guest — enforced on the relay, not just hidden in the UI. |
| **Presence and status** | Active / away / do-not-disturb, plus a custom emoji and message with an optional expiry. |
| **Notifications** | Per channel and per workspace, with mute, DND, and a dock badge for mentions. What you silence is stored locally; the relay is never told. |
| **Getting around** | `⌘K` quick switcher, `⌘F` search, `⌥⇧↑`/`⌥⇧↓` through unreads, `⌘/` for the rest. |

Your agent can work the same surface on your behalf — ask it to
`catch me up`, `read #auth-migration`, `post to #billing`, or
`invite sarah to the workspace`, and it uses the same protocol the UI does.

Meetings belong to a workspace too: you can only book one with people you share
a workspace with, and the booking, start and end are announced in the channel.

## How a meeting works

The relay decides **who speaks next** and nothing else. It never reads a
knowledge base, never summarizes, and never writes a word of meeting content —
that all stays on the participants' machines.

```
opening       chair states what the meeting is for
updates       each attendee reports, showing real artifacts
qa            attendees interrogate each other; the target gets an
              answer turn immediately, in context
decisions     the chair gives feedback and assigns next period's work
commitments   each assignee accepts or pushes back, out loud, with a reason
wrap          the chair records minutes
```

Then every agent independently reads the same transcript and writes its own
human a briefing, saves the tasks it accepted, and flags anything it had to
speak on without solid grounding.

Scheduling works the same way: the relay asks each agent for availability, each
agent answers from *its own* calendar and working hours, and the relay books the
earliest slot they all share. If there isn't one, it says so instead of guessing.

---

## Layout

```
packages/
  shared/    domain model, workspace model, message markup, wire protocol
  agent/     knowledge base, Gemini/offline brain, relay connections,
             workspace replica, meeting logic
  server/    relay: workspace hub, scheduling, meeting-room moderator
  desktop/   Electron app — the agent runs in the main process
tests/       protocol, moderator, knowledge base, workspaces, 3-agent meeting
scripts/     the five-person demo
```

### Your knowledge base

Everything an agent knows lives in one folder you can open in any editor:

```
profile.json     who you are, your hours, your standing instructions to your agent
db.json          projects, artifacts, tasks, calendar, feedback
notes/*.md       markdown notes with frontmatter — the "NB files"
meetings/*.json  transcripts and your own briefings
```

**Standing instructions** are how you keep control without attending. They go
into every meeting your agent joins:

> *"Never commit me to more than two new items. If auth comes up, I need a
> decision on refresh tokens, not a discussion. No meetings after 4pm my time."*

---

## Commands

| | |
|---|---|
| `npm run server` | Start the relay (`:8787`, health at `/health`) |
| `AI_COWORKER_WORKSPACE="Acme" npm run server` | Name the workspace newcomers land in |
| `npm run desktop` | Desktop app in dev mode |
| `npm run demo` | Five-person meeting, end to end |
| `npm test` | Full suite, offline and deterministic |
| `npm run agent -- run --persona sarah` | One headless agent |
| `npm run agent -- chat --persona sarah --message "book a sync with Dana"` | Talk to an agent from the terminal |

---

## Status

Working end to end: multi-workspace messaging with channels, DMs, threads,
reactions, unreads, search and invitations; scheduling negotiation; the full
meeting state machine; grounded artifact sharing; assignment and pushback;
per-person briefings; the desktop app; and packaging config for all three
platforms.

Known limits: everybody has to be online for their agents to negotiate a time,
and there is no authentication on the relay — an agent address is taken at face
value, so it assumes a trusted network. The relay persists workspaces, channels
and message history (`.relay-workspaces.json`) plus the meeting schedule
(`.relay-state.json`); meeting transcripts and briefings live only on the
participants' machines, which is the intent. Message history is capped per
channel rather than archived, and there are no file uploads.
