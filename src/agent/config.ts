import { z } from "zod";
import { providerError } from "./provider-error.ts";

export const defaultGeminiModel = "gemini-3.5-flash-lite";
const integer = (fallback: number, max: number) => z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(max)).prefault(String(fallback));
const schema = z.object({ provider: z.literal("gemini").default("gemini"), apiKey: z.string().trim().min(1),
  model: z.string().regex(/^gemini-[a-z0-9.-]+$/).default(defaultGeminiModel),
  maxIterations: integer(10, 25), maxToolCalls: integer(20, 100), maxTokens: integer(20_000, 1_000_000),
  timeoutMs: integer(15_000, 60_000) });

export function loadGeminiConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = schema.safeParse({ provider: env.AGENT_PROVIDER, apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL,
    maxIterations: env.AGENT_MAX_ITERATIONS, maxToolCalls: env.AGENT_MAX_TOOL_CALLS,
    maxTokens: env.AGENT_MAX_TOKENS, timeoutMs: env.AGENT_PROVIDER_TIMEOUT_MS });
  if (!parsed.success) throw providerError("configuration");
  return parsed.data;
}
