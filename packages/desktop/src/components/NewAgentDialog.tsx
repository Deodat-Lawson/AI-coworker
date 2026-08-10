import { useState } from 'react';

import {
  type AgentAutonomy,
  AGENT_AUTONOMIES,
  AGENT_EMOJI,
  AUTONOMY_BLURBS,
  AUTONOMY_LABELS,
  WORKSPACE_COLORS,
} from '@ai-coworker/shared';

import { api, type WorkspaceView } from '../lib/api.js';
import { Icon, type IconName } from './icons.js';
import { Modal } from './ui.js';

const AUTONOMY_ICONS: Record<AgentAutonomy, IconName> = {
  observer: 'eye',
  ask: 'shield-check',
  act: 'sparkle',
};

/**
 * Meeting the agent that will represent you in a workspace you just joined.
 *
 * This interrupts once, on purpose. Every other place in the app can afford to
 * be discovered later; this one cannot, because the thing it has to establish —
 * *this is a different agent from the one next door, and it starts knowing
 * nothing about this machine* — is only cheap to say at the moment the agent
 * appears. Explaining it afterwards means correcting an assumption instead of
 * setting one.
 *
 * It asks for two decisions and no more: what to call it, and how much rope it
 * has. Everything else has a safe default and a settings screen.
 */
export default function NewAgentDialog({
  workspace,
  onClose,
  onOpenAccess,
}: {
  workspace: WorkspaceView;
  onClose: () => void;
  onOpenAccess: () => void;
}) {
  const agent = workspace.agent;
  const [name, setName] = useState(agent.name);
  const [emoji, setEmoji] = useState(agent.emoji);
  const [accent, setAccent] = useState(agent.accent || workspace.workspace.color);
  const [autonomy, setAutonomy] = useState<AgentAutonomy>(agent.autonomy);
  const [busy, setBusy] = useState(false);

  const finish = async (thenOpenAccess: boolean) => {
    setBusy(true);
    await api.saveWorkspaceAgent(workspace.workspace.id, {
      name: name.trim() || agent.name,
      emoji,
      accent,
      autonomy,
      introduced: true,
    });
    setBusy(false);
    onClose();
    if (thenOpenAccess) onOpenAccess();
  };

  return (
    <Modal
      title={`Your agent in ${workspace.workspace.name}`}
      subtitle="One workspace, one agent. This one is new, and it reaches nothing on this machine yet."
      onClose={() => void finish(false)}
      wide
      footer={
        <>
          <button onClick={() => void finish(true)} disabled={busy}>
            <Icon name="shield-check" size={14} /> Set what it can reach
          </button>
          <button className="primary" onClick={() => void finish(false)} disabled={busy}>
            {busy ? 'Saving…' : 'Done'}
          </button>
        </>
      }
    >
      <div className="agent-intro">
        <div
          className="agent-avatar large"
          style={{ background: `${accent}22`, borderColor: accent }}
        >
          <span>{emoji}</span>
        </div>
        <div>
          <input
            className="agent-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Agent name"
          />
          <p className="hint" style={{ margin: '4px 0 0' }}>
            Other people never see this name — it is how you tell your agents apart.
          </p>
        </div>
      </div>

      <div className="picker-row">
        {AGENT_EMOJI.map((option) => (
          <button
            key={option}
            className={`icon-choice ${emoji === option ? 'on' : ''}`}
            onClick={() => setEmoji(option)}
          >
            {option}
          </button>
        ))}
      </div>
      <div className="picker-row">
        {WORKSPACE_COLORS.map((option) => (
          <button
            key={option}
            className={`color-choice ${accent === option ? 'on' : ''}`}
            style={{ background: option }}
            aria-label={option}
            onClick={() => setAccent(option)}
          />
        ))}
      </div>

      <h2 style={{ marginTop: 20 }}>How much it does on its own</h2>
      <div className="choice-grid" role="radiogroup" aria-label="Autonomy">
        {AGENT_AUTONOMIES.map((level) => (
          <button
            key={level}
            role="radio"
            aria-checked={autonomy === level}
            className={`choice-card ${autonomy === level ? 'on' : ''}`}
            onClick={() => setAutonomy(level)}
          >
            <Icon name={AUTONOMY_ICONS[level]} size={19} className="choice-icon" />
            <div className="choice-title">{AUTONOMY_LABELS[level]}</div>
            <div className="choice-blurb">{AUTONOMY_BLURBS[level]}</div>
          </button>
        ))}
      </div>

      <div className="banner">
        <Icon name="shield" size={17} />
        <div>
          <div className="card-title">It starts with nothing of yours</div>
          <div className="card-sub">
            No imported memory, no folders, nothing from your other workspaces. Whatever you grant it
            here applies to <strong>{workspace.workspace.name}</strong> and to no other agent.
          </div>
        </div>
      </div>
    </Modal>
  );
}
