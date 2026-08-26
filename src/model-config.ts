export interface ModelOverride {
  exclude?: string[]
  add?: string[]
  disableEffort?: boolean
  maxTokens?: number
  adaptiveThinking?: boolean
}

export interface ModelConfig {
  ccVersion: string
  ccVersionSuffix: string
  baseBetas: string[]
  longContextBetas: string[]
  modelOverrides: Record<string, ModelOverride>
}

export const config: ModelConfig = {
  ccVersion: "2.1.234",
  ccVersionSuffix: "1a0",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "thinking-token-count-2026-05-13",
    "context-management-2025-06-27",
    "prompt-caching-scope-2026-01-05",
    "mid-conversation-system-2026-04-07",
    "advisor-tool-2026-03-01",
    "effort-2025-11-24",
    "fallback-credit-2026-06-01",
    "extended-cache-ttl-2025-04-11",
  ],
  longContextBetas: [
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
  ],
  modelOverrides: {
    "opus-5": {
      maxTokens: 64_000,
      adaptiveThinking: true,
    },
    "sonnet-4-5": {
      exclude: ["effort-2025-11-24"],
    },
    haiku: {
      exclude: ["effort-2025-11-24"],
      disableEffort: true,
    },
    "4-6": {
      add: ["effort-2025-11-24"],
    },
    "4-7": {
      add: ["effort-2025-11-24"],
    },
  },
}

/**
 * Find the override entry matching a model ID.
 * Keys are matched via includes() against the lowercased model ID.
 *
 * First-match-wins: if multiple keys match, only the first (by insertion
 * order) is returned. List more specific keys before broader ones
 * (e.g. "opus-4-6" before "opus") so they take priority.
 */
export function getModelOverride(modelId: string): ModelOverride | null {
  const lower = modelId.toLowerCase()
  for (const [pattern, override] of Object.entries(config.modelOverrides)) {
    if (lower.includes(pattern)) return override
  }
  return null
}
