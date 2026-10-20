import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { extraer, validar, registrar, leer_buzon, alertas, type ToolContext } from "./src/tools/contratos.ts";
import { extractionSchema, relativePathSchema, validationSchema } from "./src/domain/schemas.ts";
import { registrationTicketSchema, type RegistrationTicket } from "./src/storage/persistence.ts";
import { readCsv } from "./src/storage/csv.ts";
import { hashBytes, optionalBytes } from "./src/storage/audit.ts";

const root = fileURLToPath(new URL("./", import.meta.url));
const timestamp = "2026-09-03T12:00:00.000Z";
const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), data: z.unknown(), error_auditoria: z.string().optional() }),
  z.object({ ok: z.literal(false), error: z.string(), error_auditoria: z.string().optional() }),
]);
const mailboxSchema = z.object({ mensajes: z.array(z.object({ id: z.string(), tiene_contrato: z.boolean(), estado: z.string().optional() })) });
const evaluationSchema = validationSchema.extend({ clasificacion: validationSchema.shape.tipo_operacion, contrato: registrationTicketSchema });
const outcomeSchema = z.object({ accion: z.string(), mensaje_id: z.string(), requiere_revision: z.array(z.string()), ruta_archivo: relativePathSchema.optional() });
const alertItem = z.object({ id_contrato: z.string() });
const alertSchema = z.object({ ruta: relativePathSchema, hoy: z.literal("2026-09-03"),
  vencen: z.array(alertItem.extend({ dias_restantes: z.number() })), vencidos: z.array(alertItem),
  polizas_pendientes: z.array(alertItem), registrados_desde_corte: z.array(alertItem), obligaciones_pendientes: z.array(alertItem) });
const historySchema = z.object({ ts: z.string(), id_contrato: z.string(), mensaje_id: z.string(), accion: z.string(),
  ruta_archivo: relativePathSchema, cambios: z.array(z.object({ campo: z.string(), anterior: z.unknown(), propuesto: z.unknown() })),
  evidencias: z.record(z.string(), z.unknown()), obligaciones_pendientes: z.array(z.object({ tipo: z.string() })) });
type Tool = { execute(args: unknown, ctx: ToolContext): Promise<string> };
type Row = { mensaje: string; clasificacion: string; estado_validacion: string; accion: string;
  revision: string[]; motivos: string[]; ticket?: RegistrationTicket };

async function csvRows(path: string) {
  const parsed = await readCsv(path);
  if (!parsed.ok) throw new Error(parsed.problemas[0]!.descripcion);
  return parsed.data.registros;
}
async function jsonLines(path: string): Promise<unknown[]> {
  return (await readFile(path, "utf8")).split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}
async function hashes(directory: string, prefix = ""): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(result, await hashes(join(directory, entry.name), name));
    else result[name] = hashBytes(await readFile(join(directory, entry.name)));
  }
  return result;
}
async function protectedHashes(source: string) {
  // AGENTS.md es local y está excluido de Git; si existe, también debe conservarse.
  const agents = await optionalBytes(join(source, "AGENTS.md"));
  return { fixtures: await hashes(join(source, "fixtures")), out: await hashes(join(source, "out")),
    prd: hashBytes(await readFile(join(source, "PRD.md"))), agents: agents === null ? null : hashBytes(agents) };
}

// El argumento source solo facilita pruebas con copias dañadas; nunca se escribe en él.
export async function runDemo(source = root, print: (message: string) => void = console.log) {
  const protectedBefore = await protectedHashes(source);
  const directory = await mkdtemp(join(tmpdir(), "periferia-demo-"));
  print(`Directorio aislado: ${directory}`);
  print(`Demo sin LLM. Reloj fijo: ${timestamp}.`);
  await cp(join(source, "fixtures"), join(directory, "fixtures"), { recursive: true });
  const ctx: ToolContext = { directory, sessionId: "demo-integral", now: () => timestamp };
  const checks: { descripcion: string; ok: boolean; error?: string }[] = [];
  let responses = 0;
  function check(description: string, assertion: () => void) {
    try { assertion(); checks.push({ descripcion: description, ok: true }); }
    catch (error) { checks.push({ descripcion: description, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  }
  async function invoke<T extends z.ZodType>(tool: Tool, args: unknown, schema: T): Promise<z.output<T>> {
    const response = responseSchema.parse(JSON.parse(await tool.execute(args, ctx)));
    responses++;
    if (response.error_auditoria) throw new Error(response.error_auditoria);
    if (!response.ok) throw new Error(response.error);
    return schema.parse(response.data);
  }
  const masterPath = join(directory, "out/sharepoint/maestro-contratos.csv");
  const historyPath = join(directory, "out/sharepoint/historial.jsonl");
  const logPath = join(directory, "out/log.jsonl");
  const mailbox = await invoke(leer_buzon, {}, mailboxSchema);
  const ids = mailbox.mensajes.map((message) => message.id).sort();
  const initial = await csvRows(masterPath);
  const initialBytes = await readFile(masterPath);
  check("Se identifican exactamente los seis mensajes", () => assert.deepEqual(ids,
    ["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"]));
  check("Maestro inicial de ocho filas, copia exacta del original", () => {
    assert.equal(initial.length, 8);
    assert.equal(protectedBefore.fixtures["reto-02/maestro-contratos.csv"], hashBytes(initialBytes));
  });

  async function pass(number: number): Promise<Row[]> {
    const rows: Row[] = [];
    for (const id of ids) {
      try {
        const before = await readFile(masterPath);
        const extraction = await invoke(extraer, { mensaje_id: id }, extractionSchema);
        const evaluation = await invoke(validar, { mensaje_id: id, contrato: extraction }, evaluationSchema);
        const outcome = await invoke(registrar, { mensaje_id: id, contrato: evaluation.contrato }, outcomeSchema);
        rows.push({ mensaje: id, clasificacion: evaluation.clasificacion, estado_validacion: evaluation.estado_validacion,
          accion: outcome.accion, revision: evaluation.requiere_revision, motivos: evaluation.motivos, ticket: evaluation.contrato });
        if (!["registrado", "actualizado"].includes(outcome.accion)) {
          const after = await readFile(masterPath);
          check(`Pasada ${number}, ${id}: ${outcome.accion} no modifica el maestro`, () => assert.deepEqual(after, before));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        rows.push({ mensaje: id, clasificacion: "error", estado_validacion: "error", accion: "error", revision: [], motivos: [message] });
        check(`Pasada ${number}, ${id}: herramientas y respuestas válidas`, () => assert.fail(message));
      }
    }
    print(`\nPasada ${number}: mensaje | clasificación | validación | persistencia`);
    for (const row of rows) {
      print(`${row.mensaje} | ${row.clasificacion} | ${row.estado_validacion} | ${row.accion}`);
      if (row.revision.length || row.clasificacion === "rechazado" || row.accion === "error") {
        print(`  ${row.revision.length ? `Revisar ${row.revision.join(", ")}. ` : ""}${row.motivos.join(" ")}`);
      }
    }
    return rows;
  }

  const first = await pass(1);
  const afterFirst = await csvRows(masterPath);
  const masterAfterFirst = await readFile(masterPath);
  const historyAfterFirst = await readFile(historyPath);
  const archiveAfterFirst = await hashes(join(directory, "out/sharepoint/Contratos"));
  const logAfterFirst = await jsonLines(logPath);
  const expected = ["nuevo", "nuevo", "actualizacion", "duplicado", "rechazado", "nuevo"];
  check("Clasificaciones de primera pasada coinciden con PRD", () => assert.deepEqual(first.map((row) => row.clasificacion), expected));
  check("Primera pasada: dos altas, una actualización, dos sin modificación y un pendiente", () => assert.deepEqual(
    first.map((row) => row.accion), ["registrado", "registrado", "actualizado", "duplicado", "rechazado", "pendiente_revision"]));
  check("El maestro final contiene diez IDs únicos", () => { assert.equal(afterFirst.length, 10); assert.equal(new Set(afterFirst.map((row) => row.id_contrato)).size, 10); });
  check("Otrosí: 520000 PEN, fin 2027-11-01 y todos los demás campos intactos", () => {
    const before = initial.find((row) => row.id_contrato === "CT-2026-011");
    const after = afterFirst.find((row) => row.id_contrato === "CT-2026-011");
    assert.ok(before && after);
    assert.equal(after.moneda, "PEN");
    assert.deepEqual(after, { ...before, valor: "520000", fecha_fin: "2027-11-01" });
    for (const original of initial.filter((row) => row.id_contrato !== before.id_contrato)) {
      assert.deepEqual(afterFirst.find((row) => row.id_contrato === original.id_contrato), original);
    }
  });
  check("Estados de póliza correctos y msg-006 no registrado", () => {
    assert.equal(afterFirst.find((row) => row.id_contrato === "CT-2026-015")?.estado_poliza, "pendiente");
    assert.equal(afterFirst.find((row) => row.id_contrato === "CT-2026-016")?.estado_poliza, "no_aplica");
    assert.ok(!afterFirst.some((row) => row.id_contrato === "CM-2026-03"));
  });
  const history = z.array(historySchema).parse(await jsonLines(historyPath));
  check("Historial: únicamente dos altas y un otrosí con dos cambios", () => {
    assert.deepEqual(history.map((event) => [event.mensaje_id, event.accion]), [["msg-001", "nuevo"], ["msg-002", "nuevo"], ["msg-003", "actualizacion"]]);
    assert.deepEqual(history[2]!.cambios.map((change) => change.campo).sort(), ["fecha_fin", "valor"]);
    assert.ok(history[2]!.obligaciones_pendientes.some((warning) => warning.tipo === "AMPLIAR_GARANTIAS"));
    const exemption = z.object({ origen: z.literal("correo"), evidencia: z.string() }).parse(history[1]!.evidencias.requiere_poliza);
    assert.match(exemption.evidencia, /no pide póliza/i);
  });
  for (const event of history) {
    const ticket = first.find((row) => row.mensaje === event.mensaje_id)?.ticket;
    assert.ok(ticket?.adjunto);
    const archived = await readFile(join(directory, "out/sharepoint", event.ruta_archivo));
    const original = await readFile(join(source, "fixtures/reto-02/buzon", event.mensaje_id, ticket.adjunto));
    check(`${event.mensaje_id}: archivo conserva bytes del adjunto original`, () => assert.deepEqual(archived, original));
  }
  check("Se archivan exclusivamente los tres documentos aplicados", () => assert.equal(Object.keys(archiveAfterFirst).length, 3));
  const pending = await invoke(leer_buzon, {}, mailboxSchema);
  check("Solo msg-006 permanece en el buzón pendiente", () => assert.deepEqual(pending.mensajes.map((row) => row.id), ["msg-006"]));

  // Repetimos los seis IDs originales, aunque leer_buzon ahora solo liste el pendiente.
  const second = await pass(2);
  const finalMaster = await readFile(masterPath);
  const finalHistory = await readFile(historyPath);
  const finalArchives = await hashes(join(directory, "out/sharepoint/Contratos"));
  check("Segunda pasada: cinco ya procesados y un pendiente, sin nuevas operaciones", () => assert.deepEqual(
    second.map((row) => row.accion), ["ya_procesado", "ya_procesado", "ya_procesado", "ya_procesado", "ya_procesado", "pendiente_revision"]));
  check("Idempotencia: maestro, historial y archivos idénticos byte a byte", () => {
    assert.deepEqual(finalMaster, masterAfterFirst); assert.deepEqual(finalHistory, historyAfterFirst); assert.deepEqual(finalArchives, archiveAfterFirst);
  });

  // Se muestra la llamada requerida por PRD 6.6 sin inventar una autorización ni datos contractuales.
  const review = second.find((row) => row.revision.length > 0 && row.ticket);
  assert.ok(review?.ticket);
  const blocked = responseSchema.parse(JSON.parse(await registrar.execute({ mensaje_id: review.mensaje, contrato: review.ticket, confirmado: true }, ctx)));
  responses++;
  check("confirmado=true sin autorización humana se bloquea", () => {
    assert.equal(blocked.ok, false); assert.ok(!blocked.error_auditoria);
    if (!blocked.ok) assert.match(blocked.error, /autorización humana/);
  });
  print(`\nConfirmación sin autorización: ${blocked.ok ? "ERROR: se aceptó" : blocked.error}`);
  const report = await invoke(alertas, { hoy: "2026-09-03" }, alertSchema);
  const idsOf = (items: { id_contrato: string }[]) => items.map((item) => item.id_contrato).sort();
  check("Alertas reales: próximos en 27 y 42 días; dos vencidos; dos pólizas pendientes", () => {
    assert.deepEqual(report.vencen.map((row) => [row.id_contrato, row.dias_restantes]), [["CT-2026-009", 27], ["CT-2026-004", 42]]);
    assert.deepEqual(idsOf(report.vencidos), ["CT-2025-018", "CT-2026-002"]);
    assert.deepEqual(idsOf(report.polizas_pendientes), ["CT-2026-004", "CT-2026-015"]);
    assert.deepEqual(idsOf(report.registrados_desde_corte), ["CT-2026-015", "CT-2026-016"]);
    assert.deepEqual(idsOf(report.obligaciones_pendientes), ["CT-2026-011"]);
  });
  const markdown = await readFile(join(directory, report.ruta), "utf8");
  check("Reporte Markdown generado con tres secciones y evidencia de ampliación", () => {
    assert.equal(markdown.match(/^## /gm)?.length, 3); assert.match(markdown, /CT-2026-011/); assert.match(markdown, /2026-09-03/);
  });
  const remaining = await invoke(leer_buzon, {}, mailboxSchema);
  const processed = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(join(directory, "out/procesados.json"), "utf8")));
  const logs = z.array(z.object({ ts: z.literal(timestamp), herramienta: z.string(), mensaje_id: z.string().nullable(),
    ok: z.boolean(), resumen: z.string() })).parse(await jsonLines(logPath));
  check("Auditoría, procesados y pendiente final coherentes", () => {
    assert.deepEqual(Object.keys(processed).sort(), ids.filter((id) => id !== "msg-006"));
    assert.deepEqual(remaining.mensajes.map((row) => row.id), ["msg-006"]);
    for (const name of ["leer_buzon", "extraer", "validar", "registrar", "alertas"]) assert.ok(logs.some((event) => event.herramienta === `contratos_${name}`));
    assert.equal(logs.filter((event) => event.herramienta.startsWith("contratos_")).length, responses);
    assert.ok(logs.length > logAfterFirst.length);
  });
  const finalMasterAfterAlerts = await readFile(masterPath);
  const finalHistoryAfterAlerts = await readFile(historyPath);
  check("Bloqueo y alertas tampoco alteran maestro ni historial", () => {
    assert.deepEqual(finalMasterAfterAlerts, masterAfterFirst);
    assert.deepEqual(finalHistoryAfterAlerts, historyAfterFirst);
  });
  const protectedAfter = await protectedHashes(source);
  const copiedFixtures = await hashes(join(directory, "fixtures"));
  check("PRD, AGENTS, fixtures originales y out operativo intactos", () => assert.deepEqual(protectedAfter, protectedBefore));
  check("La copia de fixtures también permanece intacta", () => assert.deepEqual(copiedFixtures, protectedBefore.fixtures));
  const ok = checks.every((item) => item.ok);
  print(`\nMaestro: ${initial.length} → ${afterFirst.length} → ${(await csvRows(masterPath)).length} contratos.`);
  print(`Primera pasada: ${first.filter((row) => row.accion === "registrado").length} altas, ${first.filter((row) => row.accion === "actualizado").length} actualización, ${first.filter((row) => ["duplicado", "rechazado"].includes(row.accion)).length} sin modificación y ${first.filter((row) => row.accion === "pendiente_revision").length} pendiente.`);
  print(`Segunda pasada: ${second.filter((row) => row.accion === "ya_procesado").length} ya procesados y ${second.filter((row) => row.accion === "pendiente_revision").length} pendiente. Los logs operativos registran ambos intentos.`);
  print(`Alertas: ${report.vencen.length} próximos, ${report.vencidos.length} vencidos, ${report.polizas_pendientes.length} pólizas no vigentes, ${report.registrados_desde_corte.length} altas desde el corte, ${report.obligaciones_pendientes.length} ampliación pendiente.`);
  print(`Auditoría: ${logs.length} eventos; historial contractual: ${history.length} operaciones.`);
  print(`Reporte: ${join(directory, report.ruta)}`);
  print(`Aserciones: ${checks.filter((item) => item.ok).length}/${checks.length}. Resultado global: ${ok ? "CORRECTO" : "FALLIDO"}.`);
  for (const failed of checks.filter((item) => !item.ok)) print(`FALLO: ${failed.descripcion}: ${failed.error}`);
  return { ok, directory, first, second, checks, report };
}

if (import.meta.main) {
  try { const result = await runDemo(); process.exitCode = result.ok ? 0 : 1; }
  catch (error) { console.error(`Resultado global: FALLIDO. ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}
