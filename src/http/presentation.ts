import type { AgentEvent } from "../agent/session.ts";
import type { Message } from "../agent/provider.ts";
import { toolSummary } from "../agent/tool-summary.ts";

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
// Proyección pública: nunca devolver tickets, hashes, referencias del proveedor ni autorizaciones.
const publicFields = ["mensajes", "campos", "valor_indeterminado", "requiere_revision", "advertencias", "evidencias",
  "clasificacion", "mensaje_id", "id_contrato", "id_contrato_existente", "estado_validacion", "elegible_registro",
  "datos_propuestos", "diferencias", "motivos", "campos_pendientes", "vencen", "polizas_pendientes", "registrados_desde_corte"];
const privateField = /hash|ticket|autoriz|referencia|provider_response|revisor|reviewer|solicitud_id|api.?key|secret/i;

function publicValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(object(value))
    .filter(([key]) => !privateField.test(key)).map(([key, item]) => [key, publicValue(item)]));
  return value;
}

type PublicEvent = { type: "review_required"; mensaje_id: string; fields: string[] }
  | { type: "tool"; id: string; name: string; arguments: Record<string, unknown>;
    result: { ok: boolean; summary?: string; data?: unknown; error?: string } };
function jsonObject(text: string) { try { return object(JSON.parse(text)); } catch { return {}; } }

export function publicEvents(events: AgentEvent[]): PublicEvent[] {
  return events.flatMap<PublicEvent>((event) => {
    if (event.type === "review_required") return [{ type: event.type, mensaje_id: event.mensaje_id, fields: event.fields }];
    if (event.type !== "tool") return [];
    const result = object(JSON.parse(event.result));
    const data = object(result.data);
    const args = jsonObject(event.arguments);
    return [{ type: "tool", id: event.id, name: event.name,
      arguments: Object.fromEntries(["mensaje_id", "hoy", "confirmado", "finalizar_consulta"]
        .filter((key) => ["string", "boolean"].includes(typeof args[key])).map((key) => [key, args[key]])),
      result: result.ok ? { ok: true, summary: toolSummary(event), data: publicValue(Object.fromEntries(publicFields
        .filter((key) => Object.hasOwn(data, key)).map((key) => [key, data[key]]))) }
        : { ok: false, error: typeof result.error === "string" ? result.error : "Error de herramienta." } }];
  });
}

export function publicReviews(events: AgentEvent[]) {
  const pending = new Map<string, string[]>();
  for (const event of events) {
    if (event.type === "review_required") pending.set(event.mensaje_id, event.fields);
  }
  return [...pending].map(([mensaje_id, fields]) => ({ mensaje_id, fields, status: "pending" as const,
    channel: "trusted_local" as const, canApprove: false }));
}

export function publicMessages(messages: Message[]) {
  return messages.filter((message) => message.role === "user" || message.role === "assistant" && message.content)
    .map((message) => ({ role: message.role, content: message.content }));
}

export function redact(value: unknown, secrets: string[]): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "string") return item;
    let safe = item;
    for (const secret of secrets.filter(Boolean)) safe = safe.replaceAll(secret, "[REDACTADO]");
    return safe.replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var|etc|mnt)\/)[^\s"<>]+/g, "[RUTA INTERNA]");
  });
}
