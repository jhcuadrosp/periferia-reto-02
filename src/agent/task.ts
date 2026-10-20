import { z } from "zod";
import type { AgentEvent } from "./session.ts";

export const reviewTaskSchema = z.object({ operation: z.literal("review"),
  messageIds: z.array(z.string().min(1).max(100).regex(/^[\p{L}\p{N}_-]+$/u)).max(20).default([]) }).strict();
export type ReviewTask = z.infer<typeof reviewTaskSchema>;
export type TaskProgress = ReviewTask & { validatedMessageIds: string[]; missingMessageIds: string[];
  needsTarget: boolean; validationComplete: boolean; correctionAttempts: number };

// Reconocimiento acotado del mensaje humano actual; nunca lee instrucciones de documentos.
// El controlador puede aportar task explícita cuando la intención no sea inequívoca.
export function reviewTask(text: string, explicit?: ReviewTask): ReviewTask | null {
  if (explicit) return { ...explicit, messageIds: [...new Set(explicit.messageIds)] };
  const normalized = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  if (/\b(?:no|sin)\s+(?:validar(?:lo|la)?|valides|valide|validacion)\b/.test(normalized)) return null;
  const positive = normalized.replace(/\b(?:no|sin)\s+(?:revis\w*|valid\w*|clasific\w*)\b/g, "");
  const missingForRegistration = /\bque\b.*\bfalta\b.*\bregistr\w*/.test(positive);
  const conceptual = /^(?:[¿\s]*)(?:como|explica|explicame|describe|que significa)\b/.test(positive);
  const action = /\b(?:revisa|revise|revises|revisemos|valida|valide|valides|validemos|clasifica|clasifique|clasifiques)\b/.test(positive)
    || /\b(?:puedes|podrias|quiero|necesito|solicito)\b.*\b(?:revisar|validar|clasificar)\b/.test(positive);
  if (!missingForRegistration && (!action || conceptual)) return null;
  const ids = [...text.matchAll(/\bmsg-[\p{L}\p{N}_-]+/giu)].map((match) => match[0].replace(/^msg/i, "msg"));
  return reviewTaskSchema.parse({ operation: "review", messageIds: [...new Set(ids)] });
}

export function taskProgress(task: ReviewTask | null, events: AgentEvent[], correctionAttempts: number): TaskProgress | null {
  if (!task) return null;
  const selected = new Set<string>(), validated = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool" || !["contratos_extraer", "contratos_validar"].includes(event.name)) continue;
    let rawArgs: unknown;
    try { rawArgs = JSON.parse(event.arguments); } catch { continue; }
    const args = z.object({ mensaje_id: z.string() }).safeParse(rawArgs);
    if (!args.success) continue;
    const id = args.data.mensaje_id;
    selected.add(id);
    const result = z.object({ ok: z.boolean(), data: z.record(z.string(), z.unknown()).optional() }).parse(JSON.parse(event.result));
    if (!result.ok) continue;
    if (event.name === "contratos_extraer") validated.delete(id); // Una extracción posterior requiere validar de nuevo.
    else if (result.data?.mensaje_id === id && typeof result.data.clasificacion === "string") validated.add(id);
  }
  const messageIds = task.messageIds.length ? task.messageIds : [...selected];
  const missingMessageIds = messageIds.filter((id) => !validated.has(id));
  return { operation: "review", messageIds, validatedMessageIds: messageIds.filter((id) => validated.has(id)),
    missingMessageIds, needsTarget: messageIds.length === 0, validationComplete: messageIds.length > 0 && missingMessageIds.length === 0, correctionAttempts };
}

export function incompleteTaskReply(task: TaskProgress) {
  return task.needsTarget
    ? "Revisión incompleta: indica qué mensaje o contrato deseas revisar. No se ha ejecutado contratos_validar."
    : `Revisión incompleta: falta ejecutar correctamente contratos_validar para ${task.missingMessageIds.join(", ")}. La extracción no sustituye la validación; no se afirma que la revisión esté terminada.`;
}

export function taskInstruction(task: TaskProgress) {
  return [`Control de revisión del servidor: ${JSON.stringify(task)}`,
    "Debes validar cada missingMessageIds con contratos_validar; una extracción o un texto final no completan la revisión.",
    "Si correctionAttempts es 1, se rechazó un cierre anterior: completa los pasos pendientes. Si validationComplete es true, no repitas la validación.",
    "Si needsTarget es true, identifica el contrato mediante herramientas o solicita aclaración.",
    "No registres ni inventes referencias para satisfacer este control."].join(" ");
}
