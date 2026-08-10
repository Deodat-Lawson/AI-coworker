import { useEffect, useMemo, useState } from 'react';

import {
  type UserStatus,
  type WorkspaceRole,
  WORKSPACE_COLORS,
  WORKSPACE_ICONS,
  isDirect,
  normalizeChannelName,
} from '@ai-coworker/shared';

import { api, unwrap, type AppState, type WorkspaceView } from '../lib/api.js';
import { plural, relative } from '../lib/format.js';
import { Icon, channelIcon } from './icons.js';
import { IconUploader } from './IconUploader.js';
import { Avatar, ConfirmButton, Field, Modal } from './ui.js';

/** Every dialog reports failures the same way, in place, never as a native alert. */
function useAction(): [string | null, (fn: () => Promise<unknown>) => Promise<boolean>, boolean] {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return [error, run, busy];
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export function AddWorkspaceDialog({ state, onClose }: { state: AppState; onClose: () => void }) {
  const [tab, setTab] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState<string>(WORKSPACE_ICONS[0]!);
  const [iconImage, setIconImage] = useState('');
  const [color, setColor] = useState<string>(WORKSPACE_COLORS[0]!);
  const [channels, setChannels] = useState('random');
  const [code, setCode] = useState('');
  const [error, run, busy] = useAction();

  useEffect(() => {
    if (tab === 'join') void api.discoverWorkspaces();
  }, [tab]);

  const joinable = state.discoverable.filter((w) => !w.joined);

  return (
    <Modal
      title="Add a workspace"
      subtitle="A workspace is a separate place with its own people, channels and history."
      onClose={onClose}
      wide
    >
      <div className="tabs">
        <button className={`tab ${tab === 'create' ? 'active' : ''}`} onClick={() => setTab('create')}>
          Create
        </button>
        <button className={`tab ${tab === 'join' ? 'active' : ''}`} onClick={() => setTab('join')}>
          Join
        </button>
      </div>

      {tab === 'create' ? (
        <>
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Northwind Platform" autoFocus />
          </Field>
          <Field label="What is it for?">
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="The platform team's day-to-day"
            />
          </Field>
          <Field label="Icon and colour" hint="Upload a square image, or pick an emoji. You can change both later.">
            <IconUploader
              image={iconImage}
              emoji={icon}
              name={name}
              color={color}
              onImage={setIconImage}
            />
            <div className="picker-row">
              {WORKSPACE_ICONS.map((option) => (
                <button
                  key={option}
                  className={`icon-choice ${icon === option && !iconImage ? 'on' : ''}`}
                  onClick={() => {
                    setIcon(option);
                    setIconImage('');
                  }}
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
                  onClick={() => setColor(option)}
                  aria-label={option}
                />
              ))}
            </div>
          </Field>
          <Field label="Starting channels" hint="#general is always created. Separate others with commas.">
            <input value={channels} onChange={(e) => setChannels(e.target.value)} />
          </Field>
          <button
            className="primary"
            disabled={busy || name.trim().length < 2}
            onClick={async () => {
              const ok = await run(() =>
                unwrap(
                  api.createWorkspace({
                    name: name.trim(),
                    description: description.trim(),
                    icon,
                    iconImage,
                    color,
                    channels: channels
                      .split(',')
                      .map((c) => normalizeChannelName(c))
                      .filter(Boolean),
                  }),
                ),
              );
              if (ok) onClose();
            }}
          >
            {busy ? 'Creating…' : 'Create workspace'}
          </button>
        </>
      ) : (
        <>
          <Field label="Invitation code" hint="Paste the code somebody sent you.">
            <div className="row">
              <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="abcd-efghi-jklmnop" />
              <button
                style={{ flex: '0 0 auto' }}
                disabled={busy || !code.trim()}
                onClick={async () => {
                  const ok = await run(() => unwrap(api.joinWorkspace({ code: code.trim() })));
                  if (ok) onClose();
                }}
              >
                Join
              </button>
            </div>
          </Field>

          <h2>Open on this relay</h2>
          {joinable.length === 0 ? (
            <div className="empty">Nothing else to join here yet.</div>
          ) : (
            joinable.map((workspace) => (
              <div className="card" key={workspace.id}>
                <div className="card-head">
                  <div>
                    <div className="card-title">
                      {workspace.icon} {workspace.name}
                    </div>
                    <div className="card-sub">{workspace.description || `#${workspace.slug}`}</div>
                    <div className="card-sub">{plural(workspace.memberCount, 'member')}</div>
                  </div>
                  <button
                    onClick={async () => {
                      const ok = await run(() =>
                        unwrap(api.joinWorkspace({ slug: workspace.slug, relayUrl: workspace.relayUrl })),
                      );
                      if (ok) onClose();
                    }}
                  >
                    Join
                  </button>
                </div>
              </div>
            ))
          )}
        </>
      )}
      {error ? <div className="error-text">{error}</div> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export function CreateChannelDialog({
  workspace,
  onClose,
  onCreated,
}: {
  workspace: WorkspaceView;
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [isPrivate, setPrivate] = useState(false);
  const [error, run, busy] = useAction();
  const normalized = normalizeChannelName(name);
  const taken = workspace.channels.some((c) => c.channel.name === normalized && !isDirect(c.channel));

  return (
    <Modal title="Create a channel" subtitle={workspace.workspace.name} onClose={onClose}>
      <Field label="Name" hint={normalized ? `Will be #${normalized}` : 'Lowercase, no spaces.'}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="auth-migration" autoFocus />
      </Field>
      <Field label="Topic" hint="Shown in the header so people know what belongs here.">
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Shipping SSO by the 20th" />
      </Field>
      <label className="check">
        <input type="checkbox" checked={isPrivate} onChange={(e) => setPrivate(e.target.checked)} />
        Make it private — only people you add can see it
      </label>
      {taken ? <div className="error-text">#{normalized} already exists.</div> : null}
      <button
        className="primary"
        style={{ marginTop: 12 }}
        disabled={busy || !normalized || taken}
        onClick={async () => {
          const ok = await run(() =>
            unwrap(
              api.createChannel(workspace.workspace.id, {
                name: normalized,
                topic: topic.trim(),
                kind: isPrivate ? 'private' : 'public',
              }),
            ),
          );
          if (ok) {
            onCreated(normalized);
            onClose();
          }
        }}
      >
        {busy ? 'Creating…' : 'Create'}
      </button>
      {error ? <div className="error-text">{error}</div> : null}
    </Modal>
  );
}

export function ChannelBrowser({
  workspace,
  onClose,
  onOpen,
  onCreate,
}: {
  workspace: WorkspaceView;
  onClose: () => void;
  onOpen: (channelId: string) => void;
  onCreate: () => void;
}) {
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [error, run] = useAction();

  const channels = workspace.channels
    .filter((c) => !isDirect(c.channel))
    .filter((c) => showArchived || !c.channel.archived)
    .filter((c) => !query || c.channel.name.includes(query.toLowerCase()) || c.channel.topic.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => b.channel.members.length - a.channel.members.length);

  return (
    <Modal
      title="Channels"
      subtitle={`${plural(channels.length, 'channel')} in ${workspace.workspace.name}`}
      onClose={onClose}
      wide
      footer={
        <button className="primary" onClick={onCreate}>
          Create a channel
        </button>
      }
    >
      <div className="row">
        <input placeholder="Search channels" value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
        <label className="check" style={{ flex: '0 0 auto' }}>
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Archived
        </label>
      </div>
      <div className="browse-list">
        {channels.map((view) => (
          <div className="browse-row" key={view.channel.id}>
            <div className="browse-text">
              <div className="browse-name">
                <Icon name={channelIcon(view.channel.kind)} size={15} />
                {view.channel.name}
                {view.channel.archived ? <span className="tag small">archived</span> : null}
              </div>
              <div className="browse-sub">
                {plural(view.channel.members.length, 'member')}
                {view.channel.topic ? ` · ${view.channel.topic}` : ''}
              </div>
            </div>
            {view.joined ? (
              <button
                onClick={() => {
                  onOpen(view.channel.id);
                  onClose();
                }}
              >
                Open
              </button>
            ) : (
              <button
                className="primary"
                onClick={async () => {
                  const ok = await run(() => unwrap(api.joinChannel(workspace.workspace.id, view.channel.id)));
                  if (ok) {
                    onOpen(view.channel.id);
                    onClose();
                  }
                }}
              >
                Join
              </button>
            )}
          </div>
        ))}
        {channels.length === 0 ? <div className="empty">Nothing matches.</div> : null}
      </div>
      {error ? <div className="error-text">{error}</div> : null}
    </Modal>
  );
}

export function ChannelDetailsDialog({
  workspace,
  channelId,
  onClose,
  onLeft,
}: {
  workspace: WorkspaceView;
  channelId: string;
  onClose: () => void;
  onLeft: () => void;
}) {
  const view = workspace.channels.find((c) => c.channel.id === channelId);
  const [topic, setTopic] = useState(view?.channel.topic ?? '');
  const [purpose, setPurpose] = useState(view?.channel.purpose ?? '');
  const [adding, setAdding] = useState('');
  const [error, run] = useAction();
  if (!view) return null;
  const channel = view.channel;
  const canManage =
    channel.createdBy === workspace.me.address ||
    workspace.me.role === 'owner' ||
    workspace.me.role === 'admin';

  const notMembers = workspace.members.filter((m) => !channel.members.includes(m.address));

  return (
    <Modal
      title={isDirect(channel) ? view.label : `#${channel.name}`}
      subtitle={plural(channel.members.length, 'member')}
      onClose={onClose}
      wide
    >
      {isDirect(channel) ? null : (
        <>
          <Field label="Topic">
            <div className="row">
              <input value={topic} onChange={(e) => setTopic(e.target.value)} />
              <button
                style={{ flex: '0 0 auto' }}
                onClick={() => run(() => unwrap(api.updateChannel(workspace.workspace.id, channel.id, { topic })))}
              >
                Save
              </button>
            </div>
          </Field>
          <Field label="Purpose">
            <div className="row">
              <input value={purpose} onChange={(e) => setPurpose(e.target.value)} />
              <button
                style={{ flex: '0 0 auto' }}
                onClick={() => run(() => unwrap(api.updateChannel(workspace.workspace.id, channel.id, { purpose })))}
              >
                Save
              </button>
            </div>
          </Field>
        </>
      )}

      <h2>Members</h2>
      <div className="member-list compact">
        {channel.members.map((address) => {
          const member = workspace.members.find((m) => m.address === address);
          return (
            <div className="member-row" key={address}>
              <Avatar
                name={member?.displayName ?? address}
                address={address}
                size={28}
                presence={member?.presence}
              />
              <div className="member-text">
                <div className="member-name">{member?.displayName ?? address}</div>
              </div>
              {canManage && address !== workspace.me.address && !isDirect(channel) && !channel.isDefault ? (
                <ConfirmButton
                  label="Remove"
                  confirmLabel="Confirm"
                  onConfirm={() =>
                    run(() => unwrap(api.removeFromChannel(workspace.workspace.id, channel.id, address)))
                  }
                />
              ) : null}
            </div>
          );
        })}
      </div>

      {isDirect(channel) ? null : (
        <Field label="Add someone">
          <div className="row">
            <select value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choose a person…</option>
              {notMembers.map((m) => (
                <option key={m.address} value={m.address}>
                  {m.displayName}
                </option>
              ))}
            </select>
            <button
              style={{ flex: '0 0 auto' }}
              disabled={!adding}
              onClick={async () => {
                const ok = await run(() =>
                  unwrap(api.addToChannel(workspace.workspace.id, channel.id, [adding])),
                );
                if (ok) setAdding('');
              }}
            >
              Add
            </button>
          </div>
        </Field>
      )}

      <h2>Notifications</h2>
      <div className="row">
        <select
          value={view.prefs.notify}
          onChange={(e) =>
            run(() =>
              unwrap(
                api.setChannelPrefs(workspace.workspace.id, channel.id, {
                  notify: e.target.value as 'all' | 'mentions' | 'nothing',
                }),
              ),
            )
          }
        >
          <option value="all">Every message</option>
          <option value="mentions">Only mentions</option>
          <option value="nothing">Nothing</option>
        </select>
        <label className="check">
          <input
            type="checkbox"
            checked={view.prefs.muted}
            onChange={(e) =>
              run(() =>
                unwrap(api.setChannelPrefs(workspace.workspace.id, channel.id, { muted: e.target.checked })),
              )
            }
          />
          Mute
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={view.prefs.starred}
            onChange={(e) =>
              run(() =>
                unwrap(api.setChannelPrefs(workspace.workspace.id, channel.id, { starred: e.target.checked })),
              )
            }
          />
          Star
        </label>
      </div>

      {isDirect(channel) || channel.isDefault ? null : (
        <>
          <h2>Channel</h2>
          <div className="row">
            {canManage ? (
              <ConfirmButton
                className=""
                label={channel.archived ? 'Reopen channel' : 'Archive channel'}
                confirmLabel="Confirm"
                onConfirm={() =>
                  run(() =>
                    unwrap(api.archiveChannel(workspace.workspace.id, channel.id, !channel.archived)),
                  )
                }
              />
            ) : null}
            <ConfirmButton
              label="Leave channel"
              confirmLabel="Confirm leave"
              onConfirm={async () => {
                const ok = await run(() => unwrap(api.leaveChannel(workspace.workspace.id, channel.id)));
                if (ok) {
                  onLeft();
                  onClose();
                }
              }}
            />
          </div>
        </>
      )}
      {error ? <div className="error-text">{error}</div> : null}
    </Modal>
  );
}

export function NewDirectMessageDialog({
  workspace,
  onClose,
}: {
  workspace: WorkspaceView;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, run, busy] = useAction();

  const candidates = workspace.members
    .filter((m) => m.address !== workspace.me.address && !picked.includes(m.address))
    .filter((m) => !query || m.displayName.toLowerCase().includes(query.toLowerCase()));

  return (
    <Modal
      title="New message"
      subtitle="Pick one person, or several for a group conversation."
      onClose={onClose}
    >
      <div className="token-field">
        {picked.map((address) => {
          const member = workspace.members.find((m) => m.address === address);
          return (
            <span className="token" key={address}>
              {member?.displayName ?? address}
              <button
                aria-label="Remove"
                onClick={() => setPicked((p) => p.filter((a) => a !== address))}
              >
                <Icon name="close" size={13} />
              </button>
            </span>
          );
        })}
        <input
          autoFocus
          value={query}
          placeholder={picked.length ? 'Add another' : 'Search people'}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !query && picked.length) {
              setPicked((p) => p.slice(0, -1));
            }
            if (e.key === 'Enter' && candidates[0]) {
              setPicked((p) => [...p, candidates[0]!.address]);
              setQuery('');
            }
          }}
        />
      </div>

      <div className="member-list compact">
        {candidates.slice(0, 12).map((member) => (
          <button
            className="member-row as-button"
            key={member.address}
            onClick={() => {
              setPicked((p) => [...p, member.address]);
              setQuery('');
            }}
          >
            <Avatar name={member.displayName} address={member.address} size={28} presence={member.presence} />
            <div className="member-text">
              <div className="member-name">{member.displayName}</div>
              <div className="member-sub">{member.title || member.address}</div>
            </div>
          </button>
        ))}
      </div>

      <button
        className="primary"
        disabled={busy || !picked.length}
        onClick={async () => {
          const ok = await run(() => unwrap(api.openDirectMessage(workspace.workspace.id, picked)));
          if (ok) onClose();
        }}
      >
        {busy ? 'Opening…' : picked.length > 1 ? 'Start group message' : 'Start message'}
      </button>
      {error ? <div className="error-text">{error}</div> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Status and help
// ---------------------------------------------------------------------------

const STATUS_PRESETS: { emoji: string; text: string; minutes: number }[] = [
  { emoji: '📅', text: 'In a meeting', minutes: 60 },
  { emoji: '🎧', text: 'Focusing', minutes: 120 },
  { emoji: '🚌', text: 'Commuting', minutes: 60 },
  { emoji: '🤒', text: 'Out sick', minutes: 0 },
  { emoji: '🌴', text: 'On holiday', minutes: 0 },
  { emoji: '🏠', text: 'Working remotely', minutes: 0 },
];

export function StatusDialog({ state, onClose }: { state: AppState; onClose: () => void }) {
  const [emoji, setEmoji] = useState(state.status.emoji || '💬');
  const [text, setText] = useState(state.status.text);
  const [presence, setPresence] = useState(state.presence === 'offline' ? 'active' : state.presence);
  const [error, run, busy] = useAction();

  const save = async (status: UserStatus, nextPresence = presence) => {
    const ok = await run(() => unwrap(api.setStatus(status, nextPresence)));
    if (ok) onClose();
  };

  return (
    <Modal title="Set a status" onClose={onClose}>
      <div className="row">
        <input
          className="emoji-input"
          value={emoji}
          onChange={(e) => setEmoji([...e.target.value].slice(-1).join(''))}
          style={{ flex: '0 0 56px', textAlign: 'center' }}
        />
        <input
          value={text}
          autoFocus
          placeholder="What's happening?"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void save({ emoji, text, expiresAt: 0 })}
        />
      </div>

      <div className="preset-list">
        {STATUS_PRESETS.map((preset) => (
          <button
            key={preset.text}
            className="preset"
            onClick={() =>
              save({
                emoji: preset.emoji,
                text: preset.text,
                expiresAt: preset.minutes ? Date.now() + preset.minutes * 60_000 : 0,
              })
            }
          >
            <span>{preset.emoji}</span>
            {preset.text}
            {preset.minutes ? <span className="hint">{preset.minutes} min</span> : null}
          </button>
        ))}
      </div>

      <Field label="Availability">
        <select value={presence} onChange={(e) => setPresence(e.target.value as typeof presence)}>
          <option value="active">Active</option>
          <option value="away">Away</option>
          <option value="dnd">Do not disturb — pause notifications</option>
        </select>
      </Field>

      <div className="row">
        <button className="primary" disabled={busy} onClick={() => save({ emoji, text, expiresAt: 0 })}>
          Save
        </button>
        <button onClick={() => save({ emoji: '', text: '', expiresAt: 0 }, 'active')}>Clear status</button>
      </div>
      {error ? <div className="error-text">{error}</div> : null}
    </Modal>
  );
}

export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: '⌘K', what: 'Jump to a channel, person or workspace' },
  { keys: '⌘F', what: 'Search this workspace' },
  { keys: '⌘1 … ⌘9', what: 'Switch workspace' },
  { keys: '⌥⇧↑ / ⌥⇧↓', what: 'Previous / next unread channel' },
  { keys: '⌘⇧A', what: 'Activity' },
  { keys: '⌘⇧T', what: 'Threads' },
  { keys: '⌘⇧D', what: 'Your agent' },
  { keys: '⌘⇧K', what: 'Tasks' },
  { keys: '⌘,', what: 'Settings' },
  { keys: '⌘N', what: 'New message' },
  { keys: '⌘⇧L', what: 'Dark → light → match system' },
  { keys: 'Enter', what: 'Send' },
  { keys: 'Shift+Enter', what: 'New line' },
  { keys: '↑', what: 'Edit your last message' },
  { keys: 'Esc', what: 'Close panel, or mark channel read' },
  { keys: '⌘/', what: 'This list' },
];

/** The second half of the list: keys that only mean something in Tasks. */
export const TASK_SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'A', what: 'Add a task' },
  { keys: '↑ / ↓', what: 'Move down the list' },
  { keys: 'Enter', what: 'Open the task' },
  { keys: 'C', what: 'Complete or reopen' },
  { keys: 'X', what: 'Select, for acting on several at once' },
  { keys: '1 … 4', what: 'Set priority' },
  { keys: 'T / M / W', what: 'Due today, tomorrow, next week' },
  { keys: 'R', what: 'Remove the due date' },
  { keys: '⌫', what: 'Delete' },
  { keys: '⌘Z', what: 'Undo the last change' },
  { keys: '/', what: 'Filter this view' },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <div className="shortcut-list">
        {SHORTCUTS.map((row) => (
          <div className="shortcut" key={row.keys}>
            <kbd>{row.keys}</kbd>
            <span>{row.what}</span>
          </div>
        ))}
      </div>
      <h2>In Tasks</h2>
      <div className="shortcut-list">
        {TASK_SHORTCUTS.map((row) => (
          <div className="shortcut" key={row.keys}>
            <kbd>{row.keys}</kbd>
            <span>{row.what}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}

export function ProfileCard({
  workspace,
  address,
  onClose,
  onMessage,
}: {
  workspace: WorkspaceView;
  address: string;
  onClose: () => void;
  onMessage: (address: string) => void;
}) {
  const member = useMemo(
    () => workspace.members.find((m) => m.address === address),
    [workspace.members, address],
  );
  if (!member) return null;

  return (
    <Modal title={member.displayName} subtitle={member.title || member.address} onClose={onClose}>
      <div className="profile-head">
        <Avatar name={member.displayName} address={member.address} size={72} presence={member.presence} />
        <div>
          <div className="profile-line">
            <span className={`presence-dot ${member.presence}`} /> {member.presence}
            {member.status.emoji || member.status.text ? (
              <span className="member-status">
                {member.status.emoji} {member.status.text}
              </span>
            ) : null}
          </div>
          <div className="profile-line mono">{member.address}</div>
          <div className="profile-line">{member.timezone}</div>
          <div className="profile-line">
            {member.role} in {workspace.workspace.name}
          </div>
        </div>
      </div>
      {member.bio ? <p className="subtitle">{member.bio}</p> : null}
      {member.focusAreas.length ? (
        <div>
          {member.focusAreas.map((area) => (
            <span className="tag" key={area}>
              {area}
            </span>
          ))}
        </div>
      ) : null}
      {member.address === workspace.me.address ? null : (
        <button
          className="primary"
          style={{ marginTop: 14 }}
          onClick={() => {
            onMessage(member.address);
            onClose();
          }}
        >
          Message {member.displayName.split(' ')[0]}
        </button>
      )}
    </Modal>
  );
}
