# AI Coworker

A personal AI that goes to your meetings.

Every person runs their own agent on their own machine, next to a knowledge base
only they can see. When two people need to sync, their **agents** meet instead —
they negotiate a time against both calendars, hold a real turn-taking meeting,
interrogate each other, assign work, push back on it, and then each writes a
briefing for its own human.

Nobody attends. Everybody gets told.

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
  shared/    domain model, the wire protocol, and the vault index (links,
             tags, graph, frontmatter) — pure, so main and renderer agree
  agent/     knowledge base, the vault on disk, Gemini/offline brain,
             relay client, meeting logic
  server/    relay: directory, scheduling, meeting-room moderator
  desktop/   Electron app — the agent runs in the main process; the renderer
             holds the markdown engine, the editor, the graph and the canvas
tests/       protocol, moderator, store, vault, markdown, and a 3-agent meeting
scripts/     the five-person demo
```

### Your knowledge base

Everything an agent knows lives in one folder you can open in any editor:

```
profile.json     who you are, your hours, your standing instructions to your agent
db.json          projects, artifacts, tasks, calendar, feedback
notes/           your vault — markdown, folders, attachments, .obsidian/ config
meetings/*.json  transcripts and your own briefings
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
proper editor, per-vault settings and rebindable hotkeys, light and dark themes,
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
| `npm run server` | Start the relay (`:8787`, health at `/health`) |
| `npm run desktop` | Desktop app in dev mode |
| `npm run demo` | Five-person meeting, end to end |
| `npm test` | Full suite, offline and deterministic |
| `npm run test:ui` | End-to-end vault suite in a real window (needs a display) |
| `npm run agent -- run --persona sarah` | One headless agent |
| `npm run agent -- chat --persona sarah --message "book a sync with Dana"` | Talk to an agent from the terminal |

---

## Status

Working end to end: scheduling negotiation, the full meeting state machine,
grounded artifact sharing, assignment and pushback, per-person briefings, the
vault and its editor, the desktop app, and packaging config for all three
platforms.

Known limits: agents must be online for their agent to negotiate a time, and
there is no authentication on the relay — it assumes a trusted network. The relay
persists the meeting *schedule* across restarts (`.relay-state.json`) but nothing
else; transcripts and briefings live only on the participants' machines, which is
the intent.
