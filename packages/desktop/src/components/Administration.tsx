/**
 * Running a workspace.
 *
 * Slack puts this behind a menu item called "Manage members" and it is the
 * screen an admin actually lives on: a table of everybody, filterable, with
 * bulk selection, next to the settings that decide what everybody is allowed to
 * do. The relay enforces all of it independently — nothing here is the only
 * thing standing between a guest and an owner's account — but the surface has to
 * be good enough that an admin never reaches for a config file.
 */

import { useEffect, useMemo, useState } from 'react';

import {
  type AuditAction,
  type Capability,
  type WorkspaceMember,
  type WorkspacePermissions,
  type WorkspaceRole,
  AUDIT_LABELS,
  CAPABILITIES,
  CAPABILITY_FLOORS,
  CAPABILITY_LABELS,
  ROLE_RANK,
  atLeast,
  can,
  clampCapability,
} from '@ai-coworker/shared';

import { api, unwrap, type WorkspaceView } from '../lib/api.js';
import { plural, relative } from '../lib/format.js';
import { Avatar, ConfirmButton, Field, Modal } from './ui.js';

type Tab = 'members' | 'invitations' | 'requests' | 'permissions' | 'log';

const ROLES: WorkspaceRole[] = ['guest', 'member', 'admin', 'owner'];

/** How the member table can be narrowed. Mirrors Slack's account-type filter. */
type Filter = 'all' | 'owner' | 'admin' | 'member' | 'guest' | 'deactivated' | 'offline';

const FILTER_LABELS: Record<Filter, string> = {
  all: 'Everyone',
  owner: 'Owners',
  admin: 'Admins',
  member: 'Members',
  guest: 'Guests',
  deactivated: 'Deactivated',
  offline: 'Offline',
};

type Sort = 'name' | 'role' | 'joined' | 'active';

function matchesFilter(member: WorkspaceMember, filter: Filter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'deactivated':
      return member.deactivated;
    case 'offline':
      return !member.agentOnline && !member.deactivated;
    default:
      return member.role === filter && !member.deactivated;
  }
}

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

export function AdministrationDialog({
  workspace,
  onClose,
  onMessage,
  initialTab = 'members',
}: {
  workspace: WorkspaceView;
  onClose: () => void;
  onMessage: (address: string) => void;
  initialTab?: Tab;
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const w = workspace.workspace;
  const isAdmin = atLeast(workspace.me.role, 'admin');
  const pending = workspace.joinRequests.filter((r) => r.state === 'pending').length;

  // These two are fetched rather than pushed: an audit log that streamed
  // continuously would be a lot of traffic for a screen nobody has open.
  useEffect(() => {
    if (!isAdmin) return;
    void api.listJoinRequests(w.id);
  }, [w.id, isAdmin]);

  useEffect(() => {
    if (tab === 'log' && isAdmin) void api.listAudit(w.id);
  }, [tab, w.id, isAdmin]);

  const tabs: { key: Tab; label: string; badge?: number; adminOnly?: boolean }[] = [
    { key: 'members', label: 'Members' },
    { key: 'invitations', label: 'Invitations' },
    { key: 'requests', label: 'Requests', badge: pending, adminOnly: true },
    { key: 'permissions', label: 'Permissions', adminOnly: true },
    { key: 'log', label: 'Activity log', adminOnly: true },
  ];

  return (
    <Modal
      title={`Manage ${w.name}`}
      subtitle={`#${w.slug} · ${plural(workspace.members.length, 'member')}`}
      onClose={onClose}
      wide
    >
      <div className="tabs">
        {tabs
          .filter((t) => !t.adminOnly || isAdmin)
          .map((t) => (
            <button
              key={t.key}
              className={`tab ${tab === t.key ? 'active' : ''}`}
              onClick={() => setTab(t.key)}
            >
              {t.label}
              {t.badge ? <span className="tab-badge">{t.badge}</span> : null}
            </button>
          ))}
      </div>

      {tab === 'members' ? (
        <MembersTable workspace={workspace} onMessage={onMessage} onClose={onClose} />
      ) : null}
      {tab === 'invitations' ? <Invitations workspace={workspace} /> : null}
      {tab === 'requests' ? <Requests workspace={workspace} /> : null}
      {tab === 'permissions' ? <Permissions workspace={workspace} /> : null}
      {tab === 'log' ? <ActivityLog workspace={workspace} /> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

function MembersTable({
  workspace,
  onMessage,
  onClose,
}: {
  workspace: WorkspaceView;
  onMessage: (address: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<Sort>('name');
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<WorkspaceMember | null>(null);
  const [error, run, busy] = useAction();

  const w = workspace.workspace;
  const canManage = can(workspace.me.role, 'manage_members', w.permissions);
  const iAmPrimary = w.primaryOwner === workspace.me.address;

  const people = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const rows = workspace.members.filter((m) => {
      if (!matchesFilter(m, filter)) return false;
      if (!needle) return true;
      return (
        m.displayName.toLowerCase().includes(needle) ||
        m.address.toLowerCase().includes(needle) ||
        m.title.toLowerCase().includes(needle)
      );
    });
    return rows.sort((a, b) => {
      if (sort === 'role') return ROLE_RANK[b.role] - ROLE_RANK[a.role] || a.displayName.localeCompare(b.displayName);
      if (sort === 'joined') return a.joinedAt - b.joinedAt;
      if (sort === 'active') return (b.lastSeen ?? 0) - (a.lastSeen ?? 0);
      return a.displayName.localeCompare(b.displayName);
    });
  }, [workspace.members, query, filter, sort]);

  /** Who I am allowed to act on: never myself, never above me, never the holder. */
  const actionable = (member: WorkspaceMember) => {
    if (!canManage) return false;
    if (member.address === workspace.me.address) return false;
    if (member.primaryOwner) return false;
    if (workspace.me.role === 'owner') return true;
    return !atLeast(member.role, 'owner');
  };

  const selectable = people.filter(actionable);
  const chosen = selected.filter((a) => selectable.some((m) => m.address === a));
  const allChosen = selectable.length > 0 && chosen.length === selectable.length;

  const toggle = (address: string) =>
    setSelected((prev) =>
      prev.includes(address) ? prev.filter((a) => a !== address) : [...prev, address],
    );

  const counts = useMemo(() => {
    const out: Record<string, number> = { all: workspace.members.length };
    for (const key of ['owner', 'admin', 'member', 'guest', 'deactivated', 'offline'] as Filter[]) {
      out[key] = workspace.members.filter((m) => matchesFilter(m, key)).length;
    }
    return out;
  }, [workspace.members]);

  return (
    <>
      <div className="admin-toolbar">
        <input
          placeholder="Search by name, title or address"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <select value={filter} onChange={(e) => setFilter(e.target.value as Filter)}>
          {(Object.keys(FILTER_LABELS) as Filter[]).map((key) => (
            <option key={key} value={key}>
              {FILTER_LABELS[key]} ({counts[key] ?? 0})
            </option>
          ))}
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="name">Sort by name</option>
          <option value="role">Sort by role</option>
          <option value="joined">Sort by join date</option>
          <option value="active">Sort by last seen</option>
        </select>
      </div>

      {chosen.length > 0 ? (
        <div className="bulk-bar">
          <strong>{plural(chosen.length, 'person', 'people')} selected</strong>
          <select
            value=""
            disabled={busy}
            onChange={(e) => {
              const role = e.target.value as WorkspaceRole;
              if (!role) return;
              void run(() => unwrap(api.setMemberRole(w.id, chosen, role))).then(
                (ok) => ok && setSelected([]),
              );
            }}
          >
            <option value="">Change role to…</option>
            {ROLES.filter((r) => r !== 'owner' || workspace.me.role === 'owner').map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
          <button
            disabled={busy}
            onClick={() =>
              void run(() => unwrap(api.setMemberActive(w.id, chosen, false))).then(
                (ok) => ok && setSelected([]),
              )
            }
          >
            Deactivate
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(() => unwrap(api.setMemberActive(w.id, chosen, true))).then(
                (ok) => ok && setSelected([]),
              )
            }
          >
            Reactivate
          </button>
          <ConfirmButton
            label="Remove from workspace"
            confirmLabel={`Remove ${chosen.length}`}
            onConfirm={() =>
              run(() => unwrap(api.removeMember(w.id, chosen))).then((ok) => ok && setSelected([]))
            }
          />
          <button className="ghost" onClick={() => setSelected([])}>
            Clear
          </button>
        </div>
      ) : null}

      {canManage && selectable.length > 0 ? (
        <label className="check select-all">
          <input
            type="checkbox"
            checked={allChosen}
            onChange={() => setSelected(allChosen ? [] : selectable.map((m) => m.address))}
          />
          Select everyone shown
        </label>
      ) : null}

      <div className="member-list">
        {people.length === 0 ? <div className="empty">Nobody matches that.</div> : null}
        {people.map((member) => {
          const mine = member.address === workspace.me.address;
          const canAct = actionable(member);
          return (
            <div
              className={`member-row ${member.deactivated ? 'is-deactivated' : ''}`}
              key={member.address}
            >
              {canManage ? (
                <input
                  type="checkbox"
                  className="member-check"
                  disabled={!canAct}
                  checked={selected.includes(member.address)}
                  onChange={() => toggle(member.address)}
                  aria-label={`Select ${member.displayName}`}
                />
              ) : null}
              <Avatar
                name={member.displayName}
                address={member.address}
                size={34}
                presence={member.presence}
              />
              <div className="member-text">
                <div className="member-name">
                  {member.displayName}
                  {mine ? <span className="tag small">you</span> : null}
                  {member.primaryOwner ? (
                    <span className="tag small accent">primary owner</span>
                  ) : (
                    <span className={`tag small ${member.role === 'owner' ? 'accent' : ''}`}>
                      {member.role}
                    </span>
                  )}
                  {member.deactivated ? <span className="tag small bad">deactivated</span> : null}
                  {member.guestChannels.length ? (
                    <span className="tag small warn">
                      {plural(member.guestChannels.length, 'channel')} only
                    </span>
                  ) : null}
                </div>
                <div className="member-sub">
                  {member.title ? `${member.title} · ` : ''}
                  <span className="mono">{member.address}</span>
                </div>
                <div className="member-sub member-meta">
                  Joined {relative(member.joinedAt)}
                  {member.deactivated && member.deactivatedAt
                    ? ` · deactivated ${relative(member.deactivatedAt)}`
                    : member.agentOnline
                      ? ' · online now'
                      : member.lastSeen
                        ? ` · last seen ${relative(member.lastSeen)}`
                        : ''}
                  {member.invitedBy ? ` · invited by ${member.invitedBy.split('@')[0]}` : ''}
                </div>
              </div>
              <div className="member-actions">
                {!mine && !member.deactivated ? (
                  <button
                    onClick={() => {
                      onMessage(member.address);
                      onClose();
                    }}
                  >
                    Message
                  </button>
                ) : null}
                {canAct ? (
                  <>
                    <button onClick={() => setEditing(member)}>Manage…</button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          unwrap(api.setMemberActive(w.id, member.address, member.deactivated)),
                        )
                      }
                    >
                      {member.deactivated ? 'Reactivate' : 'Deactivate'}
                    </button>
                  </>
                ) : null}
                {iAmPrimary && !mine && !member.deactivated ? (
                  <ConfirmButton
                    label="Make owner"
                    confirmLabel="Hand over the workspace"
                    onConfirm={() => run(() => unwrap(api.transferOwnership(w.id, member.address)))}
                  />
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {error ? <div className="error-text">{error}</div> : null}

      {editing ? (
        <MemberDetail
          workspace={workspace}
          member={workspace.members.find((m) => m.address === editing.address) ?? editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

/**
 * One person, in detail: their role, the channels a guest is confined to, and
 * the workspace-local name and title an admin may correct for them.
 */
function MemberDetail({
  workspace,
  member,
  onClose,
}: {
  workspace: WorkspaceView;
  member: WorkspaceMember;
  onClose: () => void;
}) {
  const w = workspace.workspace;
  const [role, setRole] = useState<WorkspaceRole>(member.role);
  const [guestChannels, setGuestChannels] = useState<string[]>(member.guestChannels);
  const [displayName, setDisplayName] = useState(member.displayName);
  const [title, setTitle] = useState(member.title);
  const [error, run, busy] = useAction();

  const channels = workspace.channels
    .filter((c) => c.channel.kind === 'public' || c.channel.kind === 'private')
    .filter((c) => !c.channel.archived)
    .sort((a, b) => a.channel.name.localeCompare(b.channel.name));

  return (
    <Modal
      title={member.displayName}
      subtitle={member.address}
      onClose={onClose}
      footer={
        <button
          className="primary"
          disabled={busy}
          onClick={async () => {
            const ok = await run(async () => {
              await unwrap(
                api.setMemberRole(
                  w.id,
                  member.address,
                  role,
                  role === 'guest' ? guestChannels : undefined,
                ),
              );
              if (displayName !== member.displayName || title !== member.title) {
                await unwrap(
                  api.setWorkspaceProfile(w.id, { address: member.address, displayName, title }),
                );
              }
            });
            if (ok) onClose();
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      }
    >
      <Field label="Role">
        <select value={role} onChange={(e) => setRole(e.target.value as WorkspaceRole)}>
          {ROLES.filter((r) => r !== 'owner' || workspace.me.role === 'owner').map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </Field>

      {role === 'guest' ? (
        <Field
          label="Channels this guest can see"
          hint="Leave every box clear to give them the run of the workspace. Tick any and they see only those — not even public channels."
        >
          <div className="guest-channels">
            {channels.map((c) => (
              <label className="check" key={c.channel.id}>
                <input
                  type="checkbox"
                  checked={guestChannels.includes(c.channel.id)}
                  onChange={() =>
                    setGuestChannels((prev) =>
                      prev.includes(c.channel.id)
                        ? prev.filter((id) => id !== c.channel.id)
                        : [...prev, c.channel.id],
                    )
                  }
                />
                #{c.channel.name}
              </label>
            ))}
          </div>
        </Field>
      ) : null}

      <h2>How they appear here</h2>
      <p className="hint">
        This is their name inside {w.name} only. It does not change their agent address or anything
        in another workspace.
      </p>
      <Field label="Display name">
        <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      </Field>
      <Field label="Title">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Staff Engineer" />
      </Field>
      {error ? <div className="error-text">{error}</div> : null}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

function Invitations({ workspace }: { workspace: WorkspaceView }) {
  const w = workspace.workspace;
  const [address, setAddress] = useState('');
  const [role, setRole] = useState<WorkspaceRole>('member');
  const [expiry, setExpiry] = useState(24 * 7);
  const [maxUses, setMaxUses] = useState(0);
  const [copied, setCopied] = useState('');
  const [error, run, busy] = useAction();

  const mayInvite = can(workspace.me.role, 'invite', w.permissions);

  return (
    <>
      {!mayInvite ? (
        <div className="banner warn">
          Inviting people is limited to {w.permissions.invite}s in this workspace.
        </div>
      ) : null}

      <div className="row">
        <Field
          label="Invite one person"
          hint="Leave blank for a code anybody can redeem."
        >
          <input
            value={address}
            disabled={!mayInvite}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="sarah@northwind"
          />
        </Field>
        <Field label="As">
          <select
            value={role}
            disabled={!mayInvite}
            onChange={(e) => setRole(e.target.value as WorkspaceRole)}
          >
            <option value="guest">guest</option>
            <option value="member">member</option>
            {atLeast(workspace.me.role, 'admin') ? <option value="admin">admin</option> : null}
          </select>
        </Field>
      </div>
      <div className="row">
        <Field label="Expires">
          <select value={expiry} disabled={!mayInvite} onChange={(e) => setExpiry(Number(e.target.value))}>
            <option value={24}>in a day</option>
            <option value={24 * 7}>in a week</option>
            <option value={24 * 30}>in a month</option>
            <option value={0}>never</option>
          </select>
        </Field>
        <Field label="Uses">
          <select value={maxUses} disabled={!mayInvite} onChange={(e) => setMaxUses(Number(e.target.value))}>
            <option value={0}>unlimited</option>
            <option value={1}>once</option>
            <option value={5}>five times</option>
            <option value={25}>twenty-five times</option>
          </select>
        </Field>
        <div className="field" style={{ alignSelf: 'end' }}>
          <button
            className="primary"
            disabled={busy || !mayInvite}
            onClick={() =>
              run(() =>
                unwrap(
                  api.createInvite(w.id, {
                    invitedAddress: address.trim() || undefined,
                    role,
                    expiresInHours: expiry,
                    maxUses,
                  }),
                ),
              ).then((ok) => ok && setAddress(''))
            }
          >
            {busy ? 'Creating…' : 'Create invitation'}
          </button>
        </div>
      </div>

      {workspace.invites.length === 0 ? (
        <div className="empty">No live invitations.</div>
      ) : (
        workspace.invites.map((invite) => (
          <div className="card" key={invite.code}>
            <div className="card-head">
              <div>
                <div className="card-title mono">{invite.code}</div>
                <div className="card-sub">
                  {invite.invitedAddress ? `For ${invite.invitedAddress}` : 'Anyone with the code'} ·
                  joins as {invite.role} ·{' '}
                  {invite.expiresAt ? `expires ${relative(invite.expiresAt)}` : 'no expiry'}
                  {invite.maxUses ? ` · ${invite.uses}/${invite.maxUses} used` : ` · used ${invite.uses}×`}
                </div>
                <div className="card-sub">
                  Created by {invite.createdBy.split('@')[0]} {relative(invite.createdAt)}
                </div>
              </div>
              <div className="row" style={{ flex: '0 0 auto', gap: 6 }}>
                <button
                  onClick={() => {
                    void navigator.clipboard?.writeText(invite.code);
                    setCopied(invite.code);
                    setTimeout(() => setCopied(''), 1500);
                  }}
                >
                  {copied === invite.code ? 'Copied' : 'Copy'}
                </button>
                <button className="danger" onClick={() => run(() => unwrap(api.revokeInvite(w.id, invite.code)))}>
                  Revoke
                </button>
              </div>
            </div>
          </div>
        ))
      )}
      {error ? <div className="error-text">{error}</div> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Join requests
// ---------------------------------------------------------------------------

function Requests({ workspace }: { workspace: WorkspaceView }) {
  const w = workspace.workspace;
  const [error, run, busy] = useAction();
  const pending = workspace.joinRequests.filter((r) => r.state === 'pending');
  const decided = workspace.joinRequests.filter((r) => r.state !== 'pending').slice(0, 20);

  return (
    <>
      {!w.acceptsJoinRequests ? (
        <div className="banner warn">
          This workspace is not taking requests. Turn it on in workspace settings and people who find
          it can ask to be let in.
        </div>
      ) : null}

      {pending.length === 0 ? (
        <div className="empty">Nobody is waiting.</div>
      ) : (
        pending.map((request) => (
          <div className="card" key={request.id}>
            <div className="card-head">
              <div>
                <div className="card-title">{request.displayName}</div>
                <div className="card-sub mono">{request.address}</div>
                {request.message ? <p className="card-sub">“{request.message}”</p> : null}
                <div className="card-sub">Asked {relative(request.createdAt)}</div>
              </div>
              <div className="row" style={{ flex: '0 0 auto', gap: 6 }}>
                <select id={`role-${request.id}`} defaultValue="member" style={{ width: 110 }}>
                  <option value="guest">as guest</option>
                  <option value="member">as member</option>
                  {workspace.me.role === 'owner' || workspace.me.role === 'admin' ? (
                    <option value="admin">as admin</option>
                  ) : null}
                </select>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    const select = document.getElementById(
                      `role-${request.id}`,
                    ) as HTMLSelectElement | null;
                    const role = (select?.value as WorkspaceRole) ?? 'member';
                    void run(() => unwrap(api.reviewJoinRequest(w.id, request.id, true, role)));
                  }}
                >
                  Approve
                </button>
                <button
                  className="danger"
                  disabled={busy}
                  onClick={() => run(() => unwrap(api.reviewJoinRequest(w.id, request.id, false)))}
                >
                  Deny
                </button>
              </div>
            </div>
          </div>
        ))
      )}

      {decided.length ? (
        <>
          <h2>Already answered</h2>
          <div className="log-list">
            {decided.map((request) => (
              <div className="log-row" key={request.id}>
                <span className={`tag small ${request.state === 'approved' ? 'good' : 'bad'}`}>
                  {request.state}
                </span>
                <span>{request.displayName}</span>
                <span className="log-when">
                  {request.decidedAt ? relative(request.decidedAt) : ''}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
      {error ? <div className="error-text">{error}</div> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

function Permissions({ workspace }: { workspace: WorkspaceView }) {
  const w = workspace.workspace;
  const [draft, setDraft] = useState<WorkspacePermissions>(w.permissions);
  const [error, run, busy] = useAction();
  const canEdit = atLeast(workspace.me.role, 'admin');

  // Somebody else may change these while this is open; follow them.
  useEffect(() => setDraft(w.permissions), [w.permissions]);

  const dirty = CAPABILITIES.some((c) => draft[c] !== w.permissions[c]);

  return (
    <>
      <p className="hint">
        Every one of these is checked on the relay, not just hidden here. Some have a floor that
        cannot be lowered — a workspace where a guest could remove its owner is not a setting.
      </p>
      {!canEdit ? <div className="banner warn">Only admins can change these.</div> : null}

      <div className="permission-table">
        {CAPABILITIES.map((capability: Capability) => {
          const floor = CAPABILITY_FLOORS[capability];
          return (
            <div className="permission-row" key={capability}>
              <div>
                <div className="permission-label">{CAPABILITY_LABELS[capability]}</div>
                {floor ? (
                  <div className="permission-floor">never below {floor}</div>
                ) : null}
              </div>
              <select
                value={draft[capability]}
                disabled={!canEdit}
                onChange={(e) =>
                  setDraft((prev) => ({
                    ...prev,
                    [capability]: clampCapability(capability, e.target.value as WorkspaceRole),
                  }))
                }
              >
                {ROLES.filter((role) => !floor || ROLE_RANK[role] >= ROLE_RANK[floor]).map((role) => (
                  <option key={role} value={role}>
                    {role === 'guest'
                      ? 'Everyone, guests included'
                      : role === 'member'
                        ? 'Members and above'
                        : role === 'admin'
                          ? 'Admins and owners'
                          : 'Owners only'}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <button
          className="primary"
          disabled={!canEdit || busy || !dirty}
          onClick={() => run(() => unwrap(api.setWorkspacePermissions(w.id, draft)))}
        >
          {busy ? 'Saving…' : 'Save permissions'}
        </button>
        <button disabled={!dirty} onClick={() => setDraft(w.permissions)}>
          Discard
        </button>
      </div>
      {error ? <div className="error-text">{error}</div> : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

function ActivityLog({ workspace }: { workspace: WorkspaceView }) {
  const name = (address: string) =>
    workspace.members.find((m) => m.address === address)?.displayName ?? address.split('@')[0];

  if (!workspace.audit.length) {
    return <div className="empty">Nothing administrative has happened yet.</div>;
  }

  return (
    <>
      <p className="hint">
        Every administrative act on this workspace, newest first. Kept on the relay and readable only
        by admins.
      </p>
      <div className="log-list">
        {workspace.audit.map((entry) => (
          <div className="log-row" key={entry.id}>
            <span className="log-actor">{name(entry.actor)}</span>
            <span className="log-what">
              {AUDIT_LABELS[entry.action as AuditAction] ?? entry.action}
              {entry.target ? ` ${entry.target.includes('@') ? name(entry.target) : entry.target}` : ''}
              {entry.detail ? <span className="log-detail"> — {entry.detail}</span> : null}
            </span>
            <span className="log-when">{relative(entry.at)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
