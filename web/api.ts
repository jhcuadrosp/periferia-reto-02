/// <reference lib="dom" />
import { z } from "zod";

const message = z.object({ role: z.enum(["user", "assistant"]), content: z.string() });
const event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool"), id: z.string(), name: z.string(), arguments: z.record(z.string(), z.unknown()),
    result: z.object({ ok: z.boolean(), summary: z.string().optional(), error: z.string().optional(), data: z.record(z.string(), z.unknown()).optional() }) }),
  z.object({ type: z.literal("review_required"), mensaje_id: z.string(), fields: z.array(z.string()) }),
]);
const review = z.object({ mensaje_id: z.string(), fields: z.array(z.string()), status: z.literal("pending"),
  channel: z.literal("trusted_local"), canApprove: z.literal(false) });
const turn = z.object({ sessionId: z.uuid(), reply: z.string(), status: z.enum(["final", "review_required", "limit", "error", "tool_error", "incomplete"]),
  tools: z.array(z.string()), events: z.array(event), reviews: z.array(review), errors: z.array(z.unknown()) });
const session = z.object({ sessionId: z.uuid(), csrfToken: z.string().min(1), expiresAt: z.iso.datetime() });
const health = z.object({ status: z.literal("ok"), provider: z.enum(["mock", "gemini"]), model: z.string().nullable(), registrationEnabled: z.literal(false) });
export type ChatMessage = z.infer<typeof message> & { status?: z.infer<typeof turn>["status"] };
export type ToolEvent = Extract<z.infer<typeof event>, { type: "tool" }>;
export type PublicEvent = z.infer<typeof event>;
export type Review = z.infer<typeof review>;

export class ApiError extends Error {
  constructor(message: string, readonly status = 0, readonly code = "NETWORK") { super(message); }
  get sessionLost() { return ["SESSION_NOT_FOUND", "SESSION_CREDENTIAL", "CSRF"].includes(this.code); }
}

// Credencial HttpOnly administrada por el navegador; CSRF solo en esta instancia en memoria.
export function createApi(fetcher: typeof fetch = fetch) {
  let current: z.infer<typeof session> | null = null;
  async function request<T>(path: string, schema: z.ZodType<T>, body?: unknown, allowTurnError = false): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(path, { method: body === undefined ? "GET" : "POST", credentials: "same-origin", cache: "no-store",
        signal: AbortSignal.timeout(260_000), headers: body === undefined ? {} : { "Content-Type": "application/json",
          ...(current ? { "X-CSRF-Token": current.csrfToken } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new ApiError("No se pudo confirmar la respuesta. Comprueba la conexión y actualiza el historial antes de reenviar."); }
    let raw: unknown;
    try { raw = await response.json(); } catch { throw new ApiError("El servicio devolvió una respuesta no reconocida.", response.status, "INVALID_RESPONSE"); }
    const envelope = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.string().optional(), code: z.string().optional() }).safeParse(raw);
    if (!envelope.success) throw new ApiError("El servicio devolvió una respuesta no reconocida.", response.status, "INVALID_RESPONSE");
    const parsed = schema.safeParse(envelope.data.data);
    // Un 502/504 puede incluir un turno completo y visible; no perder sus eventos ni su explicación.
    if (parsed.success && ((response.ok && envelope.data.ok) || (allowTurnError && [502, 504].includes(response.status)))) return parsed.data;
    if (!response.ok || !envelope.data.ok) throw new ApiError(envelope.data.error ?? "No se pudo completar la consulta.", response.status, envelope.data.code ?? "HTTP_ERROR");
    throw new ApiError("El servicio devolvió datos incompletos.", response.status, "INVALID_RESPONSE");
  }
  function path(resource: string) {
    if (!current) throw new ApiError("Inicia una conversación para continuar.", 401, "SESSION_CREDENTIAL");
    return `/api/sessions/${current.sessionId}/${resource}`;
  }
  return {
    health: () => request("/api/health", health),
    async newSession() {
      const created = await request("/api/sessions", session, {});
      current = created;
      return { sessionId: created.sessionId, expiresAt: created.expiresAt };
    },
    async send(text: string) {
      const id = current?.sessionId;
      const response = await request(path("messages"), turn, { message: text }, true);
      if (response.sessionId !== id || current?.sessionId !== id) throw new ApiError("La conversación cambió. Actualiza su estado.", 409, "SESSION_CHANGED");
      return response;
    },
    async snapshot() {
      const id = current?.sessionId;
      const [messages, events, reviews] = await Promise.all([
        request(path("messages"), z.object({ sessionId: z.uuid(), messages: z.array(message) })),
        request(path("events"), z.object({ sessionId: z.uuid(), events: z.array(event) })),
        request(path("reviews"), z.object({ sessionId: z.uuid(), reviews: z.array(review) })),
      ]);
      if ([messages, events, reviews].some((part) => part.sessionId !== id) || current?.sessionId !== id)
        throw new ApiError("La conversación cambió. Actualiza su estado.", 409, "SESSION_CHANGED");
      return { messages: messages.messages, events: events.events, reviews: reviews.reviews };
    },
  };
}
