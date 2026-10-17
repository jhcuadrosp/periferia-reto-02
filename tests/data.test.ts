import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { diagnoseCommercials, diagnoseMaster } from "../src/domain/quality.ts";
import { dateSchema, mailSchema, masterColumns, masterRecordSchema } from "../src/domain/schemas.ts";
import { parseCsv, readCsv } from "../src/storage/csv.ts";
import { readJson, readText } from "../src/storage/files.ts";
import { readMailbox } from "../src/storage/mailbox.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(root, "fixtures", "reto-02");
const masterFile = join(fixtures, "maestro-contratos.csv");
const commercialFile = join(fixtures, "comerciales.json");
const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "periferia-data-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function firstRecord() {
  const result = await readCsv(masterFile);
  if (!result.ok || !result.data.registros[0]) throw new Error("No se pudo preparar el registro de prueba.");
  return result.data.registros[0];
}

test("CSV: comillas, comas, campos vacíos, CRLF, BOM y saltos dentro de campos", () => {
  const result = parseCsv('\uFEFFid,nombre,vacio\r\n1,"Empresa, S.A.",\r\n2,"Dice ""hola""\nsegunda línea",x\r\n', "prueba.csv");
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data.columnas).toEqual(["id", "nombre", "vacio"]);
  expect(result.data.registros).toEqual([
    { id: "1", nombre: "Empresa, S.A.", vacio: "" },
    { id: "2", nombre: 'Dice "hola"\nsegunda línea', vacio: "x" },
  ]);
});

test("CSV: rechaza comillas rotas, filas irregulares y encabezados inválidos", () => {
  for (const text of ['', 'id,id\n1,2', 'id,\n1,2', 'id,nombre\n1', 'id,nombre\n1,"sin cierre']) {
    const result = parseCsv(text, "prueba.csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.problemas[0]?.archivo).toBe("prueba.csv");
  }
});

test("Maestro real: ocho registros, dieciséis columnas y tres vacíos permitidos", async () => {
  const result = await readCsv(masterFile);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const report = diagnoseMaster(result.data, masterFile);
  expect(report.total).toBe(8);
  expect(report.validos).toBe(8);
  expect(report.columnas).toEqual(masterColumns);
  expect(report.vacios.tipo_poliza).toBe(3);
  expect(report.duplicados).toEqual([]);
  expect(report.problemas).toEqual([]);
  expect(report.registros.find((row) => row.pais === "HN")?.nit_cliente).toBe("08019995123456");
  expect(report.registros[0]?.valor).toBe(420000000);
  expect(report.registros[0]?.requiere_poliza).toBe(true);
});

test("Esquema del maestro: detecta campos ausentes, nulos y vacíos", async () => {
  const row = await firstRecord();
  for (const cliente of [undefined, null, "", "   "]) {
    expect(masterRecordSchema.safeParse({ ...row, cliente }).success).toBe(false);
  }
  const { id_contrato: _id, ...missingId } = row;
  expect(masterRecordSchema.safeParse(missingId).success).toBe(false);
});

test("Esquema del maestro: rechaza formatos, importes, fechas y enumeraciones inválidos", async () => {
  const row = await firstRecord();
  for (const change of [
    { valor: "" }, { valor: "1,000" }, { valor: "-2" }, { valor: "Infinity" },
    { requiere_poliza: "FALSE" }, { nit_cliente: "890.900.111-4" },
    { moneda: "EUR" }, { pais: "MX" }, { fecha_fin: "2026-02-30" },
    { objeto: "x".repeat(201) }, { ruta_sharepoint: "../privado.pdf" },
  ]) expect(masterRecordSchema.safeParse({ ...row, ...change }).success).toBe(false);
  expect(masterRecordSchema.safeParse({ ...row, valor: "0.50" }).success).toBe(true);
  // El PRD no impone un prefijo CT- a todos los identificadores.
  expect(masterRecordSchema.safeParse({ ...row, id_contrato: "CM-2026-03" }).success).toBe(true);
});

test("Fechas: verifica calendario real y años bisiestos", () => {
  expect(dateSchema.safeParse("2024-02-29").success).toBe(true);
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "03/09/2026"]) {
    expect(dateSchema.safeParse(date).success).toBe(false);
  }
});

test("Diagnóstico: informa columnas faltantes y detalles de validación", async () => {
  const row = await firstRecord();
  const report = diagnoseMaster({ columnas: masterColumns.filter((field) => field !== "moneda"),
    registros: [{ ...row, cliente: "", moneda: "" }] }, "maestro.csv");
  expect(report.problemas.some((issue) => issue.tipo === "COLUMNA_FALTANTE" && issue.campo === "moneda")).toBe(true);
  expect(report.problemas.some((issue) => issue.archivo === "maestro.csv" && issue.campo === "registro[1].cliente" && issue.nivel === "error")).toBe(true);
  expect(report.validos).toBe(0);
});

test("Diagnóstico: duplicados y coherencia son advertencias; conserva registros", async () => {
  const row = await firstRecord();
  const report = diagnoseMaster({ columnas: masterColumns, registros: [row,
    { ...row, fecha_fin: "2020-01-01", tipo_poliza: "", estado_poliza: "no_aplica" }] }, "maestro.csv");
  expect(report.duplicados).toEqual([row.id_contrato!]);
  expect(report.validos).toBe(2);
  expect(report.problemas.length).toBe(4);
  expect(report.problemas.every((issue) => issue.nivel === "advertencia")).toBe(true);
});

test("Catálogo real: tres comerciales válidos sin duplicados", async () => {
  const result = await readJson(commercialFile);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const report = diagnoseCommercials(result.data, commercialFile);
  expect(report.total).toBe(3);
  expect(report.validos).toBe(3);
  expect(report.duplicados).toEqual([]);
  expect(report.problemas).toEqual([]);
});

test("Catálogo: detecta correo inválido, datos incompletos y raíz incorrecta", () => {
  const report = diagnoseCommercials([
    { email: "sin-arroba", nombre: "Ana", region: "CO" },
    { email: "ana@example.com", region: "CO" },
    { email: "luis@example.com", nombre: "Luis", region: null },
  ], "comerciales.json");
  expect(report.total).toBe(3);
  expect(report.validos).toBe(0);
  expect(report.problemas.map((issue) => issue.campo)).toEqual([
    "registro[1].email", "registro[2].nombre", "registro[3].region",
  ]);
  expect(diagnoseCommercials({}, "comerciales.json").problemas[0]?.nivel).toBe("error");
});

test("Catálogo: detecta correos repetidos sin distinguir mayúsculas", () => {
  const report = diagnoseCommercials([
    { email: "ana@example.com", nombre: "Ana", region: "CO" },
    { email: "ANA@example.com", nombre: "Otra Ana", region: "PE" },
  ], "comerciales.json");
  expect(report.duplicados).toEqual(["ana@example.com"]);
  expect(report.problemas[0]?.nivel).toBe("advertencia");
});

test("Buzón real: lee los seis mensajes y sus adjuntos TXT sin interpretar contenido", async () => {
  const result = await readMailbox(join(fixtures, "buzon"));
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data.map((message) => message.correo?.id)).toEqual([
    "msg-001", "msg-002", "msg-003", "msg-004", "msg-005", "msg-006",
  ]);
  expect(result.data.every((message) => message.problemas.length === 0)).toBe(true);
  expect(result.data.every((message) => message.archivos.length === 2 &&
    message.adjuntos[0]?.legible && message.adjuntos[0].formato === ".txt")).toBe(true);
  expect(result.data[2]?.adjuntos[0]?.nombre).toBe("otrosi.txt");
  expect(result.data[4]?.adjuntos[0]?.nombre).toBe("cotizacion.txt");
});

test("Metadatos: detecta email, fecha y adjuntos inválidos o ausentes", () => {
  const mail = { id: "a", de: "a@example.com", para: "b@example.com", asunto: "Asunto",
    fecha: "2026-08-04T09:12:00-05:00", cuerpo: "", adjuntos: [] };
  expect(mailSchema.safeParse(mail).success).toBe(true);
  for (const change of [{ de: "incorrecto" }, { fecha: "2026-02-30T09:12:00-05:00" },
    { adjuntos: ["../fuera.txt"] }, { adjuntos: ["C:\\fuera.txt"] }, { asunto: undefined }]) {
    expect(mailSchema.safeParse({ ...mail, ...change }).success).toBe(false);
  }
});

test("Archivos inexistentes y JSON malformado generan errores controlados", async () => {
  const directory = await temporaryDirectory();
  const missing = join(directory, "no-existe.json");
  expect((await readText(missing)).ok).toBe(false);
  expect((await readJson(missing)).ok).toBe(false);
  expect((await readCsv(missing)).ok).toBe(false);
  expect((await readMailbox(missing)).ok).toBe(false);
  const malformed = join(directory, "roto.json");
  await writeFile(malformed, '{"id":');
  const result = await readJson(malformed);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problemas[0]?.tipo).toBe("JSON_INVALIDO");
});

test("Buzón continúa después de metadatos rotos y detecta adjuntos faltantes y vacíos", async () => {
  const directory = await temporaryDirectory();
  for (const name of ["a", "b", "c"]) await mkdir(join(directory, name));
  await writeFile(join(directory, "a", "correo.json"), "{");
  // b no tiene correo.json.
  await writeFile(join(directory, "c", "correo.json"), JSON.stringify({
    id: "c", de: "a@example.com", para: "b@example.com", asunto: "Asunto",
    fecha: "2026-08-04T09:12:00-05:00", cuerpo: "Texto", adjuntos: ["falta.txt", "vacio.txt"],
  }));
  await writeFile(join(directory, "c", "vacio.txt"), " ");
  const result = await readMailbox(directory);
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.data).toHaveLength(3);
  expect(result.data[0]?.problemas[0]?.tipo).toBe("JSON_INVALIDO");
  expect(result.data[1]?.problemas[0]?.nivel).toBe("error");
  expect(result.data[2]?.correo?.id).toBe("c");
  expect(result.data[2]?.problemas.map((issue) => issue.tipo)).toEqual(["ADJUNTO_ILEGIBLE", "TEXTO_VACIO"]);
});

async function originalHashes(directory: string): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(hashes, await originalHashes(path));
    else hashes[path] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  return hashes;
}

test("La lectura y el diagnóstico conservan todos los fixtures y el PRD", async () => {
  const before = await originalHashes(fixtures);
  const prdBefore = await readFile(join(root, "PRD.md"));
  const master = await readCsv(masterFile);
  const commercials = await readJson(commercialFile);
  if (master.ok) diagnoseMaster(master.data, masterFile);
  if (commercials.ok) diagnoseCommercials(commercials.data, commercialFile);
  await readMailbox(join(fixtures, "buzon"));
  expect(await originalHashes(fixtures)).toEqual(before);
  expect(await readFile(join(root, "PRD.md"))).toEqual(prdBefore);
});
