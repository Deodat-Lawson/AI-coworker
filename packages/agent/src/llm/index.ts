import { MetaProvider, type MetaProviderOptions } from './meta.js';
import { MockProvider } from './mock.js';
import type { LLMProvider } from './types.js';

export * from './types.js';
export {
  MetaProvider,
  DEFAULT_MODEL,
  DEFAULT_API_BASE,
  toMetaSchema,
  describeMetaError,
  parseRetryDelayMs,
  parseRetryAfterHeader,
} from './meta.js';
export { MockProvider } from './mock.js';
export { renderDigest } from './prompt.js';

export interface ProviderChoice {
  provider: LLMProvider;
  /** Why this provider was selected — surfaced in the UI so the state is never a mystery. */
  reason: string;
}

export function resolveApiKey(explicit?: string): string | undefined {
  return explicit || process.env.META_API_KEY || process.env.LLAMA_API_KEY || undefined;
}

/**
 * Live Meta when a key is available, deterministic offline brain otherwise.
 * `AI_COWORKER_OFFLINE=1` forces offline (used by tests).
 */
export function createProvider(options: Partial<MetaProviderOptions> = {}): ProviderChoice {
  if (process.env.AI_COWORKER_OFFLINE === '1') {
    return { provider: new MockProvider(), reason: 'AI_COWORKER_OFFLINE=1' };
  }
  const apiKey = resolveApiKey(options.apiKey);
  if (!apiKey) {
    return {
      provider: new MockProvider(),
      reason: 'no Meta API key found — running the offline brain',
    };
  }
  const model = options.model ?? process.env.META_MODEL;
  return {
    provider: new MetaProvider({ ...options, apiKey, model }),
    reason: 'using Meta',
  };
}
