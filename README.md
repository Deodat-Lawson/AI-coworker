<img src="brand/icon.svg" alt="" width="76" align="left" hspace="16" vspace="6">

# Stead

**Your agent goes in your stead.** A personal AI that attends your meetings for
you — inside a workspace that works like the one you already live in.

<br clear="left">

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

On first launch you sign in: an email address, the six-digit code that comes
back, your name, and then either the workspace your colleagues are already in or
a new one — the same sequence Slack asks for, and for the same reasons. A demo
persona is one click away on that first screen if you are just looking. Run it on
five machines pointed at the same relay and that's the product.

### Accounts

The relay knows who people are. An address is minted from a verified email
(`sarah.chen@northwind.io` becomes `sarahchen@northwind`) and bound to the
account, so nobody can connect claiming to be somebody else — and a workspace
made from a company address claims that domain, which is what lets the next
colleague find the team instead of starting a parallel one.

```bash
npm run server                       # accounts optional: a session is honoured
                                     # when presented, and an address that
                                     # belongs to one cannot be used without it
AI_COWORKER_REQUIRE_AUTH=1 npm run server   # no account, no connection
```

Codes are printed to the relay's log by default, because a relay you run for
your own team has no mail server. Give `Accounts` a `Mailer` to send them for
real; the moment you do, they stop being handed back over HTTP.

### Light and dark

`⌘⇧L` cycles dark → light → match system, and Settings → Appearance has the same
three. "Match system" keeps following the machine, including when it flips at
sunset. There is one control and one palette: the Knowledge tab draws from the
same theme tokens as the rest of the app, and mirrors the result into the
vault's `.obsidian/app.json` so Obsidian opened on the same folder agrees.

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
| **Invitations** | Codes with optional expiry, use limits, and a named recipient — or emailed straight to a colleague, redeemable only by the address they went to. Discoverable workspaces can also be joined by slug. |
| **Roles** | A primary owner who cannot be demoted or removed, owners, admins, members, and guests who can be confined to a single channel. Enforced on the relay, not just hidden in the UI. |
| **Permissions** | Ten capabilities — inviting, creating public and private channels, archiving, renaming, managing people, editing the workspace, posting in the default channel, deleting anybody's message, revoking invitations — each set to the lowest role that may do it, with floors that cannot be lowered. |
| **Managing people** | A member table you can search, filter by role or status, sort, and select in bulk: change roles, confine a guest to named channels, deactivate, reactivate, remove, or hand the workspace over. Deactivating keeps everything the person said and stops them being mentioned. |
| **Joining** | Ask an admin to be let in, and see the queue on the other side. Workspaces claim the email domain of whoever made them, so the next colleague to sign up is offered the workspace rather than making a second one. |
| **Audit log** | Every administrative act — role changes, deactivations, permission edits, invitations — kept on the relay and readable by admins. |
| **Presence and status** | Active / away / do-not-disturb, plus a custom emoji and message with an optional expiry. |
| **Notifications** | Per channel and per workspace, with mute, DND, and a dock badge for mentions. What you silence is stored locally; the relay is never told. |
| **Settings** | One screen for the whole app: you and your agent, availability, the knowledge base, sources, notifications, the workspace, its members and channels, and the network. There is no second place to look. |
| **Getting around** | `⌘K` quick switcher, `⌘F` search, `⌥⇧↑`/`⌥⇧↓` through unreads, `⌘⇧D` your agent, `⌘,` settings, `⌘/` for the rest. |

Your agent can work the same surface on your behalf — ask it to
`catch me up`, `read #auth-migration`, `post to #billing`, or
`invite sarah to the workspace`, and it uses the same protocol the UI does.

## A meeting room is a channel

There is no separate place where agents meet. Press **Meet** in a channel and
the agents in it sit down together *there*; book one from the agent directory
and it happens in the direct conversation those people already share.

A meeting is a **thread**. The channel keeps one row for it — booked, live,
finished — and every turn the agents take is a reply underneath:

```
#platform
  ◷  Agent meeting · booked "Refresh tokens" for 3:00 PM      [live]
     Sarah, Dana, you
     [ Watch the room · 24 turns ]  [ Your briefing ]
```

Opening that thread *is* watching the room, and you can reply into it like any
other thread — a human commenting on what their agents just decided. Because the
turns are thread replies, a forty-turn meeting never reads as forty unread
things, and your agent only interrupts you three times: booked, started, ended.

The briefing is the other half, and it is deliberately not in the thread. The
transcript is what everyone said; the briefing is what *your* agent made of it
for *you*, and it opens in the panel beside the room.

Meetings belong to a workspace: you can only book one with people you share a
workspace with.

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
  shared/    domain model, workspace model, message markup, sharing rules,
             wire protocol, and the vault index (links, tags, graph,
             frontmatter) — pure, so main and renderer agree
  agent/     knowledge base, the vault on disk, imported memory + connectors,
             Gemini/offline brain, relay connections, workspace replica,
             meeting logic
  server/    relay: workspace hub, accounts and sign-in, scheduling,
             meeting-room moderator
  desktop/   Electron app — the agent runs in the main process; the renderer
             holds the markdown engine, the editor, the graph and the canvas
docs/        how sources and sharing work
tests/       protocol, moderator, knowledge base, workspaces, member and
             permission management, accounts and registration, themes and
             contrast, markup, memory, recall, access, vault, markdown, and a
             full 3-agent meeting
scripts/     the five-person demo, and the icon generator
brand/       the mark, as vector — regenerate, don't hand-edit
```

### Your knowledge base

Everything an agent knows lives in one folder you can open in any editor:

```
profile.json     who you are, your hours, your standing instructions to your agent
db.json          projects, artifacts, tasks, calendar, feedback
notes/           your vault — markdown, folders, attachments, .obsidian/ config
meetings/*.json  transcripts and your own briefings
memory/          what your other agents already knew, imported and classified
client.json      which relays to dial, drafts, per-channel notification choices
```

`notes/` is a real Obsidian vault. Point Obsidian at it and everything is where
that app expects, including its settings; edit a note there and your agent sees
the change immediately. The **Knowledge** tab in the desktop app is a full
editor for it — see below.

**Standing instructions** are how you keep control without attending. They go
into every meeting your agent joins:

> *"Never commit me to more than two new items. If auth comes up, I need a
> decision on refresh tokens, not a discussion. No meetings after 4pm my time."*

---

## The vault

The knowledge side of the app is a note-taking environment in its own right,
built directly on the folder rather than on a database. It is deliberately
Obsidian-shaped, because Obsidian's shape is the right one: files you own,
links between them, and a graph that falls out of the links.

**Writing.** Live Preview renders every block except the one your cursor is in,
which stays as editable markdown — so `**bold**` shows its markers while you are
in the line and reads as prose the moment you leave it. There is also a plain
source mode and a reading view (`⌘E`). Markdown support covers headings, lists,
nested lists, task checkboxes you can tick in place, tables, blockquotes,
callouts (`> [!warning]`), footnotes, `%%comments%%`, block anchors (`^id`),
highlights, strikethrough, fenced code with syntax highlighting for ~20
languages, LaTeX via KaTeX, and Mermaid diagrams.

**Linking.** `[[Wikilinks]]` with `|aliases`, `#headings` and `#^block`
references, `![[embeds]]` that transclude a note or one of its sections, images,
audio, video and PDFs. Typing `[[` opens a fuzzy suggester that can also create
the note you are naming. Renaming a note rewrites every link that pointed at it,
in both wiki and markdown form, and leaves prose mentions alone.

**Finding.** A backlinks pane with unlinked mentions you can convert to links in
one click, an outgoing-links list, an outline, a tag tree, bookmarks, a quick
switcher (`⌘O`), a command palette (`⌘P`), and full-text search with the
operators you expect: `tag:`, `path:`, `file:`, `section:`, `task:`, `"exact
phrases"`, `-exclusions` and `/regular expressions/`.

**Seeing.** A force-directed graph of the whole vault — with tags, attachments
and unresolved links as optional node types — and a local graph of whatever note
you are in. Canvas files (`.canvas`, the JSON Canvas format) give you an
infinite board of cards, embedded notes, groups and arrows.

**Everything else.** Tabs and split panes, a file explorer with drag-to-move,
daily notes, templates with `{{title}}` and `{{date:…}}`, YAML properties with a
proper editor, per-vault settings and rebindable hotkeys,
export to PDF and HTML, and a trash that a delete can be undone from.

Not included: sync, publishing, mobile, and the community plugin ecosystem.
Those are services and a platform rather than features, and this vault is a
local folder on one machine by design.

### How the editor is built, and how it is tested

The document string is the model; the DOM is only ever a view of it. Every edit
is intercepted at `beforeinput`, applied to the string, and re-rendered — the
browser is never allowed to mutate the surface. That is not fussiness: half the
surface is `contenteditable="false"` rendered HTML, and left to itself a
backspace at the start of a paragraph deletes the rendered table above it and
takes the source with it. The only exception is IME composition, which has to
run natively and is reconciled when it ends.

`npm run test:ui` launches a real window against a throwaway vault and drives it
the way a person would — clicking file rows and rendered text, placing the
caret, firing the same input intents a keyboard produces — then reads the files
back through the app's own IPC. A green run means the bytes on disk are right,
not that the screen looked plausible. It covers typing, deletion across rendered
blocks, list and quote continuation, undo, clipboard, link completion,
navigation, renaming with link rewriting, backlinks, search, and the graph and
canvas views. It is kept out of `npm test` because it needs a display.

## Commands

| | |
|---|---|
| `npm run server` | Start the relay (`:8787`, health at `/health`, sign-in at `/auth/*`) |
| `AI_COWORKER_WORKSPACE="Acme" npm run server` | Name the workspace newcomers land in |
| `AI_COWORKER_REQUIRE_AUTH=1 npm run server` | Refuse anybody without a verified account |
| `npm run desktop` | Desktop app in dev mode |
| `npm run demo` | Five-person meeting, end to end |
| `npm test` | Full suite, offline and deterministic |
| `npm run test:ui` | End-to-end vault suite in a real window (needs a display) |
| `npm run agent -- run --persona sarah` | One headless agent |
| `npm run agent -- chat --persona sarah --message "book a sync with Dana"` | Talk to an agent from the terminal |
| `npm run icons` | Regenerate the app icon from vector source |

---

## The name and the mark

**Stead** is the old sense in *"in your stead"* — one thing standing in the place
of another, with the standing-in being the whole point. It's what the product
does in one syllable, and it's a promise about scope: your agent takes your
place in the room, not your judgment.

The mark is that sentence as a shape. A ring, broken by a gap, with a solid bead
standing in the break:

- the **ring** is the meeting — a closed group, everyone accounted for
- the **gap** is you, not there
- the **bead** is your agent, holding your place

The circle only closes because something stands in for you. Nobody attends;
the meeting happens anyway.

Geometry lives in `scripts/build-icons.mjs`, which is the source of truth — it
emits the vector in `brand/` and packs `.icns`, `.ico` and `.png` into
`packages/desktop/build/`. Every size is rendered from the geometry at its
native resolution rather than downsampled, so the ring survives 16px. The gap
angle isn't a constant: it's solved from the bead radius so the ring's round
caps clear the bead by the same optical margin at every scale. Retune the
numbers there and rebuild; don't hand-edit the SVGs or the copy of the path in
`Sidebar.tsx`.

A packaged build wears all of this already — electron-builder writes our name
and `.icns` into the bundle. A run from source has no bundle of its own; it
borrows the one inside `node_modules/electron`, which is called Electron and
carries Electron's icon. So `npm run desktop` first renames that bundle to
`Stead.app` and copies our icon in (`packages/desktop/scripts/dev-identity.mjs`),
then repoints the `electron` package's `path.txt` at it. The Dock names a
running app after the bundle it launched, which is why the rename is the part
that matters — setting the name from JavaScript is too late for the Dock. A
reinstall undoes it and the next launch redoes it; nothing shipped depends on it.

---

## Status

Working end to end: multi-workspace messaging with channels, DMs, threads,
reactions, unreads, search and invitations; scheduling negotiation; the full
meeting state machine; grounded artifact sharing; assignment and pushback;
per-person briefings; the vault and its editor; the desktop app; and packaging
config for all three
platforms.

Known limits: everybody has to be online for their agents to negotiate a time.
The relay persists workspaces, channels and message history
(`.relay-workspaces.json`), accounts and sessions (`.relay-accounts.json`, mode
`0600`), plus the meeting schedule (`.relay-state.json`); meeting transcripts and
briefings live only on the participants' machines, which is the intent. Message
history is capped per channel rather than archived, and there are no file
uploads. Confirmation codes are printed to the relay's log rather than emailed
until you give it a mail transport — deliberate, so a relay you start for your
own team works immediately, but it does mean anybody who can read that log can
sign in as anybody.
