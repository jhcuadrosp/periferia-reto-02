import { createHash } from "node:crypto";
import { z } from "zod";
import { correctionRecordSchema, correctionsSchema, reviewerSchema } from "./review.ts";
import { extractionSchema, masterRecordSchema, relativePathSchema, validationSchema } from "./schemas.ts";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const storedContractSchema = masterRecordSchema.extend({ valor: z.number().finite().nonnegative(), requiere_poliza: z.boolean() });
export const confirmationContentSchema = z.object({
  solicitud_id: z.uuid(), mensaje_id: z.string(), adjunto: relativePathSchema,
  id_contrato: z.string().min(1), tipo_operacion: z.enum(["nuevo", "actualizacion"]),
  maestro_hash: hashSchema, entrada_hash: hashSchema, revisor: reviewerSchema,
  creada_en: z.iso.datetime({ offset: true }), caduca_en: z.iso.datetime({ offset: true }),
  validacion_original: validationSchema, extraccion_original: extractionSchema,
  correcciones_input: correctionsSchema, correcciones: z.array(correctionRecordSchema),
  validacion_revisada: validationSchema, datos_registro: storedContractSchema,
  tratamiento_valor: z.literal("indeterminado_como_cero").nullable(),
});
export const confirmationSchema = confirmationContentSchema.extend({
  datos_hash: hashSchema, contenido_hash: hashSchema,
  estado: z.enum(["pendiente", "aprobada", "rechazada", "utilizada"]),
  decision: z.object({ accion: z.enum(["aprobar", "rechazar"]), revisor_id: z.string(), fecha: z.iso.datetime({ offset: true }), datos_hash: hashSchema }).nullable(),
  utilizada_en: z.iso.datetime({ offset: true }).nullable(),
});
export type Confirmation = z.infer<typeof confirmationSchema>;
export const confirmationCommandSchema = z.object({ solicitud_id: z.uuid(), datos_hash: hashSchema }).strict();
export const decisionCommandSchema = confirmationCommandSchema.extend({ accion: z.enum(["aprobar", "rechazar"]) }).strict();
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function verifyConfirmation(supplied: unknown): Confirmation {
  const request = confirmationSchema.parse(supplied);
  if (digest(request.datos_registro) !== request.datos_hash || digest(confirmationContentSchema.parse(request)) !== request.contenido_hash) {
    throw new Error("Los datos o la revisión de la solicitud fueron modificados; requiere nueva revisión.");
  }
  if (request.mensaje_id !== request.validacion_original.mensaje_id || request.mensaje_id !== request.validacion_revisada.mensaje_id ||
    request.id_contrato !== request.datos_registro.id_contrato || request.tipo_operacion !== request.validacion_revisada.tipo_operacion ||
    (request.datos_registro.id_contrato !== request.validacion_revisada.datos_propuestos?.id_contrato && request.validacion_revisada.datos_propuestos?.id_contrato !== null)) {
    throw new Error("La solicitud no corresponde al mensaje o contrato revisado.");
  }
  if (request.estado === "pendiente" && (request.decision !== null || request.utilizada_en !== null)) throw new Error("Estado pendiente inconsistente.");
  if (request.estado !== "pendiente" && (!request.decision || request.decision.revisor_id !== request.revisor.id || request.decision.datos_hash !== request.datos_hash ||
    request.decision.accion !== (request.estado === "rechazada" ? "rechazar" : "aprobar"))) throw new Error("Falta una decisión explícita y coherente.");
  if ((request.estado === "utilizada") !== (request.utilizada_en !== null)) throw new Error("Estado de consumo inconsistente.");
  if (Date.parse(request.caduca_en) <= Date.parse(request.creada_en) ||
    (request.decision && (Date.parse(request.decision.fecha) < Date.parse(request.creada_en) || Date.parse(request.decision.fecha) >= Date.parse(request.caduca_en))) ||
    (request.utilizada_en && (Date.parse(request.utilizada_en) < Date.parse(request.decision!.fecha) || Date.parse(request.utilizada_en) >= Date.parse(request.caduca_en)))) {
    throw new Error("La cronología de la solicitud, decisión o consumo es inconsistente.");
  }
  return request;
}

export function checkAction(request: Confirmation, supplied: unknown, reviewer: unknown, now: string, expectedState: "pendiente" | "aprobada") {
  const command = confirmationCommandSchema.parse(supplied);
  const actor = reviewerSchema.parse(reviewer);
  if (request.solicitud_id !== command.solicitud_id || request.datos_hash !== command.datos_hash) throw new Error("La acción no autoriza estos valores concretos.");
  if (actor.id !== request.revisor.id) throw new Error("El revisor no coincide con la solicitud.");
  if (request.estado !== expectedState) throw new Error(`La solicitud no está ${expectedState}; no se reutiliza una decisión ni una solicitud consumida.`);
  const time = Date.parse(now);
  if (time < Date.parse(request.creada_en) || time >= Date.parse(request.caduca_en)) throw new Error("Solicitud caducada o reloj incoherente; requiere nueva revisión.");
}
