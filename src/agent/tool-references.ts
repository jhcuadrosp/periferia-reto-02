import { randomUUID } from "node:crypto";
import { z } from "zod";
import * as contracts from "../tools/contratos.ts";
import { extractionSchema } from "../domain/schemas.ts";
import { digest } from "../domain/confirmation.ts";
import { registrationTicketSchema } from "../storage/persistence.ts";
import type { Session, ToolReference } from "./session.ts";

const finishQuery = z.boolean().optional().describe("true solo si esta consulta completa toda la petición, sin validaciones o acciones posteriores; permite responder sin otra inferencia.");
const reference = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  .describe("Referencia exacta devuelta por la herramienta anterior en esta sesión; nunca fabricar ni reconstruir el contrato.");
// El transporte es pequeño; las herramientas del PRD conservan sus esquemas originales.
export const referenceShapes = {
  contratos_leer_buzon: { ...contracts.leer_buzon.args, finalizar_consulta: finishQuery },
  contratos_extraer: { ...contracts.extraer.args, finalizar_consulta: finishQuery },
  contratos_validar: { mensaje_id: contracts.validar.args.mensaje_id, contrato_ref: reference },
  contratos_registrar: { mensaje_id: contracts.registrar.args.mensaje_id, contrato_ref: reference, confirmado: contracts.registrar.args.confirmado },
  contratos_alertas: { ...contracts.alertas.args, finalizar_consulta: finishQuery },
};

export function resolveToolArguments(name: string, supplied: unknown, session: Session) {
  if (!Object.hasOwn(referenceShapes, name)) throw new Error("Herramienta no permitida.");
  const shape = referenceShapes[name as keyof typeof referenceShapes];
  const parsed = z.object(shape).strict().safeParse(supplied);
  if (!parsed.success) throw new Error("Argumentos inválidos según el contrato Zod de la herramienta.");
  const args = parsed.data;
  if (!("contrato_ref" in args)) {
    const { finalizar_consulta, ...original } = args;
    return { args: original, finishQuery: finalizar_consulta === true };
  }
  const stored = session.references.get(args.contrato_ref);
  const kind = name === "contratos_validar" ? "extraction" : "ticket";
  if (!stored || stored.kind !== kind || stored.mensaje_id !== args.mensaje_id || digest(stored.value) !== stored.hash) {
    throw new Error("Referencia inválida o desactualizada para este mensaje y sesión; vuelve a extraer o validar.");
  }
  const { contrato_ref: _, ...original } = args;
  return { args: { ...original, contrato: structuredClone(stored.value) }, finishQuery: false };
}

function remember(session: Session, id: string, kind: ToolReference["kind"], value: ToolReference["value"]) {
  for (const [key, entry] of session.references) {
    if (entry.mensaje_id === id && (kind === "extraction" || entry.kind === kind)) session.references.delete(key);
  }
  if (kind === "extraction") session.tickets.delete(id);
  const ref = randomUUID();
  session.references.set(ref, { mensaje_id: id, kind, value: structuredClone(value), hash: digest(value) });
  return ref;
}
const pick = (data: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((key) => key in data).map((key) => [key, data[key]]));

export function referenceResult(name: string, id: string, data: Record<string, unknown>, session: Session) {
  if (name === "contratos_extraer") {
    const extraction = extractionSchema.parse(data);
    return { mensaje_id: id, contrato_ref: remember(session, id, "extraction", extraction), tipo_documento: extraction.tipo_documento,
      campos: Object.fromEntries(Object.entries(extraction.campos).map(([name, field]) => [name, { normalizado: field.normalizado, confianza: field.confianza }])),
      valor_indeterminado: extraction.valor_indeterminado.normalizado, requiere_revision: extraction.requiere_revision,
      advertencias: extraction.advertencias };
  }
  if (name === "contratos_validar") {
    const ticket = registrationTicketSchema.parse(data.contrato);
    return { ...pick(data, ["mensaje_id", "clasificacion", "estado", "estado_validacion", "requiere_revision", "motivos", "datos_propuestos", "diferencias", "advertencias"]),
      contrato_ref: remember(session, id, "ticket", ticket) };
  }
  if (name === "contratos_leer_buzon" && Array.isArray(data.mensajes)) {
    return { mensajes: data.mensajes.map((item: unknown) => pick(z.record(z.string(), z.unknown()).parse(item),
      ["id", "de", "asunto", "fecha", "adjuntos", "tiene_contrato", "clasificacion", "estado", "error", "problemas"])) };
  }
  return data;
}
