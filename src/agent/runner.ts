import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createSessionStore, type AgentEvent } from "./session.ts";
import { providerResponseSchema, type Provider, type Message } from "./provider.ts";
import { executeTool, toolDefinitions } from "./tool-executor.ts";
import { prepareHumanReview, receiveHumanDecision } from "./human-review.ts";
import { recordToolEvent } from "../storage/persistence.ts";

const limitsSchema = z.object({ maxIterations: z.number().int().min(1).max(25).default(10),
  maxToolCalls: z.number().int().min(1).max(100).default(20), maxMessages: z.number().int().min(6).max(500).default(80),
  maxContextChars: z.number().int().min(1000).max(2_000_000).default(200_000),
  maxTokens: z.number().int().min(1).max(1_000_000).default(20_000),
  providerTimeoutMs: z.number().int().min(1).max(60_000).default(15_000) }).strict();
type Limits = z.input<typeof limitsSchema>;
type Turn = { ok: true; status: "final" | "review_required" | "limit" | "error"; reply: string;
  events: AgentEvent[]; tokens: number; usageComplete: boolean };

export async function createAgent(options: { directory: string; provider: Provider; limits?: Limits; now?: () => string }) {
  const limits = limitsSchema.parse(options.limits ?? {});
  const prompt = await readFile(new URL("../../agent/prompt.md", import.meta.url), "utf8");
  const store = createSessionStore();
  const now = options.now ?? (() => new Date().toISOString());

  async function controlled<T>(id: string, operation: (session: ReturnType<typeof store.get>) => Promise<T>) {
    let session: ReturnType<typeof store.get>;
    try { session = store.get(z.uuid().parse(id)); }
    catch { return { ok: false as const, error: "Sesión inexistente o inválida." }; }
    if (session.busy) return { ok: false as const, error: "La sesión tiene una operación en curso." };
    session.busy = true;
    try { return { ok: true as const, data: await operation(session) }; }
    catch { return { ok: false as const, error: "No se pudo completar la acción. Revisa los argumentos, la solicitud y sus fuentes." }; }
    finally { session.busy = false; }
  }

  async function send(id: string, supplied: unknown, turnOptions: { allowRegistration?: boolean } = {}) {
    return controlled(id, async (session): Promise<Turn> => {
      const text = z.string().trim().min(1).max(10_000).parse(supplied);
      const permissions = z.object({ allowRegistration: z.boolean().default(false) }).strict().parse(turnOptions);
      const eventStart = session.events.length;
      let toolCalls = 0;
      const fits = (extra: Message[] = []) => session.messages.length + extra.length + 1 <= limits.maxMessages &&
        JSON.stringify([{ role: "system", content: prompt }, ...session.messages, ...extra]).length <= limits.maxContextChars;
      function finish(status: Turn["status"], reply: string): Turn {
        // El historial no se trunca: no se dejan resultados huérfanos para ganar espacio.
        if (fits([{ role: "assistant", content: reply }])) session.messages.push({ role: "assistant", content: reply });
        return { ok: true, status, reply, events: structuredClone(session.events.slice(eventStart)),
          tokens: session.tokens, usageComplete: session.usageComplete };
      }
      if (!fits([{ role: "user", content: text }, { role: "assistant", content: "" }])) return finish("limit", "Se alcanzó el límite de contexto. Inicia una nueva sesión.");
      session.messages.push({ role: "user", content: text });
      for (let iteration = 0; iteration < limits.maxIterations; iteration++) {
        if (!fits() || session.tokens >= limits.maxTokens) return finish("limit", "Se alcanzó el límite de contexto o tokens. No se ejecutarán más herramientas.");
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let raw: unknown;
        try {
          const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, limits.providerTimeoutMs); });
          raw = await Promise.race([options.provider.send({ sessionId: session.id,
            messages: structuredClone([{ role: "system", content: prompt } as Message, ...session.messages]),
            tools: structuredClone(toolDefinitions()), maxOutputTokens: limits.maxTokens - session.tokens, signal: controller.signal }), timeout]);
        } catch { session.usageComplete = false; return finish("error", "El proveedor no respondió correctamente. Puedes volver a intentarlo."); }
        finally { if (timer) clearTimeout(timer); }
        const parsed = providerResponseSchema.safeParse(raw);
        if (!parsed.success) { session.usageComplete = false; return finish("error", "El proveedor devolvió una respuesta vacía o con formato inesperado."); }
        const response = parsed.data;
        if (response.usage) session.tokens += response.usage.input_tokens + response.usage.output_tokens;
        else session.usageComplete = false;
        if (session.tokens >= limits.maxTokens) return finish("limit", "Se alcanzó el presupuesto de tokens informado. No se ejecutarán más herramientas.");
        if (response.type === "final") {
          // Después de usar herramientas, los hechos mostrados salen de sus resultados,
          // no de afirmaciones libres del proveedor sobre escrituras o valores.
          const facts = session.events.slice(eventStart).filter((event) => event.type === "tool").map((event) => {
            const result = JSON.parse(event.result) as { ok: boolean; error?: string; data?: Record<string, unknown> };
            if (!result.ok) return `${event.name}: ${result.error}`;
            const data = result.data!;
            if (typeof data.accion === "string") return `${String(data.mensaje_id)}: ${data.accion}.`;
            if (typeof data.clasificacion === "string") return `${String(data.mensaje_id)}: ${data.clasificacion}.`;
            if (Array.isArray(data.mensajes)) return `Buzón consultado: ${data.mensajes.length} mensajes pendientes.`;
            if (Array.isArray(data.vencen)) return `Alertas generadas: ${data.vencen.length} próximos vencimientos. Reporte: ${String(data.ruta)}.`;
            return `${event.name}: consulta completada; consulta los datos en el evento de herramienta.`;
          });
          return finish("final", facts.length ? facts.join("\n") : response.text);
        }
        const callIds = response.calls.map((call) => call.id);
        if (new Set(callIds).size !== callIds.length || callIds.some((callId) => session.callIds.has(callId))) {
          return finish("error", "El proveedor repitió identificadores de llamadas; no se ejecutaron.");
        }
        if (toolCalls + response.calls.length > limits.maxToolCalls) return finish("limit", "Se alcanzó el límite de llamadas a herramientas; el lote no se ejecutó.");
        const assistant: Message = { role: "assistant", content: "", tool_calls: response.calls };
        const placeholders: Message[] = response.calls.map((call) => ({ role: "tool", content: " ".repeat(180), name: call.name, tool_call_id: call.id }));
        if (!fits([assistant, ...placeholders, { role: "assistant", content: "" }])) return finish("limit", "No hay espacio de contexto para completar las llamadas y sus resultados.");
        session.messages.push(assistant);
        let pending = false;
        let auditFailed = false;
        let contextExceeded = false;
        for (const [index, call] of response.calls.entries()) {
          session.callIds.add(call.id);
          toolCalls++;
          let result: string;
          if (pending || auditFailed || contextExceeded) {
            result = JSON.stringify({ ok: false, error: "Llamada no ejecutada: el turno se detuvo por revisión, auditoría o contexto." });
            session.events.push({ type: "tool", id: call.id, name: call.name, arguments: call.arguments, result });
            try {
              await recordToolEvent(options.directory, { ts: now(), herramienta: "agente_llamada_omitida", session_id: session.id,
                mensaje_id: null, ok: false, resumen: "turno_detenido", nombre: call.name });
            } catch { auditFailed = true; }
          } else {
            const execution = await executeTool(call, session, options.directory, now, permissions.allowRegistration);
            result = execution.serialized;
            pending = execution.pending;
            auditFailed = execution.auditFailed;
          }
          // Un resultado grande queda en el evento; el proveedor recibe un error de límite, nunca una instrucción.
          const toolMessage: Message = { role: "tool", content: result, name: call.name, tool_call_id: call.id };
          if (!fits([toolMessage, ...placeholders.slice(index + 1), { role: "assistant", content: "" }])) {
            contextExceeded = true;
            toolMessage.content = JSON.stringify({ ok: false, error: "Resultado fuera del límite de contexto; consulta el evento local." });
          }
          session.messages.push(toolMessage);
        }
        if (pending) return finish("review_required", "Hay campos pendientes de revisión. Proporciona aclaraciones por el canal humano controlado; el chat no concede autorización.");
        if (auditFailed) return finish("error", "No se pudo completar la auditoría. Revisa el resultado antes de reintentar una operación.");
        if (contextExceeded) return finish("limit", "El resultado excede el límite de contexto. Las operaciones ya aplicadas se conservan en los eventos.");
      }
      return finish("limit", "Se alcanzó el límite de iteraciones. Consulta las llamadas realizadas y continúa en otro turno.");
    });
  }
  return {
    createSession: () => store.create(),
    getSession(id: string) { try { return { ok: true as const, data: store.view(id) }; } catch { return { ok: false as const, error: "Sesión inexistente." }; } },
    send,
    prepareReview: (id: string, command: unknown) => controlled(id, (session) => prepareHumanReview(session, command, options.directory, now)),
    decideReview: (id: string, command: unknown) => controlled(id, (session) => receiveHumanDecision(session, command, options.directory, now)),
  };
}
