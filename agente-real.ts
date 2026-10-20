import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { GoogleGenAI } from "@google/genai";
import { loadGeminiConfig } from "./src/agent/config.ts";
import { createGeminiProvider, type GeminiMetric } from "./src/agent/gemini-provider.ts";
import { providerError, providerErrorMessage } from "./src/agent/provider-error.ts";
import { createAgent } from "./src/agent/runner.ts";
import { recordToolEvent } from "./src/storage/persistence.ts";

async function main() {
  const config = loadGeminiConfig();
  if (process.argv.includes("--verificar-modelo")) {
    const sdk = new GoogleGenAI({ apiKey: config.apiKey, httpOptions: { timeout: config.timeoutMs, retryOptions: { attempts: 1 } } });
    try {
      const model = await sdk.models.get({ model: config.model });
      if (!model.supportedActions?.includes("generateContent")) throw providerError("model");
      console.log(`Modelo accesible con esta clave: ${config.model}; generateContent disponible. No se ejecutó ninguna inferencia.`);
    } catch { throw providerError("model"); }
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "periferia-gemini-"));
  await cp(fileURLToPath(new URL("./fixtures", import.meta.url)), join(directory, "fixtures"), { recursive: true });
  const metrics: GeminiMetric[] = [];
  const provider = createGeminiProvider({ apiKey: config.apiKey, model: config.model, timeoutMs: config.timeoutMs,
    async onMetric(metric) {
      metrics.push(metric);
      await recordToolEvent(directory, { ts: new Date().toISOString(), herramienta: "gemini_proveedor", mensaje_id: null,
        resumen: metric.error_code ?? "respuesta_recibida", ...metric });
    } });
  const agent = await createAgent({ directory, provider, limits: { maxIterations: config.maxIterations,
    maxToolCalls: config.maxToolCalls, maxTokens: config.maxTokens, providerTimeoutMs: config.timeoutMs } });
  const id = agent.createSession();
  const allowRegistration = process.argv.includes("--habilitar-registros");
  console.log(`Gemini: ${config.model}. Sesión: ${id}. Almacenamiento temporal: ${directory}`);
  console.log(`Registro contractual: ${allowRegistration ? "habilitado solo para operaciones elegibles/autorizadas" : "deshabilitado"}.`);
  console.log("Cada mensaje solicita inferencia al proveedor. Escribe salir o exit para terminar.");
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  process.stdout.write("Tú> ");
  for await (const line of terminal) {
    const text = line.trim();
    if (/^(salir|exit)$/i.test(text)) break;
    if (!text) { process.stdout.write("Tú> "); continue; }
    const start = performance.now(), firstMetric = metrics.length;
    const response = await agent.send(id, text, { allowRegistration });
    if (!response.ok) console.log(`Error: ${response.error}`);
    else {
      for (const event of response.data.events) if (event.type === "tool") console.log(`Herramienta: ${event.name}`);
      console.log(`Agente [${response.data.status}]: ${response.data.reply}`);
    }
    const current = metrics.slice(firstMetric);
    const sum = (field: "input_tokens" | "output_tokens" | "total_tokens" | "thinking_tokens" | "cached_tokens") => current.length && current.every((metric) => metric[field] !== null)
      ? current.reduce((total, metric) => total + metric[field]!, 0) : null;
    const providerErrors = current.flatMap((metric) => metric.error_code ? [metric.error_code] : []);
    const toolErrors = response.ok ? response.data.toolErrors : [];
    const agentErrors = !response.ok ? ["invalid_session_or_request"]
      : response.data.status === "error" ? ["agent_error"] : response.data.status === "limit" ? ["limit"]
      : response.data.status === "incomplete" ? ["incomplete_task"] : [];
    const turn = { session_id: id, model: config.model, duration_ms: Math.round(performance.now() - start),
      provider_calls: current.reduce((total, metric) => total + metric.api_calls, 0),
      input_tokens: sum("input_tokens"), output_tokens: sum("output_tokens"), total_tokens: sum("total_tokens"),
      thinking_tokens: sum("thinking_tokens"), cached_tokens: sum("cached_tokens"),
      turn_budget_tokens: response.ok ? response.data.turnTokens : null,
      session_tokens: response.ok ? response.data.tokens : null, session_token_limit: config.maxTokens,
      usage_complete: response.ok ? response.data.usageComplete : false,
      task: response.ok ? response.data.task : null,
      tools: response.ok ? response.data.events.filter((event) => event.type === "tool").map((event) => event.name) : [],
      provider_errors: providerErrors, tool_errors: toolErrors, agent_errors: agentErrors,
      errors: [...providerErrors, ...toolErrors.map((error) => `${error.name}: ${error.error}`), ...agentErrors],
      requests: current.map((metric) => ({ request_number: metric.request_number, api_calls: metric.api_calls,
        input_tokens: metric.input_tokens, output_tokens: metric.output_tokens, total_tokens: metric.total_tokens,
        cached_tokens: metric.cached_tokens, thinking_tokens: metric.thinking_tokens, duration_ms: metric.duration_ms,
        context_characters: metric.context_characters, context_messages: metric.context_messages,
        tool_schema_characters: metric.tool_schema_characters, error_code: metric.error_code })) };
    console.log(`Métricas: ${JSON.stringify(turn)}`);
    try { await recordToolEvent(directory, { ts: new Date().toISOString(), herramienta: "gemini_turno", mensaje_id: null,
      ok: response.ok && !["error", "tool_error", "limit", "incomplete"].includes(response.data.status), resumen: response.ok ? response.data.status : "error", ...turn }); }
    catch { console.log("No se pudieron completar las métricas del turno; revisa la auditoría local."); }
    process.stdout.write("Tú> ");
  }
  terminal.close();
  console.log(`\nSesión terminada. Resultados: ${directory}`);
}
if (import.meta.main) main().catch((error) => { console.error(providerErrorMessage(error) ?? "No se pudo iniciar la consola Gemini. Revisa la configuración local."); process.exitCode = 1; });
