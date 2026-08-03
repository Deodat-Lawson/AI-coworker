/**
 * The live brain: Google Gemini via the Generative Language REST API.
 *
 * No SDK — the surface we need (structured output + function calling) is small
 * and stable, and a plain `fetch` keeps the Electron bundle light.
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

export const DEFAULT_MODEL = 'gemini-flash-latest';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// --- wire types --------------------------------------------------------------

interface GeminiPart {
  text?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; id?: string; response: Record<string, unknown> };
  thoughtSignature?: string;
}

interface GeminiContent {
  role?: 'user' | 'model';
  parts: GeminiPart[];
}

interface GeminiResponse {
  candidates?: {
    content?: GeminiContent;
    finishReason?: string;
    index?: number;
  }[];
  promptFeedback?: { blockReason?: string };
  error?: { code?: number; message?: string; status?: string };
  usageMetadata?: Record<string, unknown>;
}

interface GenerateRequest {
  systemInstruction?: { parts: { text: string }[] };
  contents: GeminiContent[];
  tools?: { functionDeclarations: unknown[] }[];
  generationConfig?: Record<string, unknown>;
}

/**
 * Convert a standard JSON Schema to the OpenAPI-flavoured subset Gemini wants:
 * uppercase type names, no `additionalProperties`, explicit property ordering.
 * Authoring in plain JSON Schema keeps the tool specs readable and reusable.
 */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const input = schema as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(input)) {
    switch (key) {
      case 'type': {
        const name = String(value).toLowerCase();
        const mapped: Record<string, string> = {
          string: 'STRING',
          integer: 'INTEGER',
          number: 'NUMBER',
          boolean: 'BOOLEAN',
          array: 'ARRAY',
          object: 'OBJECT',
          null: 'STRING',
        };
        out.type = mapped[name] ?? 'STRING';
        break;
      }
      case 'properties': {
        const properties = value as Record<string, unknown>;
        out.properties = Object.fromEntries(
          Object.entries(properties).map(([k, v]) => [k, toGeminiSchema(v)]),
        );
        // Ordering measurably improves field quality on structured output.
        out.propertyOrdering = Object.keys(properties);
        break;
      }
      case 'items':
        out.items = toGeminiSchema(value);
        break;
      case 'additionalProperties':
      case '$schema':
      case 'strict':
      case 'default':
        break; // unsupported by Gemini; dropping is safe
      default:
        out[key] = value;
    }
  }
  return out;
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

/** Pull Google's suggested wait out of a 429 body (`RetryInfo.retryDelay`, e.g. "51s"). */
export function parseRetryDelayMs(body: string): number | null {
  const structured = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (structured) return Math.ceil(Number(structured[1]) * 1000);
  const seconds = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(body);
  if (seconds) return Math.ceil(Number(seconds[1]) * 1000);
  return null;
}

/** Turn a raw API failure into something worth showing a human. */
export function describeGeminiError(err: unknown): string {
  const message = (err as Error)?.message ?? String(err);
  if (/\b429\b/.test(message) || /quota|rate limit/i.test(message)) {
    return 'the Gemini rate limit was exhausted';
  }
  if (/\b40[13]\b/.test(message)) return 'the Gemini API key was rejected';
  if (/timed out/i.test(message)) return 'the Gemini request timed out';
  const firstLine = message.split('\n')[0]!;
  return firstLine.length > 140 ? `${firstLine.slice(0, 137)}…` : firstLine;
}

export interface GeminiProviderOptions {
  apiKey: string;
  model?: string;
  maxToolIterations?: number;
  /** Wall-clock cap for a single request. */
  timeoutMs?: number;
  maxRetries?: number;
  /**
   * Extra retries reserved for 429s, which on the free tier are a normal part of
   * operation rather than a failure. Each waits the delay Google asks for.
   */
  maxRateLimitRetries?: number;
  /** Minimum spacing between requests from this process. */
  minIntervalMs?: number;
  /** Cap on how long a single rate-limit wait may be. */
  maxRateLimitWaitMs?: number;
  onRateLimit?: (waitMs: number, attempt: number) => void;
}

export class GeminiProvider implements LLMProvider {
  readonly name: string;
  readonly live = true;
  private apiKey: string;
  private model: string;
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

  constructor(options: GeminiProviderOptions) {
    if (!options.apiKey) throw new Error('GeminiProvider requires an API key.');
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_MODEL;
    this.maxToolIterations = options.maxToolIterations ?? 8;
    this.timeoutMs = options.timeoutMs ?? 90_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 6;
    this.minIntervalMs = options.minIntervalMs ?? Number(process.env.GEMINI_MIN_INTERVAL_MS ?? 0);
    this.maxRateLimitWaitMs = options.maxRateLimitWaitMs ?? 90_000;
    this.onRateLimit = options.onRateLimit;
    this.name = `gemini:${this.model}`;
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Run `work` after the previous request finished and the pacing gap elapsed. */
  private schedule<T>(work: () => Promise<T>): Promise<T> {
    const run = this.gate.then(async () => {
      const gap = this.minIntervalMs - (Date.now() - this.lastRequestAt);
      if (gap > 0) await GeminiProvider.sleep(gap);
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

  private call(body: GenerateRequest): Promise<GeminiResponse> {
    return this.schedule(() => this.callOnce(body));
  }

  private async callOnce(body: GenerateRequest): Promise<GeminiResponse> {
    let lastError: Error | null = null;
    let transientAttempts = 0;
    let rateLimitAttempts = 0;

    for (;;) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await fetch(`${API_BASE}/${this.model}:generateContent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-goog-api-key': this.apiKey,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.status === 429) {
          const text = await response.text();
          const error = new Error(`Gemini 429: ${text.slice(0, 300)}`);
          if (rateLimitAttempts >= this.maxRateLimitRetries) throw error;
          // Free-tier quotas are per-minute; Google tells us exactly how long to
          // wait, so honour that rather than guessing with exponential backoff.
          const suggested = parseRetryDelayMs(text);
          const wait = Math.min(
            this.maxRateLimitWaitMs,
            suggested ?? Math.min(60_000, 5_000 * 2 ** rateLimitAttempts),
          );
          rateLimitAttempts++;
          this.onRateLimit?.(wait, rateLimitAttempts);
          lastError = error;
          clearTimeout(timer);
          await GeminiProvider.sleep(wait);
          continue;
        }

        if (!response.ok) {
          const text = await response.text();
          const error = new Error(`Gemini ${response.status}: ${text.slice(0, 300)}`);
          if (response.status < 500 || transientAttempts >= this.maxRetries) throw error;
          transientAttempts++;
          lastError = error;
          clearTimeout(timer);
          await GeminiProvider.sleep(700 * 2 ** transientAttempts);
          continue;
        }

        const json = (await response.json()) as GeminiResponse;
        if (json.error) throw new Error(`Gemini: ${json.error.message ?? json.error.status}`);
        return json;
      } catch (err) {
        const error = err as Error;
        const isAbort = error.name === 'AbortError';
        // A thrown 429/4xx from above must not be retried again here.
        if (!isAbort && !/^Gemini \d/.test(error.message)) {
          if (transientAttempts < this.maxRetries) {
            transientAttempts++;
            lastError = error;
            await GeminiProvider.sleep(700 * 2 ** transientAttempts);
            continue;
          }
        } else if (isAbort) {
          lastError = new Error(`Gemini request timed out after ${this.timeoutMs}ms`);
          if (transientAttempts < this.maxRetries) {
            transientAttempts++;
            await GeminiProvider.sleep(700 * 2 ** transientAttempts);
            continue;
          }
        }
        throw lastError && !/^Gemini \d/.test(error.message) ? lastError : error;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private static textOf(response: GeminiResponse): string {
    const candidate = response.candidates?.[0];
    if (!candidate) {
      const blocked = response.promptFeedback?.blockReason;
      throw new Error(blocked ? `Gemini blocked the prompt (${blocked}).` : 'Gemini returned no candidates.');
    }
    if (candidate.finishReason === 'MAX_TOKENS') {
      throw new Error('Gemini hit the output limit before finishing — the response was truncated.');
    }
    if (candidate.finishReason && !['STOP', 'MAX_TOKENS'].includes(candidate.finishReason)) {
      throw new Error(`Gemini stopped early (${candidate.finishReason}).`);
    }
    const text = (candidate.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) throw new Error('Gemini returned an empty response.');
    return text;
  }

  private async structured<T>(args: {
    system: string;
    user: string;
    schema: unknown;
    maxOutputTokens?: number;
  }): Promise<T> {
    const response = await this.call({
      systemInstruction: { parts: [{ text: args.system }] },
      contents: [{ role: 'user', parts: [{ text: args.user }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: toGeminiSchema(args.schema),
        maxOutputTokens: args.maxOutputTokens ?? 16_384,
      },
    });

    const text = GeminiProvider.textOf(response);
    try {
      return JSON.parse(text) as T;
    } catch {
      // Structured output should never need this, but a stray code fence is
      // cheaper to strip than to fail a whole meeting turn over.
      const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
      if (fenced) return JSON.parse(fenced[1]!) as T;
      throw new Error(`Gemini returned unparseable JSON: ${text.slice(0, 200)}`);
    }
  }

  async meetingTurn(input: MeetingTurnInput): Promise<MeetingTurnOutput> {
    const raw = await this.structured<RawTurn>({
      system: meetingSystemPrompt(input),
      user: meetingTurnPrompt(input),
      schema: TURN_SCHEMA,
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

  async chat(input: ChatInput, tools: ToolSpec[], exec: ToolExecutor): Promise<ChatOutput> {
    const actions: ChatOutput['actions'] = [];

    const contents: GeminiContent[] = [
      ...input.history.map(
        (m): GeminiContent => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }),
      ),
      { role: 'user', parts: [{ text: input.message }] },
    ];

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

    const systemInstruction = {
      parts: [{ text: `${chatSystemPrompt(input.self, input.now)}\n\n${context}` }],
    };

    const functionDeclarations = tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: toGeminiSchema(t.input_schema),
    }));

    for (let i = 0; i < this.maxToolIterations; i++) {
      const response = await this.call({
        systemInstruction,
        contents,
        tools: [{ functionDeclarations }],
        generationConfig: { maxOutputTokens: 8192 },
      });

      const candidate = response.candidates?.[0];
      if (!candidate?.content) {
        const blocked = response.promptFeedback?.blockReason;
        return {
          reply: blocked ? `I can't help with that one (${blocked}).` : "I didn't get a response back.",
          actions,
        };
      }

      // Append the model turn verbatim: Gemini 3 requires thought signatures to
      // survive the round trip, and they ride along on the parts.
      contents.push({ role: 'model', parts: candidate.content.parts ?? [] });

      const calls = (candidate.content.parts ?? []).filter(
        (p): p is GeminiPart & { functionCall: NonNullable<GeminiPart['functionCall']> } =>
          Boolean(p.functionCall),
      );

      if (calls.length === 0) {
        const reply = (candidate.content.parts ?? [])
          .map((p) => p.text ?? '')
          .join('')
          .trim();
        return { reply: reply || 'Done.', actions };
      }

      const responseParts: GeminiPart[] = [];
      for (const part of calls) {
        const call = part.functionCall;
        const args = (call.args ?? {}) as Record<string, unknown>;
        let result: string;
        try {
          result = await exec(call.name, args);
        } catch (err) {
          result = `Error: ${(err as Error).message}`;
        }
        actions.push({ tool: call.name, input: args, result });
        responseParts.push({
          functionResponse: {
            name: call.name,
            ...(call.id ? { id: call.id } : {}),
            response: { result },
          },
        });
      }
      contents.push({ role: 'user', parts: responseParts });
    }

    return {
      reply: 'I ran out of steps working on that. Tell me which part to focus on.',
      actions,
    };
  }
}
