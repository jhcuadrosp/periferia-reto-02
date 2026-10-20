import { afterEach, expect } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { leer_buzon, extraer, validar, registrar, alertas, type ToolContext } from "../src/tools/contratos.ts";
import { createConfirmation, decideConfirmation, evaluateRegistration, getConfirmation, registrationTicketSchema,
  type StorageResult } from "../src/storage/persistence.ts";
import { extractionSchema } from "../src/domain/schemas.ts";
import { hashBytes, optionalBytes } from "../src/storage/audit.ts";
import { integrationTests } from "./helpers/integration.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [];
const { test, waitForCompletion } = integrationTests();
const reviewer = { id: "revisor-sintetico", modo: "simulado_local" as const };
const now = () => "2030-01-02T12:00:00.000Z";
const envelope = z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data: z.record(z.string(), z.unknown()) }),
  z.object({ ok: z.literal(false), error: z.string() })]);
type Tool = { execute(args: unknown, context: ToolContext): Promise<string> };
const call = async (tool: Tool, args: unknown, ctx: ToolContext) => envelope.parse(JSON.parse(await tool.execute(args, ctx)));
function data(result: z.infer<typeof envelope>) {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
function unwrap<T>(result: StorageResult<T>) { if (!result.ok) throw new Error(result.error); return result.data; }
afterEach(async () => {
  await waitForCompletion();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
}, 60_000);
async function project(): Promise<ToolContext> {
  const directory = await mkdtemp(join(tmpdir(), "periferia-tools-test-"));
  directories.push(directory);
  await cp(join(root, "fixtures"), join(directory, "fixtures"), { recursive: true });
  return { directory, sessionId: "sesion-prueba", now };
}
async function ticket(ctx: ToolContext, id: string) {
  const contract = data(await call(extraer, { mensaje_id: id }, ctx));
  return registrationTicketSchema.parse(data(await call(validar, { mensaje_id: id, contrato: contract }, ctx)).contrato);
}
async function count(ctx: ToolContext) {
  return (await readFile(join(ctx.directory, "out/sharepoint/maestro-contratos.csv"), "utf8")).trim().split("\n").length - 1;
}
async function syntheticRequest(ctx: ToolContext) {
  const directory = join(ctx.directory, "fixtures/reto-02/buzon/msg-sintetico");
  await mkdir(directory);
  await writeFile(join(directory, "correo.json"), JSON.stringify({ id: "msg-sintetico", de: "lgomez@periferia-ficticia.com",
    para: "contratos@periferia-ficticia.com", asunto: "SIMULACIÓN", fecha: now(), cuerpo: "Ejemplo sintético.", adjuntos: ["contrato.txt"] }));
  await writeFile(join(directory, "contrato.txt"), `CONTRATO No. SYN-2030-TOOL
Entre CLIENTE SINTÉTICO S.A., NIT 111.222.333-0, con domicilio en Colombia, y PERIFERIA IT GROUP S.A.S.

PRIMERA. OBJETO. Servicio sintético de soporte.

SEGUNDA. VALOR. Importe pendiente de aclaración.

TERCERA. PLAZO. Desde 2030-01-01 hasta 2030-12-31.

CUARTA. GARANTÍAS. No se requiere póliza.`);
  const original = await ticket(ctx, "msg-sintetico");
  const source = { justificacion: "Datos ficticios solo para la prueba determinista.", procedencia: "Acta SINTÉTICA" };
  const request = unwrap(await createConfirmation(ctx.directory, original, [{ campo: "valor", valor: 1500, ...source },
    { campo: "moneda", valor: "USD", ...source }], reviewer, { now }));
  return { original, request, command: { solicitud_id: request.solicitud_id, datos_hash: request.datos_hash } };
}

test("Cinco herramientas: objetos del PRD, descripción, argumentos Zod y execute JSON", async () => {
  const ctx = await project();
  for (const tool of [leer_buzon, extraer, validar, registrar, alertas]) {
    expect(typeof tool.description).toBe("string");
    expect(z.object(tool.args)).toBeDefined();
    expect((await call(tool, { dato_inesperado: true }, ctx)).ok).toBe(false);
    for (const schema of Object.values(tool.args)) {
      if (!(schema instanceof z.ZodType)) throw new Error("El argumento no es un esquema Zod.");
      expect(schema.description).toBeTruthy();
    }
  }
});

test("Leer buzón devuelve seis pendientes, cotización rechazada y msg-006 revisable", async () => {
  const ctx = await project();
  const messages = z.array(z.object({ id: z.string(), tiene_contrato: z.boolean(), clasificacion: z.string() }))
    .parse(data(await call(leer_buzon, {}, ctx)).mensajes);
  expect(messages).toHaveLength(6);
  expect(messages.find((row) => row.id === "msg-005")).toMatchObject({ tiene_contrato: false, clasificacion: "rechazado" });
  expect(messages.find((row) => row.id === "msg-006")).toMatchObject({ tiene_contrato: true, clasificacion: "nuevo" });
});

test("Extraer y validar reutilizan datos y reglas de los seis mensajes", async () => {
  const ctx = await project();
  const expected = ["nuevo", "nuevo", "actualizacion", "duplicado", "rechazado", "nuevo"];
  for (let number = 1; number <= 6; number++) {
    const id = `msg-00${number}`;
    const contract = extractionSchema.parse(data(await call(extraer, { mensaje_id: id }, ctx)));
    const result = data(await call(validar, { mensaje_id: id, contrato: contract }, ctx));
    expect(result.clasificacion).toBe(expected[number - 1]);
    if (number === 6) { expect(result.estado).toBe("pendiente_revision"); expect(contract.campos.valor.normalizado).toBeNull(); }
  }
});

test("Registro válido e idempotente; leer buzón excluye procesado y conserva pendientes", async () => {
  const ctx = await project();
  const contract = await ticket(ctx, "msg-001");
  expect(data(await call(registrar, { mensaje_id: "msg-001", contrato: contract }, ctx)).accion).toBe("registrado");
  expect(data(await call(registrar, { mensaje_id: "msg-001", contrato: contract }, ctx)).accion).toBe("ya_procesado");
  expect(await count(ctx)).toBe(9);
  const messages = z.array(z.object({ id: z.string() })).parse(data(await call(leer_buzon, {}, ctx)).mensajes);
  expect(messages).toHaveLength(5);
  expect(messages.some((row) => row.id === "msg-006")).toBe(true);
});

test("Revisión pendiente tiene resultado explícito sin fingir escritura", async () => {
  const ctx = await project();
  const result = data(await call(registrar, { mensaje_id: "msg-006", contrato: await ticket(ctx, "msg-006") }, ctx));
  expect(result).toMatchObject({ accion: "pendiente_revision", estado: "requiere_revision", aplicado: false });
  expect(await count(ctx)).toBe(8);
});

test("confirmado=true aislado, elegibilidad alterada y cambio de ID no autorizan", async () => {
  const ctx = await project();
  const contract = await ticket(ctx, "msg-006");
  expect((await call(registrar, { mensaje_id: "msg-006", contrato: contract, confirmado: true }, ctx)).ok).toBe(false);
  expect((await call(registrar, { mensaje_id: "msg-001", contrato: contract }, ctx)).ok).toBe(false);
  const changed = structuredClone(contract);
  changed.validacion.elegible_registro = true;
  expect((await call(registrar, { mensaje_id: "msg-006", contrato: changed }, ctx)).ok).toBe(false);
  expect(await count(ctx)).toBe(8);
});

test("Extracción o propuesta alterada y autorización añadida como argumento se rechazan", async () => {
  const ctx = await project();
  const contract = extractionSchema.parse(data(await call(extraer, { mensaje_id: "msg-001" }, ctx)));
  contract.campos.valor.normalizado = 1;
  expect((await call(validar, { mensaje_id: "msg-001", contrato: contract }, ctx)).ok).toBe(false);
  const original = await ticket(ctx, "msg-001");
  original.validacion.datos_propuestos!.valor = 1;
  expect((await call(registrar, { mensaje_id: "msg-001", contrato: original }, ctx)).ok).toBe(false);
  expect((await call(registrar, { mensaje_id: "msg-001", contrato: original, autorizacion: {} }, ctx)).ok).toBe(false);
});

test("Confirmación aprobada en contexto permite solo los valores autorizados y no se reutiliza", async () => {
  const ctx = await project();
  const { original, request, command } = await syntheticRequest(ctx);
  const authorized = { ...ctx, autorizacion: { ...command, revisor: reviewer } };
  const args = { mensaje_id: original.mensaje_id, contrato: original, confirmado: true };
  expect((await call(registrar, args, authorized)).ok).toBe(false);
  unwrap(await decideConfirmation(ctx.directory, { ...command, accion: "aprobar" }, reviewer, { now }));
  expect(data(await call(registrar, args, authorized)).accion).toBe("registrado");
  expect((await call(registrar, args, authorized)).ok).toBe(false);
  expect(await count(ctx)).toBe(9);
  expect(unwrap(await getConfirmation(ctx.directory, request.solicitud_id)).estado).toBe("utilizada");
});

test("Autorización inexistente, rechazada, caducada y hash distinto se bloquean", async () => {
  const ctx = await project();
  const { original, command } = await syntheticRequest(ctx);
  const args = { mensaje_id: original.mensaje_id, contrato: original, confirmado: true };
  const authorized = { ...ctx, autorizacion: { ...command, revisor: reviewer } };
  expect((await call(registrar, args, { ...authorized, autorizacion: { ...authorized.autorizacion, solicitud_id: crypto.randomUUID() } })).ok).toBe(false);
  unwrap(await decideConfirmation(ctx.directory, { ...command, accion: "aprobar" }, reviewer, { now }));
  expect((await call(registrar, args, { ...authorized, autorizacion: { ...authorized.autorizacion, datos_hash: "f".repeat(64) } })).ok).toBe(false);
  expect((await call(registrar, args, { ...authorized, now: () => "2030-01-02T13:00:00Z" })).ok).toBe(false);
  expect(await count(ctx)).toBe(8);
  const another = await project();
  const rejected = await syntheticRequest(another);
  unwrap(await decideConfirmation(another.directory, { ...rejected.command, accion: "rechazar" }, reviewer, { now }));
  expect((await call(registrar, { mensaje_id: rejected.original.mensaje_id, contrato: rejected.original, confirmado: true },
    { ...another, autorizacion: { ...rejected.command, revisor: reviewer } })).ok).toBe(false);
});

test("Cambio del maestro o documento tras validar bloquea el registro", async () => {
  const ctx = await project();
  const contract = await ticket(ctx, "msg-001");
  const path = join(ctx.directory, "out/sharepoint/maestro-contratos.csv");
  await writeFile(path, (await readFile(path, "utf8")).replace("420000000", "420000001"));
  expect((await call(registrar, { mensaje_id: "msg-001", contrato: contract }, ctx)).ok).toBe(false);
  const fresh = await ticket(ctx, "msg-001");
  const document = join(ctx.directory, "fixtures/reto-02/buzon/msg-001/contrato.txt");
  await writeFile(document, `${await readFile(document, "utf8")}\nCambio posterior.`);
  expect((await call(registrar, { mensaje_id: "msg-001", contrato: fresh }, ctx)).ok).toBe(false);
});

test("IDs inseguros, fechas imposibles, mensaje ausente y contexto inválido siempre devuelven JSON de error", async () => {
  const ctx = await project();
  for (const args of [{ mensaje_id: "../msg-001" }, { mensaje_id: "inexistente" }, {}]) expect((await call(extraer, args, ctx)).ok).toBe(false);
  expect((await call(alertas, { hoy: "2026-02-30" }, ctx)).ok).toBe(false);
  expect((await call(leer_buzon, {}, { ...ctx, directory: "" })).ok).toBe(false);
  const detached = extraer.execute;
  expect(envelope.parse(JSON.parse(await detached({ mensaje_id: "msg-001" }, ctx))).ok).toBe(true);
});

test("Un mensaje roto no impide listar y procesar los siguientes; texto vacío no es extracción exitosa", async () => {
  const ctx = await project();
  await writeFile(join(ctx.directory, "fixtures/reto-02/buzon/msg-001/correo.json"), "{roto");
  const messages = z.array(z.record(z.string(), z.unknown())).parse(data(await call(leer_buzon, {}, ctx)).mensajes);
  expect(messages.find((row) => row.id === "msg-001")!.estado).toBe("error");
  expect(messages.find((row) => row.id === "msg-002")!.tiene_contrato).toBe(true);
  await writeFile(join(ctx.directory, "fixtures/reto-02/buzon/msg-002/contrato.txt"), " ");
  expect((await call(extraer, { mensaje_id: "msg-002" }, ctx)).ok).toBe(false);
});

test("Reporte repetible, maestro intacto, ampliación CT-2026-011 visible y gap sin contar actualización", async () => {
  const ctx = await project();
  for (const id of ["msg-001", "msg-002", "msg-003"]) data(await call(registrar, { mensaje_id: id, contrato: await ticket(ctx, id) }, ctx));
  const master = join(ctx.directory, "out/sharepoint/maestro-contratos.csv");
  const before = hashBytes(await readFile(master));
  const report = data(await call(alertas, { hoy: "2030-01-02" }, ctx));
  expect(report.ruta).toBe("out/alertas.md");
  const obligations = z.array(z.object({ id_contrato: z.string() })).parse(report.obligaciones_pendientes);
  expect(obligations.map((entry) => entry.id_contrato)).toContain("CT-2026-011");
  const registered = z.array(z.object({ id_contrato: z.string() })).parse(report.registrados_desde_corte);
  expect(registered.map((entry) => entry.id_contrato)).toEqual(["CT-2026-015", "CT-2026-016"]);
  const markdown = await readFile(join(ctx.directory, "out/alertas.md"), "utf8");
  expect(data(await call(alertas, { hoy: "2030-01-02" }, ctx))).toEqual(report);
  expect(await readFile(join(ctx.directory, "out/alertas.md"), "utf8")).toBe(markdown);
  expect(hashBytes(await readFile(master))).toBe(before);
  expect(markdown).toContain("CT-2026-011");
});

test("RN7 audita las cinco herramientas, errores y sesión sin duplicar historial contractual", async () => {
  const ctx = await project();
  await call(leer_buzon, {}, ctx);
  await call(registrar, { mensaje_id: "msg-006", contrato: await ticket(ctx, "msg-006") }, ctx);
  await call(alertas, { hoy: "2026-09-03" }, ctx);
  await call(extraer, { mensaje_id: "../invalido" }, ctx);
  const events = (await readFile(join(ctx.directory, "out/log.jsonl"), "utf8")).trim().split("\n")
    .map((line) => z.object({ herramienta: z.string(), ok: z.boolean(), session_id: z.string().optional() }).parse(JSON.parse(line)));
  for (const name of ["leer_buzon", "extraer", "validar", "registrar", "alertas"]) {
    expect(events.some((event) => event.herramienta === `contratos_${name}` && event.session_id === ctx.sessionId)).toBe(true);
  }
  expect(events.some((event) => !event.ok)).toBe(true);
  expect(await readFile(join(ctx.directory, "out/sharepoint/historial.jsonl"), "utf8")).toBe("");
});

test("Maestro corrupto impide informe y auditoría inaccesible no oculta un error", async () => {
  const ctx = await project();
  await call(leer_buzon, {}, ctx);
  await writeFile(join(ctx.directory, "out/sharepoint/maestro-contratos.csv"), "CSV roto");
  expect((await call(alertas, { hoy: "2026-09-03" }, ctx)).ok).toBe(false);
  const missing = { ...ctx, directory: join(ctx.directory, "no-existe") };
  const result = z.object({ ok: z.boolean(), error_auditoria: z.string() }).parse(JSON.parse(await leer_buzon.execute({}, missing)));
  expect(result.ok).toBe(false);
  expect(typeof result.error_auditoria).toBe("string");
});

test("Fuentes originales, documentos de control y out operativo permanecen intactos", async () => {
  async function hashes(directory: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) Object.assign(result, await hashes(path));
      else result[path] = hashBytes(await readFile(path));
    }
    return result;
  }
  const before = { fixtures: await hashes(join(root, "fixtures")), out: await hashes(join(root, "out")),
    prd: await readFile(join(root, "PRD.md")), agents: await optionalBytes(join(root, "AGENTS.md")) };
  const ctx = await project();
  await call(registrar, { mensaje_id: "msg-003", contrato: await ticket(ctx, "msg-003") }, ctx);
  await call(alertas, { hoy: "2026-09-03" }, ctx);
  expect(await hashes(join(root, "fixtures"))).toEqual(before.fixtures);
  expect(await hashes(join(root, "out"))).toEqual(before.out);
  expect(await readFile(join(root, "PRD.md"))).toEqual(before.prd);
  expect(await optionalBytes(join(root, "AGENTS.md"))).toEqual(before.agents);
});

test("Informe previo se conserva cuando el historial es inválido o hay varios TXT ambiguos", async () => {
  const ctx = await project();
  data(await call(alertas, { hoy: "2026-09-03" }, ctx));
  const path = join(ctx.directory, "out/alertas.md");
  const before = await readFile(path);
  await writeFile(join(ctx.directory, "out/sharepoint/historial.jsonl"), "{historial roto");
  expect((await call(alertas, { hoy: "2026-09-03" }, ctx)).ok).toBe(false);
  expect(await readFile(path)).toEqual(before);
  const mailPath = join(ctx.directory, "fixtures/reto-02/buzon/msg-001/correo.json");
  const mail = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(mailPath, "utf8")));
  mail.adjuntos = ["contrato.txt", "alternativo.txt"];
  await writeFile(mailPath, JSON.stringify(mail));
  await writeFile(join(ctx.directory, "fixtures/reto-02/buzon/msg-001/alternativo.txt"), "Otro texto.");
  expect((await call(extraer, { mensaje_id: "msg-001" }, ctx)).ok).toBe(false);
});
