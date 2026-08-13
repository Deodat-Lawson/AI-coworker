import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  type AgentAutonomy,
  type AgentToolKey,
  type AgentToolSpec,
  type Sensitivity,
  type SourceMode,
  type WorkspaceAgent,
  AGENT_AUTONOMIES,
  AGENT_EMOJI,
  AGENT_TOOL_GROUPS,
  AUTONOMY_BLURBS,
  AUTONOMY_LABELS,
  SENSITIVITY_ORDER,
  SOURCE_KIND_TOOLS,
  WORKSPACE_COLORS,
  agentMay,
  describeAgentReach,
  liveTools,
} from '@ai-coworker/shared';

import type { MemoryApi, MemoryState } from '../../electron/memory-ipc.js';
import type { AgentIsolationView } from '../../electron/ipc.js';
import { connectorMeta } from '../components/connectors.js';
import { Icon, type IconName } from '../components/icons.js';
import { Field } from '../components/ui.js';
import { api, unwrap, type WorkspaceView } from '../lib/api.js';
import { relative } from '../lib/format.js';

declare global {
  interface Window {
    memory: MemoryApi;
  }
}

/**
 * The agent that represents you in this workspace, and everything it can reach.
 *
 * This screen exists because "one agent per workspace" is only a real promise
 * if a person can see it. So it is laid out as an answer to three questions, in
 * the order somebody actually asks them: *who is this*, *how much rope does it
 * have*, and *what of mine can it touch*. The last of those is the long half,
 * and it is deliberately concrete — named tools with a status, named folders
 * with a path — rather than a page of switches whose effect you have to guess.
 */
export default function AgentAccess({ workspace }: { workspace: WorkspaceView | undefined }) {
  const [memory, setMemory] = useState<MemoryState | null>(null);
  const [isolation, setIsolation] = useState<AgentIsolationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.memory.getMemoryState().then(setMemory);
    return window.memory.onMemoryState(setMemory);
  }, []);

  const refreshIsolation = useCallback(() => {
    void api.agentIsolation().then((result) => {
      if (result.ok) setIsolation(result.value);
    });
  }, []);
  useEffect(refreshIsolation, [refreshIsolation, workspace?.agent]);

  const save = useCallback(
    async (patch: Parameters<typeof api.saveWorkspaceAgent>[1]) => {
      if (!workspace) return;
      setBusy(true);
      setError(null);
      try {
        await unwrap(api.saveWorkspaceAgent(workspace.workspace.id, patch));
        refreshIsolation();
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [workspace, refreshIsolation],
  );

  if (!workspace) {
    return (
      <div className="empty">
        You are not in a workspace yet. Each workspace you join gets its own agent, and this is where
        you would decide what that one is allowed to touch.
      </div>
    );
  }

  const agent = workspace.agent;

  return (
    <>
      <h1>{agent.name}</h1>
      <p className="subtitle">
        The one agent that represents you in <strong>{workspace.workspace.name}</strong>. It is yours,
        it runs on this machine, and it reaches only what you grant it here — the agent in your next
        workspace is a different agent with a different list.
      </p>

      {error ? <div className="banner bad">{error}</div> : null}

      <IdentityCard agent={agent} busy={busy} onSave={save} />
      <AutonomyChooser agent={agent} onSave={save} />
      <InstructionsCard agent={agent} busy={busy} onSave={save} />
      <CapabilityCards agent={agent} onSave={save} />
      <KnowledgeReach agent={agent} onSave={save} />
      <ComputerAccess
        agent={agent}
        workspaceId={workspace.workspace.id}
        memory={memory}
        busy={busy}
        onSave={save}
        onError={setError}
      />
      <IsolationCard agent={agent} isolation={isolation} />
    </>
  );
}

type Save = (patch: Parameters<typeof api.saveWorkspaceAgent>[1]) => Promise<void>;

// ---------------------------------------------------------------------------
// Who it is
// ---------------------------------------------------------------------------

function IdentityCard({ agent, busy, onSave }: { agent: WorkspaceAgent; busy: boolean; onSave: Save }) {
  const [name, setName] = useState(agent.name);
  const [open, setOpen] = useState(false);

  return (
    <div className="agent-identity">
      <div className="agent-avatar" style={{ background: `${agent.accent}22`, borderColor: agent.accent }}>
        <span>{agent.emoji}</span>
      </div>
      <div className="agent-identity-body">
        <input
          className="agent-name-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() !== agent.name && void onSave({ name: name.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          aria-label="Agent name"
        />
        <div className="agent-reach">{describeAgentReach(agent)}</div>
      </div>
      <button className="tab" onClick={() => setOpen((v) => !v)} disabled={busy}>
        <Icon name="palette" size={15} /> Look
      </button>

      {open ? (
        <div className="agent-look">
          <div className="picker-row">
            {AGENT_EMOJI.map((emoji) => (
              <button
                key={emoji}
                className={`icon-choice ${agent.emoji === emoji ? 'on' : ''}`}
                onClick={() => void onSave({ emoji })}
              >
                {emoji}
              </button>
            ))}
          </div>
          <div className="picker-row">
            {WORKSPACE_COLORS.map((color) => (
              <button
                key={color}
                className={`color-choice ${agent.accent === color ? 'on' : ''}`}
                style={{ background: color }}
                aria-label={color}
                onClick={() => void onSave({ accent: color })}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

const AUTONOMY_ICONS: Record<AgentAutonomy, IconName> = {
  observer: 'eye',
  ask: 'shield-check',
  act: 'sparkle',
};

function AutonomyChooser({ agent, onSave }: { agent: WorkspaceAgent; onSave: Save }) {
  return (
    <>
      <h2>How much it does on its own</h2>
      <div className="choice-grid" role="radiogroup" aria-label="Autonomy">
        {AGENT_AUTONOMIES.map((level) => (
          <button
            key={level}
            role="radio"
            aria-checked={agent.autonomy === level}
            className={`choice-card ${agent.autonomy === level ? 'on' : ''}`}
            onClick={() => void onSave({ autonomy: level })}
          >
            <Icon name={AUTONOMY_ICONS[level]} size={19} className="choice-icon" />
            <div className="choice-title">{AUTONOMY_LABELS[level]}</div>
            <div className="choice-blurb">{AUTONOMY_BLURBS[level]}</div>
          </button>
        ))}
      </div>
      {agent.autonomy === 'observer' ? (
        <p className="hint">
          While it is watching only, the switches that put something into the world — accepting work,
          booking meetings, writing to your knowledge base — are held off no matter how they are set.
        </p>
      ) : null}
    </>
  );
}

function InstructionsCard({ agent, busy, onSave }: { agent: WorkspaceAgent; busy: boolean; onSave: Save }) {
  const [text, setText] = useState(agent.instructions);
  const [saved, setSaved] = useState(false);

  return (
    <>
      <h2>Standing instructions, here</h2>
      <div className="card">
        <Field
          label={`What it should always do — and never do — in this workspace`}
          hint="These apply here only. A client workspace and your own team rarely want the same agent."
        >
          <textarea
            style={{ minHeight: 110 }}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            placeholder="Never commit me to a date without checking. Push back on scope before launch. Do not discuss headcount."
          />
        </Field>
        <label className="check">
          <input
            type="checkbox"
            checked={agent.inheritInstructions}
            onChange={(e) => void onSave({ inheritInstructions: e.target.checked })}
          />
          Also follow my machine-wide instructions here
        </label>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="primary"
            style={{ flex: '0 0 auto' }}
            disabled={busy || text === agent.instructions}
            onClick={() =>
              void onSave({ instructions: text }).then(() => setSaved(true))
            }
          >
            Save instructions
          </button>
          {saved ? <span style={{ color: 'var(--good)' }}>Saved.</span> : null}
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// What it may do
// ---------------------------------------------------------------------------

const TOOL_ICONS: Record<AgentToolKey, IconName> = {
  messages: 'hash',
  meetings: 'meeting',
  calendar: 'calendar',
  tasks: 'check',
  knowledge_read: 'knowledge',
  knowledge_write: 'edit',
  memory_recall: 'database',
  computer_folders: 'folder',
  computer_claude_code: 'terminal',
  computer_codex: 'code',
};

function CapabilityCards({ agent, onSave }: { agent: WorkspaceAgent; onSave: Save }) {
  const tools = liveTools();

  return (
    <>
      {AGENT_TOOL_GROUPS.filter((group) => group.key !== 'computer').map((group) => (
        <div key={group.key}>
          <h2>{group.label}</h2>
          <p className="subtitle" style={{ marginTop: -6 }}>
            {group.blurb}
          </p>
          <div className="card tight">
            {tools
              .filter((tool) => tool.group === group.key)
              .map((tool) => (
                <ToggleRow
                  key={tool.key}
                  tool={tool}
                  on={agent.access.tools[tool.key] === true}
                  held={agent.access.tools[tool.key] === true && !agentMay(agent, tool.key)}
                  onToggle={(next) => void onSave({ access: { tools: { [tool.key]: next } } })}
                />
              ))}
          </div>
        </div>
      ))}
    </>
  );
}

function ToggleRow({
  tool,
  on,
  held,
  onToggle,
}: {
  tool: AgentToolSpec;
  on: boolean;
  /** Switched on, but something else is holding it off right now. */
  held?: boolean;
  onToggle: (next: boolean) => void;
}) {
  return (
    <div className={`switch-row ${on ? 'on' : ''}`}>
      <Icon name={TOOL_ICONS[tool.key]} size={17} className="switch-icon" />
      <div className="switch-text">
        <div className="switch-title">
          {tool.label}
          {tool.risk === 'high' ? <span className="tag small warn">sensitive</span> : null}
          {held ? <span className="tag small">held — watching only</span> : null}
        </div>
        <div className="switch-blurb">{tool.blurb}</div>
      </div>
      <Switch on={on} label={tool.label} onChange={onToggle} />
    </div>
  );
}

/** A real switch, not a checkbox: this is the control the whole screen is made of. */
export function Switch({
  on,
  label,
  disabled,
  onChange,
}: {
  on: boolean;
  label: string;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`switch ${on ? 'on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span className="switch-knob" />
    </button>
  );
}

// ---------------------------------------------------------------------------
// How far into your own knowledge it reaches
// ---------------------------------------------------------------------------

const CEILING_BLURBS: Record<Sensitivity, string> = {
  public: 'Only what you would say to anyone.',
  internal: 'Everyday work. Nothing marked confidential or above.',
  confidential: 'Includes confidential material — finance, people, strategy.',
  restricted: 'Nearly everything. Restricted material is loaded here.',
  secret: 'Not offered: secret material never leaves this machine, in any workspace.',
};

function KnowledgeReach({ agent, onSave }: { agent: WorkspaceAgent; onSave: Save }) {
  // `secret` is not on the dial: it never leaves this machine in any workspace,
  // so offering it as a ceiling would imply it could be raised to.
  const levels: Sensitivity[] = SENSITIVITY_ORDER.filter((level) => level !== 'secret');
  const at = levels.indexOf(agent.access.ceiling) === -1 ? 1 : levels.indexOf(agent.access.ceiling);

  return (
    <>
      <h2>Sensitivity ceiling</h2>
      <p className="subtitle" style={{ marginTop: -6 }}>
        Nothing above this level is loaded in this workspace at all. Not shared carefully — not
        loaded, so it cannot be leaked by a clever question.
      </p>
      <div className="card">
        <div className="ceiling">
          {levels.map((level, i) => (
            <button
              key={level}
              className={`ceiling-step ${i <= at ? 'filled' : ''} ${i === at ? 'current' : ''}`}
              onClick={() => void onSave({ access: { ceiling: level } })}
              aria-pressed={i === at}
            >
              <span className="ceiling-bar" />
              <span className="ceiling-label">{level}</span>
            </button>
          ))}
        </div>
        <p className="hint">{CEILING_BLURBS[agent.access.ceiling]}</p>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// This computer
// ---------------------------------------------------------------------------


function ComputerAccess({
  agent,
  workspaceId,
  memory,
  busy,
  onSave,
  onError,
}: {
  agent: WorkspaceAgent;
  workspaceId: string;
  memory: MemoryState | null;
  busy: boolean;
  onSave: Save;
  onError: (error: string | null) => void;
}) {
  const mode: SourceMode = agent.access.sourceMode;
  const granted = useMemo(() => new Set(agent.access.sources), [agent.access.sources]);

  const sources = memory?.sources ?? [];
  const available = memory?.available ?? [];

  const setMode = (next: SourceMode) =>
    void onSave({ access: { sourceMode: next, tools: { memory_recall: next !== 'none' } } });

  const toggleSource = (id: string, kind: string) => {
    const on = granted.has(id);
    const next = on ? agent.access.sources.filter((s) => s !== id) : [...agent.access.sources, id];
    // Granting a source switches on everything the runtime needs to honour it.
    // A source ticked in a list that the recall gate — or its tool's own gate —
    // then throws away is a settings screen telling you a lie.
    const tools: Record<string, boolean> = { memory_recall: next.length > 0 };
    const kindTool = SOURCE_KIND_TOOLS[kind];
    if (kindTool && !on) tools[kindTool] = true;
    void onSave({
      access: { sources: next, sourceMode: next.length ? 'selected' : 'none', tools },
    });
  };

  return (
    <>
      <h2>This computer</h2>
      <p className="subtitle" style={{ marginTop: -6 }}>
        {AGENT_TOOL_GROUPS.find((g) => g.key === 'computer')?.blurb}
      </p>

      {/* The master switches for each class of reach. They are above the source
          list because switching one off has to be understood as covering every
          source of that kind, granted or not. */}
      <div className="card tight">
        {liveTools()
          .filter((tool) => tool.group === 'computer')
          .map((tool) => (
            <ToggleRow
              key={tool.key}
              tool={tool}
              on={agent.access.tools[tool.key] === true}
              onToggle={(next) => void onSave({ access: { tools: { [tool.key]: next } } })}
            />
          ))}
      </div>

      <div className="grant-modes" role="radiogroup" aria-label="Imported memory">
        {(
          [
            { key: 'none', label: 'Nothing', blurb: 'This agent recalls no imported memory.', icon: 'shield' },
            { key: 'selected', label: 'Chosen sources', blurb: 'Only what you tick below.', icon: 'shield-check' },
            { key: 'all', label: 'Everything imported', blurb: 'Every source, including ones added later.', icon: 'database' },
          ] as { key: SourceMode; label: string; blurb: string; icon: IconName }[]
        ).map((option) => (
          <button
            key={option.key}
            role="radio"
            aria-checked={mode === option.key}
            className={`choice-card small ${mode === option.key ? 'on' : ''}`}
            onClick={() => setMode(option.key)}
          >
            <Icon name={option.icon} size={17} className="choice-icon" />
            <div className="choice-title">{option.label}</div>
            <div className="choice-blurb">{option.blurb}</div>
          </button>
        ))}
      </div>

      {mode === 'all' ? (
        <div className="banner warn">
          <Icon name="alert" size={17} />
          <div>
            <div className="card-title">Every source, including ones connected later</div>
            <div className="card-sub">
              A source you connect next month lands in this workspace without another decision.
              "Chosen sources" is the setting that stays true.
            </div>
          </div>
        </div>
      ) : null}

      <h3 className="grant-heading">Connected on this machine</h3>
      {sources.length === 0 ? (
        <div className="empty">
          Nothing imported yet. Connect a tool below and its memory becomes grantable — to this
          workspace's agent, and only the ones you tick.
        </div>
      ) : (
        <div className="connector-grid">
          {sources.map((source) => {
            const meta = connectorMeta(source.kind);
            const kindTool = SOURCE_KIND_TOOLS[source.kind];
            const kindOff = Boolean(kindTool) && agent.access.tools[kindTool!] === false;
            const on = (mode === 'all' || granted.has(source.id)) && !kindOff;
            return (
              <div className={`connector-card ${on ? 'granted' : ''}`} key={source.id}>
                <div className="connector-head">
                  <span className="connector-tile">
                    <Icon name={meta.icon} size={18} />
                  </span>
                  <div className="connector-title">
                    <div className="connector-name">{source.label}</div>
                    <div className="connector-sub">
                      {source.memories} memor{source.memories === 1 ? 'y' : 'ies'}
                      {source.lastSyncAt ? ` · imported ${relative(source.lastSyncAt)}` : ' · never imported'}
                    </div>
                  </div>
                  <Switch
                    on={on}
                    disabled={(mode === 'all' && !kindOff) || busy}
                    label={`Grant ${source.label}`}
                    onChange={() => toggleSource(source.id, source.kind)}
                  />
                </div>
                <div className="connector-path" title={source.root}>
                  {source.root}
                </div>
                {kindOff ? (
                  <span className="tag small warn">{meta.label} is switched off for this agent</span>
                ) : null}
                {!source.enabled ? <span className="tag small warn">paused</span> : null}
              </div>
            );
          })}
        </div>
      )}

      {available.length ? (
        <>
          <h3 className="grant-heading">Found on this machine, not connected</h3>
          <div className="connector-grid">
            {available.map((source) => {
              const meta = connectorMeta(source.kind);
              return (
                <div className="connector-card offer" key={source.id}>
                  <div className="connector-head">
                    <span className="connector-tile">
                      <Icon name={meta.icon} size={18} />
                    </span>
                    <div className="connector-title">
                      <div className="connector-name">{source.label}</div>
                      <div className="connector-sub">{source.detail}</div>
                    </div>
                    <button
                      className="tab"
                      disabled={busy}
                      onClick={() =>
                        void window.memory.connectSource(source.id).then((result) => {
                          if (!result.ok) onError(result.error);
                        })
                      }
                    >
                      Connect
                    </button>
                  </div>
                  <div className="connector-path" title={source.root}>
                    {source.root}
                  </div>
                </div>
              );
            })}
          </div>
          <p className="hint">
            Connecting imports the memory to your machine. It does not hand it to this workspace's
            agent — that is the switch above, and it is per workspace.
          </p>
        </>
      ) : null}

      <h3 className="grant-heading">Folders this agent may read</h3>
      <div className="card">
        {agent.access.folders.length === 0 ? (
          <p className="card-sub" style={{ marginTop: 0 }}>
            None. This agent cannot read a single file on this machine outside your knowledge base.
          </p>
        ) : (
          agent.access.folders.map((folder) => (
            <div className="folder-row" key={folder}>
              <Icon name="folder-open" size={16} className="folder-icon" />
              <span className="folder-path" title={folder}>
                {folder}
              </span>
              <button
                className="ghost"
                onClick={() =>
                  void api.revokeAgentFolder(workspaceId, folder).then((result) => {
                    if (!result.ok) onError(result.error);
                  })
                }
              >
                Revoke
              </button>
            </div>
          ))
        )}
        <button
          className="tab"
          style={{ marginTop: 10 }}
          disabled={busy}
          onClick={() =>
            void api.grantAgentFolder(workspaceId).then((result) => {
              if (!result.ok) onError(result.error);
            })
          }
        >
          <Icon name="plus" size={14} /> Grant a folder
        </button>
        {agentMay(agent, 'computer_folders') ? null : (
          <p className="hint">
            Granting a folder switches folder reading on for this agent — a path in a list nothing
            consults would be a settings screen telling you a lie.
          </p>
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Are they actually separate?
// ---------------------------------------------------------------------------

function IsolationCard({
  agent,
  isolation,
}: {
  agent: WorkspaceAgent;
  isolation: AgentIsolationView | null;
}) {
  if (!isolation || isolation.rows.length <= 1) return null;
  const others = isolation.rows.filter((row) => row.workspaceId !== agent.workspaceId);

  return (
    <>
      <h2>Your other agents</h2>
      <p className="subtitle" style={{ marginTop: -6 }}>
        One per workspace, each with its own list. Nothing on this screen applies to any of them.
      </p>
      <div className="card tight">
        {others.map((row) => (
          <div className="isolation-row" key={row.workspaceId}>
            <span className="isolation-mark" style={{ background: `${row.accent}22`, borderColor: row.accent }}>
              {row.emoji}
            </span>
            <div className="isolation-text">
              <div className="isolation-name">
                {row.agentName} <span className="isolation-where">in {row.workspaceName}</span>
              </div>
              <div className="isolation-reach">{row.reach}</div>
            </div>
            <span className="tag small">{row.autonomy}</span>
          </div>
        ))}
      </div>

      {isolation.shared.length ? (
        <div className="banner warn">
          <Icon name="alert" size={17} />
          <div>
            <div className="card-title">Two of your agents reach the same thing</div>
            {isolation.shared.slice(0, 3).map((pair, i) => (
              <div className="card-sub" key={i}>
                {pair.a} and {pair.b} both reach {pair.overlap.slice(0, 3).join(', ')}
                {pair.overlap.length > 3 ? ` and ${pair.overlap.length - 3} more` : ''}.
              </div>
            ))}
            <div className="card-sub">
              That may be exactly what you want. It is listed because it is the only thing here worth
              a second look.
            </div>
          </div>
        </div>
      ) : (
        <div className="banner good">
          <Icon name="shield-check" size={17} />
          <div>
            <div className="card-title">No overlap</div>
            <div className="card-sub">
              No two of your agents reach the same source or folder.
            </div>
          </div>
        </div>
      )}
    </>
  );
}
