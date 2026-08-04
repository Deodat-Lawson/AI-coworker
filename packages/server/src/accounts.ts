/**
 * Accounts: who somebody is, established once and remembered.
 *
 * Until now the relay took an agent address at face value — which is fine on a
 * trusted network and indefensible anywhere else, because it means anybody can
 * claim to be anybody. This is the missing half: an email you have to prove you
 * can read, a password you may set, and a session token the socket presents so
 * the relay knows the address on the wire belongs to the person using it.
 *
 * The shape is Slack's, because Slack's shape is right and people already know
 * it: enter an email, type the code that arrives, then either join the
 * workspace your colleagues are already in — matched on your email domain — or
 * make a new one.
 *
 * Everything here is deliberately dependency-free. Password hashing is scrypt
 * from `node:crypto`; delivery is an interface with a transport that prints to
 * the relay log, which is exactly right for a relay you run yourself and the
 * seam to hang real SMTP on when you do not.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { type AgentAddress, id } from '@ai-coworker/shared';

/** A refusal the HTTP layer turns into a status code and a message. */
export class AuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface Account {
  id: string;
  /** As typed, for display. */
  email: string;
  /** Lower-cased, the key everything looks up by. */
  emailKey: string;
  /** Set once the code has been typed back. Nothing works before that. */
  verifiedAt: number;
  /** Optional: a verified email alone is enough to sign in with a fresh code. */
  passwordHash?: string;
  displayName: string;
  /** The agent address this account owns. Derived from the email, then fixed. */
  address: AgentAddress;
  createdAt: number;
  lastLoginAt: number;
  /** Switched off by an operator; nothing about it works while this is set. */
  disabledAt?: number;
}

/** What the client is allowed to know about its own account. */
export interface AccountView {
  id: string;
  email: string;
  displayName: string;
  address: AgentAddress;
  hasPassword: boolean;
  createdAt: number;
}

export interface Session {
  token: string;
  accountId: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
}

interface PendingCode {
  emailKey: string;
  /** Stored hashed: a leaked state file should not be a book of live codes. */
  codeHash: string;
  expiresAt: number;
  attempts: number;
  sentAt: number;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void> | void;
}

/**
 * The default transport. A relay you run for your own team has no mail server,
 * and pretending otherwise would mean nobody could ever sign in; printing the
 * code where the operator can see it is the honest behaviour. `sent` keeps the
 * last few so the desktop app can offer to fill the code in during setup on the
 * same machine, and so tests can read it.
 */
export class LogMailer implements Mailer {
  readonly sent: Mail[] = [];
  constructor(private readonly log: (message: string) => void = () => {}) {}

  send(mail: Mail): void {
    this.sent.push(mail);
    if (this.sent.length > 50) this.sent.shift();
    this.log(`mail to ${mail.to}: ${mail.subject}\n${mail.text}`);
  }

  lastFor(email: string): Mail | undefined {
    const key = email.trim().toLowerCase();
    return [...this.sent].reverse().find((m) => m.to.toLowerCase() === key);
  }
}

export interface AccountsOptions {
  statePath?: string;
  mailer?: Mailer;
  relayName?: string;
  log?: (message: string) => void;
  /** How long a code is good for. Slack uses minutes, not hours. */
  codeTtlMs?: number;
  sessionTtlMs?: number;
  /** How many codes one address may ask for inside the window. */
  maxCodesPerWindow?: number;
  rateWindowMs?: number;
  /** Wrong guesses before the code is burned. */
  maxAttempts?: number;
}

const DEFAULTS = {
  codeTtlMs: 15 * 60_000,
  sessionTtlMs: 30 * 24 * 3_600_000,
  maxCodesPerWindow: 5,
  rateWindowMs: 15 * 60_000,
  maxAttempts: 5,
};

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/**
 * Deliberately permissive. The only claim that matters is the one the code
 * proves, so the shape check exists to catch a typo, not to adjudicate RFC 5322.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isEmail(raw: string): boolean {
  return EMAIL_RE.test(raw.trim());
}

export function emailDomain(raw: string): string {
  return normalizeEmail(raw).split('@')[1] ?? '';
}

/**
 * Free mailboxes are not organisations, so a workspace must never be offered to
 * every stranger who happens to have a gmail address.
 */
const PUBLIC_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'hotmail.com',
  'outlook.com',
  'live.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
  'yandex.com',
  'zoho.com',
  'fastmail.com',
  'hey.com',
  'qq.com',
  '163.com',
  'example.com',
]);

export function isCorporateDomain(domain: string): boolean {
  return Boolean(domain) && !PUBLIC_DOMAINS.has(domain.toLowerCase());
}

/**
 * The agent address for an email. `sarah.chen@northwind.io` becomes
 * `sarahchen@northwind`, which is what the rest of the system already expects an
 * address to look like, and stays recognisable to the person it belongs to.
 */
export function addressForEmail(email: string, taken: (address: string) => boolean): AgentAddress {
  const [local = '', domain = ''] = normalizeEmail(email).split('@');
  const handle = local.replace(/\+.*$/, '').replace(/[^a-z0-9]/g, '') || 'user';
  const network = (domain.split('.')[0] ?? 'local').replace(/[^a-z0-9]/g, '') || 'local';
  const base = `${handle}@${network}`;
  if (!taken(base)) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${handle}${n}@${network}`;
    if (!taken(candidate)) return candidate;
  }
  return `${handle}${id('x').slice(-5)}@${network}`;
}

export function nameFromEmail(email: string): string {
  const local = normalizeEmail(email).split('@')[0] ?? '';
  return (
    local
      .replace(/\+.*$/, '')
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || 'Someone'
  );
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/**
 * Six digits, from the CSPRNG rather than Math.random, and never with a leading
 * zero problem because it is formatted rather than truncated.
 */
export function generateCode(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code: string): string {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const derived = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64);
  const expected = Buffer.from(hashHex, 'hex');
  // Length-mismatched buffers make timingSafeEqual throw rather than return false.
  if (expected.length !== derived.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/** Compare two secrets without leaking how far the match got. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

export const PASSWORD_MIN = 8;

export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) {
    return `Use at least ${PASSWORD_MIN} characters.`;
  }
  if (password.length > 256) return 'That password is too long.';
  if (!/[a-zA-Z]/.test(password) || !/[0-9\W]/.test(password)) {
    return 'Mix letters with a number or a symbol.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export class Accounts {
  private accounts = new Map<string, Account>();
  private byEmail = new Map<string, string>();
  private byAddress = new Map<AgentAddress, string>();
  private sessions = new Map<string, Session>();
  private codes = new Map<string, PendingCode>();
  /** emailKey -> timestamps of codes sent, for the rate limit. */
  private recentSends = new Map<string, number[]>();
  private options: Required<Omit<AccountsOptions, 'statePath' | 'mailer'>> & {
    statePath?: string;
    mailer: Mailer;
  };
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(options: AccountsOptions = {}) {
    this.options = {
      ...DEFAULTS,
      statePath: options.statePath,
      mailer: options.mailer ?? new LogMailer(options.log),
      relayName: options.relayName ?? 'Stead',
      log: options.log ?? (() => {}),
      codeTtlMs: options.codeTtlMs ?? DEFAULTS.codeTtlMs,
      sessionTtlMs: options.sessionTtlMs ?? DEFAULTS.sessionTtlMs,
      maxCodesPerWindow: options.maxCodesPerWindow ?? DEFAULTS.maxCodesPerWindow,
      rateWindowMs: options.rateWindowMs ?? DEFAULTS.rateWindowMs,
      maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
    };
    this.restore();
  }

  get mailer(): Mailer {
    return this.options.mailer;
  }

  get size(): number {
    return this.accounts.size;
  }

  // -------------------------------------------------------------------------
  // Lookups
  // -------------------------------------------------------------------------

  byId(accountId: string): Account | undefined {
    return this.accounts.get(accountId);
  }

  find(email: string): Account | undefined {
    const accountId = this.byEmail.get(normalizeEmail(email));
    return accountId ? this.accounts.get(accountId) : undefined;
  }

  forAddress(address: AgentAddress): Account | undefined {
    const accountId = this.byAddress.get(address);
    return accountId ? this.accounts.get(accountId) : undefined;
  }

  view(account: Account): AccountView {
    return {
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      address: account.address,
      hasPassword: Boolean(account.passwordHash),
      createdAt: account.createdAt,
    };
  }

  /** Every verified email domain in use, so a workspace can claim one. */
  domainsInUse(): string[] {
    const out = new Set<string>();
    for (const account of this.accounts.values()) {
      const domain = emailDomain(account.email);
      if (isCorporateDomain(domain)) out.add(domain);
    }
    return [...out].sort();
  }

  // -------------------------------------------------------------------------
  // Signing in
  // -------------------------------------------------------------------------

  /**
   * Step one, for both new people and returning ones: send a code. The reply
   * never says whether the address is already known, because "no account with
   * that email" is a free membership oracle.
   */
  async startEmail(rawEmail: string): Promise<{ expiresAt: number; devCode?: string }> {
    const email = normalizeEmail(rawEmail);
    if (!isEmail(email)) {
      throw new AuthError(400, 'bad_email', 'That does not look like an email address.');
    }
    const existing = this.find(email);
    if (existing?.disabledAt) {
      throw new AuthError(403, 'disabled', 'That account has been switched off.');
    }
    this.checkSendRate(email);

    const code = generateCode();
    const expiresAt = Date.now() + this.options.codeTtlMs;
    this.codes.set(email, {
      emailKey: email,
      codeHash: hashCode(code),
      expiresAt,
      attempts: 0,
      sentAt: Date.now(),
    });

    const minutes = Math.round(this.options.codeTtlMs / 60_000);
    await this.options.mailer.send({
      to: email,
      subject: `${code} is your ${this.options.relayName} code`,
      text: [
        `Your confirmation code is ${code}.`,
        '',
        `Type it into ${this.options.relayName} within ${minutes} minutes.`,
        'If you did not ask for this, you can ignore it — nothing has happened.',
      ].join('\n'),
    });
    this.save();

    // A relay run for your own team has no mail server. Handing the code back
    // when the mailer is the log one is what makes that setup usable at all;
    // it is never returned once real delivery is configured.
    const devCode = this.options.mailer instanceof LogMailer ? code : undefined;
    return { expiresAt, devCode };
  }

  private checkSendRate(emailKey: string): void {
    const now = Date.now();
    const window = this.options.rateWindowMs;
    const recent = (this.recentSends.get(emailKey) ?? []).filter((t) => now - t < window);
    if (recent.length >= this.options.maxCodesPerWindow) {
      const wait = Math.ceil((window - (now - recent[0]!)) / 60_000);
      throw new AuthError(
        429,
        'too_many_codes',
        `Too many codes requested. Try again in ${Math.max(1, wait)} minute(s).`,
      );
    }
    recent.push(now);
    this.recentSends.set(emailKey, recent);
  }

  /**
   * Step two: prove you can read the mailbox. This is also where a brand new
   * account comes into existence — there is no separate "register" call,
   * because until the code is typed there is nothing worth storing.
   */
  verifyEmail(rawEmail: string, rawCode: string): { account: Account; session: Session; created: boolean } {
    const email = normalizeEmail(rawEmail);
    const pending = this.codes.get(email);
    if (!pending) {
      throw new AuthError(400, 'no_code', 'Ask for a code first — that one is no longer waiting.');
    }
    if (pending.expiresAt < Date.now()) {
      this.codes.delete(email);
      throw new AuthError(400, 'code_expired', 'That code has expired. Ask for a fresh one.');
    }
    if (pending.attempts >= this.options.maxAttempts) {
      this.codes.delete(email);
      throw new AuthError(429, 'too_many_attempts', 'Too many wrong codes. Ask for a fresh one.');
    }
    if (!constantTimeEqual(hashCode(rawCode.replace(/\s/g, '')), pending.codeHash)) {
      pending.attempts++;
      const left = this.options.maxAttempts - pending.attempts;
      if (left <= 0) {
        // Burn it here rather than on the next try: leaving a dead code in place
        // to be discovered on the following request tells an attacker they got
        // one more guess than they did.
        this.codes.delete(email);
        throw new AuthError(429, 'too_many_attempts', 'Too many wrong codes. Ask for a fresh one.');
      }
      throw new AuthError(400, 'bad_code', `That code is not right. ${left} attempt(s) left.`);
    }
    this.codes.delete(email);

    let created = false;
    let account = this.find(email);
    if (!account) {
      account = {
        id: id('acc'),
        email: rawEmail.trim(),
        emailKey: email,
        verifiedAt: Date.now(),
        displayName: nameFromEmail(email),
        address: addressForEmail(email, (a) => this.byAddress.has(a)),
        createdAt: Date.now(),
        lastLoginAt: Date.now(),
      };
      this.accounts.set(account.id, account);
      this.byEmail.set(email, account.id);
      this.byAddress.set(account.address, account.id);
      created = true;
      this.options.log(`new account ${account.email} → ${account.address}`);
    } else {
      if (account.disabledAt) throw new AuthError(403, 'disabled', 'That account has been switched off.');
      if (!account.verifiedAt) account.verifiedAt = Date.now();
      account.lastLoginAt = Date.now();
    }

    const session = this.newSession(account);
    this.save();
    return { account, session, created };
  }

  /** The returning-visitor path, for anybody who set a password. */
  login(rawEmail: string, password: string): { account: Account; session: Session } {
    const account = this.find(rawEmail);
    // Same refusal either way: whether an email is registered is not something
    // an unauthenticated caller gets to learn.
    const wrong = () => new AuthError(401, 'bad_login', 'That email and password do not match.');
    if (!account || !account.passwordHash) throw wrong();
    if (account.disabledAt) throw new AuthError(403, 'disabled', 'That account has been switched off.');
    if (!verifyPassword(password, account.passwordHash)) throw wrong();
    account.lastLoginAt = Date.now();
    const session = this.newSession(account);
    this.save();
    return { account, session };
  }

  /**
   * Step three: name yourself, and optionally set a password so the next visit
   * does not need the mailbox.
   */
  completeProfile(
    token: string,
    patch: { displayName?: string; password?: string },
  ): Account {
    const account = this.requireSession(token);
    if (patch.displayName !== undefined) {
      const name = patch.displayName.trim().slice(0, 60);
      if (name.length < 2) throw new AuthError(400, 'bad_name', 'Give your name so people know who you are.');
      account.displayName = name;
    }
    if (patch.password) {
      const problem = passwordProblem(patch.password);
      if (problem) throw new AuthError(400, 'weak_password', problem);
      account.passwordHash = hashPassword(patch.password);
    }
    this.save();
    return account;
  }

  // -------------------------------------------------------------------------
  // Sessions
  // -------------------------------------------------------------------------

  private newSession(account: Account): Session {
    const session: Session = {
      token: crypto.randomBytes(32).toString('base64url'),
      accountId: account.id,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.options.sessionTtlMs,
      lastSeenAt: Date.now(),
    };
    this.sessions.set(session.token, session);
    return session;
  }

  /** The account behind a token, or undefined. Expired tokens are swept here. */
  resolve(token: string | undefined): Account | undefined {
    if (!token) return undefined;
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt < Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    const account = this.accounts.get(session.accountId);
    if (!account || account.disabledAt) return undefined;
    session.lastSeenAt = Date.now();
    return account;
  }

  requireSession(token: string | undefined): Account {
    const account = this.resolve(token);
    if (!account) throw new AuthError(401, 'no_session', 'Sign in again.');
    return account;
  }

  logout(token: string): void {
    this.sessions.delete(token);
    this.save();
  }

  /** Every session for one account — used when a password changes. */
  logoutAll(accountId: string): void {
    for (const [token, session] of this.sessions) {
      if (session.accountId === accountId) this.sessions.delete(token);
    }
    this.save();
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private save(): void {
    if (!this.options.statePath) return;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 300);
    this.saveTimer.unref?.();
  }

  flush(): void {
    const file = this.options.statePath;
    if (!file) return;
    try {
      const payload = {
        version: 1,
        accounts: [...this.accounts.values()],
        // Sessions are worth keeping: restarting the relay should not sign
        // everybody out. Codes are not — they expire in minutes anyway.
        sessions: [...this.sessions.values()],
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, file);
    } catch (err) {
      this.options.log(`could not persist accounts: ${(err as Error).message}`);
    }
  }

  private restore(): void {
    const file = this.options.statePath;
    if (!file) return;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    try {
      const data = JSON.parse(raw) as { accounts?: Account[]; sessions?: Session[] };
      for (const account of data.accounts ?? []) {
        this.accounts.set(account.id, account);
        this.byEmail.set(account.emailKey, account.id);
        this.byAddress.set(account.address, account.id);
      }
      const now = Date.now();
      for (const session of data.sessions ?? []) {
        if (session.expiresAt > now) this.sessions.set(session.token, session);
      }
      if (this.accounts.size) {
        this.options.log(`restored ${this.accounts.size} account(s) from ${file}`);
      }
    } catch (err) {
      this.options.log(`ignoring unreadable account state: ${(err as Error).message}`);
    }
  }

  shutdown(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.flush();
  }
}
