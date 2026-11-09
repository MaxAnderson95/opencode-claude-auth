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
  ccVersion: "2.1.321",
  ccVersionSuffix: "cf7",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    "advanced-tool-use-2025-11-20",
    "effort-2025-11-24",
    "thinking-display-updates-2026-08-18",
    "extended-cache-ttl-2025-04-11",
  ],
  longContextBetas: [
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
  ],
  modelOverrides: {
    "fable-5": {
      add: [
        "per-turn-control-2026-07-01",
        "mid-conversation-tool-changes-2026-07-01",
        "inline-tools-2026-09-15",
        "fallback-credit-2026-06-01",
      ],
      maxTokens: 128_000,
      adaptiveThinking: true,
    },
    "opus-5-5": {
      add: [
        "per-turn-control-2026-07-01",
        "mid-conversation-tool-changes-2026-07-01",
        "inline-tools-2026-09-15",
        "fallback-credit-2026-06-01",
      ],
      maxTokens: 128_000,
      adaptiveThinking: true,
    },
    "opus-5": {
      add: [
        "mid-conversation-tool-changes-2026-07-01",
        "inline-tools-2026-09-15",
        "fallback-credit-2026-06-01",
      ],
      maxTokens: 64_000,
      adaptiveThinking: true,
    },
    "haiku-5": {
      add: [
        "per-turn-control-2026-07-01",
        "mid-conversation-tool-changes-2026-07-01",
        "inline-tools-2026-09-15",
      ],
      maxTokens: 128_000,
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
