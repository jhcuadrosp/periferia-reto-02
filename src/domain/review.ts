import { z } from "zod";
import { validateContract } from "./validation.ts";
import { proposedContractSchema, type Commercial, type Extraction, type Mail, type MasterRecord, type Validation } from "./schemas.ts";

const correctionFields = ["id_contrato", "cliente", "nit_cliente", "pais", "objeto", "valor", "moneda",
  "fecha_inicio", "fecha_fin", "requiere_poliza", "tipo_poliza", "comercial", "tratamiento_valor", "tratamiento_poliza"] as const;
export const reviewerSchema = z.object({ id: z.string().trim().min(3), modo: z.literal("simulado_local") }).strict();
export type Reviewer = z.infer<typeof reviewerSchema>;
export const correctionSchema = z.object({
  campo: z.enum(correctionFields), valor: z.union([z.string(), z.number().finite(), z.boolean()]),
  justificacion: z.string().trim().min(8), procedencia: z.string().trim().min(3),
}).strict().superRefine((correction, ctx) => {
  const schema = correction.campo === "tratamiento_valor" ? z.literal("indeterminado_como_cero")
    : correction.campo === "tratamiento_poliza" ? z.enum(["condicion_activada", "condicion_no_activada"])
    : proposedContractSchema.shape[correction.campo];
  if (!schema.safeParse(correction.valor).success || (typeof correction.valor === "string" && correction.campo !== "tipo_poliza" && !correction.valor.trim())) {
    ctx.addIssue({ code: "custom", path: ["valor"], message: "Valor incompatible con el campo que se quiere corregir." });
  }
});
export const correctionsSchema = z.array(correctionSchema).superRefine((corrections, ctx) => {
  if (new Set(corrections.map((correction) => correction.campo)).size !== corrections.length) {
    ctx.addIssue({ code: "custom", message: "No se permite corregir dos veces el mismo campo en una revisión." });
  }
});
export type Correction = z.infer<typeof correctionSchema>;
export const correctionRecordSchema = correctionSchema.safeExtend({
  anterior: z.union([z.string(), z.number(), z.boolean(), z.null()]), revisor_id: z.string(), fecha: z.iso.datetime({ offset: true }),
});

export function reviewView(extraction: Extraction | null, validation: Validation, master: MasterRecord[]) {
  const original = master.find((row) => row.id_contrato === validation.id_contrato_existente) ?? null;
  const fields = [...validation.requiere_revision];
  if (validation.advertencias.some((warning) => warning.tipo === "REMITENTE_DESCONOCIDO")) fields.push("comercial");
  return { mensaje_id: validation.mensaje_id, id_contrato: validation.id_contrato, tipo_operacion: validation.tipo_operacion,
    revisable: ["nuevo", "actualizacion"].includes(validation.tipo_operacion) && validation.estado_validacion === "pendiente_revision",
    datos_documentales: extraction?.campos ?? null, datos_enriquecidos: validation.datos_propuestos,
    campos: fields.map((field) => ({ campo: field, bloqueante: validation.requiere_revision.includes(field),
      actual: original?.[field as keyof MasterRecord] ?? null,
      propuesto: validation.datos_propuestos?.[field as keyof MasterRecord] ?? null,
      evidencia: validation.evidencias[field as keyof MasterRecord] ?? null })),
    motivos: validation.motivos, advertencias: validation.advertencias };
}

export function applyHumanReview(extraction: Extraction, original: Validation, mail: Mail, master: MasterRecord[],
  commercials: Commercial[], supplied: unknown, reviewer: Reviewer, date: string) {
  reviewerSchema.parse(reviewer);
  if (!["nuevo", "actualizacion"].includes(original.tipo_operacion) || original.estado_validacion !== "pendiente_revision") {
    throw new Error("Solo pueden revisarse operaciones nuevas o actualizaciones pendientes, nunca duplicados o rechazos.");
  }
  const corrections = correctionsSchema.parse(supplied);
  const copy = structuredClone(extraction);
  const treatment = corrections.find((correction) => correction.campo === "tratamiento_valor");
  const policyTreatment = corrections.find((correction) => correction.campo === "tratamiento_poliza");
  const conditional = extraction.advertencias.some((warning) => warning.tipo === "POLIZA_CONDICIONAL");
  const records: z.infer<typeof correctionRecordSchema>[] = [];
  for (const correction of corrections) {
    const key = correction.campo;
    if (key === "tratamiento_valor") {
      if (extraction.valor_indeterminado.normalizado !== true || corrections.some((item) => item.campo === "valor")) {
        throw new Error("El tratamiento a cero solo aplica a valor documental indeterminado y no se combina con un importe real.");
      }
      records.push({ ...correction, anterior: "valor indeterminado; normalizado null", revisor_id: reviewer.id, fecha: date });
      // Es una propuesta para el maestro; el documento original continúa con valor null e indeterminado=true.
      copy.campos.valor = { extraido: correction.justificacion, normalizado: 0, confianza: 1, evidencia: correction.procedencia };
    } else if (key === "tratamiento_poliza") {
      if (!conditional) throw new Error("El documento no contiene una obligación condicional de póliza reconocida.");
      records.push({ ...correction, anterior: extraction.condicion_poliza.normalizado, revisor_id: reviewer.id, fecha: date });
    } else {
      const pending = original.requiere_revision.includes(key) || original.datos_propuestos?.[key] === null ||
        (key === "id_contrato" && original.requiere_revision.includes("contrato_base"));
      if (!pending) throw new Error(`El campo ${key} no está pendiente; no se modifica información ajena a la revisión.`);
      if (key === "valor" && extraction.valor_indeterminado.normalizado === true) {
        throw new Error("No sustituir valor indeterminado por un importe; declara expresamente su tratamiento para el maestro.");
      }
      records.push({ ...correction, anterior: original.datos_propuestos?.[key] ?? null, revisor_id: reviewer.id, fecha: date });
      // Parsear el resultado completo verifica el tipo concreto, sin cambiar la extracción original.
      copy.campos = { ...copy.campos, [key]: { extraido: String(correction.valor), normalizado: correction.valor,
        confianza: 1, evidencia: `${correction.procedencia}: ${correction.justificacion}` } };
    }
  }
  const policy = corrections.find((correction) => correction.campo === "requiere_poliza");
  if (conditional && (policy || policyTreatment)) {
    if (!policy || !policyTreatment || policy.valor !== (policyTreatment.valor === "condicion_activada")) {
      throw new Error("La decisión de póliza debe declarar la condición evaluada y una obligación coherente, con fundamento.");
    }
  }
  if (policy?.valor === false) copy.campos.tipo_poliza = { extraido: policy.justificacion, normalizado: "", confianza: 1, evidencia: policy.procedencia };
  const revised = validateContract(copy, mail, master, commercials);
  if (treatment && revised.datos_propuestos?.valor === 0) {
    revised.requiere_revision = revised.requiere_revision.filter((key) => key !== "valor");
    revised.motivos = revised.motivos.filter((reason) => !reason.startsWith("valor:"));
    revised.motivos.push("Revisión humana propone representar el valor indeterminado como cero en el maestro (PRD 7.2); no es un importe real.");
  }
  for (const correction of corrections) {
    const key = correction.campo === "tratamiento_valor" ? "valor" : correction.campo === "tratamiento_poliza" ? "requiere_poliza" : correction.campo;
    if (revised.datos_propuestos?.[key] === correction.valor || correction.campo.startsWith("tratamiento_")) {
      revised.evidencias[key] = { origen: "humano", confianza: 1,
        evidencia: `${reviewer.id}; ${date}; ${correction.procedencia}; ${correction.justificacion}`, regla: "Corrección humana explícita; pendiente de autorización de los valores finales" };
    }
  }
  if (policy?.valor === false) revised.evidencias.tipo_poliza = { origen: "regla", confianza: 1,
    evidencia: "requiere_poliza=false por revisión humana", regla: "PRD 7.2: tipo vacío; no elimina la condición original conservada en auditoría" };
  revised.estado_validacion = revised.requiere_revision.length ? "pendiente_revision" : ["nuevo", "actualizacion"].includes(revised.tipo_operacion) ? "validado" : "no_aplica";
  revised.elegible_registro = revised.estado_validacion === "validado";
  return { validacion: revised, correcciones: records, tratamiento_valor: treatment ? "indeterminado_como_cero" as const : null,
    condicion_poliza_original: extraction.condicion_poliza, extraccion_original: extraction };
}
