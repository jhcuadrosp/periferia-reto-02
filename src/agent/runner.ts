import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createSessionStore, type AgentEvent } from "./session.ts";
import { providerResponseSchema, providerUsageSchema, type Provider, type Message } from "./provider.ts";
import { executeTool, toolDefinitions } from "./tool-executor.ts";
import { prepareHumanReview, receiveHumanDecision } from "./human-review.ts";
import { recordToolEvent } from "../storage/persistence.ts";
import { providerErrorMessage, providerErrorUsage } from "./provider-error.ts";
import { toolSummary } from "./tool-summary.ts";
import { contextWindow } from "./context-window.ts";
import { reviewTaskSchema, reviewTask, taskProgress, incompleteTaskReply, taskInstruction, type ReviewTask, type TaskProgress } from "./task.ts";

const limitsSchema = z.object({ maxIterations: z.number().int().min(1).max(25).default(10),
  maxToolCalls: z.number().int().min(1).max(100).default(20), maxMessages: z.number().int().min(6).max(500).default(80),
  maxContextChars: z.number().int().min(1000).max(2_000_000).default(200_000),
  maxTokens: z.number().int().min(1).max(1_000_000).default(20_000),
  providerTimeoutMs: z.number().int().min(1).max(60_000).default(15_000) }).strict();
type Limits = z.input<typeof limitsSchema>;
type Turn = { ok: true; status: "final" | "review_required" | "limit" | "error" | "tool_error" | "incomplete"; reply: string;
  events: AgentEvent[]; tokens: number; turnTokens: number; tokenLimit: number; usageComplete: boolean;
  toolErrors: { name: string; call_id: string; error: string }[]; task: TaskProgress | null };

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

  async function send(id: string, supplied: unknown, turnOptions: { allowRegistration?: boolean; task?: ReviewTask } = {}) {
    return controlled(id, async (session): Promise<Turn> => {
      const text = z.string().trim().min(1).max(10_000).parse(supplied);
      const permissions = z.object({ allowRegistration: z.boolean().default(false), task: reviewTaskSchema.optional() }).strict().parse(turnOptions);
      const task = reviewTask(text, permissions.task);
      const eventStart = session.events.length;
      const tokenStart = session.tokens;
      const transport = options.provider.toolTransport;
      let toolCalls = 0;
      let correctionAttempts = 0;
      const progress = () => taskProgress(task, session.events.slice(eventStart), correctionAttempts);
      function trackUsage(usage?: z.infer<typeof providerUsageSchema>) {
        if (usage?.input_tokens === undefined || usage.output_tokens === undefined) session.usageComplete = false;
        if (usage) session.tokens += Math.max(usage.total_tokens ?? 0,
          (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.thinking_tokens ?? 0));
      }
      const fits = (extra: Message[] = []) => {
        const current = progress();
        const system = current ? `${prompt}\n\n${taskInstruction(current)}` : prompt;
        return session.messages.length + extra.length + 1 <= limits.maxMessages &&
          JSON.stringify([{ role: "system", content: system }, ...session.messages, ...extra]).length <= limits.maxContextChars;
      };
      function finish(status: Turn["status"], reply: string, providerResponseId?: string): Turn {
        const events = structuredClone(session.events.slice(eventStart));
        const toolErrors = events.flatMap((event) => {
          if (event.type !== "tool") return [];
          const result = JSON.parse(event.result) as { ok: boolean; error?: string };
          return result.ok ? [] : [{ name: event.name, call_id: event.id, error: result.error ?? "Error de herramienta." }];
        });
        if (status === "final" && toolErrors.length) status = "tool_error";
        const currentTask = progress();
        if (status === "final" && currentTask && !currentTask.validationComplete) {
          status = "incomplete";
          reply = incompleteTaskReply(currentTask);
          providerResponseId = undefined;
        }
        if (status === "incomplete") {
          const facts = events.filter((event) => event.type === "tool").map(toolSummary);
          if (facts.length) reply = `${facts.join("\n")}\n${reply}`;
        }
        if (status === "limit") {
          const facts = events.filter((event) => event.type === "tool").map(toolSummary);
          if (facts.length) reply = `${facts.join("\n")}\n${reply}`;
        }
        // El historial no se trunca: no se dejan resultados huérfanos para ganar espacio.
        const message: Message = { role: "assistant", content: reply, ...(providerResponseId ? { provider_response_id: providerResponseId } : {}) };
        if (fits([message])) session.messages.push(message);
        return { ok: true, status, reply, events, tokens: session.tokens, turnTokens: session.tokens - tokenStart,
          tokenLimit: limits.maxTokens, toolErrors, task: currentTask, usageComplete: session.usageComplete };
      }
      if (!fits([{ role: "user", content: text }, { role: "assistant", content: "" }])) return finish("limit", "Se alcanzó el límite de contexto. Inicia una nueva sesión.");
      session.messages.push({ role: "user", content: text });
      for (let iteration = 0; iteration < limits.maxIterations; iteration++) {
        if (!fits() || session.tokens >= limits.maxTokens) return finish("limit", "Se alcanzó el límite de contexto o tokens. No se ejecutarán más herramientas.");
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let raw: unknown;
        const currentTask = progress();
        try {
          const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, limits.providerTimeoutMs); });
          raw = await Promise.race([options.provider.send({ sessionId: session.id,
            messages: structuredClone([{ role: "system", content: prompt } as Message, ...(transport ? contextWindow(session.messages) : session.messages)]),
            tools: structuredClone(toolDefinitions(transport)), maxOutputTokens: limits.maxTokens - session.tokens, signal: controller.signal,
            ...(currentTask ? { task: structuredClone(currentTask) } : {}) }), timeout]);
        } catch (error) { trackUsage(providerErrorUsage(error)); return finish("error", providerErrorMessage(error) ?? "El proveedor no respondió correctamente. Puedes volver a intentarlo."); }
        finally { if (timer) clearTimeout(timer); }
        const parsed = providerResponseSchema.safeParse(raw);
        if (!parsed.success) { session.usageComplete = false; return finish("error", "El proveedor devolvió una respuesta vacía o con formato inesperado."); }
        const response = parsed.data;
        trackUsage(response.usage);
        if (session.tokens >= limits.maxTokens) return finish("limit", "Se alcanzó el presupuesto de tokens informado. No se ejecutarán más herramientas.");
        if (response.type === "final") {
          const missing = progress();
          const toolFailed = session.events.slice(eventStart).some((event) => event.type === "tool" && !(JSON.parse(event.result) as { ok: boolean }).ok);
          if (missing && !missing.validationComplete && !toolFailed) {
            const correction = await requestCorrection(iteration);
            if (correction === "retry") continue;
            return finish(correction === "audit_error" ? "error" : "incomplete", correction === "audit_error"
              ? "No se pudo auditar la corrección de la tarea; no se harán más solicitudes." : incompleteTaskReply(progress()!));
          }
          // Después de usar herramientas, los hechos mostrados salen de sus resultados,
          // no de afirmaciones libres del proveedor sobre escrituras o valores.
          const facts = session.events.slice(eventStart).filter((event) => event.type === "tool").map(toolSummary);
          return finish("final", facts.length ? facts.join("\n") : response.text, response.provider_response_id);
        }
        const callIds = response.calls.map((call) => call.id);
        if (new Set(callIds).size !== callIds.length || callIds.some((callId) => session.callIds.has(callId))) {
          return finish("error", "El proveedor repitió identificadores de llamadas; no se ejecutaron.");
        }
        if (toolCalls + response.calls.length > limits.maxToolCalls) return finish("limit", "Se alcanzó el límite de llamadas a herramientas; el lote no se ejecutó.");
        const assistant: Message = { role: "assistant", content: "", tool_calls: response.calls,
          ...(response.provider_response_id ? { provider_response_id: response.provider_response_id } : {}) };
        const placeholders: Message[] = response.calls.map((call) => ({ role: "tool", content: " ".repeat(180), name: call.name, tool_call_id: call.id }));
        if (!fits([assistant, ...placeholders, { role: "assistant", content: "" }])) return finish("limit", "No hay espacio de contexto para completar las llamadas y sus resultados.");
        session.messages.push(assistant);
        let pending = false;
        let auditFailed = false;
        let contextExceeded = false;
        let finishQueries = Boolean(transport);
        for (const [index, call] of response.calls.entries()) {
          session.callIds.add(call.id);
          toolCalls++;
          let result: string;
          if (pending || auditFailed || contextExceeded) {
            finishQueries = false;
            result = JSON.stringify({ ok: false, error: "Llamada no ejecutada: el turno se detuvo por revisión, auditoría o contexto." });
            session.events.push({ type: "tool", id: call.id, name: call.name, arguments: call.arguments, result });
            try {
              await recordToolEvent(options.directory, { ts: now(), herramienta: "agente_llamada_omitida", session_id: session.id,
                mensaje_id: null, ok: false, resumen: "turno_detenido", nombre: call.name });
            } catch { auditFailed = true; }
          } else {
            const execution = await executeTool(call, session, options.directory, now, permissions.allowRegistration, transport);
            result = execution.providerSerialized;
            finishQueries = finishQueries && execution.finishQuery;
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
        if (pending) {
          const review = session.events.slice(eventStart).find((event) => event.type === "review_required");
          return finish("review_required", `Hay campos pendientes de revisión${review?.type === "review_required" ? `: ${review.fields.join(", ")}` : ""}. Proporciona aclaraciones por el canal humano controlado; el chat no concede autorización.`);
        }
        if (auditFailed) return finish("error", "No se pudo completar la auditoría. Revisa el resultado antes de reintentar una operación.");
        if (contextExceeded) return finish("limit", "El resultado excede el límite de contexto. Las operaciones ya aplicadas se conservan en los eventos.");
        if (finishQueries) {
          const missing = progress();
          if (missing && !missing.validationComplete) {
            const correction = await requestCorrection(iteration);
            if (correction === "retry") continue;
            return finish(correction === "audit_error" ? "error" : "incomplete", correction === "audit_error"
              ? "No se pudo auditar la corrección de la tarea; no se harán más solicitudes." : incompleteTaskReply(progress()!));
          }
          const facts = session.events.slice(eventStart).filter((event) => event.type === "tool").map(toolSummary);
          return finish("final", facts.join("\n"));
        }
      }
      return finish("limit", "Se alcanzó el límite de iteraciones. Consulta las llamadas realizadas y continúa en otro turno.");

      async function requestCorrection(iteration: number) {
        const current = progress();
        if (!current || current.needsTarget || correctionAttempts >= 1 || iteration + 1 >= limits.maxIterations || toolCalls >= limits.maxToolCalls) return "stop";
        correctionAttempts++;
        try {
          await recordToolEvent(options.directory, { ts: now(), herramienta: "agente_tarea_incompleta", session_id: session.id,
            mensaje_id: null, ok: false, resumen: "correccion_solicitada", pendientes: current.missingMessageIds, intentos: correctionAttempts });
        } catch { return "audit_error"; }
        return "retry";
      }
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
