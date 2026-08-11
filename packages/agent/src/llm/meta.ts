/**
 * The live brain: Meta's model API (`https://api.meta.ai/v1`).
 *
 * No SDK — the surface we need (structured output + function calling) is small
 * and stable, and a plain `fetch` keeps the Electron bundle light.
 *
 * The wire format is the OpenAI chat-completions shape: a flat `messages` array,
 * `tools` as function declarations, `tool_calls` on the assistant turn, and
 * results fed back as `role: 'tool'` messages.
 */

import {
  chatSystemPrompt,
  meetingSystemPrompt,
  meetingTurnPrompt,
  postMeetingPrompt,
  postMeetingSystemPrompt,
} from './prompt.js';
import {
  type ChatInput,
  type ChatOutput,
  type LLMProvider,
  type MeetingTurnInput,
  type MeetingTurnOutput,
  type PostMeetingInput,
  type PostMeetingOutput,
  type ToolExecutor,
  type ToolSpec,
  emptyTurnOutput,
} from './types.js';

export const DEFAULT_MODEL = 'muse-spark-1.2';
export const DEFAULT_API_BASE = 'https://api.meta.ai/v1';

// --- wire types --------------------------------------------------------------

interface MetaToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface MetaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: MetaToolCall[];
  tool_call_id?: string;
  refusal?: string | null;
}

interface MetaResponse {
  choices?: {
    index?: number;
    message?: MetaMessage;
    finish_reason?: string;
  }[];
  error?: { message?: string; type?: string; code?: string };
  usage?: Record<string, unknown>;
}

interface ChatRequest {
  model?: string;
  messages: MetaMessage[];
  tools?: { type: 'function'; function: { name: string; description: string; parameters: unknown } }[];
  response_format?: {
    type: 'json_schema';
    json_schema: { name: string; strict?: boolean; schema: unknown };
  };
  max_completion_tokens?: number;
}

/**
 * Sanitize a JSON Schema for the API. Meta takes standard JSON Schema, so unlike
 * the OpenAPI dialect this only has to drop the keywords the endpoint rejects.
 *
 * `strict` additionally seals every object — `additionalProperties: false` and
 * every property listed in `required` — which is what strict structured output
 * demands. Tool parameters are converted *without* it: their optional arguments
 * are genuinely optional, and forcing them into `required` would make the model
 * invent values for fields the caller meant to leave out.
 */
export function toMetaSchema(schema: unknown, options: { strict?: boolean } = {}): unknown {
  const strict = options.strict ?? false;
  const convert = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(convert);
    if (!node || typeof node !== 'object') return node;

    const input = node as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(input)) {
      switch (key) {
        case 'properties': {
          const properties = value as Record<string, unknown>;
          out.properties = Object.fromEntries(
            Object.entries(properties).map(([k, v]) => [k, convert(v)]),
          );
          break;
        }
        case 'items':
          out.items = convert(value);
          break;
        case '$schema':
        case 'strict':
        // An OpenAPI-dialect ordering hint; this endpoint rejects it as unknown.
        case 'propertyOrdering':
          break;
        default:
          out[key] = value;
      }
    }

    if (strict && out.type === 'object') {
      out.additionalProperties = false;
      out.required = Object.keys((out.properties as Record<string, unknown>) ?? {});
    }
    return out;
  };
  return convert(schema);
}

// --- schemas -----------------------------------------------------------------

const TURN_SCHEMA = {
  type: 'object',
  properties: {
    speech: { type: 'string', description: 'What you say out loud this turn. Two to five sentences.' },
    show_artifact_ids: {
      type: 'array',
      items: { type: 'string' },
      description: 'Artifact ids from the knowledge base to show the room. Empty if none.',
    },
    question: {
      type: 'object',
      description: 'A question for one other attendee. Leave "to" empty for no question.',
      properties: {
        to: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['to', 'text'],
    },
    assignments: {
      type: 'array',
      description: 'Work you are assigning as chair. Empty unless this is a decisions turn.',
      items: {
        type: 'object',
        properties: {
          assignee: { type: 'string' },
          title: { type: 'string' },
          detail: { type: 'string' },
          priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] },
          due_in_days: { type: 'integer' },
          acceptance_criteria: { type: 'array', items: { type: 'string' } },
          project_hint: { type: 'string' },
        },
        required: ['assignee', 'title', 'detail', 'priority', 'due_in_days', 'acceptance_criteria', 'project_hint'],
      },
    },
    commitments: {
      type: 'array',
      description: 'Your response to tasks assigned to you. Empty unless this is a commit turn.',
      items: {
        type: 'object',
        properties: {
          task_id: { type: 'string' },
          accepted: { type: 'boolean' },
          note: { type: 'string' },
          proposed_due_in_days: { type: 'integer', description: '0 keeps the assigned date.' },
        },
        required: ['task_id', 'accepted', 'note', 'proposed_due_in_days'],
      },
    },
    decisions: { type: 'array', items: { type: 'string' } },
    minutes: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        decisions: { type: 'array', items: { type: 'string' } },
        risks: { type: 'array', items: { type: 'string' } },
        follow_ups: { type: 'array', items: { type: 'string' } },
      },
      required: ['summary', 'decisions', 'risks', 'follow_ups'],
    },
    open_questions_for_human: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'speech',
    'show_artifact_ids',
    'question',
    'assignments',
    'commitments',
    'decisions',
    'minutes',
    'open_questions_for_human',
  ],
};

const BRIEFING_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One line: the single most important thing.' },
    summary: { type: 'string', description: 'A short paragraph. What happened and what changed.' },
    decisions: { type: 'array', items: { type: 'string' } },
    my_commitments: { type: 'array', items: { type: 'string' } },
    open_questions_for_human: { type: 'array', items: { type: 'string' } },
    notes_to_save: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          kind: {
            type: 'string',
            enum: ['update', 'decision', 'idea', 'blocker', 'meeting', 'reference'],
          },
          project_hint: { type: 'string' },
        },
        required: ['title', 'body', 'kind', 'project_hint'],
      },
    },
  },
  required: ['headline', 'summary', 'decisions', 'my_commitments', 'open_questions_for_human', 'notes_to_save'],
};

interface RawTurn {
  speech?: string;
  show_artifact_ids?: string[];
  question?: { to?: string; text?: string };
  assignments?: {
    assignee: string;
    title: string;
    detail: string;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    due_in_days?: number;
    acceptance_criteria?: string[];
    project_hint?: string;
  }[];
  commitments?: { task_id: string; accepted: boolean; note?: string; proposed_due_in_days?: number }[];
  decisions?: string[];
  minutes?: { summary?: string; decisions?: string[]; risks?: string[]; follow_ups?: string[] };
  open_questions_for_human?: string[];
}

interface RawBriefing {
  headline?: string;
  summary?: string;
  decisions?: string[];
  my_commitments?: string[];
  open_questions_for_human?: string[];
  notes_to_save?: { title: string; body: string; kind: string; project_hint?: string }[];
}

/**
 * Pull a suggested wait out of a 429. The `Retry-After` header is authoritative
 * when it is present; this covers the body, which is all we get otherwise.
 */
export function parseRetryDelayMs(body: string): number | null {
  const field = /"retry_?(?:after|delay)(?:_ms)?"\s*:\s*"?(\d+(?:\.\d+)?)(s)?"?/i.exec(body);
  if (field) {
    const value = Number(field[1]);
    // `retry_after_ms` is already milliseconds; everything else is seconds.
    const isMs = /_ms"/i.test(field[0]) && !field[2];
    return Math.ceil(isMs ? value : value * 1000);
  }
  const phrase = /retry (?:again )?in (\d+(?:\.\d+)?)\s*s/i.exec(body);
  if (phrase) return Math.ceil(Number(phrase[1]) * 1000);
  return null;
}

/** Read the standard `Retry-After` header: either seconds or an HTTP date. */
export function parseRetryAfterHeader(value: string | null, now: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

/** Turn a raw API failure into something worth showing a human. */
export function describeMetaError(err: unknown): string {
  const message = (err as Error)?.message ?? String(err);
  if (/\b429\b/.test(message) || /quota|rate limit/i.test(message)) {
    return 'the Meta rate limit was exhausted';
  }
  if (/\b40[13]\b/.test(message)) return 'the Meta API key was rejected';
  if (/timed out/i.test(message)) return 'the Meta request timed out';
  // 5xx is the model being briefly unavailable, and its body is a JSON blob.
  // Without this the raw blob ends up spoken aloud in a meeting transcript.
  if (/\b5\d\d\b/.test(message) || /overloaded|unavailable/i.test(message)) {
    return 'the model was briefly unavailable';
  }
  const firstLine = message.split('\n')[0]!;
  // Anything still unrecognised is an API string, not a sentence. Say the shape
  // of the problem rather than pasting it where a human has to read it.
  if (/^Meta\b/.test(firstLine) || /[{}"]/.test(firstLine)) return 'the model call failed';
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine;
}

export interface MetaProviderOptions {
  apiKey: string;
  model?: string;
  /** Override the API root, e.g. for a proxy. Defaults to `META_API_BASE` or Meta's. */
  apiBase?: string;
  maxToolIterations?: number;
  /** Wall-clock cap for a single request. */
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Extra retries reserved for 429s, which on a small key are a normal part of
   * operation rather than a failure. Each waits the delay the API asks for.
   */
  maxRateLimitRetries?: number;
  /** Minimum spacing between requests from this process. */
  minIntervalMs?: number;
  /** Cap on how long a single rate-limit wait may be. */
  maxRateLimitWaitMs?: number;
  onRateLimit?: (waitMs: number, attempt: number) => void;
}

export class MetaProvider implements LLMProvider {
  readonly name: string;
  readonly live = true;
  private apiKey: string;
  private model: string;
  private apiBase: string;
  private maxToolIterations: number;
  private timeoutMs: number;
  private maxRetries: number;
  private maxRateLimitRetries: number;
  private minIntervalMs: number;
  private maxRateLimitWaitMs: number;
  /** Public so the owning agent can surface waits in its activity log. */
  onRateLimit?: (waitMs: number, attempt: number) => void;
  /** Serializes requests from this process so pacing actually holds. */
  private gate: Promise<void> = Promise.resolve();
  private lastRequestAt = 0;

  constructor(options: MetaProviderOptions) {
    if (!options.apiKey) throw new Error('MetaProvider requires an API key.');
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.apiBase = (options.apiBase ?? process.env.META_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    this.maxToolIterations = options.maxToolIterations ?? 8;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    // A lost turn is expensive — it is a hole in a meeting transcript that
    // everyone else has to read around — and a 503 is the model being busy for
    // a second, not a real failure. Worth several more tries than a normal call.
    this.maxRetries = options.maxRetries ?? 4;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 6;
    this.minIntervalMs = options.minIntervalMs ?? Number(process.env.META_MIN_INTERVAL_MS ?? 0);
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 90_000;
    this.onRateLimit = options.onRateLimit;
    this.name = `meta:${this.model}`;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Run `work` after the previous request finished and the pacing gap elapsed. */
  private schedule<T>(work: () => Promise<T>): Promise<T> {
    const run = this.gate.then(async () => {
      const gap = this.minIntervalMs - (Date.now() - this.lastRequestAt);
      if (gap > 0) await MetaProvider.sleep(gap);
      try {
        return await work();
      } finally {
        this.lastRequestAt = Date.now();
      }
    });
    // Keep the chain alive even when a call rejects.
    this.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private call(body: ChatRequest): Promise<MetaResponse> {
    return this.schedule(() => this.callOnce({ model: this.model, ...body }));
  }

  /**
   * True when the model hit the token ceiling with nothing to show for it.
   *
   * Constrained decoding occasionally runs away padding a string or an array
   * until the cap, and the endpoint then returns an empty `content` because the
   * JSON never closed. It is rare, it is not a real overflow, and a plain retry
   * clears it — so it is handled here rather than surfacing as a failed turn.
   */
  private static isEmptyTruncation(response: MetaResponse): boolean {
    const choice = response.choices?.[0];
    if (choice?.finish_reason !== 'length') return false;
    const message = choice.message;
    return !message?.content?.trim() && !message?.tool_calls?.length;
  }

  private async callOnce(body: ChatRequest): Promise<MetaResponse> {
    let lastError: Error | null = null;
    let transientAttempts = 0;
    let rateLimitAttempts = 0;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(`${this.apiBase}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.status === 429) {
          const text = await response.text();
          const error = new Error(`Meta 429: ${text.slice(0, 300)}`);
          if (rateLimitAttempts >= this.maxRateLimitRetries) throw error;
          // The API tells us how long to wait, so honour that rather than
          // guessing with exponential backoff.
          const suggested =
            parseRetryAfterHeader(response.headers.get('retry-after')) ?? parseRetryDelayMs(text);
          const wait = Math.min(
            this.maxRateLimitWaitMs,
            suggested ?? Math.min(60_000, 5_000 * 2 ** rateLimitAttempts),
          );
          rateLimitAttempts++;
          this.onRateLimit?.(wait, rateLimitAttempts);
          lastError = error;
          clearTimeout(timer);
          await MetaProvider.sleep(wait);
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          const error = new Error(`Meta ${response.status}: ${text.slice(0, 300)}`);
          if (response.status < 500 || transientAttempts >= this.maxRetries) throw error;
          transientAttempts++;
          lastError = error;
          clearTimeout(timer);
          await MetaProvider.sleep(700 * 2 ** transientAttempts);
          continue;
        }

        const json = (await response.json()) as MetaResponse;
        if (json.error) throw new Error(`Meta: ${json.error.message ?? json.error.type}`);

        if (MetaProvider.isEmptyTruncation(json)) {
          const error = new Error('Meta returned an empty response at the token limit.');
          if (transientAttempts >= this.maxRetries) throw error;
          transientAttempts++;
          lastError = error;
          clearTimeout(timer);
          await MetaProvider.sleep(700 * 2 ** transientAttempts);
          continue;
        }
        return json;
      } catch (err) {
        const error = err as Error;
        const isAbort = error.name === 'AbortError';
        // A thrown 429/4xx from above must not be retried again here.
        if (!isAbort && !/^Meta \d/.test(error.message)) {
          if (transientAttempts < this.maxRetries) {
            transientAttempts++;
            lastError = error;
            await MetaProvider.sleep(700 * 2 ** transientAttempts);
            continue;
          }
        } else if (isAbort) {
          lastError = new Error(`Meta request timed out after ${this.timeoutMs}ms`);
          if (transientAttempts < this.maxRetries) {
            transientAttempts++;
            await MetaProvider.sleep(700 * 2 ** transientAttempts);
            continue;
          }
        }
        throw lastError && !/^Meta \d/.test(error.message) ? lastError : error;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private static textOf(response: MetaResponse): string {
    const choice = response.choices?.[0];
    if (!choice) throw new Error('Meta returned no choices.');
    if (choice.message?.refusal) {
      throw new Error(`Meta declined the prompt (${choice.message.refusal}).`);
    }
    if (choice.finish_reason === 'length') {
      throw new Error('Meta hit the output limit before finishing — the response was truncated.');
    }
    if (choice.finish_reason && !['stop', 'tool_calls'].includes(choice.finish_reason)) {
      throw new Error(`Meta stopped early (${choice.finish_reason}).`);
    }
    const text = (choice.message?.content ?? '').trim();
    if (!text) throw new Error('Meta returned an empty response.');
    return text;
  }

  private async structured<T>(args: {
    system: string;
    user: string;
    schema: unknown;
    name: string;
    maxOutputTokens?: number;
  }): Promise<T> {
    const response = await this.call({
      messages: [
        { role: 'system', content: args.system },
        { role: 'user', content: args.user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: args.name,
          strict: true,
          schema: toMetaSchema(args.schema, { strict: true }),
        },
      },
      // Reasoning tokens are billed against this ceiling and a turn spends most
      // of its budget there, so the headroom is deliberately wide.
      max_completion_tokens: args.maxOutputTokens ?? 32_768,
    });

    const text = MetaProvider.textOf(response);
    try {
      return JSON.parse(text) as T;
    } catch {
      // Structured output should never need this, but a stray code fence is
      // cheaper to strip than to fail a whole meeting turn over.
      const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
      if (fenced) return JSON.parse(fenced[1]!) as T;
      throw new Error(`Meta returned unparseable JSON: ${text.slice(0, 200)}`);
    }
  }

  async meetingTurn(input: MeetingTurnInput): Promise<MeetingTurnOutput> {
    const raw = await this.structured<RawTurn>({
      system: meetingSystemPrompt(input),
      user: meetingTurnPrompt(input),
      schema: TURN_SCHEMA,
      name: 'meeting_turn',
    });

    return {
      ...emptyTurnOutput(),
      speech: raw.speech ?? '',
      showArtifactIds: raw.show_artifact_ids ?? [],
      question: { to: raw.question?.to ?? '', text: raw.question?.text ?? '' },
      assignments: (raw.assignments ?? []).map((a) => ({
        assignee: a.assignee,
        title: a.title,
        detail: a.detail,
        priority: a.priority ?? 'normal',
        dueInDays: a.due_in_days ?? 7,
        acceptanceCriteria: a.acceptance_criteria ?? [],
        projectHint: a.project_hint ?? '',
      })),
      commitments: (raw.commitments ?? []).map((c) => ({
        taskId: c.task_id,
        accepted: c.accepted,
        note: c.note ?? '',
        proposedDueInDays: c.proposed_due_in_days ?? 0,
      })),
      decisions: raw.decisions ?? [],
      minutes: {
        summary: raw.minutes?.summary ?? '',
        decisions: raw.minutes?.decisions ?? [],
        risks: raw.minutes?.risks ?? [],
        followUps: raw.minutes?.follow_ups ?? [],
      },
      openQuestionsForHuman: raw.open_questions_for_human ?? [],
    };
  }

  async postMeeting(input: PostMeetingInput): Promise<PostMeetingOutput> {
    const raw = await this.structured<RawBriefing>({
      system: postMeetingSystemPrompt(input),
      user: postMeetingPrompt(input),
      schema: BRIEFING_SCHEMA,
      name: 'post_meeting_briefing',
    });
    return {
      headline: raw.headline ?? '',
      summary: raw.summary ?? '',
      decisions: raw.decisions ?? [],
      myCommitments: raw.my_commitments ?? [],
      openQuestionsForHuman: raw.open_questions_for_human ?? [],
      notesToSave: (raw.notes_to_save ?? []).map((n) => ({
        title: n.title,
        body: n.body,
        kind: (n.kind as PostMeetingOutput['notesToSave'][number]['kind']) ?? 'meeting',
        projectHint: n.project_hint ?? '',
      })),
    };
  }

  /** Tool arguments arrive as a JSON *string*; a malformed one is the model's fault, not the tool's. */
  private static parseToolArguments(raw: string | undefined): Record<string, unknown> {
    if (!raw?.trim()) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  async chat(input: ChatInput, tools: ToolSpec[], exec: ToolExecutor): Promise<ChatOutput> {
    const actions: ChatOutput['actions'] = [];

    const context = [
      "Current state of your human's world (already loaded — no need to look these up):",
      `Upcoming meetings: ${
        input.upcoming.length
          ? input.upcoming
              .map((m) => `"${m.title}" with ${m.participants.join(', ')} at ${new Date(m.start).toLocaleString()}`)
              .join('; ')
          : 'none'
      }`,
      `Projects: ${input.digest.projects.map((p) => p.name).join(', ') || 'none'}`,
      `Open tasks: ${input.digest.tasks.length}`,
      `People on the network: ${
        input.directory.map((d) => `${d.displayName} (${d.address}${d.title ? `, ${d.title}` : ''})`).join('; ') ||
        'nobody else is online'
      }`,
    ].join('\n');

    const messages: MetaMessage[] = [
      { role: 'system', content: `${chatSystemPrompt(input.self, input.now)}\n\n${context}` },
      ...input.history.map(
        (m): MetaMessage => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        }),
      ),
      { role: 'user', content: input.message },
    ];

    const functions = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: toMetaSchema(t.input_schema),
      },
    }));

    for (let i = 0; i < this.maxToolIterations; i++) {
      const response = await this.call({
        messages,
        tools: functions,
        max_completion_tokens: 16_384,
      });

      const choice = response.choices?.[0];
      const message = choice?.message;
      if (!message) return { reply: "I didn't get a response back.", actions };
      if (message.refusal) return { reply: `I can't help with that one (${message.refusal}).`, actions };

      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        return { reply: (message.content ?? '').trim() || 'Done.', actions };
      }

      // Append the assistant turn verbatim: the tool results that follow are
      // matched back to it by `tool_call_id`.
      messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls });

      for (const call of calls) {
        const args = MetaProvider.parseToolArguments(call.function?.arguments);
        let result: string;
        try {
          result = await exec(call.function.name, args);
        } catch (err) {
          result = `Error: ${(err as Error).message}`;
        }
        actions.push({ tool: call.function.name, input: args, result });
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }

    return {
      reply: 'I ran out of steps working on that. Tell me which part to focus on.',
      actions,
    };
  }
}
