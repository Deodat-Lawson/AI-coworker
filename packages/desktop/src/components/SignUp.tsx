import { DEFAULT_RELAY_URL } from '@ai-coworker/shared';
/**
 * Signing up, in the order Slack asks.
 *
 *   1. your email
 *   2. the six-digit code that arrives
 *   3. the workspace your colleagues are already in, or a new one
 *   4. your name, and a password if you want one
 *   5. what your team is working on — that becomes the first channel
 *   6. who else is on the team
 *
 * The order is not arbitrary. Everything before step 3 is about establishing
 * that you are a real person with a real mailbox; step 3 is the moment the
 * product pays that back by showing you your colleagues are already here. A
 * flow that asked for a password first would make somebody commit before it had
 * shown them anything.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { api, unwrap, type AppState } from '../lib/api.js';
import type {
  AuthResult,
  PendingInvitationView,
  WelcomeWorkspaceView,
} from '../../electron/ipc.js';
import { plural } from '../lib/format.js';

type Step = 'email' | 'code' | 'password' | 'place' | 'name' | 'project' | 'invite' | 'finishing';

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

/** Six boxes, the way every code entry does it, with paste handled. */
function CodeInput({
  value,
  onChange,
  onComplete,
  disabled,
}: {
  value: string;
  onChange: (next: string) => void;
  onComplete: (code: string) => void;
  disabled?: boolean;
}) {
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(6, ' ').slice(0, 6).split('');

  useEffect(() => {
    inputs.current[Math.min(value.length, 5)]?.focus();
  }, [value.length]);

  const set = (index: number, char: string) => {
    const cleaned = char.replace(/\D/g, '');
    if (!cleaned) return;
    const next = (value.slice(0, index) + cleaned + value.slice(index + cleaned.length))
      .replace(/\D/g, '')
      .slice(0, 6);
    onChange(next);
    if (next.length === 6) onComplete(next);
  };

  return (
    <div className="code-input">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(el) => {
            inputs.current[index] = el;
          }}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          disabled={disabled}
          value={digit.trim()}
          aria-label={`Digit ${index + 1}`}
          onChange={(e) => set(index, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !digits[index]?.trim()) {
              onChange(value.slice(0, Math.max(0, index - 1)));
            } else if (e.key === 'Backspace') {
              onChange(value.slice(0, index) + value.slice(index + 1));
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
            onChange(pasted);
            if (pasted.length === 6) onComplete(pasted);
          }}
        />
      ))}
    </div>
  );
}

export default function SignUp({
  state,
  onUseDemoPersona,
  onBack,
}: {
  state: AppState;
  onUseDemoPersona: () => void;
  /** Present only when this was reached deliberately from an app that is
      already set up — during first-run there is nothing behind it. */
  onBack?: () => void;
}) {
  const [step, setStep] = useState<Step>('email');
  const [relayUrl, setRelayUrl] = useState(state.connection.relayUrl || DEFAULT_RELAY_URL);
  const [relayName, setRelayName] = useState('');
  const [codesInResponse, setCodesInResponse] = useState(false);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [devCode, setDevCode] = useState('');
  const [auth, setAuth] = useState<AuthResult | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [project, setProject] = useState('');
  const [invites, setInvites] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // A relay that answers tells us its name and whether it can actually send
  // mail — worth knowing before somebody waits for a code that will never come.
  useEffect(() => {
    let live = true;
    void api
      .authConfig(relayUrl)
      .then((result) => {
        if (!live || !result.ok) return;
        setRelayName(result.value.relayName);
        setCodesInResponse(result.value.codesInResponse);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [relayUrl]);

  async function attempt(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const emailValid = EMAIL_RE.test(email.trim());

  // --- steps ---------------------------------------------------------------

  const sendCode = () =>
    attempt(async () => {
      const result = await unwrap(api.authStart({ email: email.trim(), relayUrl: relayUrl.trim() }));
      setDevCode(result.devCode ?? '');
      setCode('');
      setStep('code');
    });

  const verify = (typed: string) =>
    attempt(async () => {
      const result = await unwrap(
        api.authVerify({ email: email.trim(), code: typed, relayUrl: relayUrl.trim() }),
      );
      setAuth(result);
      setDisplayName(result.account.displayName);
      // Somebody with a password already has an account; skip straight past the
      // introductions to where they are going.
      setStep(result.needsProfile ? 'name' : 'place');
    });

  const signInWithPassword = () =>
    attempt(async () => {
      const result = await unwrap(
        api.authLogin({ email: email.trim(), password, relayUrl: relayUrl.trim() }),
      );
      setAuth(result);
      setDisplayName(result.account.displayName);
      setStep('place');
    });

  const saveName = () =>
    attempt(async () => {
      await unwrap(
        api.authProfile({
          displayName: displayName.trim(),
          password: password ? password : undefined,
        }),
      );
      setPassword('');
      setStep('place');
    });

  const createWorkspace = () =>
    attempt(async () => {
      const result = await unwrap(
        api.authCreateWorkspace({ name: workspaceName.trim(), project: project.trim() }),
      );
      setWorkspaceId(result.workspaceId);
      setStep('invite');
    });

  const joinExisting = (workspace: WelcomeWorkspaceView) =>
    attempt(async () => {
      const result = await unwrap(api.authJoin({ workspaceId: workspace.id }));
      setWorkspaceId(result.workspaceId);
      if (result.requested) {
        setRequested(true);
        setNotice(
          `Asked to join ${workspace.name}. You will land in it as soon as an admin says yes.`,
        );
        setStep('finishing');
        void finish();
        return;
      }
      setStep('invite');
    });

  const redeem = (invitation: PendingInvitationView) =>
    attempt(async () => {
      const result = await unwrap(api.authJoin({ code: invitation.code }));
      setWorkspaceId(result.workspaceId);
      setStep('invite');
    });

  const sendInvites = () =>
    attempt(async () => {
      const emails = invites
        .split(/[\s,;]+/)
        .map((e) => e.trim())
        .filter(Boolean);
      if (emails.length && workspaceId) {
        const result = await unwrap(api.authInvite({ workspaceId, emails }));
        if (result.failed.length) {
          setNotice(
            `Invited ${plural(result.invited.length, 'person', 'people')}. ${result.failed.length} could not be: ${result.failed[0]?.error ?? ''}`,
          );
        }
      }
      setStep('finishing');
      await finish();
    });

  async function finish() {
    await unwrap(api.authFinish({}));
  }

  const skipToFinish = () =>
    attempt(async () => {
      setStep('finishing');
      await finish();
    });

  // --- rendering -----------------------------------------------------------

  const welcome = auth?.workspaces ?? [];
  const invitations = auth?.invitations ?? [];
  const alreadyIn = welcome.filter((w) => w.joined);
  const canJoin = welcome.filter((w) => !w.joined);

  const heading = useMemo(() => {
    switch (step) {
      case 'email':
        return relayName ? `Sign in to ${relayName}` : 'Sign in to Stead';
      case 'code':
        return 'Check your email';
      case 'password':
        return 'Welcome back';
      case 'name':
        return "What's your name?";
      case 'place':
        return alreadyIn.length || canJoin.length || invitations.length
          ? 'Where are you working?'
          : "What's your team called?";
      case 'project':
        return 'What is your team working on?';
      case 'invite':
        return 'Who else is on your team?';
      default:
        return 'Setting things up…';
    }
  }, [step, relayName, alreadyIn.length, canJoin.length, invitations.length]);

  return (
    <div className="onboarding">
      <div className="onboarding-inner signup">
        <div className="signup-progress" aria-hidden="true">
          {(['email', 'code', 'name', 'place', 'invite'] as const).map((key) => (
            <span
              key={key}
              className={`signup-dot ${
                stepIndex(step) > stepIndex(key)
                  ? 'done'
                  : stepIndex(step) === stepIndex(key)
                    ? 'on'
                    : ''
              }`}
            />
          ))}
        </div>

        <h1>{heading}</h1>

        {step === 'email' ? (
          <>
            <p className="subtitle">
              We will send a six-digit code to confirm it is you. No code arrives in your inbox
              without you asking for one.
            </p>
            <div className="field">
              <label>Email address</label>
              <input
                type="email"
                value={email}
                autoFocus
                placeholder="you@company.com"
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && emailValid && !busy && void sendCode()}
              />
            </div>
            <button className="primary big" disabled={!emailValid || busy} onClick={() => void sendCode()}>
              {busy ? 'Sending…' : 'Continue'}
            </button>
            {codesInResponse ? (
              <p className="hint">
                {relayName || 'This relay'} has no mail server configured, so it will show you the
                code here rather than sending it.
              </p>
            ) : null}
            <p className="hint">
              Already have a password?{' '}
              <button className="linkish" onClick={() => setStep('password')}>
                Sign in with it instead
              </button>
            </p>
            {onBack ? (
              <p className="hint">
                <button className="linkish" onClick={onBack}>
                  Back to the app
                </button>{' '}
                — your knowledge base is already set up; signing in only adds an account to the
                relay.
              </p>
            ) : null}
            <p className="hint">
              Just looking around?{' '}
              <button className="linkish" onClick={onUseDemoPersona}>
                Set up with a demo persona
              </button>{' '}
              — a ready-made knowledge base with projects, notes and blockers in it, so a meeting
              has something to be about.
            </p>

            <details className="signup-advanced">
              <summary>Connecting to a different relay</summary>
              <div className="field">
                <label>Relay address</label>
                <input value={relayUrl} onChange={(e) => setRelayUrl(e.target.value)} />
                <p className="hint">
                  One relay runs per team. It routes agents and moderates meetings — it never sees
                  your knowledge base. Start one with <code>npm run server</code>.
                </p>
              </div>
            </details>
          </>
        ) : null}

        {step === 'password' ? (
          <>
            <p className="subtitle">Enter the password you set for {email || 'your account'}.</p>
            <div className="field">
              <label>Email address</label>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="field">
              <label>Password</label>
              <input
                type="password"
                value={password}
                autoFocus
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && void signInWithPassword()}
              />
            </div>
            <button
              className="primary big"
              disabled={busy || !emailValid || !password}
              onClick={() => void signInWithPassword()}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <p className="hint">
              <button className="linkish" onClick={() => setStep('email')}>
                Email me a code instead
              </button>
            </p>
          </>
        ) : null}

        {step === 'code' ? (
          <>
            <p className="subtitle">
              We sent a code to <strong>{email}</strong>. It is good for fifteen minutes.
            </p>
            <CodeInput value={code} onChange={setCode} onComplete={(c) => void verify(c)} disabled={busy} />
            {devCode ? (
              <div className="banner">
                This relay has no mail server configured, so it printed the code to its log instead:{' '}
                <strong className="mono">{devCode}</strong>
                <button className="linkish" onClick={() => void verify(devCode)}>
                  use it
                </button>
              </div>
            ) : null}
            <div className="row" style={{ marginTop: 12 }}>
              <button disabled={busy} onClick={() => void sendCode()}>
                Send it again
              </button>
              <button className="ghost" onClick={() => setStep('email')}>
                Use a different email
              </button>
            </div>
          </>
        ) : null}

        {step === 'name' ? (
          <>
            <p className="subtitle">
              This is how you will appear to everybody else. You can present differently in each
              workspace later.
            </p>
            <div className="field">
              <label>Your name</label>
              <input
                value={displayName}
                autoFocus
                placeholder="Ada Lovelace"
                onChange={(e) => setDisplayName(e.target.value)}
                onKeyDown={(e) =>
                  e.key === 'Enter' && displayName.trim().length > 1 && !busy && void saveName()
                }
              />
            </div>
            <div className="field">
              <label>Password (optional)</label>
              <input
                type="password"
                value={password}
                placeholder="Leave blank to sign in by email code each time"
                onChange={(e) => setPassword(e.target.value)}
              />
              <p className="hint">
                At least eight characters, mixing letters with a number or a symbol. Without one you
                will sign in with a fresh code each time, which is no less secure.
              </p>
            </div>
            <div className="hint">
              Your agent's address will be <code>{auth?.account.address}</code>.
            </div>
            <button
              className="primary big"
              disabled={busy || displayName.trim().length < 2}
              onClick={() => void saveName()}
            >
              {busy ? 'Saving…' : 'Continue'}
            </button>
          </>
        ) : null}

        {step === 'place' ? (
          <>
            {invitations.length ? (
              <>
                <h2>You have been invited</h2>
                {invitations.map((invitation) => (
                  <button
                    key={invitation.code}
                    className="workspace-choice"
                    disabled={busy}
                    onClick={() => void redeem(invitation)}
                  >
                    <span className="workspace-choice-name">{invitation.workspaceName}</span>
                    <span className="workspace-choice-sub">
                      {invitation.invitedBy.split('@')[0]} invited you as {invitation.role}
                    </span>
                  </button>
                ))}
              </>
            ) : null}

            {alreadyIn.length ? (
              <>
                <h2>Workspaces you are in</h2>
                {alreadyIn.map((workspace) => (
                  <button
                    key={workspace.id}
                    className="workspace-choice"
                    disabled={busy}
                    onClick={() => {
                      setWorkspaceId(workspace.id);
                      setStep('invite');
                    }}
                  >
                    <span className="workspace-choice-icon">{workspace.icon}</span>
                    <span className="workspace-choice-name">{workspace.name}</span>
                    <span className="workspace-choice-sub">
                      {plural(workspace.memberCount, 'member')}
                    </span>
                  </button>
                ))}
              </>
            ) : null}

            {canJoin.length ? (
              <>
                <h2>Open to {email.split('@')[1]}</h2>
                <p className="subtitle">
                  Your colleagues are already here. Joining is what you want — a second workspace for
                  the same team is how a company ends up with two.
                </p>
                {canJoin.map((workspace) => (
                  <button
                    key={workspace.id}
                    className="workspace-choice"
                    disabled={busy}
                    onClick={() => void joinExisting(workspace)}
                  >
                    <span className="workspace-choice-icon">{workspace.icon}</span>
                    <span className="workspace-choice-name">{workspace.name}</span>
                    <span className="workspace-choice-sub">
                      {plural(workspace.memberCount, 'member')}
                      {workspace.how === 'request' ? ' · an admin has to say yes' : ''}
                    </span>
                  </button>
                ))}
              </>
            ) : null}

            <h2>{alreadyIn.length || canJoin.length ? 'Or start a new one' : 'Create your workspace'}</h2>
            <div className="field">
              <label>Company or team name</label>
              <input
                value={workspaceName}
                autoFocus={!canJoin.length && !alreadyIn.length}
                placeholder="Northwind"
                onChange={(e) => setWorkspaceName(e.target.value)}
                onKeyDown={(e) =>
                  e.key === 'Enter' && workspaceName.trim().length > 1 && setStep('project')
                }
              />
            </div>
            <button
              className="primary big"
              disabled={busy || workspaceName.trim().length < 2}
              onClick={() => setStep('project')}
            >
              Create workspace
            </button>
          </>
        ) : null}

        {step === 'project' ? (
          <>
            <p className="subtitle">
              We will make it a channel. Channels are where work happens — one per project keeps
              conversations out of each other's way.
            </p>
            <div className="field">
              <label>Project name</label>
              <input
                value={project}
                autoFocus
                placeholder="auth-migration"
                onChange={(e) => setProject(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !busy && void createWorkspace()}
              />
              <p className="hint">
                {project.trim()
                  ? `Your team will start in #${project.trim().toLowerCase().replace(/\s+/g, '-')} and #general.`
                  : 'Leave it blank and you will start with #general alone.'}
              </p>
            </div>
            <button className="primary big" disabled={busy} onClick={() => void createWorkspace()}>
              {busy ? 'Creating…' : 'Create workspace'}
            </button>
          </>
        ) : null}

        {step === 'invite' ? (
          <>
            <p className="subtitle">
              Their agents meet yours. A workspace with one person in it is a notebook — this is the
              step that makes it a team.
            </p>
            <div className="field">
              <label>Email addresses</label>
              <textarea
                value={invites}
                autoFocus
                placeholder={'sarah@northwind.com\nmarcus@northwind.com'}
                onChange={(e) => setInvites(e.target.value)}
              />
              <p className="hint">One per line, or separated by commas.</p>
            </div>
            <div className="row">
              <button className="primary big" disabled={busy} onClick={() => void sendInvites()}>
                {busy ? 'Sending…' : invites.trim() ? 'Send invitations' : 'Continue'}
              </button>
              <button disabled={busy} onClick={() => void skipToFinish()}>
                Skip for now
              </button>
            </div>
          </>
        ) : null}

        {step === 'finishing' ? (
          <p className="subtitle">
            {requested
              ? 'Your request is with the admins. Your agent is starting up in the meantime.'
              : 'Creating your knowledge base and starting your agent…'}
          </p>
        ) : null}

        {notice ? <div className="banner">{notice}</div> : null}
        {error ? <div className="error-text">{error}</div> : null}
      </div>
    </div>
  );
}

/** Where a step sits on the progress rail. Two of them share a dot. */
function stepIndex(step: Step): number {
  switch (step) {
    case 'email':
    case 'password':
      return 0;
    case 'code':
      return 1;
    case 'name':
      return 2;
    case 'place':
    case 'project':
      return 3;
    default:
      return 4;
  }
}
