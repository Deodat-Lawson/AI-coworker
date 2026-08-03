import { GeminiProvider, type GeminiProviderOptions } from './gemini.js';
import { MockProvider } from './mock.js';
import type { LLMProvider } from './types.js';

export * from './types.js';
export {
  GeminiProvider,
  DEFAULT_MODEL,
  toGeminiSchema,
  describeGeminiError,
  parseRetryDelayMs,
} from './gemini.js';
export { MockProvider } from './mock.js';
export { renderDigest } from './prompt.js';

export interface ProviderChoice {
  provider: LLMProvider;
  /** Why this provider was selected — surfaced in the UI so the state is never a mystery. */
  reason: string;
}

export function resolveApiKey(explicit?: string): string | undefined {
  return (
    explicit ||
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    process.env.GOOGLE_GENAI_API_KEY ||
    undefined
  );
}

/**
 * Live Gemini when a key is available, deterministic offline brain otherwise.
 * `AI_COWORKER_OFFLINE=1` forces offline (used by tests).
 */
export function createProvider(options: Partial<GeminiProviderOptions> = {}): ProviderChoice {
  if (process.env.AI_COWORKER_OFFLINE === '1') {
    return { provider: new MockProvider(), reason: 'AI_COWORKER_OFFLINE=1' };
  }
  const apiKey = resolveApiKey(options.apiKey);
  if (!apiKey) {
    return {
      provider: new MockProvider(),
      reason: 'no Gemini API key found — running the offline brain',
    };
  }
  const model = options.model ?? process.env.GEMINI_MODEL;
  return {
    provider: new GeminiProvider({ ...options, apiKey, model }),
    reason: 'using Gemini',
  };
}
