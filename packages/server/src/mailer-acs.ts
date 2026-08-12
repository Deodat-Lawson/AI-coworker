/**
 * Real mail, via Azure Communication Services Email.
 *
 * This exists to close a specific hole. With `LogMailer` the confirmation code
 * comes back in the body of `POST /auth/start` — which is what makes a laptop
 * demo work without a mail server, and what makes a public relay an open door:
 * anyone who can reach it can ask for a code for any address and read it back.
 * The moment a real transport is configured, `startEmail` stops returning the
 * code and the only way to learn it is to own the mailbox.
 *
 * No SDK, on purpose: the surface is one POST, and the server package otherwise
 * depends on `ws` alone — which keeps the App Service deployment a few hundred
 * kilobytes instead of a few megabytes. The cost is doing the HMAC ourselves,
 * which is the function below and is worth reading once.
 */

import crypto from 'node:crypto';

import type { Mail, Mailer } from './accounts.js';

const API_VERSION = '2023-03-31';

export interface AcsCredentials {
  endpoint: string;
  accessKey: string;
}

/**
 * Split the connection string the portal hands out:
 * `endpoint=https://x.communication.azure.com/;accesskey=BASE64==`
 *
 * Case-insensitive on the keys, because the portal, the CLI and the docs do not
 * agree with each other about capitalisation.
 */
export function parseAcsConnectionString(value: string): AcsCredentials {
  const parts = new Map<string, string>();
  for (const segment of value.split(';')) {
    const at = segment.indexOf('=');
    if (at <= 0) continue;
    // The key is base64 and contains '=', so only the first separator counts.
    parts.set(segment.slice(0, at).trim().toLowerCase(), segment.slice(at + 1).trim());
  }
  const endpoint = parts.get('endpoint');
  const accessKey = parts.get('accesskey');
  if (!endpoint || !accessKey) {
    throw new Error('ACS connection string needs both endpoint= and accesskey=.');
  }
  return { endpoint: endpoint.replace(/\/+$/, ''), accessKey };
}

/**
 * Azure's shared-key scheme. The signature covers the verb, the path, the date,
 * the host and a hash of the body — so a captured request cannot be replayed
 * against a different route or with the payload swapped.
 *
 * Exported so a test can pin it against a known vector; the ordering of the
 * signed headers is part of the contract and easy to break by accident.
 */
export function signAcsRequest(args: {
  method: string;
  url: URL;
  body: string;
  accessKey: string;
  date: string;
}): { authorization: string; contentHash: string } {
  const contentHash = crypto.createHash('sha256').update(args.body, 'utf8').digest('base64');
  const pathAndQuery = `${args.url.pathname}${args.url.search}`;
  const stringToSign = [
    args.method.toUpperCase(),
    pathAndQuery,
    `${args.date};${args.url.host};${contentHash}`,
  ].join('\n');
  const signature = crypto
    .createHmac('sha256', Buffer.from(args.accessKey, 'base64'))
    .update(stringToSign, 'utf8')
    .digest('base64');
  return {
    contentHash,
    authorization: `HMAC-SHA256 SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${signature}`,
  };
}

export interface AcsMailerOptions {
  connectionString: string;
  /** The verified sender, e.g. `DoNotReply@<guid>.azurecomm.net`. */
  senderAddress: string;
  log?: (message: string) => void;
  /** Wall-clock cap for the send. */
  timeoutMs?: number;
}

export class AcsMailer implements Mailer {
  private readonly credentials: AcsCredentials;
  private readonly senderAddress: string;
  private readonly log: (message: string) => void;
  private readonly timeoutMs: number;

  constructor(options: AcsMailerOptions) {
    if (!options.senderAddress) throw new Error('AcsMailer requires a sender address.');
    this.credentials = parseAcsConnectionString(options.connectionString);
    this.senderAddress = options.senderAddress;
    this.log = options.log ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async send(mail: Mail): Promise<void> {
    const url = new URL(`${this.credentials.endpoint}/emails:send?api-version=${API_VERSION}`);
    const body = JSON.stringify({
      senderAddress: this.senderAddress,
      recipients: { to: [{ address: mail.to }] },
      content: { subject: mail.subject, plainText: mail.text },
    });
    const date = new Date().toUTCString();
    const { authorization, contentHash } = signAcsRequest({
      method: 'POST',
      url,
      body,
      accessKey: this.credentials.accessKey,
      date,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-ms-date': date,
          'x-ms-content-sha256': contentHash,
          Authorization: authorization,
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        // The address never goes in the message: this lands in a log the
        // operator reads, and the whole point is that only the mailbox owner
        // learns anything about a given address.
        throw new Error(`ACS send failed (${response.status}): ${text.slice(0, 200)}`);
      }
      // 202 with an Operation-Location; delivery is asynchronous from here, and
      // polling it would not change what we tell the caller either way.
      this.log(`mail accepted by ACS for delivery (${mail.subject})`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build the mailer the environment asks for. Returns undefined when ACS is not
 * configured, so the caller keeps its own default rather than guessing here.
 */
export function acsMailerFromEnv(log?: (message: string) => void): AcsMailer | undefined {
  const connectionString = process.env.ACS_CONNECTION_STRING;
  const senderAddress = process.env.ACS_SENDER_ADDRESS;
  if (!connectionString || !senderAddress) return undefined;
  return new AcsMailer({ connectionString, senderAddress, log });
}
