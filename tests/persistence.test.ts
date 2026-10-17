import { afterEach, expect } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { appendJsonLine, hashBytes, outputPath, recoverTransaction } from "../src/storage/audit.ts";
import { readCsv } from "../src/storage/csv.ts";
import { evaluateRegistration, initializeStorage, persistRegistration, resetStorage,
  type RegistrationTicket, type StorageResult } from "../src/storage/persistence.ts";
import { prepareRegistration } from "../src/domain/registration.ts";
import { integrationTests } from "./helpers/integration.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporaryDirectories: string[] = [];
const { test, waitForCompletion } = integrationTests();
const fixedClock = { now: () => "2026-09-03T12:00:00.000Z" };

function unwrap<T>(result: StorageResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

async function project() {
  const directory = await mkdtemp(join(tmpdir(), "periferia-persistence-"));
  temporaryDirectories.push(directory);
  await cp(join(root, "fixtures"), join(directory, "fixtures"), { recursive: true });
  unwrap(await initializeStorage(directory));
  return directory;
}

afterEach(async () => {
  await waitForCompletion();
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
}, 60_000);

const out = (directory: string, path: string) => join(directory, "out", path);
const masterPath = (directory: string) => out(directory, "sharepoint/maestro-contratos.csv");
async function rows(directory: string) {
  const result = await readCsv(masterPath(directory));
  if (!result.ok) throw new Error("CSV de salida inválido.");
  return result.data;
}
async function lines(directory: string, name: string): Promise<unknown[]> {
  const text = await readFile(out(directory, name), "utf8");
  return text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line) as unknown) : [];
}
async function ticket(directory: string, id: string) {
  const attachment = id === "msg-003" ? "otrosi.txt" : id === "msg-005" ? "cotizacion.txt" : "contrato.txt";
  return unwrap(await evaluateRegistration(directory, id, attachment));
}
async function processMessage(directory: string, id: string) {
  return unwrap(await persistRegistration(directory, await ticket(directory, id), fixedClock));
}

const logSchema = z.object({ ok: z.boolean(), resumen: z.string(), validacion: z.object({
  tipo_operacion: z.string(), requiere_revision: z.array(z.string()),
  advertencias: z.array(z.object({ tipo: z.string(), descripcion: z.string() })),
  evidencias: z.record(z.string(), z.object({ origen: z.string(), evidencia: z.string().nullable() })),
}).optional(), obligaciones_pendientes: z.array(z.object({ tipo: z.string(), descripcion: z.string() })).optional() });

test("Inicialización copia exactamente el maestro y crea los cinco destinos", async () => {
  const directory = await project();
  expect(await readFile(masterPath(directory))).toEqual(await readFile(join(directory, "fixtures/reto-02/maestro-contratos.csv")));
  expect((await rows(directory)).registros).toHaveLength(8);
  expect(await readdir(out(directory, "sharepoint/Contratos"))).toEqual([]);
  expect(await lines(directory, "sharepoint/historial.jsonl")).toEqual([]);
  expect(JSON.parse(await readFile(out(directory, "procesados.json"), "utf8"))).toEqual({});
  expect(await lines(directory, "log.jsonl")).toEqual([]);
});

test("msg-001: inserta, archiva bytes originales y registra auditoría e historial", async () => {
  const directory = await project();
  const result = await processMessage(directory, "msg-001");
  expect(result.accion).toBe("registrado");
  const data = await rows(directory);
  expect(data.registros).toHaveLength(9);
  const row = data.registros.find((row) => row.id_contrato === "CT-2026-015")!;
  expect(row.estado_poliza).toBe("pendiente");
  expect(row.fecha_registro).toBe("2026-09-03");
  expect(row.comercial).toBe("Laura Gómez Restrepo");
  expect(await readFile(out(directory, `sharepoint/${row.ruta_sharepoint}`))).toEqual(await readFile(join(directory, "fixtures/reto-02/buzon/msg-001/contrato.txt")));
  expect(await lines(directory, "sharepoint/historial.jsonl")).toHaveLength(1);
  expect(await lines(directory, "log.jsonl")).toHaveLength(1);
});

test("msg-002: exención procedente del correo permanece en el historial", async () => {
  const directory = await project();
  expect((await processMessage(directory, "msg-002")).accion).toBe("registrado");
  const row = (await rows(directory)).registros.find((row) => row.id_contrato === "CT-2026-016")!;
  expect(row.requiere_poliza).toBe("false");
  expect(row.tipo_poliza).toBe("");
  expect(row.estado_poliza).toBe("no_aplica");
  const history = z.object({ evidencias: z.object({ requiere_poliza: z.object({ origen: z.string(), evidencia: z.string() }) }) })
    .parse((await lines(directory, "sharepoint/historial.jsonl"))[0]);
  expect(history.evidencias.requiere_poliza.origen).toBe("correo");
  expect(history.evidencias.requiere_poliza.evidencia).toContain("no pide póliza");
});

test("msg-003: dos cambios, ocho filas, estado histórico y ampliación pendiente", async () => {
  const directory = await project();
  const before = (await rows(directory)).registros.find((row) => row.id_contrato === "CT-2026-011")!;
  const result = await processMessage(directory, "msg-003");
  expect(result.accion).toBe("actualizado");
  const data = await rows(directory);
  expect(data.registros).toHaveLength(8);
  const current = data.registros.find((row) => row.id_contrato === "CT-2026-011")!;
  expect(current).toEqual({ ...before, valor: "520000", fecha_fin: "2027-11-01" });
  expect(current.estado_poliza).toBe("vigente");
  expect(result.ruta_archivo).toContain("/otrosies/msg-003/");
  expect(await readFile(out(directory, `sharepoint/${result.ruta_archivo}`))).toEqual(await readFile(join(directory, "fixtures/reto-02/buzon/msg-003/otrosi.txt")));
  const history = z.object({ cambios: z.array(z.object({ campo: z.string() })),
    obligaciones_pendientes: z.array(z.object({ tipo: z.string(), descripcion: z.string() })) }).parse((await lines(directory, "sharepoint/historial.jsonl"))[0]);
  expect(history.cambios.map((change) => change.campo)).toEqual(["valor", "fecha_fin"]);
  expect(history.obligaciones_pendientes[0]?.tipo).toBe("AMPLIAR_GARANTIAS");
  expect(history.obligaciones_pendientes[0]?.descripcion).toContain("no acredita");
});

test("msg-004 y msg-005: solo auditoría operativa y procesados, sin historial ni archivos", async () => {
  const directory = await project();
  const before = await readFile(masterPath(directory));
  expect((await processMessage(directory, "msg-004")).accion).toBe("duplicado");
  expect((await processMessage(directory, "msg-005")).accion).toBe("rechazado");
  expect(await readFile(masterPath(directory))).toEqual(before);
  expect(await lines(directory, "sharepoint/historial.jsonl")).toEqual([]);
  expect(await readdir(out(directory, "sharepoint/Contratos"))).toEqual([]);
  const processed: unknown = JSON.parse(await readFile(out(directory, "procesados.json"), "utf8"));
  expect(z.record(z.string(), z.unknown()).parse(processed)).toHaveProperty("msg-004");
  expect(z.record(z.string(), z.unknown()).parse(processed)).toHaveProperty("msg-005");
});

test("msg-006: bloqueado, null preservado, motivos guardados y solicitud disponible", async () => {
  const directory = await project();
  const before = await readFile(masterPath(directory));
  const result = await processMessage(directory, "msg-006");
  expect(result.accion).toBe("pendiente_revision");
  expect(result.requiere_revision).toContain("valor");
  expect(await readFile(masterPath(directory))).toEqual(before);
  expect(await lines(directory, "sharepoint/historial.jsonl")).toEqual([]);
  expect(await readdir(out(directory, "sharepoint/Contratos"))).toEqual([]);
  expect(JSON.parse(await readFile(out(directory, "procesados.json"), "utf8"))).not.toHaveProperty("msg-006");
  const log = logSchema.parse((await lines(directory, "log.jsonl"))[0]);
  expect(log.validacion?.requiere_revision).toContain("valor");
  expect((await ticket(directory, "msg-006")).validacion.datos_propuestos?.valor).toBeNull();
});

test("Lote completo dos veces: diez filas, tres eventos contractuales y cinco ya procesados", async () => {
  const directory = await project();
  const ids = ["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"];
  const first = [];
  for (const id of ids) first.push((await processMessage(directory, id)).accion);
  expect(first).toEqual(["registrado", "registrado", "actualizado", "duplicado", "rechazado", "pendiente_revision"]);
  const masterBefore = await readFile(masterPath(directory));
  const historyBefore = await readFile(out(directory, "sharepoint/historial.jsonl"));
  const second = [];
  for (const id of ids) second.push((await processMessage(directory, id)).accion);
  expect(second).toEqual(["ya_procesado", "ya_procesado", "ya_procesado", "ya_procesado", "ya_procesado", "pendiente_revision"]);
  expect((await rows(directory)).registros).toHaveLength(10);
  expect(await readFile(masterPath(directory))).toEqual(masterBefore);
  expect(await readFile(out(directory, "sharepoint/historial.jsonl"))).toEqual(historyBefore);
  expect(await lines(directory, "sharepoint/historial.jsonl")).toHaveLength(3);
  expect(await lines(directory, "log.jsonl")).toHaveLength(12);
});

test("Reintentar el mismo ticket ya aplicado es idempotente aunque cambió el hash del maestro", async () => {
  const directory = await project();
  const request = await ticket(directory, "msg-003");
  expect(unwrap(await persistRegistration(directory, request, fixedClock)).accion).toBe("actualizado");
  expect(unwrap(await persistRegistration(directory, request, fixedClock)).accion).toBe("ya_procesado");
  expect(await lines(directory, "sharepoint/historial.jsonl")).toHaveLength(1);
});

test("Reenvío de un otrosí ya aplicado bajo otro mensaje no repite el cambio", async () => {
  const directory = await project();
  await processMessage(directory, "msg-003");
  const folder = join(directory, "fixtures/reto-02/buzon/msg-007");
  await cp(join(directory, "fixtures/reto-02/buzon/msg-003"), folder, { recursive: true });
  const metadata = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(join(folder, "correo.json"), "utf8")));
  metadata.id = "msg-007";
  await writeFile(join(folder, "correo.json"), JSON.stringify(metadata));
  const before = await readFile(masterPath(directory));
  const request = unwrap(await evaluateRegistration(directory, "msg-007", "otrosi.txt"));
  const result = unwrap(await persistRegistration(directory, request, fixedClock));
  expect(result.tipo_operacion).toBe("actualizacion");
  expect(result.accion).toBe("sin_cambios");
  expect(await readFile(masterPath(directory))).toEqual(before);
  expect(await lines(directory, "sharepoint/historial.jsonl")).toHaveLength(1);
});

test("Otro mensaje con el mismo contrato no inserta una segunda fila", async () => {
  const directory = await project();
  await processMessage(directory, "msg-001");
  const folder = join(directory, "fixtures/reto-02/buzon/msg-007");
  await cp(join(directory, "fixtures/reto-02/buzon/msg-001"), folder, { recursive: true });
  const metadata = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(join(folder, "correo.json"), "utf8")));
  metadata.id = "msg-007";
  await writeFile(join(folder, "correo.json"), JSON.stringify(metadata));
  const request = unwrap(await evaluateRegistration(directory, "msg-007", "contrato.txt"));
  const result = unwrap(await persistRegistration(directory, request, fixedClock));
  expect(result.accion).toBe("duplicado");
  expect((await rows(directory)).registros).toHaveLength(9);
  expect(await lines(directory, "sharepoint/historial.jsonl")).toHaveLength(1);
});

test("Maestro cambiado después de validar bloquea, conserva el cambio externo y registra error", async () => {
  const directory = await project();
  const request = await ticket(directory, "msg-003");
  const modified = (await readFile(masterPath(directory), "utf8")).replace("350000,PEN", "360000,PEN");
  await writeFile(masterPath(directory), modified);
  const result = await persistRegistration(directory, request, fixedClock);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("maestro cambió");
  expect(await readFile(masterPath(directory), "utf8")).toBe(modified);
  expect(await lines(directory, "sharepoint/historial.jsonl")).toEqual([]);
  expect(logSchema.parse((await lines(directory, "log.jsonl"))[0]).ok).toBe(false);
});

test("La creación de un contrato entre evaluación y registro bloquea un ticket nuevo", async () => {
  const directory = await project();
  const stale = await ticket(directory, "msg-002");
  await processMessage(directory, "msg-001");
  expect((await persistRegistration(directory, stale, fixedClock)).ok).toBe(false);
  expect((await rows(directory)).registros).toHaveLength(9);
});

test("Cambio de adjunto o catálogo invalida la evaluación", async () => {
  for (const filename of ["fixtures/reto-02/buzon/msg-001/contrato.txt", "fixtures/reto-02/comerciales.json"]) {
    const directory = await project();
    const request = await ticket(directory, "msg-001");
    await writeFile(join(directory, filename), `${await readFile(join(directory, filename), "utf8")}\n`);
    const result = await persistRegistration(directory, request, fixedClock);
    expect(result.ok).toBe(false);
    expect((await rows(directory)).registros).toHaveLength(8);
  }
});

test("No acepta confirmado=true ni una elegibilidad alterada para msg-006", async () => {
  const directory = await project();
  const request = await ticket(directory, "msg-006");
  expect((await persistRegistration(directory, { ...request, confirmado: true }, fixedClock)).ok).toBe(false);
  const forged: RegistrationTicket = { ...request, validacion: { ...request.validacion,
    elegible_registro: true, requiere_revision: [], estado_validacion: "validado" } };
  expect((await persistRegistration(directory, forged, fixedClock)).ok).toBe(false);
  expect((await rows(directory)).registros).toHaveLength(8);
});

test("Fallo después de modificar el maestro revierte archivo, CSV, historial y procesados", async () => {
  const directory = await project();
  const request = await ticket(directory, "msg-001");
  const before = await readFile(masterPath(directory));
  const result = await persistRegistration(directory, request, { ...fixedClock, beforeReplace: (name) => {
    if (name === "sharepoint/historial.jsonl") throw new Error("Fallo de escritura simulado.");
  } });
  expect(result.ok).toBe(false);
  expect(await readFile(masterPath(directory))).toEqual(before);
  expect(await lines(directory, "sharepoint/historial.jsonl")).toEqual([]);
  expect(JSON.parse(await readFile(out(directory, "procesados.json"), "utf8"))).toEqual({});
  const archive = request.validacion.datos_propuestos!;
  const prepared = prepareRegistration(request.validacion, [], "contrato.txt", "2026-09-03", "lgomez@periferia-ficticia.com");
  expect(archive.id_contrato).toBe("CT-2026-015");
  expect(await Bun.file(out(directory, `sharepoint/${prepared.archive}`)).exists()).toBe(false);
  expect(await Bun.file(out(directory, ".transaccion.json")).exists()).toBe(false);
  expect(logSchema.parse((await lines(directory, "log.jsonl"))[0]).resumen).toContain("simulado");
  expect((await processMessage(directory, "msg-001")).accion).toBe("registrado");
});

test("Error real del sistema de archivos evita perder el maestro anterior", async () => {
  const directory = await project();
  const request = await ticket(directory, "msg-001");
  const before = await readFile(masterPath(directory));
  const result = await persistRegistration(directory, request, { ...fixedClock, beforeReplace: async (name) => {
    if (name === "sharepoint/historial.jsonl") await rm(out(directory, name));
  } });
  expect(result.ok).toBe(false);
  // El cambio externo del historial impide recuperar a ciegas y deja evidencia para revisión.
  expect(await Bun.file(out(directory, ".transaccion.json")).exists()).toBe(true);
  expect((await initializeStorage(directory)).ok).toBe(false);
  // Restaurar la versión externa conocida permite una recuperación controlada.
  await writeFile(out(directory, "sharepoint/historial.jsonl"), "");
  expect((await initializeStorage(directory)).ok).toBe(true);
  expect(await readFile(masterPath(directory))).toEqual(before);
});

test("Recuperación de interrupción preparada restaura imágenes anteriores", async () => {
  const directory = await project();
  const before = await readFile(masterPath(directory));
  const after = Buffer.from(`${before.toString("utf8")}\n`);
  await writeFile(masterPath(directory), after);
  await writeFile(out(directory, ".transaccion.json"), JSON.stringify({ estado: "preparado", archivos: [
    { ruta: "sharepoint/maestro-contratos.csv", antes: before.toString("base64"), despues: after.toString("base64") },
  ] }));
  await recoverTransaction(directory);
  expect(await readFile(masterPath(directory))).toEqual(before);
  expect(await Bun.file(out(directory, ".transaccion.json")).exists()).toBe(false);
});

test("Recuperación confirmada conserva los cambios ya comprometidos", async () => {
  const directory = await project();
  const before = await readFile(masterPath(directory));
  const after = Buffer.from(`${before.toString("utf8")}\n`);
  await writeFile(masterPath(directory), after);
  await writeFile(out(directory, ".transaccion.json"), JSON.stringify({ estado: "confirmado", archivos: [
    { ruta: "sharepoint/maestro-contratos.csv", antes: before.toString("base64"), despues: after.toString("base64") },
  ] }));
  await recoverTransaction(directory);
  expect(await readFile(masterPath(directory))).toEqual(after);
  expect(await Bun.file(out(directory, ".transaccion.json")).exists()).toBe(false);
});

test("JSONL incorpora separador y no acepta concatenar sobre auditoría malformada", () => {
  const result = appendJsonLine(Buffer.from('{"anterior":true}'), { siguiente: true });
  expect(result.toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown))
    .toEqual([{ anterior: true }, { siguiente: true }]);
  expect(() => appendJsonLine(Buffer.from('{"roto":'), { siguiente: true })).toThrow();
});

test("Inicialización repetida no reinicia un maestro con registros anteriores", async () => {
  const directory = await project();
  await processMessage(directory, "msg-001");
  const before = await readFile(masterPath(directory));
  unwrap(await initializeStorage(directory));
  expect(await readFile(masterPath(directory))).toEqual(before);
});

test("Reinicio explícito de demostración restaura solo out/", async () => {
  const directory = await project();
  const original = await readFile(join(directory, "fixtures/reto-02/maestro-contratos.csv"));
  await processMessage(directory, "msg-001");
  unwrap(await resetStorage(directory, "demostracion"));
  expect((await rows(directory)).registros).toHaveLength(8);
  expect(await readFile(join(directory, "fixtures/reto-02/maestro-contratos.csv"))).toEqual(original);
});

test("Rutas relativas maliciosas, IDs y junctions no permiten escribir fuera de out/", async () => {
  const directory = await project();
  for (const name of ["../fuera.txt", "C:\\fuera.txt", "/fuera.txt", "sharepoint/../../fuera.txt"]) {
    await expect(outputPath(directory, name)).rejects.toBeDefined();
  }
  expect((await evaluateRegistration(directory, "../msg-001", "contrato.txt")).ok).toBe(false);
  const external = join(directory, "externo");
  await mkdir(external);
  await symlink(external, out(directory, "enlace"), process.platform === "win32" ? "junction" : "dir");
  await expect(outputPath(directory, "enlace/no-escribir.txt")).rejects.toBeDefined();
  expect(await readdir(external)).toEqual([]);
});

test("No reemplaza un documento preexistente", async () => {
  const directory = await project();
  const request = await ticket(directory, "msg-001");
  const prepared = prepareRegistration(request.validacion, [], "contrato.txt", "2026-09-03", "lgomez@periferia-ficticia.com");
  const archive = await outputPath(directory, `sharepoint/${prepared.archive}`);
  await mkdir(join(archive, ".."), { recursive: true });
  await writeFile(archive, "Documento que debe conservarse.");
  expect((await persistRegistration(directory, request, fixedClock)).ok).toBe(false);
  expect(await readFile(archive, "utf8")).toBe("Documento que debe conservarse.");
  expect((await rows(directory)).registros).toHaveLength(8);
});

test("Duplicado con conflicto conserva RN1, advertencias y revisión en auditoría", async () => {
  const directory = await project();
  const path = join(directory, "fixtures/reto-02/buzon/msg-004/contrato.txt");
  await writeFile(path, (await readFile(path, "utf8")).replace("COP $210.000.000", "USD 210.000.000"));
  const before = await readFile(masterPath(directory));
  const result = await processMessage(directory, "msg-004");
  expect(result.tipo_operacion).toBe("duplicado");
  expect(result.accion).toBe("pendiente_revision");
  expect(result.requiere_revision).toContain("moneda");
  const log = logSchema.parse((await lines(directory, "log.jsonl"))[0]);
  expect(log.validacion?.tipo_operacion).toBe("duplicado");
  expect(log.validacion?.advertencias.some((warning) => warning.tipo === "CONFLICTO_DUPLICADO")).toBe(true);
  expect(await readFile(masterPath(directory))).toEqual(before);
  expect(await lines(directory, "sharepoint/historial.jsonl")).toEqual([]);
});

test("CSV conserva encabezados, campos vacíos y registros preexistentes", async () => {
  const directory = await project();
  const before = await rows(directory);
  await processMessage(directory, "msg-001");
  const after = await rows(directory);
  expect(after.columnas).toEqual(before.columnas);
  expect(after.registros.slice(0, 8)).toEqual(before.registros);
});

test("CSV serializado conserva comas y comillas en datos nuevos", async () => {
  const directory = await project();
  const path = join(directory, "fixtures/reto-02/buzon/msg-001/contrato.txt");
  await writeFile(path, (await readFile(path, "utf8")).replace("INDUSTRIAS DELTA S.A.S.", 'INDUSTRIAS "DELTA", S.A.S.'));
  await processMessage(directory, "msg-001");
  expect((await rows(directory)).registros.find((row) => row.id_contrato === "CT-2026-015")?.cliente).toBe('INDUSTRIAS "DELTA", S.A.S.');
});

test("Generación AUTO solo al registrar; secuencia basada en el maestro actual", async () => {
  const directory = await project();
  const path = join(directory, "fixtures/reto-02/buzon/msg-001/contrato.txt");
  await writeFile(path, (await readFile(path, "utf8")).replace(" No. CT-2026-015", ""));
  const request = await ticket(directory, "msg-001");
  expect(request.validacion.id_contrato).toBeNull();
  const result = unwrap(await persistRegistration(directory, request, fixedClock));
  expect(result.id_contrato).toBe("AUTO-2026-0001");
  expect((await rows(directory)).registros).toHaveLength(9);
});

test("Remitente desconocido completo conserva email real, sin inventar nombre", async () => {
  const directory = await project();
  const path = join(directory, "fixtures/reto-02/buzon/msg-001/correo.json");
  const metadata = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, "utf8")));
  metadata.de = "desconocido@example.com";
  await writeFile(path, JSON.stringify(metadata));
  expect((await processMessage(directory, "msg-001")).accion).toBe("registrado");
  expect((await rows(directory)).registros.find((row) => row.id_contrato === "CT-2026-015")?.comercial).toBe("desconocido@example.com");
});

test("Dos llamadas simultáneas del mismo proceso no duplican el mensaje", async () => {
  const directory = await project();
  const request = await ticket(directory, "msg-001");
  const results = await Promise.all([persistRegistration(directory, request, fixedClock), persistRegistration(directory, request, fixedClock)]);
  expect(results.map((result) => unwrap(result).accion).sort()).toEqual(["registrado", "ya_procesado"]);
  expect((await rows(directory)).registros).toHaveLength(9);
});

test("La persistencia aislada no cambia fixtures reales ni los de entrada durante el registro", async () => {
  const directory = await project();
  async function hashes(folder: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    async function visit(path: string) {
      for (const entry of await readdir(path, { withFileTypes: true })) {
        const file = join(path, entry.name);
        if (entry.isDirectory()) await visit(file);
        else result[file] = hashBytes(await readFile(file));
      }
    }
    await visit(folder);
    return result;
  }
  const originalBefore = await hashes(join(root, "fixtures"));
  const copiedBefore = await hashes(join(directory, "fixtures"));
  const prd = await readFile(join(root, "PRD.md"));
  const agents = await readFile(join(root, "AGENTS.md"));
  for (const id of ["msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006"]) await processMessage(directory, id);
  expect(await hashes(join(root, "fixtures"))).toEqual(originalBefore);
  expect(await hashes(join(directory, "fixtures"))).toEqual(copiedBefore);
  expect(await readFile(join(root, "PRD.md"))).toEqual(prd);
  expect(await readFile(join(root, "AGENTS.md"))).toEqual(agents);
});
