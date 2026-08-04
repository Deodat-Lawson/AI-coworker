/**
 * The sign-up and sign-in endpoints.
 *
 * Registration is HTTP rather than websocket because it necessarily happens
 * before there is anybody to open a socket as: the whole point of the exchange
 * is to find out who is on the other end. Once it is finished the client holds a
 * session token, and the socket presents that at `hello`.
 *
 * The sequence is Slack's, step for step:
 *
 *   POST /auth/start     email            → a code goes to the mailbox
 *   POST /auth/verify    email + code     → a session, and the workspaces this
 *                                            email is already welcome in
 *   POST /auth/profile   name, password   → who you are, and how to get back in
 *   POST /auth/workspace name, channel    → make one, and land in it
 *   POST /auth/join      workspaceId      → or join one your colleagues built
 *   POST /auth/invite    emails[]         → bring the rest of the team
 *   POST /auth/login     email + password → the returning path
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  type AgentAddress,
  type WorkspaceRole,
  validateChannelName,
} from '@ai-coworker/shared';

import {
  type Account,
  type Accounts,
  AuthError,
  LogMailer,
  emailDomain,
  isCorporateDomain,
  isEmail,
  normalizeEmail,
} from './accounts.js';
import type { WorkspaceHub } from './hub.js';

/** Bodies are tiny; anything larger is a mistake or an attack. */
const MAX_BODY = 64 * 1024;

export interface AuthHttpOptions {
  accounts: Accounts;
  hub: WorkspaceHub;
  relayName: string;
  log?: (message: string) => void;
}

interface Handled {
  status: number;
  body: unknown;
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new AuthError(413, 'too_large', 'That request is too big.');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new AuthError(400, 'bad_json', 'That request body is not JSON.');
  }
}

function str(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

/** The bearer token, from the header or the body, whichever the client used. */
function tokenOf(req: IncomingMessage, body: Record<string, unknown>): string {
  const header = req.headers.authorization ?? '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  return bearer ? bearer[1]!.trim() : str(body, 'token');
}

export class AuthHttp {
  constructor(private readonly options: AuthHttpOptions) {}

  private get accounts(): Accounts {
    return this.options.accounts;
  }

  private get hub(): WorkspaceHub {
    return this.options.hub;
  }

  /**
   * Handle the request if it is ours. Returns false when it is not, so the
   * caller can fall through to whatever else it serves.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = (req.url ?? '').split('?')[0] ?? '';
    if (!url.startsWith('/auth/')) return false;

    // The desktop app is not a browser page, so there is no origin to trust and
    // nothing useful CORS can protect. Answering the preflight keeps a browser
    // client workable during development.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-allow-methods': 'POST, GET, OPTIONS',
      });
      res.end();
      return true;
    }

    let result: Handled;
    try {
      result = await this.route(url, req);
    } catch (err) {
      if (err instanceof AuthError) {
        result = { status: err.status, body: { ok: false, code: err.code, error: err.message } };
      } else {
        this.options.log?.(`auth error on ${url}: ${(err as Error).message}`);
        result = {
          status: 500,
          body: { ok: false, code: 'internal', error: 'Something went wrong on the relay.' },
        };
      }
    }

    const payload = JSON.stringify(result.body);
    res.writeHead(result.status, {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(payload);
    return true;
  }

  private async route(url: string, req: IncomingMessage): Promise<Handled> {
    if (url === '/auth/config' && req.method === 'GET') {
      return {
        status: 200,
        body: {
          ok: true,
          relayName: this.options.relayName,
          accounts: this.accounts.size,
          // Whether codes come back in the response, so the app can say so
          // instead of leaving somebody waiting for mail that will not arrive.
          codesInResponse: this.accounts.mailer instanceof LogMailer,
        },
      };
    }

    if (req.method !== 'POST') {
      throw new AuthError(405, 'bad_method', 'Use POST.');
    }
    const body = await readJson(req);

    switch (url) {
      case '/auth/start':
        return this.start(body);
      case '/auth/verify':
        return this.verify(body);
      case '/auth/profile':
        return this.profile(req, body);
      case '/auth/workspace':
        return this.createWorkspace(req, body);
      case '/auth/join':
        return this.join(req, body);
      case '/auth/invite':
        return this.invite(req, body);
      case '/auth/login':
        return this.login(body);
      case '/auth/session':
        return this.session(req, body);
      case '/auth/logout':
        return this.logout(req, body);
      default:
        throw new AuthError(404, 'no_route', 'No such endpoint.');
    }
  }

  // -------------------------------------------------------------------------

  private async start(body: Record<string, unknown>): Promise<Handled> {
    const email = str(body, 'email');
    const { expiresAt, devCode } = await this.accounts.startEmail(email);
    return {
      status: 200,
      body: {
        ok: true,
        // Never says whether the address is already registered: that would make
        // this endpoint a way to enumerate the team.
        sent: true,
        email: normalizeEmail(email),
        expiresAt,
        devCode,
      },
    };
  }

  private verify(body: Record<string, unknown>): Handled {
    const email = str(body, 'email');
    const code = str(body, 'code');
    const { account, session, created } = this.accounts.verifyEmail(email, code);

    return {
      status: 200,
      body: {
        ok: true,
        token: session.token,
        account: this.accounts.view(account),
        created,
        needsProfile: !account.passwordHash || created,
        workspaces: this.welcomeFor(account),
        invitations: this.invitationsFor(account),
      },
    };
  }

  private profile(req: IncomingMessage, body: Record<string, unknown>): Handled {
    const token = tokenOf(req, body);
    const account = this.accounts.completeProfile(token, {
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      password: typeof body.password === 'string' && body.password ? body.password : undefined,
    });
    return { status: 200, body: { ok: true, account: this.accounts.view(account) } };
  }

  /**
   * "What's the name of your company or team?" followed by "What's a project
   * your team is working on?" — the second becomes the first channel beside
   * #general, exactly as it does in Slack.
   */
  private createWorkspace(req: IncomingMessage, body: Record<string, unknown>): Handled {
    const token = tokenOf(req, body);
    const account = this.accounts.requireSession(token);
    const name = str(body, 'name').trim();
    if (name.length < 2) throw new AuthError(400, 'bad_name', 'Give the workspace a name.');

    const project = str(body, 'project').trim();
    const channels: string[] = [];
    if (project) {
      const validated = validateChannelName(project);
      if (validated.ok && validated.name !== 'general') channels.push(validated.name);
    }

    this.registerIdentity(account);
    const workspaceId = this.hub.createWorkspace(account.address, {
      name,
      description: str(body, 'description').trim(),
      discoverable: Boolean(body.discoverable ?? false),
      channels,
    });

    // A workspace made by somebody with a company address claims that domain,
    // so the next colleague to sign up is offered it rather than making a
    // second, parallel workspace nobody notices for a week.
    const domain = emailDomain(account.email);
    if (isCorporateDomain(domain)) {
      this.hub.claimEmailDomain(account.address, workspaceId, domain);
    }

    return {
      status: 200,
      body: {
        ok: true,
        workspace: this.hub.publicView(workspaceId),
        address: account.address,
        createdChannel: channels[0] ?? '',
      },
    };
  }

  /** Join one of the workspaces the verified email domain is welcome in. */
  private join(req: IncomingMessage, body: Record<string, unknown>): Handled {
    const token = tokenOf(req, body);
    const account = this.accounts.requireSession(token);
    const workspaceId = str(body, 'workspaceId');
    const code = str(body, 'code');
    this.registerIdentity(account);

    if (code) {
      const joined = this.hub.joinWorkspace(account.address, { code });
      return { status: 200, body: { ok: true, workspace: this.hub.publicView(joined) } };
    }

    const welcome = this.welcomeFor(account).find((w) => w.id === workspaceId);
    if (!welcome) {
      throw new AuthError(403, 'not_welcome', 'That workspace is not open to your email address.');
    }
    if (welcome.joined) {
      return { status: 200, body: { ok: true, workspace: this.hub.publicView(workspaceId) } };
    }
    if (welcome.how === 'request') {
      this.hub.requestJoin(account.address, welcome.slug, str(body, 'message'));
      return { status: 200, body: { ok: true, requested: true, workspace: welcome } };
    }
    const joined = this.hub.joinByDomain(account.address, workspaceId, emailDomain(account.email));
    return { status: 200, body: { ok: true, workspace: this.hub.publicView(joined) } };
  }

  /** "Who else is on your team?" — the last step before you are in. */
  private invite(req: IncomingMessage, body: Record<string, unknown>): Handled {
    const token = tokenOf(req, body);
    const account = this.accounts.requireSession(token);
    const workspaceId = str(body, 'workspaceId');
    const raw = Array.isArray(body.emails) ? body.emails : [];
    const emails = [
      ...new Set(
        raw
          .filter((e): e is string => typeof e === 'string')
          .map((e) => normalizeEmail(e))
          .filter((e) => isEmail(e) && e !== account.emailKey),
      ),
    ].slice(0, 50);

    const role: WorkspaceRole = body.role === 'guest' ? 'guest' : 'member';
    const invited: { email: string; code: string }[] = [];
    const failed: { email: string; error: string }[] = [];

    for (const email of emails) {
      try {
        const invite = this.hub.createInvite(account.address, workspaceId, {
          invitedEmail: email,
          role,
          expiresInHours: 24 * 14,
          maxUses: 1,
        });
        invited.push({ email, code: invite.code });
        void this.accounts.mailer.send({
          to: email,
          subject: `${account.displayName} invited you to ${invite.workspaceName}`,
          text: [
            `${account.displayName} (${account.email}) has invited you to join`,
            `"${invite.workspaceName}" on ${this.options.relayName}.`,
            '',
            `Your invitation code is ${invite.code}.`,
            '',
            'Open Stead, sign in with this email address, and paste the code in.',
          ].join('\n'),
        });
      } catch (err) {
        failed.push({ email, error: (err as Error).message });
      }
    }

    return { status: 200, body: { ok: true, invited, failed } };
  }

  private login(body: Record<string, unknown>): Handled {
    const { account, session } = this.accounts.login(str(body, 'email'), str(body, 'password'));
    return {
      status: 200,
      body: {
        ok: true,
        token: session.token,
        account: this.accounts.view(account),
        workspaces: this.welcomeFor(account),
        invitations: this.invitationsFor(account),
      },
    };
  }

  private session(req: IncomingMessage, body: Record<string, unknown>): Handled {
    const account = this.accounts.requireSession(tokenOf(req, body));
    return {
      status: 200,
      body: {
        ok: true,
        account: this.accounts.view(account),
        workspaces: this.welcomeFor(account),
        invitations: this.invitationsFor(account),
      },
    };
  }

  private logout(req: IncomingMessage, body: Record<string, unknown>): Handled {
    const token = tokenOf(req, body);
    if (token) this.accounts.logout(token);
    return { status: 200, body: { ok: true } };
  }

  // -------------------------------------------------------------------------

  /**
   * The relay knows this address belongs to a real, verified person before any
   * socket opens, so the profile the socket later presents can be checked
   * against it rather than believed.
   */
  private registerIdentity(account: Account): void {
    this.hub.registerAccount(account.address, account.displayName, account.email);
  }

  /** Workspaces this email is already welcome in, and on what terms. */
  private welcomeFor(account: Account) {
    return this.hub.workspacesForEmail(account.address, emailDomain(account.email));
  }

  /** Invitations sent to this email address, waiting to be redeemed. */
  private invitationsFor(account: Account) {
    return this.hub.invitationsForEmail(account.emailKey).map((invite) => ({
      code: invite.code,
      workspaceId: invite.workspaceId,
      workspaceName: invite.workspaceName,
      role: invite.role,
      invitedBy: invite.createdBy as AgentAddress,
      expiresAt: invite.expiresAt,
    }));
  }
}
