import { z } from "zod";
import { correctionsSchema, reviewerSchema } from "../domain/review.ts";
import { decisionCommandSchema } from "../domain/confirmation.ts";
import { createConfirmation, decideConfirmation, recordToolEvent } from "../storage/persistence.ts";
import type { Session } from "./session.ts";

// Solo para el controlador local de confianza; no son herramientas del proveedor.
export async function prepareHumanReview(session: Session, supplied: unknown, directory: string, now: () => string) {
  const input = z.object({ mensaje_id: z.string(), correcciones: correctionsSchema, revisor: reviewerSchema }).strict().parse(supplied);
  const ticket = session.tickets.get(input.mensaje_id);
  if (!ticket) throw new Error("Falta validación en esta sesión.");
  const created = await createConfirmation(directory, ticket, input.correcciones, input.revisor, { now });
  if (!created.ok) throw new Error("La revisión sigue incompleta o las fuentes cambiaron; vuelve a evaluar.");
  const request = created.data;
  session.approvals.set(request.solicitud_id, { ticket: structuredClone(ticket), datos_hash: request.datos_hash,
    reviewer: input.revisor, state: "pendiente" });
  const event = { type: "approval_request" as const, solicitud_id: request.solicitud_id, datos_hash: request.datos_hash,
    values: request.datos_registro, reviewer: input.revisor.id };
  session.events.push(event);
  try {
    await recordToolEvent(directory, { ts: now(), herramienta: "agente_revision", session_id: session.id,
      mensaje_id: ticket.mensaje_id, ok: true, resumen: "solicitud_vinculada", solicitud_id: request.solicitud_id, datos_hash: request.datos_hash });
    return structuredClone(event);
  } catch { return { ...structuredClone(event), error_auditoria: "Solicitud creada; no se pudo completar el evento adicional de sesión." }; }
}

export async function receiveHumanDecision(session: Session, supplied: unknown, directory: string, now: () => string) {
  const input = decisionCommandSchema.extend({ revisor: reviewerSchema }).strict().parse(supplied);
  const binding = session.approvals.get(input.solicitud_id);
  if (!binding || binding.datos_hash !== input.datos_hash || binding.reviewer.id !== input.revisor.id || binding.state !== "pendiente") {
    throw new Error("La decisión no pertenece a una solicitud pendiente de esta sesión y este revisor.");
  }
  const decided = await decideConfirmation(directory, { solicitud_id: input.solicitud_id, datos_hash: input.datos_hash,
    accion: input.accion }, input.revisor, { now });
  if (!decided.ok) throw new Error("No se pudo aplicar la decisión; comprueba vigencia, fuentes y maestro.");
  binding.state = decided.data.estado === "aprobada" ? "aprobada" : "rechazada";
  const event = { type: "decision" as const, solicitud_id: input.solicitud_id, action: input.accion, reviewer: input.revisor.id };
  session.events.push(event);
  try {
    await recordToolEvent(directory, { ts: now(), herramienta: "agente_decision", session_id: session.id,
      mensaje_id: binding.ticket.mensaje_id, ok: true, resumen: input.accion, solicitud_id: input.solicitud_id, datos_hash: input.datos_hash });
    return structuredClone(event);
  } catch { return { ...structuredClone(event), error_auditoria: "Decisión aplicada; no se pudo completar el evento adicional de sesión." }; }
}
