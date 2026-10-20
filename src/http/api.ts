import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { createAgent } from "../agent/runner.ts";
import { recordToolEvent } from "../storage/persistence.ts";
import { publicEvents, publicMessages, publicReviews, redact } from "./presentation.ts";
import type { WebAsset } from "./web.ts";

type Agent = Awaited<ReturnType<typeof createAgent>>;
export type HttpLimits = { maxSessions: number; sessionTtlMs: number; maxConcurrentTurns: number;
  clientRequestsPerMinute: number; sessionMessagesPerMinute: number; creationsPerMinute: number;
  maxBodyBytes: number; bodyTimeoutMs: number };
const defaults: HttpLimits = { maxSessions: 50, sessionTtlMs: 30 * 60_000, maxConcurrentTurns: 2,
  clientRequestsPerMinute: 60, sessionMessagesPerMinute: 10, creationsPerMinute: 5,
  maxBodyBytes: 65_536, bodyTimeoutMs: 5000 };
type Access = { credential: Buffer; csrf: Buffer; expires: number; busy: boolean };
const cookieName = "periferia_session";
const token = () => randomBytes(32).toString("base64url");
const hash = (value: string) => createHash("sha256").update(value).digest();
const matches = (supplied: string, expected: Buffer) => /^[A-Za-z0-9_-]{43}$/.test(supplied) && timingSafeEqual(hash(supplied), expected);
const messageSchema = z.object({ message: z.string().trim().min(1).max(10_000) }).strict();

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export function createHttpApi(options: { agent: Agent; directory: string; provider: "mock" | "gemini"; model: string | null;
  secrets?: string[]; limits?: Partial<HttpLimits>; now?: () => number; assets?: ReadonlyMap<string, WebAsset> }) {
  const limits = { ...defaults, ...options.limits };
  const now = options.now ?? Date.now;
  const sessions = new Map<string, Access>();
  const rates = new Map<string, { count: number; reset: number }>();
  let activeTurns = 0;
  let origin = "";
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(redact(data, options.secrets ?? []),
    { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...headers } });
  function fail(status: number, code: string, message: string): never { throw new HttpError(status, code, message); }
  async function audit(action: string, sessionId: string | null, ok: boolean, summary: string) {
    try { await recordToolEvent(options.directory, { ts: new Date(now()).toISOString(), herramienta: action,
      session_id: sessionId, mensaje_id: null, ok, resumen: summary }); }
    catch { fail(503, "AUDIT_UNAVAILABLE", "No se pudo completar la auditoría; revisa el resultado antes de reintentar."); }
  }
  function prune() {
    for (const [id, session] of sessions) if (!session.busy && session.expires <= now() && options.agent.disposeSession(id)) sessions.delete(id);
    for (const [key, rate] of rates) if (rate.reset <= now()) rates.delete(key);
  }
  function rate(key: string, maximum: number) {
    let current = rates.get(key);
    if (!current || current.reset <= now()) {
      if (rates.size >= 1000) fail(429, "RATE_LIMIT", "Se alcanzó el límite de solicitudes. Intenta más tarde.");
      current = { count: 0, reset: now() + 60_000 }; rates.set(key, current);
    }
    if (++current.count > maximum) fail(429, "RATE_LIMIT", "Se alcanzó el límite de solicitudes. Intenta más tarde.");
  }
  async function body(request: Request): Promise<unknown> {
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json")
      fail(415, "CONTENT_TYPE", "Utiliza Content-Type: application/json.");
    const length = request.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > limits.maxBodyBytes)) fail(413, "BODY_TOO_LARGE", "La solicitud supera el tamaño permitido.");
    if (!request.body) fail(400, "INVALID_JSON", "Se requiere un cuerpo JSON.");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([(async () => {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > limits.maxBodyBytes) fail(413, "BODY_TOO_LARGE", "La solicitud supera el tamaño permitido.");
          chunks.push(chunk.value);
        }
      })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new HttpError(408, "BODY_TIMEOUT", "Se agotó el tiempo para recibir la solicitud.")), limits.bodyTimeoutMs); })]);
      try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
      catch { return fail(400, "INVALID_JSON", "El cuerpo no contiene JSON válido."); }
    } finally { if (timer) clearTimeout(timer); void reader.cancel().catch(() => undefined); }
  }
  async function handle(request: Request, client: string) {
    prune();
    const url = new URL(request.url);
    if (url.host !== new URL(origin).host || request.headers.get("host") !== new URL(origin).host)
      fail(403, "INVALID_HOST", "Host no permitido.");
    if ((request.headers.get("origin") && request.headers.get("origin") !== origin) || request.headers.get("sec-fetch-site") === "cross-site")
      fail(403, "INVALID_ORIGIN", "Origen no permitido.");
    rate(`client:${client}`, limits.clientRequestsPerMinute);
    if (url.search) fail(400, "INVALID_QUERY", "Esta API no acepta parámetros de consulta.");
    const path = url.pathname;
    const asset = options.assets?.get(path);
    if (asset) {
      if (!["GET", "HEAD"].includes(request.method)) fail(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
      return new Response(request.method === "HEAD" ? null : asset.body, { headers: { "Content-Type": asset.contentType,
        "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" } });
    }
    if (path === "/api/health") {
      if (request.method !== "GET") fail(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
      return json({ ok: true, data: { status: "ok", provider: options.provider, model: options.model, registrationEnabled: false } });
    }
    if (request.method === "POST" && request.headers.get("origin") !== origin) fail(403, "INVALID_ORIGIN", "Se requiere el origen de esta aplicación.");
    if (path === "/api/sessions") {
      if (request.method !== "POST") fail(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
      if (!z.object({}).strict().safeParse(await body(request)).success) fail(400, "INVALID_BODY", "Para crear una sesión envía un objeto JSON vacío.");
      rate(`create:${client}`, limits.creationsPerMinute);
      if (sessions.size >= limits.maxSessions) fail(503, "SESSION_CAPACITY", "No hay capacidad para otra sesión. Intenta más tarde.");
      // Reservar antes de I/O: dos creaciones simultáneas no pueden superar el cupo.
      const id = options.agent.createSession(), credential = token(), csrf = token();
      const expires = now() + limits.sessionTtlMs;
      sessions.set(id, { credential: hash(credential), csrf: hash(csrf), expires, busy: true });
      try { await audit("http_sesion_creada", id, true, "registro_deshabilitado"); }
      catch (error) { sessions.delete(id); options.agent.disposeSession(id); throw error; }
      sessions.get(id)!.busy = false;
      const secure = origin.startsWith("https:") ? "; Secure" : "";
      return json({ ok: true, data: { sessionId: id, csrfToken: csrf, expiresAt: new Date(expires).toISOString() } }, 201,
        { "Set-Cookie": `${cookieName}=${credential}; Path=/api/sessions/${id}; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(limits.sessionTtlMs / 1000)}${secure}` });
    }
    const route = /^\/api\/sessions\/([^/]+)\/(messages|events|reviews)$/.exec(path);
    if (!route) fail(404, "NOT_FOUND", "Ruta inexistente.");
    const id = route[1]!, resource = route[2]!;
    if (!z.uuid().safeParse(id).success) fail(400, "INVALID_SESSION", "Identificador de sesión inválido.");
    const session = sessions.get(id);
    if (!session || session.expires <= now()) fail(404, "SESSION_NOT_FOUND", "Sesión inexistente o caducada.");
    const cookies = (request.headers.get("cookie") ?? "").split(";").map((item) => item.trim()).filter((item) => item.startsWith(`${cookieName}=`));
    if (!cookies.length) fail(401, "SESSION_CREDENTIAL", "Falta la credencial de sesión.");
    if (cookies.length !== 1 || !matches(cookies[0]!.slice(cookieName.length + 1), session.credential)) fail(403, "SESSION_CREDENTIAL", "Credencial de sesión inválida.");
    if (request.method === "GET") {
      const view = options.agent.getSession(id);
      if (!view.ok) fail(404, "SESSION_NOT_FOUND", "Sesión inexistente.");
      const data = view.data;
      return json({ ok: true, data: { sessionId: id, ...(resource === "messages" ? { messages: publicMessages(data.messages) }
        : resource === "events" ? { events: publicEvents(data.events) } : { reviews: publicReviews(data.events) }) } });
    }
    if (request.method !== "POST" || resource !== "messages") fail(405, "METHOD_NOT_ALLOWED", "Método no permitido.");
    if (!matches(request.headers.get("x-csrf-token") ?? "", session.csrf)) fail(403, "CSRF", "Token CSRF inválido.");
    const parsed = messageSchema.safeParse(await body(request));
    if (!parsed.success) fail(400, "INVALID_MESSAGE", "Envía únicamente message, con entre 1 y 10000 caracteres.");
    // La sesión pudo caducar mientras el cliente enviaba el cuerpo.
    if (session.expires <= now() || sessions.get(id) !== session) fail(404, "SESSION_NOT_FOUND", "Sesión inexistente o caducada.");
    if (session.busy) fail(409, "SESSION_BUSY", "La sesión tiene un turno en curso.");
    rate(`session:${id}`, limits.sessionMessagesPerMinute);
    if (activeTurns >= limits.maxConcurrentTurns) fail(429, "SERVER_BUSY", "El servidor ya está atendiendo el máximo de turnos simultáneos.");
    session.busy = true; activeTurns++;
    try {
      await audit("http_turno_iniciado", id, true, "registro_deshabilitado");
      // El navegador nunca puede proporcionar permisos ni comandos Human-in-the-Loop.
      const result = await options.agent.send(id, parsed.data.message, { allowRegistration: false });
      if (!result.ok) fail(503, "AGENT_UNAVAILABLE", "El agente no pudo completar el turno.");
      const turn = result.data;
      await audit("http_turno_finalizado", id, turn.status !== "error", turn.status);
      const view = options.agent.getSession(id);
      const events = publicEvents(turn.events);
      return json({ ok: turn.status !== "error", data: { sessionId: id, reply: turn.reply, status: turn.status,
        tools: turn.events.filter((event) => event.type === "tool").map((event) => event.name), events,
        reviews: publicReviews(view.ok ? view.data.events : turn.events), errors: [...turn.toolErrors,
          ...(turn.status === "error" ? [{ code: turn.errorCode ?? "AGENT_ERROR", error: turn.reply }] : [])],
        usage: { turnTokens: turn.turnTokens, sessionTokens: turn.tokens, tokenLimit: turn.tokenLimit, complete: turn.usageComplete }, task: turn.task } },
        turn.status === "error" ? turn.errorCode === "PROVIDER_TIMEOUT" ? 504 : 502 : 200);
    } finally { session.busy = false; activeTurns--; }
  }
  return {
    limits,
    setOrigin(value: string) { origin = value; },
    prune,
    dispose() { for (const id of sessions.keys()) if (options.agent.disposeSession(id)) sessions.delete(id); rates.clear(); },
    error() { return json({ ok: false, code: "INTERNAL_ERROR", error: "No se pudo completar la solicitud." }, 500); },
    async fetch(request: Request, client: string) {
      try { return await handle(request, client); }
      catch (error) {
        if (error instanceof HttpError) return json({ ok: false, code: error.code, error: error.message }, error.status,
          error.status === 429 ? { "Retry-After": "60" } : {});
        return this.error();
      }
    },
  };
}
