import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createAgent } from "./agent/runner.ts";
import { loadGeminiConfig } from "./agent/config.ts";
import { createGeminiProvider } from "./agent/gemini-provider.ts";
import { createMockProvider } from "./agent/mock-provider.ts";
import type { Provider, ProviderRequest } from "./agent/provider.ts";
import { initializeStorage, recordToolEvent } from "./storage/persistence.ts";
import { createHttpApi, type HttpLimits } from "./http/api.ts";
import { webAssets } from "./http/web.ts";

const portSchema = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(65535));
const httpSchema = z.object({ port: portSchema.default(3000), hostname: z.string().regex(/^[\w.:-]+$/).default("127.0.0.1"),
  provider: z.enum(["mock", "gemini"]).default("mock"), publicOrigin: z.url().optional() });

export type ServerOptions = { env?: Record<string, string | undefined>; provider?: Provider;
  httpLimits?: Partial<HttpLimits>; now?: () => number };

// Solo configuración confiable del proceso. Ninguna ruta llega de solicitudes HTTP.
export async function startHttpServer(options: ServerOptions = {}) {
  const env = options.env ?? process.env;
  const parsed = httpSchema.safeParse({ port: env.PORT, hostname: env.HOST,
    provider: env.AGENT_PROVIDER, publicOrigin: env.PUBLIC_ORIGIN || undefined });
  if (!parsed.success) throw new Error("Configuración HTTP inválida: revisa PORT, HOST, PUBLIC_ORIGIN y AGENT_PROVIDER.");
  const config = parsed.data;
  let publicOrigin: string | undefined;
  if (config.publicOrigin) {
    const url = new URL(config.publicOrigin);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("PUBLIC_ORIGIN debe ser un origen HTTP(S), sin rutas ni credenciales.");
    publicOrigin = url.origin;
  }
  if (!publicOrigin && !["127.0.0.1", "localhost", "::1"].includes(config.hostname))
    throw new Error("Configura PUBLIC_ORIGIN al escuchar fuera de localhost.");
  // Reutilizar la validación de los límites actuales; mock no requiere clave.
  const agentConfig = loadGeminiConfig(config.provider === "gemini" ? env
    : { ...env, AGENT_PROVIDER: "gemini", GEMINI_API_KEY: "mock-no-credential" });
  const directory = await mkdtemp(join(tmpdir(), "periferia-http-"));
  await cp(fileURLToPath(new URL("../fixtures", import.meta.url)), join(directory, "fixtures"), { recursive: true });
  if (!(await initializeStorage(directory)).ok) throw new Error("No se pudo inicializar el almacenamiento temporal HTTP.");
  const provider = options.provider ?? (config.provider === "gemini"
    ? createGeminiProvider({ apiKey: agentConfig.apiKey, model: agentConfig.model, timeoutMs: agentConfig.timeoutMs,
      onMetric: (metric) => recordToolEvent(directory, { ts: new Date().toISOString(), herramienta: "http_gemini_proveedor",
        mensaje_id: null, resumen: metric.error_code ?? "respuesta_recibida", ...metric }) })
    : createMockProvider([
      { type: "tools", calls: [{ id: "mock-buzon", name: "contratos_leer_buzon", arguments: "{}" }] },
      { type: "final", text: "Consulta del buzón completada." },
      { type: "tools", calls: [{ id: "mock-extract", name: "contratos_extraer", arguments: '{"mensaje_id":"msg-006"}' }] },
      (request: ProviderRequest) => {
        const extraction = request.messages.filter((message) => message.role === "tool" && message.name === "contratos_extraer").at(-1);
        if (!extraction) throw new Error("Falta extracción en el guion mock.");
        const result = z.object({ ok: z.literal(true), data: z.unknown() }).parse(JSON.parse(extraction.content));
        return { type: "tools", calls: [{ id: "mock-validate", name: "contratos_validar",
          arguments: JSON.stringify({ mensaje_id: "msg-006", contrato: result.data }) }] };
      },
      { type: "tools", calls: [{ id: "mock-register", name: "contratos_registrar", arguments: '{"mensaje_id":"msg-006","confirmado":true}' }] },
      { type: "final", text: "El canal público no permite registros contractuales." },
    ]));
  const agent = await createAgent({ directory, provider, limits: { maxIterations: agentConfig.maxIterations,
    maxToolCalls: agentConfig.maxToolCalls, maxTokens: agentConfig.maxTokens, providerTimeoutMs: agentConfig.timeoutMs } });
  const api = createHttpApi({ agent, directory, provider: config.provider, model: config.provider === "gemini" ? agentConfig.model : null,
    secrets: [env.GEMINI_API_KEY ?? "", directory], limits: options.httpLimits, now: options.now, assets: await webAssets() });
  await recordToolEvent(directory, { ts: new Date().toISOString(), herramienta: "http_servidor_preparado", mensaje_id: null,
    ok: true, resumen: "registro_deshabilitado", provider: config.provider });
  const server = Bun.serve({ hostname: config.hostname, port: config.port,
    // El timeout del proveedor y los topes del runner acotan el trabajo; el HTTP no corta un turno a los 10 s por defecto.
    idleTimeout: 255,
    // El lector HTTP limita a 64 KiB (incluso sin Content-Length). Evitar el 413 vacío nativo permite devolver JSON.
    maxRequestBodySize: Number.MAX_SAFE_INTEGER,
    development: false,
    fetch(request, current) { return api.fetch(request, current.requestIP(request)?.address ?? "unknown"); },
    error() { return api.error(); },
  });
  api.setOrigin(publicOrigin ?? server.url.origin);
  const cleanup = setInterval(api.prune, 60_000);
  cleanup.unref();
  return { url: server.url.origin, origin: publicOrigin ?? server.url.origin, directory,
    async stop() { clearInterval(cleanup); await server.stop(true); api.dispose(); } };
}

if (import.meta.main) {
  startHttpServer().then((server) => {
    console.log(`API HTTP: ${server.url}. Origen permitido: ${server.origin}. Registro contractual deshabilitado.`);
    console.log(`Resultados aislados: ${server.directory}`);
    const stop = () => { void server.stop().then(() => process.exit(0)); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  }).catch(() => { console.error("No se pudo iniciar la API. Revisa PORT, HOST, PUBLIC_ORIGIN, AGENT_PROVIDER, GEMINI_API_KEY y los límites del agente."); process.exitCode = 1; });
}
