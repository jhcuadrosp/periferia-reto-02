import type { ChatMessage, PublicEvent, Review, ToolEvent } from "./api.ts";

const statusLabels = { final: "Consulta completada", review_required: "Pendiente de revisión", limit: "Límite alcanzado",
  error: "Error del servicio", tool_error: "Error de herramienta", incomplete: "Tarea incompleta" };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
export function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: string) {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function badge(text: string, tone = "success") { const element = node("span", "status-badge", text); element.dataset.tone = tone; return element; }
function details(title: string, value: unknown) {
  const block = node("details"); block.append(node("summary", "", title), node("pre", "", JSON.stringify(value, null, 2))); return block;
}

export function renderMessages(container: HTMLElement, messages: ChatMessage[]) {
  container.replaceChildren(...messages.map((message) => {
    const article = node("article", `message ${message.role}`);
    article.append(node("div", "message-author", message.role === "user" ? "Tú" : "Agente contractual"), node("div", "message-content", message.content));
    if (message.status) {
      const status = node("span", "turn-status", statusLabels[message.status]);
      status.dataset.tone = ["error", "tool_error"].includes(message.status) ? "error" : message.status === "final" ? "success" : "warning";
      article.append(status);
    }
    return article;
  }));
}

// Solo etiquetas de presentación para estados emitidos por el backend; no evaluar reglas aquí.
function operationStatus(tool: ToolEvent) {
  if (!tool.result.ok) return { label: "Error", tone: "error" };
  const data = tool.result.data ?? {};
  if (data.estado_validacion === "pendiente_revision") return { label: "Pendiente de revisión", tone: "warning" };
  if (data.clasificacion === "rechazado") return { label: "Rechazado", tone: "error" };
  if (data.estado_validacion === "validado") return { label: "Validado", tone: "success" };
  if (["registrado", "actualizado"].includes(String(data.accion))) return { label: "Aplicado", tone: "success" };
  if (data.clasificacion === "duplicado") return { label: "Duplicado", tone: "warning" };
  return { label: "Completada", tone: "success" };
}

export function renderTools(container: HTMLElement, events: PublicEvent[]) {
  const tools = events.filter((event): event is ToolEvent => event.type === "tool");
  container.replaceChildren(...tools.map((tool) => {
    const article = node("article", "tool-event"), top = node("div", "tool-top"), status = operationStatus(tool);
    top.append(node("h3", "tool-name", tool.name), badge(status.label, status.tone));
    article.append(top, node("p", "tool-summary", tool.result.summary ?? tool.result.error ?? "Sin resumen disponible."),
      details("Ver argumentos y resultado", { arguments: tool.arguments, result: tool.result }));
    return article;
  }));
  if (!tools.length) container.append(node("p", "empty-state", "Las herramientas utilizadas aparecerán aquí después de tu primera consulta."));
  return tools.length;
}

export function renderReviews(container: HTMLElement, reviews: Review[], events: PublicEvent[]) {
  container.replaceChildren(...reviews.map((review) => {
    const latest = events.filter((event): event is ToolEvent => event.type === "tool" && event.name === "contratos_validar" && event.result.ok
      && event.result.data?.mensaje_id === review.mensaje_id).at(-1)?.result.data ?? {};
    const article = node("article", "review-item"), top = node("div", "review-top");
    top.append(node("h3", "", typeof latest.id_contrato === "string" ? latest.id_contrato : review.mensaje_id), badge("Pendiente", "warning"));
    article.append(top, node("p", "review-message", review.mensaje_id));
    const fields = node("div", "review-fields");
    fields.append(...review.fields.map((field) => node("span", "field-tag", field)));
    article.append(fields);
    const reasons = strings(latest.motivos);
    const warnings = Array.isArray(latest.advertencias) ? latest.advertencias.map((warning) => record(warning).descripcion).filter((item): item is string => typeof item === "string") : [];
    if (reasons.length || warnings.length) {
      const list = node("ul"); list.append(...[...reasons, ...warnings].map((reason) => node("li", "", reason))); article.append(list);
    } else article.append(node("p", "", "Los campos indicados necesitan revisión antes de cualquier registro."));
    if (latest.evidencias) article.append(details("Consultar evidencias", latest.evidencias));
    return article;
  }));
  if (!reviews.length) container.append(node("p", "empty-state", "Sin revisiones pendientes en esta conversación."));
}
