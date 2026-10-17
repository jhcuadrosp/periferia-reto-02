import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { extractContract } from "../domain/extraction.ts";
import { diagnoseCommercials, diagnoseMaster } from "../domain/quality.ts";
import { prepareRegistration, rawRecord, safeSegment } from "../domain/registration.ts";
import { validateContract } from "../domain/validation.ts";
import { applyHumanReview, correctionsSchema, reviewerSchema, reviewView } from "../domain/review.ts";
import { checkAction, confirmationCommandSchema, confirmationContentSchema, decisionCommandSchema, digest,
  verifyConfirmation, type Confirmation } from "../domain/confirmation.ts";
import { mailSchema, relativePathSchema, validationSchema, type MasterRecord, type Validation } from "../domain/schemas.ts";
import { parseCsv, type CsvData } from "./csv.ts";
import { appendJsonLine, appendLog, commitFiles, hashBytes, optionalBytes, outputPath, recoverTransaction, type CommitOptions } from "./audit.ts";

const masterName = "sharepoint/maestro-contratos.csv";
const processedSchema = z.record(z.string(), z.object({ entrada_hash: z.string(), tipo_operacion: z.string(),
  id_contrato: z.string().nullable(), ts: z.string() }));
export const registrationTicketSchema = z.object({
  mensaje_id: z.string(), adjunto: relativePathSchema.nullable(), maestro_hash: z.string(), entrada_hash: z.string(),
  validacion: validationSchema,
}).strict();
export type RegistrationTicket = z.infer<typeof registrationTicketSchema>;
type Outcome = { accion: "registrado" | "actualizado" | "duplicado" | "rechazado" | "pendiente_revision" | "ya_procesado" | "sin_cambios";
  mensaje_id: string; id_contrato: string | null; tipo_operacion: Validation["tipo_operacion"]; ruta_archivo?: string;
  requiere_revision: string[] };
export type StorageResult<T> = { ok: true; data: T } | { ok: false; error: string };
export type PersistenceOptions = CommitOptions & { now?: () => string };

// Un proceso local: todas las operaciones sobre el mismo out/ se serializan.
const queues = new Map<string, Promise<unknown>>();
async function serialized<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const key = await realpath(directory);
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(key, next);
  try { return await next; }
  finally { if (queues.get(key) === next) queues.delete(key); }
}

async function initialize(directory: string) {
  await mkdir(await outputPath(directory, "."), { recursive: true });
  await recoverTransaction(directory);
  await mkdir(await outputPath(directory, "sharepoint/Contratos"), { recursive: true });
  const masterPath = await outputPath(directory, masterName);
  if (!(await optionalBytes(masterPath))) {
    const original = await readFile(join(directory, "fixtures/reto-02/maestro-contratos.csv"));
    await writeFile(masterPath, original, { flag: "wx" });
  }
  for (const [name, initial] of [["sharepoint/historial.jsonl", ""], ["procesados.json", "{}\n"], ["log.jsonl", ""]]) {
    const path = await outputPath(directory, name!);
    if ((await optionalBytes(path)) === null) await writeFile(path, initial!, { flag: "wx" });
  }
}

export async function initializeStorage(directory: string): Promise<StorageResult<null>> {
  try { await serialized(directory, () => initialize(directory)); return { ok: true, data: null }; }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Error inicializando out/." }; }
}

// Solo se invoca explícitamente para una prueba o demostración, nunca al ejecutar registro normal.
export async function resetStorage(directory: string, purpose: "prueba" | "demostracion"): Promise<StorageResult<null>> {
  try {
    z.enum(["prueba", "demostracion"]).parse(purpose);
    await serialized(directory, async () => {
      const out = await outputPath(directory, ".");
      const root = await realpath(directory);
      if (relative(root, out) !== "out") throw new Error("Reinicio fuera del out/ del proyecto.");
      await rm(out, { recursive: true, force: true });
      await initialize(directory);
    });
    return { ok: true, data: null };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Error reiniciando out/." }; }
}

async function masterState(directory: string) {
  const bytes = await readFile(await outputPath(directory, masterName));
  const parsed = parseCsv(bytes.toString("utf8"), masterName);
  if (!parsed.ok) throw new Error(parsed.problemas[0]!.descripcion);
  const report = diagnoseMaster(parsed.data, masterName);
  if (report.problemas.some((problem) => problem.nivel === "error") || report.duplicados.length) throw new Error("Maestro de salida inválido; no se sobrescribe.");
  return { bytes, hash: hashBytes(bytes), csv: parsed.data, records: report.registros };
}

async function inputState(directory: string, messageId: string, attachment: string | null) {
  safeSegment(messageId);
  const folder = await realpath(join(directory, "fixtures/reto-02/buzon", messageId));
  const mailbox = await realpath(join(directory, "fixtures/reto-02/buzon"));
  const relativeFolder = relative(mailbox, folder);
  if (isAbsolute(relativeFolder) || relativeFolder.startsWith(`..${sep}`) || relativeFolder === "..") throw new Error("Mensaje fuera del buzón.");
  const mailPath = await realpath(join(folder, "correo.json"));
  const relativeMail = relative(folder, mailPath);
  if (isAbsolute(relativeMail) || relativeMail === ".." || relativeMail.startsWith(`..${sep}`)) throw new Error("Correo fuera de la carpeta del mensaje.");
  const mailBytes = await readFile(mailPath);
  const mail = mailSchema.parse(JSON.parse(mailBytes.toString("utf8")));
  if (mail.id !== messageId) throw new Error("El ID del correo no coincide con la carpeta.");
  let document: Buffer | null = null;
  if (attachment !== null) {
    relativePathSchema.parse(attachment);
    if (!mail.adjuntos.includes(attachment)) throw new Error("El adjunto no está referenciado por el correo.");
    const path = await realpath(join(folder, attachment));
    const rel = relative(folder, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Adjunto fuera de la carpeta del mensaje.");
    document = await readFile(path);
  } else if (mail.adjuntos.length) throw new Error("Debes indicar el adjunto a evaluar.");
  const catalogBytes = await readFile(join(directory, "fixtures/reto-02/comerciales.json"));
  const catalog = diagnoseCommercials(JSON.parse(catalogBytes.toString("utf8")), "comerciales.json");
  if (catalog.problemas.some((problem) => problem.nivel === "error") || catalog.duplicados.length) throw new Error("Catálogo inválido o ambiguo.");
  const extraction = document === null ? null : extractContract(document.toString("utf8"));
  const hash = hashBytes(JSON.stringify([mailBytes.toString("base64"), attachment, document?.toString("base64"), catalogBytes.toString("base64")]));
  return { mail, document, extraction, commercials: catalog.registros, hash };
}

// Adaptadores para herramientas: comparten la misma cola y recuperación del registro.
export function inspectMessageInput(directory: string, messageId: string, attachment: string | null) {
  return serialized(directory, () => inputState(directory, messageId, attachment));
}

export function storageSnapshot(directory: string) {
  return serialized(directory, async () => {
    await initialize(directory);
    const master = await masterState(directory);
    const processed = processedSchema.parse(JSON.parse((await readFile(await outputPath(directory, "procesados.json"))).toString("utf8")));
    const historyBytes = await readFile(await outputPath(directory, "sharepoint/historial.jsonl"));
    const history: unknown[] = historyBytes.toString("utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    return { records: master.records, maestro_hash: master.hash, processed, history, historial_hash: hashBytes(historyBytes) };
  });
}

export function recordToolEvent(directory: string, event: unknown) {
  return serialized(directory, async () => { await initialize(directory); await appendLog(directory, event); });
}

export function writeAlertsReport(directory: string, markdown: string, masterHash: string, historyHash: string) {
  return serialized(directory, async () => {
    await initialize(directory);
    if (hashBytes(await readFile(await outputPath(directory, "sharepoint/historial.jsonl"))) !== historyHash) {
      throw new Error("El historial cambió; vuelve a generar las alertas.");
    }
    await commitFiles(directory, [{ ruta: "alertas.md", data: Buffer.from(markdown) }], masterHash);
  });
}

export async function evaluateRegistration(directory: string, messageId: string, attachment: string | null): Promise<StorageResult<RegistrationTicket>> {
  try {
    return await serialized(directory, async () => {
      await initialize(directory);
      const master = await masterState(directory);
      const input = await inputState(directory, messageId, attachment);
      return { ok: true, data: { mensaje_id: messageId, adjunto: attachment, maestro_hash: master.hash, entrada_hash: input.hash,
        validacion: validateContract(input.extraction, input.mail, master.records, input.commercials) } };
    });
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Error de evaluación." }; }
}

function serializeCsv(csv: CsvData, rows: Record<string, string>[]) {
  const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  return `${[csv.columnas, ...rows.map((row) => csv.columnas.map((column) => row[column] ?? ""))].map((row) => row.map(quote).join(",")).join("\n")}\n`;
}

function timestamp(options: PersistenceOptions) {
  return z.iso.datetime({ offset: true }).parse(options.now?.() ?? new Date().toISOString());
}

function registrationDate(ts: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Cancun", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ts));
}

async function persistRegistrationLocked(directory: string, supplied: unknown, options: PersistenceOptions, authorized?: Confirmation): Promise<StorageResult<Outcome>> {
      await initialize(directory);
      let ticket: RegistrationTicket | undefined;
      const ts = timestamp(options);
      try {
        if (authorized) checkAction(authorized, { solicitud_id: authorized.solicitud_id, datos_hash: authorized.datos_hash }, authorized.revisor, ts, "aprobada");
        ticket = registrationTicketSchema.parse(supplied);
        const input = await inputState(directory, ticket.mensaje_id, ticket.adjunto);
        if (input.hash !== ticket.entrada_hash) throw new Error("Correo, adjunto o catálogo cambiaron; vuelve a evaluar.");
        const master = await masterState(directory);
        const processedPath = await outputPath(directory, "procesados.json");
        const processed = processedSchema.parse(JSON.parse((await readFile(processedPath)).toString("utf8")));
        const originalValidation = validateContract(input.extraction, input.mail, master.records, input.commercials);
        let fresh = originalValidation;
        let outcome: Outcome;
        let files: { ruta: string; data: Uint8Array }[] = [];
        let history: unknown = null;
        let prepared: ReturnType<typeof prepareRegistration> | null = null;
        if (Object.hasOwn(processed, ticket.mensaje_id)) {
          if (authorized) throw new Error("La operación ya fue procesada; la autorización no se aplica de nuevo.");
          const previous = processed[ticket.mensaje_id]!;
          if (previous.entrada_hash !== input.hash) throw new Error("Un mensaje procesado cambió de contenido; no se repite automáticamente.");
          outcome = { accion: "ya_procesado", mensaje_id: ticket.mensaje_id, id_contrato: previous.id_contrato,
            tipo_operacion: z.enum(["nuevo", "actualizacion", "duplicado", "rechazado"]).parse(previous.tipo_operacion), requiere_revision: [] };
        } else {
          if (master.hash !== ticket.maestro_hash) throw new Error("El maestro cambió desde la validación; vuelve a evaluar.");
          if (JSON.stringify(originalValidation) !== JSON.stringify(ticket.validacion)) throw new Error("El resultado suministrado no coincide con las reglas recalculadas.");
          if (authorized) {
            if (!input.extraction) throw new Error("Falta documento para revalidar la revisión.");
            const reviewed = applyHumanReview(input.extraction, originalValidation, input.mail, master.records,
              input.commercials, authorized.correcciones_input, authorized.revisor, authorized.creada_en);
            if (JSON.stringify(reviewed.validacion) !== JSON.stringify(authorized.validacion_revisada)) throw new Error("La revisión autorizada ya no coincide con las reglas.");
            fresh = reviewed.validacion;
          }
          const pending = fresh.estado_validacion === "pendiente_revision";
          const noChanges = fresh.tipo_operacion === "actualizacion" && fresh.diferencias.length === 0;
          if (authorized && (!fresh.elegible_registro || noChanges)) throw new Error("La revisión no es elegible o su operación equivalente ya está aplicada.");
          const action = pending ? "pendiente_revision" : noChanges ? "sin_cambios" : fresh.tipo_operacion === "nuevo" ? "registrado"
            : fresh.tipo_operacion === "actualizacion" ? "actualizado" : fresh.tipo_operacion;
          outcome = { accion: action, mensaje_id: ticket.mensaje_id, id_contrato: fresh.id_contrato,
            tipo_operacion: fresh.tipo_operacion, requiere_revision: fresh.requiere_revision };
          if (fresh.elegible_registro && !noChanges) {
            if (!ticket.adjunto || !input.document) throw new Error("Falta documento original para archivar.");
            const date = registrationDate(ts);
            prepared = prepareRegistration(fresh, master.records, ticket.adjunto, date, input.mail.de, authorized?.tratamiento_valor ?? undefined);
            if (authorized && digest(prepared.record) !== authorized.datos_hash) throw new Error("Los valores finales no coinciden con los autorizados, incluida la fecha o ID automático; requiere nueva revisión.");
            const archive = `sharepoint/${prepared.archive}`;
            if ((await optionalBytes(await outputPath(directory, archive))) !== null) throw new Error("Ya existe el archivo de destino; no se reemplaza.");
            const rows = master.csv.registros.map((row) => ({ ...row }));
            const raw = rawRecord(prepared.record);
            if (fresh.tipo_operacion === "nuevo") rows.push(raw);
            else {
              const index = rows.findIndex((row) => row.id_contrato === fresh.id_contrato_existente);
              if (index < 0) throw new Error("El contrato a actualizar ya no existe.");
              const current = rows[index]!;
              for (const difference of fresh.diferencias) current[difference.campo] = raw[difference.campo]!;
            }
            history = { ts, id_contrato: prepared.record.id_contrato, accion: fresh.tipo_operacion,
              cambios: fresh.tipo_operacion === "actualizacion" ? fresh.diferencias
                : Object.entries(prepared.record).map(([campo, propuesto]) => ({ campo, anterior: null, propuesto })),
              mensaje_id: ticket.mensaje_id, ruta_archivo: prepared.archive, derivados: prepared.derivados,
              evidencias: fresh.evidencias, advertencias: fresh.advertencias,
              obligaciones_pendientes: fresh.advertencias.filter((warning) => warning.tipo === "AMPLIAR_GARANTIAS"),
              revision_humana: authorized ? { solicitud_id: authorized.solicitud_id, datos_hash: authorized.datos_hash,
                revisor: authorized.revisor, decision: authorized.decision, correcciones: authorized.correcciones,
                tratamiento_valor: authorized.tratamiento_valor, valor_indeterminado_documental: authorized.extraccion_original.valor_indeterminado,
                condicion_poliza_documental: authorized.extraccion_original.condicion_poliza } : null };
            const oldHistory = await readFile(await outputPath(directory, "sharepoint/historial.jsonl"));
            files = [{ ruta: archive, data: input.document }, { ruta: masterName, data: Buffer.from(serializeCsv(master.csv, rows)) },
              { ruta: "sharepoint/historial.jsonl", data: appendJsonLine(oldHistory, history) }];
            outcome.id_contrato = prepared.record.id_contrato;
            outcome.ruta_archivo = prepared.archive;
          }
          if (!pending) {
            processed[ticket.mensaje_id] = { entrada_hash: input.hash, tipo_operacion: fresh.tipo_operacion,
              id_contrato: outcome.id_contrato, ts };
            files.push({ ruta: "procesados.json", data: Buffer.from(`${JSON.stringify(processed, null, 2)}\n`) });
          }
        }
        if (authorized) {
          const current = await readConfirmation(directory, authorized.solicitud_id);
          if (JSON.stringify(current) !== JSON.stringify(authorized)) throw new Error("La autorización almacenada cambió durante la operación.");
          files.push({ ruta: confirmationPath(authorized.solicitud_id),
            data: Buffer.from(JSON.stringify({ ...authorized, estado: "utilizada", utilizada_en: ts }, null, 2)) });
        }
        const event = { ts, herramienta: "registro_local", mensaje_id: ticket.mensaje_id, ok: true, resumen: outcome.accion,
          resultado: outcome, validacion: fresh, maestro_hash: master.hash, entrada_hash: input.hash,
          obligaciones_pendientes: fresh.advertencias.filter((warning) => warning.tipo === "AMPLIAR_GARANTIAS"),
          derivados: prepared?.derivados ?? null,
          confirmacion: authorized ? { solicitud_id: authorized.solicitud_id, revisor: authorized.revisor,
            decision: authorized.decision, datos_hash: authorized.datos_hash, correcciones: authorized.correcciones } : null };
        const log = await readFile(await outputPath(directory, "log.jsonl"));
        files.push({ ruta: "log.jsonl", data: appendJsonLine(log, event) });
        const commitOptions: PersistenceOptions = authorized ? { ...options, beforeReplace: async (path, index) => {
          await options.beforeReplace?.(path, index);
          const now = timestamp(options);
          checkAction(authorized, { solicitud_id: authorized.solicitud_id, datos_hash: authorized.datos_hash }, authorized.revisor, now, "aprobada");
          if (prepared && registrationDate(now) !== prepared.record.fecha_registro && fresh.tipo_operacion === "nuevo") {
            throw new Error("La fecha de registro cambió durante la escritura; requiere nueva revisión.");
          }
        } } : options;
        await commitFiles(directory, files, master.hash, commitOptions);
        return { ok: true, data: outcome };
      } catch (error) {
        const message = error instanceof Error ? error.message : "Error de persistencia.";
        try {
          if (await optionalBytes(await outputPath(directory, ".transaccion.json"))) throw new Error("Diario pendiente; no se altera auditoría.");
          await appendLog(directory, { ts, herramienta: "registro_local", mensaje_id: ticket?.mensaje_id ?? null,
            ok: false, resumen: message, validacion: ticket?.validacion ?? null });
        } catch { return { ok: false, error: `${message} No se pudo completar el log de error.` }; }
        return { ok: false, error: message };
      }
}

export async function persistRegistration(directory: string, supplied: unknown, options: PersistenceOptions = {}): Promise<StorageResult<Outcome>> {
  try { return await serialized(directory, () => persistRegistrationLocked(directory, supplied, options)); }
  catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Error accediendo al almacenamiento." }; }
}

const confirmationPath = (id: string) => `confirmaciones/${z.uuid().parse(id)}.json`;
async function readConfirmation(directory: string, id: string) {
  return verifyConfirmation(JSON.parse((await readFile(await outputPath(directory, confirmationPath(id)))).toString("utf8")));
}

async function reviewStorage<T>(directory: string, options: PersistenceOptions, operation: (ts: string) => Promise<T>): Promise<StorageResult<T>> {
  try {
    return await serialized(directory, async () => {
      await initialize(directory);
      const ts = timestamp(options);
      try { return { ok: true, data: await operation(ts) }; }
      catch (error) {
        const message = error instanceof Error ? error.message : "Error de revisión o confirmación.";
        try {
          if (await optionalBytes(await outputPath(directory, ".transaccion.json"))) throw new Error("Recuperación pendiente.");
          await appendLog(directory, { ts, herramienta: "confirmacion_local", mensaje_id: null, ok: false, resumen: message });
        } catch { return { ok: false, error: `${message} No se pudo completar el log de error.` }; }
        return { ok: false, error: message };
      }
    });
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "Error accediendo al almacenamiento de revisiones." }; }
}

async function reviewContext(directory: string, supplied: unknown) {
  const ticket = registrationTicketSchema.parse(supplied);
  const master = await masterState(directory);
  const input = await inputState(directory, ticket.mensaje_id, ticket.adjunto);
  if (master.hash !== ticket.maestro_hash || input.hash !== ticket.entrada_hash) throw new Error("Maestro o fuentes cambiaron; vuelve a evaluar antes de revisar o confirmar.");
  const validation = validateContract(input.extraction, input.mail, master.records, input.commercials);
  if (JSON.stringify(validation) !== JSON.stringify(ticket.validacion)) throw new Error("Evaluación de origen alterada.");
  return { ticket, master, input, validation };
}

export function inspectReview(directory: string, supplied: unknown, options: PersistenceOptions = {}) {
  return reviewStorage(directory, options, async () => {
    const context = await reviewContext(directory, supplied);
    return reviewView(context.input.extraction, context.validation, context.master.records);
  });
}

export function createConfirmation(directory: string, supplied: unknown, corrections: unknown, reviewer: unknown,
  options: PersistenceOptions & { ttlMinutes?: number } = {}) {
  return reviewStorage(directory, options, async (ts) => {
    const context = await reviewContext(directory, supplied);
    if (!context.input.extraction || !context.ticket.adjunto) throw new Error("No hay documento revisable.");
    const processed = processedSchema.parse(JSON.parse((await readFile(await outputPath(directory, "procesados.json"))).toString("utf8")));
    if (Object.hasOwn(processed, context.ticket.mensaje_id)) throw new Error("El mensaje ya fue procesado.");
    const actor = reviewerSchema.parse(reviewer);
    const correctionInputs = correctionsSchema.parse(corrections);
    const review = applyHumanReview(context.input.extraction, context.validation, context.input.mail, context.master.records,
      context.input.commercials, correctionInputs, actor, ts);
    if (!review.validacion.elegible_registro || !["nuevo", "actualizacion"].includes(review.validacion.tipo_operacion)) {
      await appendLog(directory, { ts, herramienta: "revision_local", mensaje_id: context.ticket.mensaje_id, ok: true,
        resumen: "revision_incompleta", revisor: actor, correcciones: review.correcciones,
        validacion: review.validacion, maestro_hash: context.master.hash, entrada_hash: context.input.hash });
      throw new Error(`Revisión incompleta o no registrable: ${review.validacion.requiere_revision.join(", ") || review.validacion.tipo_operacion}.`);
    }
    if (review.validacion.tipo_operacion === "actualizacion" && !review.validacion.diferencias.length) throw new Error("La operación equivalente ya está aplicada.");
    const date = registrationDate(ts);
    const prepared = prepareRegistration(review.validacion, context.master.records, context.ticket.adjunto, date, context.input.mail.de,
      review.tratamiento_valor ?? undefined);
    const ttl = z.number().int().min(1).max(60).parse(options.ttlMinutes ?? 30);
    const content = confirmationContentSchema.parse({ solicitud_id: randomUUID(), mensaje_id: context.ticket.mensaje_id,
      id_contrato: prepared.record.id_contrato, tipo_operacion: review.validacion.tipo_operacion,
      adjunto: context.ticket.adjunto, maestro_hash: context.master.hash, entrada_hash: context.input.hash, revisor: actor,
      creada_en: ts, caduca_en: new Date(Date.parse(ts) + ttl * 60_000).toISOString(),
      validacion_original: context.validation, extraccion_original: context.input.extraction,
      correcciones_input: correctionInputs, correcciones: review.correcciones, validacion_revisada: review.validacion,
      datos_registro: prepared.record, tratamiento_valor: review.tratamiento_valor });
    const request = verifyConfirmation({ ...content, datos_hash: digest(content.datos_registro), contenido_hash: digest(content),
      estado: "pendiente", decision: null, utilizada_en: null });
    const path = confirmationPath(request.solicitud_id);
    if (await optionalBytes(await outputPath(directory, path))) throw new Error("Identificador de solicitud ya existente.");
    await saveConfirmation(directory, request, context.master.hash, ts, "solicitud_creada", options);
    return request;
  });
}

async function saveConfirmation(directory: string, request: Confirmation, masterHash: string, ts: string, summary: string, options: PersistenceOptions) {
  const log = await readFile(await outputPath(directory, "log.jsonl"));
  await commitFiles(directory, [
    { ruta: confirmationPath(request.solicitud_id), data: Buffer.from(JSON.stringify(request, null, 2)) },
    { ruta: "log.jsonl", data: appendJsonLine(log, { ts, herramienta: "confirmacion_local", mensaje_id: request.mensaje_id,
      ok: true, resumen: summary, solicitud_id: request.solicitud_id, revisor: request.revisor,
      datos_hash: request.datos_hash, maestro_hash: request.maestro_hash, entrada_hash: request.entrada_hash,
      correcciones: request.correcciones, decision: request.decision }) },
  ], masterHash, options);
}

export function getConfirmation(directory: string, id: string, options: PersistenceOptions = {}) {
  return reviewStorage(directory, options, () => readConfirmation(directory, id));
}

export function decideConfirmation(directory: string, supplied: unknown, reviewer: unknown, options: PersistenceOptions = {}) {
  return reviewStorage(directory, options, async (ts) => {
    const command = decisionCommandSchema.parse(supplied);
    const request = await readConfirmation(directory, command.solicitud_id);
    checkAction(request, { solicitud_id: command.solicitud_id, datos_hash: command.datos_hash }, reviewer, ts, "pendiente");
    await reviewContext(directory, { mensaje_id: request.mensaje_id, adjunto: request.adjunto,
      maestro_hash: request.maestro_hash, entrada_hash: request.entrada_hash, validacion: request.validacion_original });
    const decided = verifyConfirmation({ ...request, estado: command.accion === "aprobar" ? "aprobada" : "rechazada",
      decision: { accion: command.accion, revisor_id: reviewerSchema.parse(reviewer).id, fecha: ts, datos_hash: request.datos_hash } });
    await saveConfirmation(directory, decided, request.maestro_hash, ts, `solicitud_${decided.estado}`, options);
    return decided;
  });
}

export async function persistConfirmedRegistration(directory: string, supplied: unknown, reviewer: unknown,
  options: PersistenceOptions = {}): Promise<StorageResult<Outcome>> {
  const result = await reviewStorage(directory, options, async (ts) => {
    const command = confirmationCommandSchema.parse(supplied);
    const request = await readConfirmation(directory, command.solicitud_id);
    checkAction(request, command, reviewer, ts, "aprobada");
    const ticket: RegistrationTicket = { mensaje_id: request.mensaje_id, adjunto: request.adjunto, maestro_hash: request.maestro_hash,
      entrada_hash: request.entrada_hash, validacion: request.validacion_original };
    return persistRegistrationLocked(directory, ticket, options, request);
  });
  return result.ok ? result.data : result;
}
