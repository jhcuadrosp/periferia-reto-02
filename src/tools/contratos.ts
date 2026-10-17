import { join } from "node:path";
import { z } from "zod";
import { generateAlerts, renderAlerts } from "../domain/alerts.ts";
import { confirmationCommandSchema, digest } from "../domain/confirmation.ts";
import { reviewerSchema } from "../domain/review.ts";
import { dateSchema, extractionSchema } from "../domain/schemas.ts";
import { readMailbox } from "../storage/mailbox.ts";
import { evaluateRegistration, getConfirmation, inspectMessageInput, persistConfirmedRegistration, persistRegistration,
  recordToolEvent, registrationTicketSchema, storageSnapshot, writeAlertsReport, type StorageResult } from "../storage/persistence.ts";

const messageId = z.string().regex(/^[\p{L}\p{N}_-]+$/u).describe("ID de la carpeta del mensaje dentro del buzón.");
const authorizationSchema = confirmationCommandSchema.extend({ revisor: reviewerSchema }).strict();
export type ToolContext = { directory: string; sessionId: string;
  // Contexto local proporcionado por el consumidor de confianza, nunca por argumentos del modelo.
  autorizacion?: z.infer<typeof authorizationSchema>; now?: () => string };
const contextSchema = z.object({ directory: z.string().min(1), sessionId: z.string().min(1),
  autorizacion: authorizationSchema.optional(), now: z.custom<() => string>((value) => typeof value === "function").optional() }).strict();

function unwrap<T>(result: StorageResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

// Límite común de las cinco herramientas: valida, controla errores y deja RN7.
async function executeTool<T extends z.ZodRawShape>(name: string, shape: T, supplied: unknown, context: ToolContext,
  operation: (args: z.infer<z.ZodObject<T>>, ctx: ToolContext) => Promise<Record<string, unknown>>) {
  let ctx: ToolContext | undefined;
  let result: { ok: true; data: Record<string, unknown> } | { ok: false; error: string };
  try {
    ctx = contextSchema.parse(context);
    const args = z.object(shape).strict().parse(supplied);
    result = { ok: true, data: await operation(args, ctx) };
  } catch (error) { result = { ok: false, error: error instanceof Error ? error.message : "Error de herramienta." }; }
  try {
    if (!ctx) throw new Error("Contexto inválido; no hay destino de auditoría confiable.");
    const id = z.object({ mensaje_id: messageId.optional() }).safeParse(supplied);
    await recordToolEvent(ctx.directory, { ts: z.iso.datetime({ offset: true }).parse(ctx.now?.() ?? new Date().toISOString()),
      herramienta: name, session_id: ctx.sessionId, mensaje_id: id.success ? id.data.mensaje_id ?? null : null,
      ok: result.ok, resumen: result.ok ? String(result.data.accion ?? result.data.estado ?? "completado") : result.error });
  } catch (error) {
    // Una operación ya aplicada no se presenta como fallida por un error posterior de auditoría.
    return JSON.stringify({ ...result, error_auditoria: error instanceof Error ? error.message : "Auditoría no disponible." });
  }
  return JSON.stringify(result);
}

async function attachment(directory: string, id: string) {
  const mailbox = await readMailbox(join(directory, "fixtures/reto-02/buzon"));
  if (!mailbox.ok) throw new Error(mailbox.problemas[0]!.descripcion);
  const message = mailbox.data.find((entry) => entry.carpeta === id);
  if (!message?.correo) throw new Error("Mensaje inexistente o metadatos inválidos.");
  if (message.problemas.some((problem) => problem.nivel === "error")) throw new Error("Mensaje con adjuntos o metadatos ilegibles.");
  const texts = message.adjuntos.filter((file) => file.formato === ".txt");
  if (texts.length > 1) throw new Error("Varios TXT en el mensaje; no se selecciona un contrato arbitrariamente.");
  if (!texts.length && message.correo.adjuntos.length) throw new Error("Formato de adjunto no soportado; se requiere TXT.");
  return texts[0]?.nombre ?? null;
}

export const leer_buzon = {
  description: "Lista mensajes no procesados y distingue contratos, documentos rechazados y problemas de lectura.",
  args: {},
  execute(args: unknown, ctx: ToolContext): Promise<string> {
    return executeTool("contratos_leer_buzon", leer_buzon.args, args, ctx, async (_, context) => {
      const snapshot = await storageSnapshot(context.directory);
      const mailbox = await readMailbox(join(context.directory, "fixtures/reto-02/buzon"));
      if (!mailbox.ok) throw new Error(mailbox.problemas[0]!.descripcion);
      const mensajes: Record<string, unknown>[] = [];
      for (const entry of mailbox.data) {
        if (entry.correo && Object.hasOwn(snapshot.processed, entry.correo.id)) continue;
        try {
          if (!entry.correo) throw new Error("Metadatos inválidos.");
          const ticket = unwrap(await evaluateRegistration(context.directory, entry.carpeta, await attachment(context.directory, entry.carpeta)));
          mensajes.push({ ...entry.correo, tiene_contrato: ticket.validacion.tipo_operacion !== "rechazado",
            clasificacion: ticket.validacion.tipo_operacion, problemas: entry.problemas });
        } catch (error) {
          mensajes.push({ id: entry.carpeta, ...(entry.correo ?? {}), tiene_contrato: false, estado: "error",
            error: error instanceof Error ? error.message : "Mensaje ilegible.", problemas: entry.problemas });
        }
      }
      return { mensajes };
    });
  },
};

export const extraer = {
  description: "Extrae campos contractuales con confianza y evidencias desde el TXT original del mensaje.",
  args: { mensaje_id: messageId },
  execute(args: unknown, ctx: ToolContext): Promise<string> {
    return executeTool("contratos_extraer", extraer.args, args, ctx, async (input, context) => {
      const original = await inspectMessageInput(context.directory, input.mensaje_id, await attachment(context.directory, input.mensaje_id));
      if (!original.extraction || !original.document?.toString("utf8").trim()) throw new Error("No hay texto contractual para extraer.");
      return original.extraction;
    });
  },
};

export const validar = {
  description: "Revalida la extracción contra sus fuentes y el maestro y devuelve clasificación, revisión y ticket de registro.",
  args: { mensaje_id: messageId, contrato: extractionSchema.strict().describe("Extracción documental devuelta por contratos_extraer, sin alteraciones.") },
  execute(args: unknown, ctx: ToolContext): Promise<string> {
    return executeTool("contratos_validar", validar.args, args, ctx, async (input, context) => {
      const name = await attachment(context.directory, input.mensaje_id);
      const original = await inspectMessageInput(context.directory, input.mensaje_id, name);
      if (digest(input.contrato) !== digest(original.extraction)) throw new Error("La extracción fue alterada; las correcciones deben pasar por revisión humana.");
      const ticket = unwrap(await evaluateRegistration(context.directory, input.mensaje_id, name));
      if (ticket.entrada_hash !== original.hash) throw new Error("Las fuentes cambiaron durante la validación; vuelve a extraer.");
      return { ...ticket.validacion, clasificacion: ticket.validacion.tipo_operacion,
        estado: ticket.validacion.estado_validacion, contrato: ticket };
    });
  },
};

export const registrar = {
  description: "Registra un ticket revalidado; las revisiones requieren una autorización humana aprobada en el contexto local.",
  args: { mensaje_id: messageId, contrato: registrationTicketSchema.describe("Ticket íntegro devuelto como contrato por contratos_validar."),
    confirmado: z.boolean().optional().describe("Indica ejecución confirmada; true requiere además solicitud humana aprobada en el contexto.") },
  execute(args: unknown, ctx: ToolContext): Promise<string> {
    return executeTool("contratos_registrar", registrar.args, args, ctx, async (input, context) => {
      if (input.mensaje_id !== input.contrato.mensaje_id) throw new Error("El ticket pertenece a otro mensaje.");
      const options = { now: context.now };
      if (input.confirmado === true) {
        if (!context.autorizacion) throw new Error("confirmado=true no concede autorización humana; falta solicitud aprobada.");
        // La solicitud almacenada debe corresponder exactamente al ticket presentado.
        const request = unwrap(await getConfirmation(context.directory, context.autorizacion.solicitud_id, options));
        if (request.mensaje_id !== input.mensaje_id || request.adjunto !== input.contrato.adjunto ||
          request.maestro_hash !== input.contrato.maestro_hash || request.entrada_hash !== input.contrato.entrada_hash ||
          digest(request.validacion_original) !== digest(input.contrato.validacion)) throw new Error("La autorización no corresponde al ticket presentado.");
        const outcome = unwrap(await persistConfirmedRegistration(context.directory,
          { solicitud_id: context.autorizacion.solicitud_id, datos_hash: context.autorizacion.datos_hash }, context.autorizacion.revisor, options));
        return { ...outcome, estado: "aplicado" };
      }
      if (context.autorizacion) throw new Error("La ejecución de una autorización requiere confirmado=true explícito.");
      const outcome = unwrap(await persistRegistration(context.directory, input.contrato, options));
      if (outcome.accion === "pendiente_revision") return { ...outcome, estado: "requiere_revision", aplicado: false };
      return { ...outcome, estado: ["registrado", "actualizado"].includes(outcome.accion) ? "aplicado" : "sin_escritura_contractual" };
    });
  },
};

export const alertas = {
  description: "Genera alertas de vencimientos, pólizas y registros desde el corte para una fecha explícita, sin modificar el maestro.",
  args: { hoy: dateSchema.describe("Fecha de referencia reproducible en formato YYYY-MM-DD.") },
  execute(args: unknown, ctx: ToolContext): Promise<string> {
    return executeTool("contratos_alertas", alertas.args, args, ctx, async (input, context) => {
      const snapshot = await storageSnapshot(context.directory);
      const report = generateAlerts(snapshot.records, input.hoy, snapshot.history);
      await writeAlertsReport(context.directory, renderAlerts(report), snapshot.maestro_hash, snapshot.historial_hash);
      return { ruta: "out/alertas.md", ...report };
    });
  },
};
