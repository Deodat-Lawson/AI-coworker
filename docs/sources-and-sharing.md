# Sources and sharing

Your agent should not start empty. You already run other agents on this machine —
Claude Code, Codex, an OpenClaw workspace, Hermes — and each of them has been
writing down what it learned about you and your work for months. This is the
pipeline that borrows it, and the rule set that decides who your agent may
repeat it to.

Nothing here uploads anything. Every connector reads a local directory and
writes into your own knowledge base.

---

## What gets connected

| Tool | Where it looks | What it takes |
|---|---|---|
| **Claude Code** | `~/.claude` | per-project memory files, `CLAUDE.md` at user and project level, and what past sessions in each project were about |
| **Codex** | `~/.codex` | `AGENTS.md`, distilled memories (files or `memories_*.sqlite`), and the subject of past threads |
| **OpenClaw** | `~/.openclaw/workspace` | `MEMORY.md` split per section, `USER.md`, `IDENTITY.md`, `AGENTS.md`, daily notes |
| **Hermes** | `~/.hermes` | `memories/MEMORY.md` and `memories/USER.md`, one memory per `§` chunk |
| **Any folder** | wherever you point it | `MEMORY.md`, `AGENTS.md`, `CLAUDE.md`, `USER.md`, `memory/*.md` |

Two things are deliberately *not* taken. Index files like Claude Code's
`MEMORY.md` are skipped, because every memory they point at is imported
individually and ingesting the index would duplicate all of them in summary
form. And transcripts are never summarized: from a past session the pipeline
keeps only what the tool already stated — the directory it ran in and the
opening request, quoted, with the machine preamble stripped. Nothing in this
pipeline can invent a memory you never had.

The last connector is the escape hatch. Every tool in this space converges on
the same filenames, so the fifth tool — or next year's — usually needs a path,
not a code change.

---

## Where it lands

```
<knowledge-base>/memory/sources.json    what is connected, and how fresh each one is
<knowledge-base>/memory/records/*.md    one memory per file, sharing policy in the frontmatter
```

This sits *beside* `notes/`, not inside it. `notes/` is what you wrote; `memory/`
is what your other agents knew. Keeping them apart means an import can never
quietly rewrite something you authored, disconnecting a tool can take its
memories with it in one move, and every record still knows which tool, which
file and which session it came from.

It is markdown for the same reason the notes are: open the folder in any editor
and you can see exactly what your agent absorbed and what it is allowed to say
about it.

Re-running a sync is cheap. Each source keeps a watermark, so the second run of
the day reads what changed rather than every transcript on the machine. Editing
a memory file updates the record it produced last time instead of stacking a
second copy, and the same sentence arriving from two different tools is stored
once with both sightings recorded.

---

## Who may hear it

Every memory carries a policy: how sensitive it is, what it is about, and any
explicit allow or deny you pinned onto it. The classification is automatic and
rule-based — no model call, so the same memory always gets the same answer and a
refusal can be explained.

| Level | Reaches |
|---|---|
| `public` | anyone, inside the company or outside |
| `internal` | anyone at the company |
| `confidential` | your manager in full; everyone else is told it exists |
| `restricted` | you; your manager is told it exists |
| `secret` | you alone |

Topic sets the floor: money, people decisions and legal exposure start at
`confidential`, anything about you personally starts at `restricted`, and
"do not share" written in the text raises it further. Something that looks like
an actual credential is **quarantined** — kept on disk so you can see it, never
recalled, never shared.

Talking about tokens is not the same as holding one. "The refresh-token rollout
is behind" is ordinary engineering and stays internal; "a refresh token was
hard-coded and has leaked" is confidential; `sk-...` in the text is quarantined.

### The case this exists for

An engineer asks their manager's agent about revenue. The wrong answers are
"here is the number" and "I don't know anything about that". What actually
happens:

```
$ npm run agent -- memory ask --as sarah@northwind --query "revenue this quarter"

If sarah@northwind asked "revenue this quarter":

  WITHOLD Revenue for the quarter (finance)
          This is confidential finance material. I can say that it exists, not
          what it says — someone who reports to me would need my human to
          release the detail.
```

The subject is acknowledged. The figure never reaches the model at all — not the
prompt, not the transcript. Direction matters too: the same memory going *up* to
that manager's own manager is shared in full.

A meeting is a room, not one listener. Anything said is heard by everyone
present, so a room gets the strictest of the individual answers: one outsider in
the call and the memory is not raised at all.

### Overriding it

`allow` and `deny` are yours. A deny beats everything, including allow-anyone —
that is what makes it usable as a safety valve. Anything you set is pinned, and
no later sync re-decides it.

```
memory policy --id mem_… --sensitivity restricted
memory policy --id mem_… --allow team:platform,dana@northwind
memory policy --id mem_… --deny role:ic
```

Audiences are written the way you would say them: `anyone`, `org`,
`team:platform`, `role:manager`, `manager`, `reports`, or a plain address.

---

## Using it

In the app, **Sources** shows what is connected, what was found on this machine
and never imported, every memory with its policy, and — the part worth looking
at — what a specific person would actually get if they asked.

From the terminal:

```bash
npm run agent -- memory status                 # what I know, and what I don't
npm run agent -- memory sources                # every store found on this machine
npm run agent -- memory sync                   # import what changed
npm run agent -- memory list --query auth      # what I have on a subject
npm run agent -- memory ask --as sarah@northwind --query revenue
npm run agent -- memory connect --folder ~/some-other-agent
npm run agent -- memory forget --id mem_…
```

And in conversation with your own agent: *"what do you know about the auth
migration"*, or *"what would you tell Sarah about our revenue"*.

`memory status` is the honest half of the feature. It reports what is connected,
what is stale, what failed to read and why, and what is sitting on the machine
unconnected — so a gap in an answer is something you can see rather than
something you find out about later.
