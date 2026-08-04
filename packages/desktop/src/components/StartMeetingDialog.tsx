import { useState } from 'react';

import { isDirect } from '@ai-coworker/shared';

import { api, unwrap, type ChannelView, type WorkspaceView } from '../lib/api.js';
import { Avatar, Field, Modal } from './ui.js';

interface Props {
  workspace: WorkspaceView;
  view: ChannelView;
  onClose: () => void;
}

const KINDS = [
  { value: 'sync', label: 'sync' },
  { value: 'standup', label: 'standup' },
  { value: 'one_on_one', label: '1:1' },
  { value: 'review', label: 'review' },
  { value: 'planning', label: 'planning' },
] as const;

/**
 * Have the agents in this channel meet, here.
 *
 * There is no separate place to book a meeting because there is no separate
 * place for one to happen: the room is this channel, and everyone in it is
 * already the invite list.
 */
export default function StartMeetingDialog({ workspace, view, onClose }: Props) {
  const channel = view.channel;
  const me = workspace.me.address;
  const candidates = channel.members
    .filter((a) => a !== me)
    .map((address) => workspace.members.find((m) => m.address === address))
    .filter((m): m is NonNullable<typeof m> => Boolean(m) && !m!.deactivated);

  const label = isDirect(channel) ? view.label : `#${channel.name}`;
  const [selected, setSelected] = useState<string[]>(candidates.map((m) => m.address));
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [kind, setKind] = useState<(typeof KINDS)[number]['value']>('sync');
  const [duration, setDuration] = useState(30);
  const [urgency, setUrgency] = useState<'whenever' | 'this_week' | 'asap'>('asap');
  const [agenda, setAgenda] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (address: string) =>
    setSelected((prev) =>
      prev.includes(address) ? prev.filter((a) => a !== address) : [...prev, address],
    );

  async function book() {
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.requestMeeting({
          participants: selected,
          title: title.trim() || defaultTitle(label, purpose),
          purpose: purpose.trim(),
          kind,
          durationMins: duration,
          urgency,
          workspaceId: workspace.workspace.id,
          channelId: channel.id,
          agenda: agenda
            .split('\n')
            .map((a) => a.trim())
            .filter(Boolean),
        }),
      );
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title={`Have your agents meet in ${label}`}
      subtitle="They negotiate a time against everyone's calendar, meet without you, and each write their own human a briefing. It all lands here."
      onClose={onClose}
      footer={
        <>
          {error ? <div className="error-text">{error}</div> : null}
          <button onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={busy || !purpose.trim() || selected.length === 0}
            onClick={() => void book()}
          >
            {busy ? 'Asking…' : 'Ask their agents for a time'}
          </button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <div className="empty">
          There is nobody else in {label} yet. Add somebody, and their agent can meet yours here.
        </div>
      ) : (
        <>
          <Field
            label="Who"
            hint="Everyone in this channel is invited by default. Their agent attends, not them."
          >
            <div className="member-picks">
              {candidates.map((member) => (
                <button
                  key={member.address}
                  className={`member-pick ${selected.includes(member.address) ? 'on' : ''}`}
                  onClick={() => toggle(member.address)}
                >
                  <Avatar
                    name={member.displayName}
                    address={member.address}
                    size={20}
                    square
                    presence={member.presence}
                  />
                  {member.displayName}
                  {member.agentOnline ? null : <span className="tag small">agent offline</span>}
                </button>
              ))}
            </div>
          </Field>

          <Field label="Purpose — this is what the agents will actually discuss">
            <textarea
              autoFocus
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Get status on the auth migration and decide whether the billing launch date moves."
            />
          </Field>

          <Field label="Title (optional)">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={defaultTitle(label, purpose)}
            />
          </Field>

          <Field label="Agenda (one per line, optional)">
            <textarea value={agenda} onChange={(e) => setAgenda(e.target.value)} />
          </Field>

          <div className="row">
            <Field label="Kind">
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                {KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Duration">
              <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {[15, 30, 45, 60].map((d) => (
                  <option key={d} value={d}>
                    {d} min
                  </option>
                ))}
              </select>
            </Field>
            <Field label="When">
              <select value={urgency} onChange={(e) => setUrgency(e.target.value as typeof urgency)}>
                <option value="asap">as soon as possible</option>
                <option value="this_week">this week</option>
                <option value="whenever">whenever there's room</option>
              </select>
            </Field>
          </div>
        </>
      )}
    </Modal>
  );
}

function defaultTitle(label: string, purpose: string): string {
  const first = purpose.trim().split(/[.\n]/)[0]?.trim();
  if (first && first.length > 3 && first.length <= 60) return first;
  return `${label} sync`;
}
