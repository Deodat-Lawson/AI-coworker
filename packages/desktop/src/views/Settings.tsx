import { useEffect, useState } from 'react';

import {
  type ChannelPrefs,
  type NotifyLevel,
  type WorkspaceRole,
  WORKSPACE_COLORS,
  WORKSPACE_ICONS,
  isDirect,
} from '@ai-coworker/shared';

import { SHORTCUTS } from '../components/dialogs.js';
import { Avatar, ConfirmButton, Field } from '../components/ui.js';
import { api, unwrap, type AppState, type WorkspaceView } from '../lib/api.js';
import { dateTimeOf, plural, relative } from '../lib/format.js';
import Sources from './Sources.js';

/**
 * Every setting in the app, in one place.
 *
 * There is no second settings screen. What used to be scattered across a
 * workspace dialog, a members dialog, a channel dialog and an agent page is one
 * list of panes here — because "where do I change this?" should have exactly
 * one answer.
 */
export type SettingsPane =
  | 'account'
  | 'agent'
  | 'availability'
  | 'notifications'
  | 'workspace'
  | 'members'
  | 'channels'
  | 'knowledge'
  | 'sources'
  | 'network'
  | 'shortcuts';

const PANES: { key: SettingsPane; label: string; group: string }[] = [
  { key: 'account', label: 'You', group: 'Your agent' },
  { key: 'agent', label: 'Agent', group: 'Your agent' },
  { key: 'availability', label: 'Availability', group: 'Your agent' },
  { key: 'knowledge', label: 'Knowledge base', group: 'Your agent' },
  { key: 'sources', label: 'Sources', group: 'Your agent' },
  { key: 'notifications', label: 'Notifications', group: 'This workspace' },
  { key: 'workspace', label: 'Workspace', group: 'This workspace' },
  { key: 'members', label: 'Members and invites', group: 'This workspace' },
  { key: 'channels', label: 'Channels', group: 'This workspace' },
  { key: 'network', label: 'Network', group: 'App' },
  { key: 'shortcuts', label: 'Shortcuts', group: 'App' },
];

interface Props {
  state: AppState;
  workspace: WorkspaceView | undefined;
  pane: SettingsPane;
  onPane: (pane: SettingsPane) => void;
  onOpenChannel: (channelId: string) => void;
  onMessage: (address: string) => void;
  onOpenKnowledge: () => void;
}

export default function Settings({
  state,
  workspace,
  pane,
  onPane,
  onOpenChannel,
  onMessage,
  onOpenKnowledge,
}: Props) {
  const groups = [...new Set(PANES.map((p) => p.group))];

  return (
    <div className="settings">
      <nav className="settings-rail">
        <div className="settings-rail-title">Settings</div>
        {groups.map((group) => (
          <div className="settings-rail-group" key={group}>
            <div className="settings-rail-label">{group}</div>
            {PANES.filter((p) => p.group === group).map((p) => (
              <button
                key={p.key}
                className={`settings-rail-item ${pane === p.key ? 'active' : ''}`}
                onClick={() => onPane(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* Keyed on the workspace: switching to another one must re-seed every
          form here rather than leaving the last workspace's values in the
          boxes. */}
      <div className="settings-pane" key={workspace?.workspace.id ?? 'none'}>
        {pane === 'account' ? <AccountPane state={state} workspace={workspace} /> : null}
        {pane === 'agent' ? <AgentPane state={state} /> : null}
        {pane === 'availability' ? <AvailabilityPane state={state} /> : null}
        {pane === 'notifications' ? (
          <NotificationsPane workspace={workspace} onOpenChannel={onOpenChannel} />
        ) : null}
        {pane === 'workspace' ? <WorkspacePane workspace={workspace} /> : null}
        {pane === 'members' ? <MembersPane workspace={workspace} onMessage={onMessage} /> : null}
        {pane === 'channels' ? (
          <ChannelsPane workspace={workspace} onOpenChannel={onOpenChannel} />
        ) : null}
        {pane === 'knowledge' ? (
          <KnowledgePane state={state} onOpenKnowledge={onOpenKnowledge} />
        ) : null}
        {pane === 'sources' ? <Sources state={state} /> : null}
        {pane === 'network' ? <NetworkPane state={state} /> : null}
        {pane === 'shortcuts' ? <ShortcutsPane /> : null}
      </div>
    </div>
  );
}

/** Every pane saves the same way, and says so in the same place. */
function useSaver(): [React.ReactNode, (fn: () => Promise<unknown>, done?: string) => Promise<void>, boolean] {
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!status) return;
    const id = setTimeout(() => setStatus(null), 2200);
    return () => clearTimeout(id);
  }, [status]);

  const save = async (fn: () => Promise<unknown>, done = 'Saved.') => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setStatus(done);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const note = (
    <>
      {status ? <span style={{ marginLeft: 10, color: 'var(--good)' }}>{status}</span> : null}
      {error ? <div className="error-text">{error}</div> : null}
    </>
  );
  return [note, save, busy];
}

function NoWorkspace() {
  return (
    <div className="empty">
      You are not in a workspace yet. Create or join one and its settings appear here.
    </div>
  );
}

// ---------------------------------------------------------------------------
// You
// ---------------------------------------------------------------------------

function AccountPane({ state, workspace }: { state: AppState; workspace: WorkspaceView | undefined }) {
  const profile = state.profile!;
  const [displayName, setDisplayName] = useState(profile.displayName);
  const [title, setTitle] = useState(profile.title);
  const [team, setTeam] = useState(profile.team);
  const [bio, setBio] = useState(profile.bio);
  const [focus, setFocus] = useState(profile.focusAreas.join(', '));
  const [note, save, busy] = useSaver();

  const [wsName, setWsName] = useState(workspace?.me.displayName ?? '');
  const [wsTitle, setWsTitle] = useState(workspace?.me.title ?? '');
  const [wsNote, wsSave, wsBusy] = useSaver();

  return (
    <>
      <h1>You</h1>
      <p className="subtitle">
        How your agent introduces you to other agents. Everything here is on your machine; only what
        is published to a workspace directory leaves it.
      </p>

      <div className="card">
        <div className="row">
          <Field label="Name">
            <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          </Field>
          <Field label="Agent address">
            <input readOnly value={profile.address} />
          </Field>
        </div>
        <div className="row">
          <Field label="Title">
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Team">
            <input value={team} onChange={(e) => setTeam(e.target.value)} />
          </Field>
        </div>
        <Field label="Bio — how other agents understand your role">
          <textarea value={bio} onChange={(e) => setBio(e.target.value)} />
        </Field>
        <Field
          label="Focus areas (comma separated)"
          hint="Other agents use this to decide which questions belong to you."
        >
          <input value={focus} onChange={(e) => setFocus(e.target.value)} />
        </Field>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void save(() =>
              unwrap(
                api.saveProfile({
                  displayName,
                  title,
                  team,
                  bio,
                  focusAreas: focus.split(',').map((f) => f.trim()).filter(Boolean),
                }),
              ),
            )
          }
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {note}
      </div>

      {workspace ? (
        <>
          <h2>How you appear in {workspace.workspace.name}</h2>
          <div className="card">
            <p className="card-sub" style={{ marginTop: 0 }}>
              Each workspace can see you differently. Your address stays{' '}
              <code>{workspace.me.address}</code>.
            </p>
            <div className="row">
              <Field label="Display name">
                <input value={wsName} onChange={(e) => setWsName(e.target.value)} />
              </Field>
              <Field label="Title">
                <input value={wsTitle} onChange={(e) => setWsTitle(e.target.value)} />
              </Field>
            </div>
            <button
              className="primary"
              disabled={wsBusy}
              onClick={() =>
                void wsSave(() =>
                  unwrap(
                    api.setWorkspaceProfile(workspace.workspace.id, {
                      displayName: wsName,
                      title: wsTitle,
                    }),
                  ),
                )
              }
            >
              {wsBusy ? 'Saving…' : 'Save'}
            </button>
            {wsNote}
          </div>
        </>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

function AgentPane({ state }: { state: AppState }) {
  const profile = state.profile!;
  const [instructions, setInstructions] = useState(profile.agentInstructions);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(state.connection.model);
  const [note, save, busy] = useSaver();
  const [brainNote, brainSave, brainBusy] = useSaver();

  return (
    <>
      <h1>Agent</h1>
      <p className="subtitle">
        Your agent speaks for you in every room it enters. This is where you tell it how.
      </p>

      <h2>Standing instructions</h2>
      <div className="card">
        <Field
          label="What your agent should always do — and never do"
          hint="It follows these in every meeting. This is where you protect your own time."
        >
          <textarea
            style={{ minHeight: 140 }}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="Never commit me to more than two new items in a meeting. Push back on anything that adds scope before launch."
          />
        </Field>
        <button
          className="primary"
          disabled={busy}
          onClick={() => void save(() => unwrap(api.saveProfile({ agentInstructions: instructions })))}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {note}
      </div>

      <h2>Brain</h2>
      <div className="card">
        <p style={{ marginTop: 0 }}>
          <span className={`tag ${state.connection.providerLive ? 'good' : 'warn'}`}>
            {state.connection.providerName}
          </span>{' '}
          {state.connection.providerReason}
          {state.connection.apiKeySource === 'environment' ? ' (key from your environment)' : ''}
        </p>
        <Field
          label="Gemini API key"
          hint="Stored locally in this app's config. It never leaves your machine except in requests to Google. You can also set GEMINI_API_KEY in your environment or a .env file next to the app."
        >
          <div className="row">
            <input
              type="password"
              value={apiKey}
              placeholder={
                state.connection.hasApiKey ? '•••••••• (a key is already set)' : 'Paste your Gemini API key'
              }
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button
              style={{ flex: '0 0 auto' }}
              disabled={brainBusy}
              onClick={() =>
                void brainSave(async () => {
                  await unwrap(api.setBrain({ apiKey: apiKey.trim(), model: model.trim() }));
                  setApiKey('');
                }, 'Brain updated.')
              }
            >
              Save key
            </button>
            {state.connection.apiKeySource === 'settings' ? (
              <button
                style={{ flex: '0 0 auto' }}
                onClick={() =>
                  void brainSave(
                    () => unwrap(api.setBrain({ apiKey: '', model: model.trim() })),
                    'Key cleared.',
                  )
                }
              >
                Clear
              </button>
            ) : null}
          </div>
        </Field>
        <Field label="Model">
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="gemini-flash-latest" />
        </Field>
        {!state.connection.providerLive ? (
          <p className="hint">
            Everything works without a key, but the offline brain only handles simple phrasings and
            writes much blunter meeting turns.
          </p>
        ) : null}
        {brainNote}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function AvailabilityPane({ state }: { state: AppState }) {
  const profile = state.profile!;
  const [startHour, setStartHour] = useState(Math.floor(profile.workingHours.startMinute / 60));
  const [endHour, setEndHour] = useState(Math.floor(profile.workingHours.endMinute / 60));
  const [days, setDays] = useState<number[]>(profile.workingHours.days);
  const [note, save, busy] = useSaver();

  return (
    <>
      <h1>Availability</h1>
      <p className="subtitle">
        When other agents are allowed to put something in your calendar. Your agent negotiates inside
        these hours and nowhere else.
      </p>

      <div className="card">
        <div className="row">
          <Field label="From">
            <select value={startHour} onChange={(e) => setStartHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
          </Field>
          <Field label="Until">
            <select value={endHour} onChange={(e) => setEndHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {h}:00
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field label="Days">
          <div>
            {DAY_LABELS.map((label, index) => (
              <button
                key={label}
                className={days.includes(index) ? 'primary' : ''}
                style={{ marginRight: 6 }}
                onClick={() =>
                  setDays((prev) =>
                    prev.includes(index) ? prev.filter((d) => d !== index) : [...prev, index].sort(),
                  )
                }
              >
                {label}
              </button>
            ))}
          </div>
        </Field>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            void save(() =>
              unwrap(
                api.saveProfile({
                  workingHours: { days, startMinute: startHour * 60, endMinute: endHour * 60 },
                }),
              ),
            )
          }
        >
          {busy ? 'Saving…' : 'Save hours'}
        </button>
        {note}
      </div>

      <h2>Calendar holds</h2>
      <div className="card">
        {state.calendar.length === 0 ? (
          <p className="card-sub" style={{ margin: 0 }}>
            Nothing held. Ask your agent to block focus time and other agents will schedule around it.
          </p>
        ) : (
          state.calendar.map((block) => (
            <div className="activity-line" key={block.id}>
              <span className="activity-time">{block.kind}</span>
              <span className="activity-text">
                {block.title} — {dateTimeOf(block.start)}
              </span>
              {!block.meetingId ? (
                <button className="ghost" onClick={() => void api.removeCalendarBlock(block.id)}>
                  remove
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

const SNOOZE = [
  { label: '30 minutes', ms: 30 * 60_000 },
  { label: '1 hour', ms: 60 * 60_000 },
  { label: 'Until tomorrow', ms: 12 * 60 * 60_000 },
];

function NotificationsPane({
  workspace,
  onOpenChannel,
}: {
  workspace: WorkspaceView | undefined;
  onOpenChannel: (channelId: string) => void;
}) {
  const [note, save] = useSaver();
  if (!workspace) return <NoWorkspace />;

  const id = workspace.workspace.id;
  const prefs = workspace.prefs;
  const snoozed = prefs.dndUntil > Date.now();
  // Only channels you have deliberately changed are worth listing; the rest
  // follow the workspace default and do not need a row each.
  const overridden = workspace.channels.filter(
    (c) => c.joined && (c.prefs.muted || c.prefs.notify !== 'all' || c.prefs.starred),
  );

  const setPrefs = (channelId: string, patch: Partial<ChannelPrefs>) =>
    void save(() => unwrap(api.setChannelPrefs(id, channelId, patch)), 'Updated.');

  return (
    <>
      <h1>Notifications</h1>
      <p className="subtitle">
        What reaches you in <strong>{workspace.workspace.name}</strong>. None of this is sent to the
        relay — what you silence is nobody else's business.
      </p>

      <div className="card">
        <Field label="Notify me about">
          <select
            value={prefs.notify}
            onChange={(e) =>
              void save(
                () => unwrap(api.setWorkspacePrefs(id, { notify: e.target.value as NotifyLevel })),
                'Updated.',
              )
            }
          >
            <option value="all">Everything in channels I have joined</option>
            <option value="mentions">Mentions and direct messages only</option>
            <option value="nothing">Nothing</option>
          </select>
        </Field>

        <Field label="Pause notifications">
          {snoozed ? (
            <div className="row">
              <span className="tag warn">Paused until {dateTimeOf(prefs.dndUntil)}</span>
              <button
                style={{ flex: '0 0 auto' }}
                onClick={() => void save(() => unwrap(api.setWorkspacePrefs(id, { dndUntil: 0 })), 'Resumed.')}
              >
                Resume
              </button>
            </div>
          ) : (
            <div>
              {SNOOZE.map((option) => (
                <button
                  key={option.label}
                  style={{ marginRight: 6 }}
                  onClick={() =>
                    void save(
                      () => unwrap(api.setWorkspacePrefs(id, { dndUntil: Date.now() + option.ms })),
                      'Paused.',
                    )
                  }
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </Field>
        <p className="hint">
          A meeting your agents are holding never notifies you turn by turn — only when it is booked,
          starts, and ends.
        </p>
        {note}
      </div>

      <h2>Channels you have changed</h2>
      {overridden.length === 0 ? (
        <div className="empty">
          Every channel follows the setting above. Mute or star one from its own header and it shows
          up here.
        </div>
      ) : (
        <div className="card">
          {overridden.map((c) => (
            <div className="member-row" key={c.channel.id}>
              <div className="member-text">
                <button className="member-name link" onClick={() => onOpenChannel(c.channel.id)}>
                  {isDirect(c.channel) ? c.label : `#${c.channel.name}`}
                </button>
                <div className="member-sub">
                  {c.prefs.muted ? 'muted' : c.prefs.notify}
                  {c.prefs.starred ? ' · starred' : ''}
                </div>
              </div>
              <div className="member-actions">
                <select
                  value={c.prefs.notify}
                  onChange={(e) => setPrefs(c.channel.id, { notify: e.target.value as NotifyLevel })}
                >
                  <option value="all">All messages</option>
                  <option value="mentions">Mentions</option>
                  <option value="nothing">Nothing</option>
                </select>
                <button onClick={() => setPrefs(c.channel.id, { muted: !c.prefs.muted })}>
                  {c.prefs.muted ? 'Unmute' : 'Mute'}
                </button>
                <button onClick={() => setPrefs(c.channel.id, { starred: !c.prefs.starred })}>
                  {c.prefs.starred ? 'Unstar' : 'Star'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

function WorkspacePane({ workspace }: { workspace: WorkspaceView | undefined }) {
  const [name, setName] = useState(workspace?.workspace.name ?? '');
  const [description, setDescription] = useState(workspace?.workspace.description ?? '');
  const [icon, setIcon] = useState(workspace?.workspace.icon ?? '');
  const [color, setColor] = useState(workspace?.workspace.color ?? '');
  const [discoverable, setDiscoverable] = useState(workspace?.workspace.discoverable ?? false);
  const [invitePolicy, setInvitePolicy] = useState(workspace?.workspace.invitePolicy ?? 'anyone');
  const [note, save, busy] = useSaver();

  if (!workspace) return <NoWorkspace />;
  const w = workspace.workspace;
  const canEdit = workspace.me.role === 'owner' || workspace.me.role === 'admin';

  return (
    <>
      <h1>{w.name}</h1>
      <p className="subtitle">
        <code>{w.slug}</code> · {plural(workspace.members.length, 'member')} · you are{' '}
        {workspace.me.role}
      </p>

      {!canEdit ? <div className="banner warn">Only admins can change these.</div> : null}

      <div className="card">
        <Field label="Name">
          <input value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <input
            value={description}
            disabled={!canEdit}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>
        <Field label="Icon and colour">
          <div className="picker-row">
            {WORKSPACE_ICONS.map((option) => (
              <button
                key={option}
                className={`icon-choice ${icon === option ? 'on' : ''}`}
                disabled={!canEdit}
                onClick={() => setIcon(option)}
              >
                {option}
              </button>
            ))}
          </div>
          <div className="picker-row">
            {WORKSPACE_COLORS.map((option) => (
              <button
                key={option}
                className={`color-choice ${color === option ? 'on' : ''}`}
                style={{ background: option }}
                disabled={!canEdit}
                onClick={() => setColor(option)}
                aria-label={option}
              />
            ))}
          </div>
        </Field>
        <Field label="Who can invite people">
          <select
            value={invitePolicy}
            disabled={!canEdit}
            onChange={(e) => setInvitePolicy(e.target.value as typeof invitePolicy)}
          >
            <option value="anyone">Any member</option>
            <option value="admins">Admins only</option>
          </select>
        </Field>
        <Field label="Discovery" hint="Discoverable workspaces are listed to everyone on this relay.">
          <label className="check">
            <input
              type="checkbox"
              checked={discoverable}
              disabled={!canEdit}
              onChange={(e) => setDiscoverable(e.target.checked)}
            />
            Anyone on this relay can find and join
          </label>
        </Field>
        <button
          className="primary"
          disabled={!canEdit || busy}
          onClick={() =>
            void save(() =>
              unwrap(
                api.updateWorkspace(w.id, {
                  name: name.trim(),
                  description: description.trim(),
                  icon,
                  color,
                  discoverable,
                  invitePolicy,
                }),
              ),
            )
          }
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
        {note}
      </div>

      <h2>Leaving</h2>
      <div className="card">
        <p className="card-sub" style={{ marginTop: 0 }}>
          Leaving removes this workspace from your app. Your knowledge base is untouched — it was
          never in the workspace to begin with.
        </p>
        <ConfirmButton
          label={`Leave ${w.name}`}
          confirmLabel="Confirm — leave"
          className=""
          onConfirm={() => void api.leaveWorkspace(w.id)}
        />
        {workspace.me.role === 'owner' ? (
          <>
            <p className="hint" style={{ marginTop: 14 }}>
              Deleting removes the workspace and its history for everyone in it.
            </p>
            <ConfirmButton
              label="Delete this workspace"
              confirmLabel="Really delete — this cannot be undone"
              onConfirm={() => void api.deleteWorkspace(w.id)}
            />
          </>
        ) : null}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Members and invites
// ---------------------------------------------------------------------------

function MembersPane({
  workspace,
  onMessage,
}: {
  workspace: WorkspaceView | undefined;
  onMessage: (address: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [address, setAddress] = useState('');
  const [copied, setCopied] = useState('');
  const [note, save, busy] = useSaver();

  if (!workspace) return <NoWorkspace />;
  const id = workspace.workspace.id;
  const canManage = workspace.me.role === 'owner' || workspace.me.role === 'admin';
  const needle = query.trim().toLowerCase();
  const people = workspace.members.filter(
    (m) =>
      !needle ||
      m.displayName.toLowerCase().includes(needle) ||
      m.address.toLowerCase().includes(needle),
  );

  return (
    <>
      <h1>Members and invites</h1>
      <p className="subtitle">
        {plural(workspace.members.length, 'member')} in {workspace.workspace.name}. Every one of them
        has their own agent on their own machine.
      </p>

      <input placeholder="Find someone" value={query} onChange={(e) => setQuery(e.target.value)} />

      <div className="card">
        {people.map((member) => (
          <div className="member-row" key={member.address}>
            <Avatar
              name={member.displayName}
              address={member.address}
              size={34}
              presence={member.presence}
            />
            <div className="member-text">
              <div className="member-name">
                {member.displayName}
                {member.address === workspace.me.address ? <span className="tag small">you</span> : null}
                <span className={`tag small ${member.role === 'owner' ? 'accent' : ''}`}>
                  {member.role}
                </span>
                {member.agentOnline ? <span className="tag small good">agent online</span> : null}
              </div>
              <div className="member-sub">{member.title || member.address}</div>
            </div>
            <div className="member-actions">
              {member.address === workspace.me.address ? null : (
                <button onClick={() => onMessage(member.address)}>Message</button>
              )}
              {canManage && member.address !== workspace.me.address ? (
                <>
                  <select
                    value={member.role}
                    onChange={(e) =>
                      void save(
                        () => unwrap(api.setMemberRole(id, member.address, e.target.value as WorkspaceRole)),
                        'Role updated.',
                      )
                    }
                  >
                    <option value="guest">guest</option>
                    <option value="member">member</option>
                    <option value="admin">admin</option>
                    {workspace.me.role === 'owner' ? <option value="owner">owner</option> : null}
                  </select>
                  <ConfirmButton
                    label="Remove"
                    confirmLabel="Confirm"
                    onConfirm={() =>
                      void save(() => unwrap(api.removeMember(id, member.address)), 'Removed.')
                    }
                  />
                </>
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <h2>Invitations</h2>
      <div className="card">
        <Field
          label="Invite one person (optional)"
          hint="Leave blank for a code anybody can use. With an address, only that agent can redeem it."
        >
          <div className="row">
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="sarah@northwind"
            />
            <button
              style={{ flex: '0 0 auto' }}
              className="primary"
              disabled={busy}
              onClick={() =>
                void save(async () => {
                  await unwrap(api.createInvite(id, { invitedAddress: address.trim() || undefined }));
                  setAddress('');
                }, 'Invite created.')
              }
            >
              {busy ? 'Creating…' : 'Create invite'}
            </button>
          </div>
        </Field>

        {workspace.invites.length === 0 ? (
          <div className="empty">No live invitations.</div>
        ) : (
          workspace.invites.map((invite) => (
            <div className="member-row" key={invite.code}>
              <div className="member-text">
                <div className="member-name mono">{invite.code}</div>
                <div className="member-sub">
                  {invite.invitedAddress ? `For ${invite.invitedAddress}` : 'Anyone with the code'} ·{' '}
                  {invite.expiresAt ? `expires ${relative(invite.expiresAt)}` : 'no expiry'}
                  {invite.maxUses ? ` · ${invite.uses}/${invite.maxUses} used` : ''}
                </div>
              </div>
              <div className="member-actions">
                <button
                  onClick={() => {
                    void navigator.clipboard?.writeText(invite.code);
                    setCopied(invite.code);
                    setTimeout(() => setCopied(''), 1500);
                  }}
                >
                  {copied === invite.code ? 'Copied' : 'Copy'}
                </button>
                <button
                  className="danger"
                  onClick={() => void save(() => unwrap(api.revokeInvite(id, invite.code)), 'Revoked.')}
                >
                  Revoke
                </button>
              </div>
            </div>
          ))
        )}
      </div>
      {note}
    </>
  );
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

function ChannelsPane({
  workspace,
  onOpenChannel,
}: {
  workspace: WorkspaceView | undefined;
  onOpenChannel: (channelId: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [note, save] = useSaver();

  if (!workspace) return <NoWorkspace />;
  const id = workspace.workspace.id;
  const needle = query.trim().toLowerCase();
  const channels = workspace.channels
    .filter((c) => !isDirect(c.channel))
    .filter((c) => showArchived || !c.channel.archived)
    .filter(
      (c) =>
        !needle ||
        c.channel.name.includes(needle) ||
        c.channel.topic.toLowerCase().includes(needle),
    )
    .sort((a, b) => b.channel.members.length - a.channel.members.length);
  const canManage = workspace.me.role === 'owner' || workspace.me.role === 'admin';

  return (
    <>
      <h1>Channels</h1>
      <p className="subtitle">
        Every channel is also a meeting room: press <strong>Meet</strong> in one and the agents in it
        sit down together, there.
      </p>

      <div className="row">
        <input
          placeholder="Search channels"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check" style={{ flex: '0 0 auto' }}>
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>

      <div className="card">
        {channels.length === 0 ? (
          <div className="empty">Nothing matches.</div>
        ) : (
          channels.map((c) => (
            <div className="member-row" key={c.channel.id}>
              <div className="member-text">
                <button className="member-name link" onClick={() => onOpenChannel(c.channel.id)}>
                  {c.channel.kind === 'private' ? '🔒' : '#'}
                  {c.channel.name}
                  {c.channel.archived ? <span className="tag small">archived</span> : null}
                  {c.channel.isDefault ? <span className="tag small accent">default</span> : null}
                </button>
                <div className="member-sub">
                  {c.channel.topic || c.channel.purpose || 'No topic'} ·{' '}
                  {plural(c.channel.members.length, 'member')}
                </div>
              </div>
              <div className="member-actions">
                {c.joined ? (
                  c.channel.isDefault ? null : (
                    <button onClick={() => void save(() => unwrap(api.leaveChannel(id, c.channel.id)), 'Left.')}>
                      Leave
                    </button>
                  )
                ) : (
                  <button onClick={() => void save(() => unwrap(api.joinChannel(id, c.channel.id)), 'Joined.')}>
                    Join
                  </button>
                )}
                {canManage && !c.channel.isDefault ? (
                  <button
                    onClick={() =>
                      void save(
                        () => unwrap(api.archiveChannel(id, c.channel.id, !c.channel.archived)),
                        c.channel.archived ? 'Reopened.' : 'Archived.',
                      )
                    }
                  >
                    {c.channel.archived ? 'Reopen' : 'Archive'}
                  </button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
      {note}
    </>
  );
}

// ---------------------------------------------------------------------------
// Knowledge base
// ---------------------------------------------------------------------------

function KnowledgePane({
  state,
  onOpenKnowledge,
}: {
  state: AppState;
  onOpenKnowledge: () => void;
}) {
  return (
    <>
      <h1>Knowledge base</h1>
      <p className="subtitle">
        One folder on your disk. Only you and your own agent can read it — the relay has never seen it
        and cannot.
      </p>

      <div className="card">
        <p className="card-sub" style={{ marginTop: 0 }}>
          <code>{state.knowledgeDir}</code>
        </p>
        <p className="hint">
          Notes are markdown files; projects, artifacts and tasks are one JSON file. Anything marked{' '}
          <code>private</code> never leaves this machine — not even into your agent's own reasoning
          when it is in a room with other people.
        </p>
        <div className="row">
          <button style={{ flex: '0 0 auto' }} onClick={() => void api.openKnowledgeDir()}>
            Open folder
          </button>
          <button style={{ flex: '0 0 auto' }} onClick={onOpenKnowledge}>
            Open it in the app
          </button>
        </div>
      </div>

      <h2>What's in it</h2>
      <div className="card">
        <div className="activity-line">
          <span className="activity-time">{state.notes.length}</span>
          <span className="activity-text">notes</span>
        </div>
        <div className="activity-line">
          <span className="activity-time">{state.projects.length}</span>
          <span className="activity-text">projects</span>
        </div>
        <div className="activity-line">
          <span className="activity-time">{state.artifacts.length}</span>
          <span className="activity-text">
            artifacts your agent can show in a meeting — it can only show ones that really exist
          </span>
        </div>
        <div className="activity-line">
          <span className="activity-time">{state.tasks.length}</span>
          <span className="activity-text">tasks</span>
        </div>
        <div className="activity-line">
          <span className="activity-time">{state.meetings.length}</span>
          <span className="activity-text">meetings on the record</span>
        </div>
      </div>

      <h2>Editor preferences</h2>
      <div className="card">
        <p className="card-sub" style={{ marginTop: 0 }}>
          How the notes editor itself behaves — hotkeys, daily notes, templates, link handling — is
          kept with the folder in <code>.obsidian/app.json</code>, so it travels with the vault rather
          than with this app.
        </p>
        <button onClick={onOpenKnowledge}>Open Knowledge, then press ⌘,</button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

function NetworkPane({ state }: { state: AppState }) {
  const [relayUrl, setRelayUrl] = useState(state.connection.relayUrl);
  const [extra, setExtra] = useState('');
  const [note, save] = useSaver();

  return (
    <>
      <h1>Network</h1>
      <p className="subtitle">
        A relay is a switchboard. It carries workspaces, messages and meeting rooms — and it never
        sees a knowledge base.
      </p>

      <div className="card">
        <Field label="Relay address">
          <div className="row">
            <input value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} />
            <button
              style={{ flex: '0 0 auto' }}
              onClick={() => void save(() => unwrap(api.setRelayUrl(relayUrl.trim())), 'Connecting…')}
            >
              Connect
            </button>
          </div>
        </Field>
        <p className="hint">
          Status: <strong>{state.connection.state}</strong>
          {state.connection.error ? ` — ${state.connection.error}` : ''}
        </p>
        <button onClick={() => void api.reconnect()}>Reconnect</button>
        {note}
      </div>

      <h2>Other relays</h2>
      <div className="card">
        <p className="card-sub" style={{ marginTop: 0 }}>
          You can belong to workspaces on more than one relay at a time — work on one, a client on
          another. They never see each other.
        </p>
        {state.relays.map((url) => (
          <div className="activity-line" key={url}>
            <span className="activity-text mono">{url}</span>
            {url === state.connection.relayUrl ? (
              <span className="tag good">current</span>
            ) : (
              <button className="ghost" onClick={() => void api.removeRelay(url)}>
                remove
              </button>
            )}
          </div>
        ))}
        <div className="row" style={{ marginTop: 8 }}>
          <input
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder="ws://relay.example.com:8787"
          />
          <button
            style={{ flex: '0 0 auto' }}
            onClick={() =>
              void save(async () => {
                await unwrap(api.addRelay(extra.trim()));
                setExtra('');
              }, 'Added.')
            }
          >
            Add relay
          </button>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

function ShortcutsPane() {
  return (
    <>
      <h1>Shortcuts</h1>
      <p className="subtitle">The vault has its own, listed under Knowledge.</p>
      <div className="card">
        <div className="shortcut-list">
          {SHORTCUTS.map((row) => (
            <div className="shortcut" key={row.keys}>
              <kbd>{row.keys}</kbd>
              <span>{row.what}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
