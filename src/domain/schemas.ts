import { z } from "zod";

const requiredText = z.string().refine((value) => value.trim().length > 0, {
  message: "El campo obligatorio no puede estar vacío.",
});

export const dateSchema = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, { message: "Se requiere una fecha real con formato YYYY-MM-DD." });

export const relativePathSchema = requiredText.refine((value) => {
  const parts = value.replaceAll("\\", "/").split("/");
  return !value.startsWith("/") && !value.startsWith("\\") &&
    !value.includes(":") && !parts.includes("..") && !parts.includes("");
}, { message: "Se requiere una ruta relativa sin salir de su directorio." });

// Los valores del CSV llegan como texto. Solo se convierten después de validarlos.
const amountSchema = z.string().regex(/^\d+(\.\d+)?$/, {
  message: "El importe debe ser numérico, sin separadores de miles y no negativo.",
}).transform(Number).refine(Number.isFinite, { message: "El importe excede el rango numérico." });

export const masterRecordSchema = z.object({
  id_contrato: requiredText,
  cliente: requiredText,
  nit_cliente: z.string().regex(/^\d+$/, "El identificador debe contener solo dígitos, sin puntos ni guion."),
  pais: z.enum(["CO", "EC", "PE", "PA", "HN"]),
  objeto: requiredText.pipe(z.string().max(200)),
  valor: amountSchema,
  moneda: z.enum(["COP", "USD", "PEN", "PAB", "HNL"]),
  fecha_inicio: dateSchema,
  fecha_fin: dateSchema,
  requiere_poliza: z.enum(["true", "false"]).transform((value) => value === "true"),
  tipo_poliza: z.string(),
  estado_poliza: z.enum(["vigente", "pendiente", "vencida", "no_aplica"]),
  comercial: requiredText,
  ruta_sharepoint: relativePathSchema,
  fecha_registro: dateSchema,
  fuente: z.enum(["buzon", "manual", "migracion"]),
});

export const masterColumns = Object.keys(masterRecordSchema.shape);

export const commercialSchema = z.object({
  email: z.email(),
  nombre: requiredText,
  region: requiredText,
});

export const mailSchema = z.object({
  id: requiredText,
  de: z.email(),
  para: z.email(),
  asunto: requiredText,
  fecha: z.iso.datetime({ offset: true }).refine(
    (value) => dateSchema.safeParse(value.slice(0, 10)).success,
    "La fecha del correo debe ser una fecha real.",
  ),
  cuerpo: z.string(),
  adjuntos: z.array(relativePathSchema),
});

export type MasterRecord = z.infer<typeof masterRecordSchema>;
export type Commercial = z.infer<typeof commercialSchema>;
export type Mail = z.infer<typeof mailSchema>;

// La extracción es parcial; no debe validarse como una fila lista para escribir.
function extractedField<T extends z.ZodType>(schema: T) {
  return z.object({
    extraido: z.string().nullable(),
    normalizado: schema.nullable(),
    confianza: z.number().min(0).max(1),
    evidencia: z.string().nullable(),
  }).superRefine((field, ctx) => {
    if (field.extraido === null && (("normalizado" in field && field.normalizado !== null) || field.confianza !== 0 || field.evidencia !== null)) {
      ctx.addIssue({ code: "custom", message: "Un campo ausente debe conservar null y confianza 0." });
    }
    if (field.extraido !== null && !field.evidencia?.trim()) {
      ctx.addIssue({ code: "custom", message: "Todo dato encontrado debe conservar evidencia textual." });
    }
  });
}

export const extractionSchema = z.object({
  tipo_documento: z.enum(["contrato", "otrosi", "cotizacion", "desconocido"]),
  id_documento: extractedField(z.string()),
  campos: z.object({
    id_contrato: extractedField(z.string()),
    cliente: extractedField(z.string()),
    nit_cliente: extractedField(z.string().regex(/^\d+$/)),
    pais: extractedField(z.enum(["CO", "EC", "PE", "PA", "HN"])),
    objeto: extractedField(z.string()),
    valor: extractedField(z.number().finite().nonnegative()),
    moneda: extractedField(z.enum(["COP", "USD", "PEN", "PAB", "HNL"])),
    fecha_inicio: extractedField(dateSchema),
    fecha_fin: extractedField(dateSchema),
    requiere_poliza: extractedField(z.boolean()),
    tipo_poliza: extractedField(z.string()),
    estado_poliza: extractedField(z.enum(["vigente", "pendiente", "vencida", "no_aplica"])),
    comercial: extractedField(z.string()),
    ruta_sharepoint: extractedField(relativePathSchema),
    fecha_registro: extractedField(dateSchema),
    fuente: extractedField(z.enum(["buzon", "manual", "migracion"])),
  }),
  valor_indeterminado: extractedField(z.boolean()),
  plazo_meses: extractedField(z.number().int().positive()),
  condicion_poliza: extractedField(z.string()),
  campos_modificados: z.array(z.enum(["valor", "moneda", "fecha_fin"])),
  requiere_revision: z.array(z.string()),
  advertencias: z.array(z.object({ campo: z.string(), tipo: z.string(), descripcion: z.string() })),
});

export type Extraction = z.infer<typeof extractionSchema>;

// Propuesta en memoria: todavía admite campos pendientes y conserva el objeto íntegro.
export const proposedContractSchema = z.object({
  id_contrato: z.string().nullable(), cliente: z.string().nullable(),
  nit_cliente: z.string().regex(/^\d+$/).nullable(),
  pais: z.enum(["CO", "EC", "PE", "PA", "HN"]).nullable(),
  objeto: z.string().nullable(), valor: z.number().finite().nonnegative().nullable(),
  moneda: z.enum(["COP", "USD", "PEN", "PAB", "HNL"]).nullable(),
  fecha_inicio: dateSchema.nullable(), fecha_fin: dateSchema.nullable(),
  requiere_poliza: z.boolean().nullable(), tipo_poliza: z.string().nullable(),
  estado_poliza: z.enum(["vigente", "pendiente", "vencida", "no_aplica"]).nullable(),
  comercial: z.string().nullable(), ruta_sharepoint: relativePathSchema.nullable(),
  fecha_registro: dateSchema.nullable(), fuente: z.enum(["buzon", "manual", "migracion"]).nullable(),
});

const proposalValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const validationSchema = z.object({
  mensaje_id: z.string(), id_contrato: z.string().nullable(),
  id_contrato_existente: z.string().nullable(),
  tipo_operacion: z.enum(["nuevo", "actualizacion", "duplicado", "rechazado"]),
  estado_validacion: z.enum(["validado", "pendiente_revision", "no_aplica"]),
  elegible_registro: z.boolean(), requiere_revision: z.array(z.string()),
  motivos: z.array(z.string()), campos_pendientes: z.array(z.string()),
  datos_propuestos: proposedContractSchema.nullable(),
  valor_indeterminado: z.boolean().nullable(), comercial_remitente: z.string().nullable(),
  diferencias: z.array(z.object({ campo: proposedContractSchema.keyof(),
    anterior: proposalValueSchema, propuesto: proposalValueSchema })),
  advertencias: z.array(z.object({ campo: z.string(), tipo: z.string(), descripcion: z.string() })),
  evidencias: z.record(proposedContractSchema.keyof(), z.object({
    origen: z.enum(["documento", "maestro", "catalogo", "correo", "regla", "humano", "pendiente"]),
    confianza: z.number().min(0).max(1), evidencia: z.string().nullable(), regla: z.string().nullable(),
  })),
}).superRefine((result, ctx) => {
  const expected = ["nuevo", "actualizacion"].includes(result.tipo_operacion) && result.requiere_revision.length === 0;
  if (result.elegible_registro !== expected) ctx.addIssue({ code: "custom", message: "La elegibilidad no coincide con la operación y sus revisiones." });
  const expectedState = result.requiere_revision.length ? "pendiente_revision"
    : ["nuevo", "actualizacion"].includes(result.tipo_operacion) ? "validado" : "no_aplica";
  if (result.estado_validacion !== expectedState) ctx.addIssue({ code: "custom", message: "El estado no coincide con las revisiones y la operación." });
  if (["nuevo", "actualizacion"].includes(result.tipo_operacion) && result.datos_propuestos === null) {
    ctx.addIssue({ code: "custom", message: "Una operación propuesta debe incluir sus datos pendientes o validados." });
  }
  if (["duplicado", "rechazado"].includes(result.tipo_operacion) && (result.datos_propuestos !== null || result.diferencias.length > 0)) {
    ctx.addIssue({ code: "custom", message: "Un duplicado o rechazo no debe proponer escrituras." });
  }
});

export type ProposedContract = z.infer<typeof proposedContractSchema>;
export type Validation = z.infer<typeof validationSchema>;
