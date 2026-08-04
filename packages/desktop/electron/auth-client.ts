/**
 * Talking to the relay's sign-in endpoints, from the main process.
 *
 * This lives here rather than in the renderer for two reasons. The renderer runs
 * under a content-security policy that only lets it fetch from itself, which is
 * exactly the property that makes an Electron app hard to turn into a
 * credential-stealing page — relaxing it so a signup form could work would be a
 * poor trade. And the session token belongs next to the knowledge base on disk,
 * which the renderer deliberately cannot touch.
 */

/** A relay's websocket url, as the app stores it, turned into an http origin. */
export function httpOriginFor(relayUrl: string): string {
  const trimmed = relayUrl.trim().replace(/\/+$/, '');
  if (trimmed.startsWith('wss://')) return `https://${trimmed.slice(6)}`;
  if (trimmed.startsWith('ws://')) return `http://${trimmed.slice(5)}`;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed;
  return `http://${trimmed}`;
}

export interface AuthAccount {
  id: string;
  email: string;
  displayName: string;
  address: string;
  hasPassword: boolean;
  createdAt: number;
}

export interface WelcomeWorkspace {
  id: string;
  slug: string;
  name: string;
  description: string;
  icon: string;
  color: string;
  memberCount: number;
  joined: boolean;
  how: 'open' | 'request';
}

export interface PendingInvitation {
  code: string;
  workspaceId: string;
  workspaceName: string;
  role: string;
  invitedBy: string;
  expiresAt: number;
}

/** A refusal from the relay, with the message meant for the person reading it. */
export class RelayAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RelayAuthError';
  }
}

async function call<T>(
  relayUrl: string,
  path: string,
  body?: Record<string, unknown>,
  token?: string,
): Promise<T> {
  const url = `${httpOriginFor(relayUrl)}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      // Long enough for a slow link, short enough that a wrong address does not
      // leave somebody staring at a spinner.
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    const reason = (err as Error).name === 'TimeoutError' ? 'did not answer' : 'could not be reached';
    throw new RelayAuthError('unreachable', `The relay at ${relayUrl} ${reason}.`);
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await response.json()) as Record<string, unknown>;
  } catch {
    throw new RelayAuthError(
      'bad_relay',
      `${relayUrl} answered, but not like a Stead relay. Check the address.`,
    );
  }
  if (!response.ok || payload.ok !== true) {
    throw new RelayAuthError(
      typeof payload.code === 'string' ? payload.code : 'error',
      typeof payload.error === 'string' ? payload.error : `The relay refused (${response.status}).`,
    );
  }
  return payload as T;
}

export const relayAuth = {
  config: (relayUrl: string) =>
    call<{ relayName: string; accounts: number; codesInResponse: boolean }>(
      relayUrl,
      '/auth/config',
    ),

  start: (relayUrl: string, email: string) =>
    call<{ email: string; expiresAt: number; devCode?: string }>(relayUrl, '/auth/start', { email }),

  verify: (relayUrl: string, email: string, code: string) =>
    call<{
      token: string;
      account: AuthAccount;
      created: boolean;
      needsProfile: boolean;
      workspaces: WelcomeWorkspace[];
      invitations: PendingInvitation[];
    }>(relayUrl, '/auth/verify', { email, code }),

  login: (relayUrl: string, email: string, password: string) =>
    call<{
      token: string;
      account: AuthAccount;
      workspaces: WelcomeWorkspace[];
      invitations: PendingInvitation[];
    }>(relayUrl, '/auth/login', { email, password }),

  profile: (relayUrl: string, token: string, patch: { displayName?: string; password?: string }) =>
    call<{ account: AuthAccount }>(relayUrl, '/auth/profile', patch, token),

  createWorkspace: (
    relayUrl: string,
    token: string,
    input: { name: string; project?: string; description?: string; discoverable?: boolean },
  ) =>
    call<{
      workspace: { id: string; slug: string; name: string; icon: string; color: string };
      address: string;
      createdChannel: string;
    }>(relayUrl, '/auth/workspace', input, token),

  join: (relayUrl: string, token: string, input: { workspaceId?: string; code?: string; message?: string }) =>
    call<{
      workspace: { id: string; slug: string; name: string };
      requested?: boolean;
    }>(relayUrl, '/auth/join', input, token),

  invite: (relayUrl: string, token: string, workspaceId: string, emails: string[]) =>
    call<{ invited: { email: string; code: string }[]; failed: { email: string; error: string }[] }>(
      relayUrl,
      '/auth/invite',
      { workspaceId, emails },
      token,
    ),

  session: (relayUrl: string, token: string) =>
    call<{
      account: AuthAccount;
      workspaces: WelcomeWorkspace[];
      invitations: PendingInvitation[];
    }>(relayUrl, '/auth/session', {}, token),

  logout: (relayUrl: string, token: string) => call<unknown>(relayUrl, '/auth/logout', {}, token),
};
