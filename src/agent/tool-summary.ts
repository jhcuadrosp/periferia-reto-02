import type { AgentEvent } from "./session.ts";

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const display = (value: unknown) => value === null || value === undefined ? "no informado" : String(value);
const fields = ["valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "estado_poliza"];

// Presentación de valores ya validados, sin inferir estados ni reglas contractuales.
export function toolSummary(event: Extract<AgentEvent, { type: "tool" }>) {
  const result = JSON.parse(event.result) as { ok: boolean; error?: string; data?: Record<string, unknown> };
  if (!result.ok) return `${event.name}: ${result.error}`;
  const data = result.data!;
  if (typeof data.accion === "string") return `${String(data.mensaje_id)}: ${data.accion}.`;
  if (typeof data.clasificacion === "string") {
    const proposed = record(data.datos_propuestos);
    return `${String(data.mensaje_id)}: ${data.clasificacion}.` + (Object.keys(proposed).length ? `\n${fields.map((field) => `${field}: ${display(proposed[field])}`).join("; ")}` : "");
  }
  if (Array.isArray(data.mensajes)) return `Buzón consultado: ${data.mensajes.length} mensajes pendientes.\n` + data.mensajes.map((item) => {
    const message = record(item); return `${display(message.id)}: ${display(message.asunto)} — ${display(message.de)}`;
  }).join("\n");
  if (Array.isArray(data.vencen)) return `Alertas generadas: ${data.vencen.length} próximos vencimientos. Reporte: ${String(data.ruta)}.\n` + data.vencen.map((item) => {
    const row = record(item); return `${display(row.id_contrato)}: ${display(row.fecha_fin)}, ${display(row.dias_restantes)} días`;
  }).join("\n");
  if (data.campos) {
    const values = record(data.campos);
    return `Extracción documental ${display(record(values.id_contrato).normalizado)}:\n` + fields.map((field) => `${field}: ${display(record(values[field]).normalizado)}`).join("; ") +
      (record(data.valor_indeterminado).normalizado === true ? "\nValor documental indeterminado; no equivale a un importe real cero." : "");
  }
  return `${event.name}: consulta completada; consulta los datos en el evento de herramienta.`;
}
