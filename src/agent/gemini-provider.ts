import { randomUUID } from "node:crypto";
import { GoogleGenAI, FunctionCallingConfigMode, type GenerateContentParameters, type GenerateContentResponse } from "@google/genai";
import { z } from "zod";
import { providerResponseSchema, type Provider } from "./provider.ts";
import { providerError, providerErrorMessage, type ProviderErrorCode } from "./provider-error.ts";
import { geminiHistory, type SavedResponse } from "./gemini-history.ts";
import { geminiDeclarations } from "./gemini-schema.ts";
import { taskInstruction } from "./task.ts";

export type GeminiMetric = { session_id: string; model: string; request_number: number; api_calls: number; duration_ms: number; ok: boolean;
  input_tokens: number | null; output_tokens: number | null; total_tokens: number | null; thinking_tokens: number | null;
  cached_tokens: number | null; context_characters: number; context_messages: number; tool_schema_characters: number; error_code: ProviderErrorCode | null };
type Generate = (params: GenerateContentParameters) => Promise<GenerateContentResponse>;
type Options = { apiKey: string; model: string; timeoutMs?: number; generate?: Generate; onMetric?: (metric: GeminiMetric) => Promise<void> | void };

function errorCode(error: unknown, aborted: boolean): ProviderErrorCode {
  if (aborted) return "timeout";
  if (error && typeof error === "object") {
    if (providerErrorMessage(error) && "providerCode" in error) return error.providerCode as ProviderErrorCode;
    if ("name" in error && error.name === "AbortError") return "timeout";
    const code = "status" in error ? error.status : undefined;
    if (code === 401 || code === 403) return "authentication";
    if (code === 404) return "model";
    if (code === 429) return "quota";
    if (typeof code === "number" && code >= 500) return "temporary";
    // No se conserva ni devuelve el mensaje de API: puede contener la clave o el request.
    if (code === 400 && "message" in error && typeof error.message === "string" && /API_KEY_INVALID|API key not valid/i.test(error.message)) return "authentication";
  }
  return "unexpected";
}
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
function reportedUsage(metric: GeminiMetric) {
  const fields = { input_tokens: metric.input_tokens, output_tokens: metric.output_tokens,
    total_tokens: metric.total_tokens, thinking_tokens: metric.thinking_tokens };
  const known = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));
  return Object.keys(known).length ? known : undefined;
}

export function createGeminiProvider(options: Options): Provider {
  if (!options.apiKey?.trim() || !/^gemini-[a-z0-9.-]+$/.test(options.model)) throw providerError("configuration");
  // Nunca se usa AFC: el SDK solo propone llamadas; runner/tool-executor son los ejecutores.
  const client = options.generate ? undefined : new GoogleGenAI({ apiKey: options.apiKey, httpOptions: { retryOptions: { attempts: 1 }, timeout: options.timeoutMs ?? 15_000 } });
  const generate: Generate = options.generate ?? ((params) => client!.models.generateContent(params));
  const sessions = new Map<string, { saved: Map<string, SavedResponse>; requests: number }>();
  return { toolTransport: "references", async send(request) {
    let state = sessions.get(request.sessionId);
    if (!state) { state = { saved: new Map(), requests: 0 }; sessions.set(request.sessionId, state); }
    const start = performance.now();
    const metric: GeminiMetric = { session_id: request.sessionId, model: options.model, request_number: ++state.requests,
      api_calls: 0, duration_ms: 0, ok: false, input_tokens: null, output_tokens: null, total_tokens: null, thinking_tokens: null,
      cached_tokens: null, context_characters: 0, context_messages: 0, tool_schema_characters: 0, error_code: null };
    let response: z.infer<typeof providerResponseSchema> | undefined;
    try {
      const history = geminiHistory(request.messages, state.saved);
      const declarations = geminiDeclarations(request.tools, "references");
      metric.context_messages = history.contents.length;
      metric.tool_schema_characters = JSON.stringify(declarations).length;
      const systemInstruction = request.task ? `${history.systemInstruction}\n\n${taskInstruction(request.task)}` : history.systemInstruction;
      metric.context_characters = JSON.stringify({ ...history, systemInstruction }).length;
      const params: GenerateContentParameters = { model: options.model, contents: history.contents,
        config: { systemInstruction, candidateCount: 1, maxOutputTokens: Math.min(request.maxOutputTokens, 8192),
          abortSignal: request.signal, httpOptions: { retryOptions: { attempts: 1 }, timeout: options.timeoutMs ?? 15_000 },
          automaticFunctionCalling: { disable: true }, automaticContinuation: false,
          tools: [{ functionDeclarations: declarations }],
          toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } } } };
      if (request.signal.aborted) throw providerError("timeout");
      let abort!: () => void;
      const aborted = new Promise<never>((_, reject) => { abort = () => reject(providerError("timeout")); request.signal.addEventListener("abort", abort, { once: true }); });
      let raw: GenerateContentResponse;
      try { metric.api_calls = 1; raw = await Promise.race([generate(params), aborted]); }
      finally { request.signal.removeEventListener("abort", abort); }
      const usage = raw.usageMetadata;
      metric.input_tokens = count(usage?.promptTokenCount); metric.output_tokens = count(usage?.candidatesTokenCount);
      metric.total_tokens = count(usage?.totalTokenCount); metric.thinking_tokens = count(usage?.thoughtsTokenCount);
      metric.cached_tokens = count(usage?.cachedContentTokenCount);
      if (request.signal.aborted) throw providerError("timeout");
      if (raw.promptFeedback?.blockReason && raw.promptFeedback.blockReason !== "BLOCKED_REASON_UNSPECIFIED") throw providerError("blocked");
      if (raw.candidates?.length !== 1) throw providerError(raw.candidates?.length ? "incomplete" : "empty");
      const candidate = raw.candidates[0]!;
      if (["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY", "RECITATION"].includes(String(candidate.finishReason))) throw providerError("blocked");
      if (candidate.finishReason !== "STOP") throw providerError("incomplete");
      const content = candidate.content;
      if (content?.role !== "model" || !content.parts?.length) throw providerError("empty");
      const calls: SavedResponse["calls"] = [];
      const wireCalls: SavedResponse["wireCalls"] = new Map();
      const wireIds = new Set<string>();
      for (const part of content.parts) {
        if (!part.functionCall) continue;
        const wire = part.functionCall;
        const args = z.record(z.string(), z.unknown()).safeParse(wire.args ?? {});
        if (!wire.name || !args.success || wire.partialArgs?.length || wire.willContinue) throw providerError("invalid_call");
        const id = randomUUID();
        const serialized = JSON.stringify(args.data);
        if (serialized.includes(options.apiKey) || (wire.id && wireIds.has(wire.id))) throw providerError("invalid_call");
        if (wire.id) wireIds.add(wire.id);
        calls.push({ id, name: wire.name, arguments: serialized });
        wireCalls.set(id, structuredClone(wire));
      }
      const text = content.parts.filter((part) => !part.thought && !part.functionCall).map((part) => part.text ?? "").join("").trim().replaceAll(options.apiKey, "[REDACTADO]");
      if (!calls.length && !text) throw providerError("empty");
      const reference = randomUUID();
      const known = reportedUsage(metric);
      const reported = known ? { usage: known } : {};
      const parsed = providerResponseSchema.safeParse(calls.length
        ? { type: "tools", calls, provider_response_id: reference, ...reported }
        : { type: "final", text, provider_response_id: reference, ...reported });
      if (!parsed.success) throw providerError("invalid_call");
      state.saved.set(reference, { content: structuredClone(content), calls: structuredClone(calls), wireCalls });
      response = parsed.data; metric.ok = true;
    } catch (error) { metric.error_code = errorCode(error, request.signal.aborted); }
    metric.duration_ms = Math.round(performance.now() - start);
    try { await options.onMetric?.({ ...metric }); } catch { throw providerError("metrics", reportedUsage(metric)); }
    if (!response) throw providerError(metric.error_code ?? "unexpected", reportedUsage(metric));
    return response;
  } };
}
