import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { relativePathSchema } from "../domain/schemas.ts";

export const hashBytes = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export function appendJsonLine(current: Buffer, event: unknown): Buffer {
  const text = current.toString("utf8");
  for (const line of text.split(/\r?\n/).filter((line) => line.trim())) JSON.parse(line);
  const separator = text && !text.endsWith("\n") ? "\n" : "";
  return Buffer.concat([current, Buffer.from(`${separator}${JSON.stringify(event)}\n`)]);
}

export async function optionalBytes(path: string): Promise<Buffer | null> {
  try { return await readFile(path); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

// Todas las rutas de escritura son relativas al out/ del proyecto, incluidos temporales y recuperación.
export async function outputPath(directory: string, name: string): Promise<string> {
  if (name !== ".") relativePathSchema.parse(name);
  const project = await realpath(directory);
  const out = join(project, "out");
  const target = resolve(out, name);
  const rel = relative(out, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Ruta de salida fuera de out/.");
  const parts = rel ? ["out", ...rel.split(sep)] : ["out"];
  let cursor = project;
  for (const part of parts) {
    cursor = join(cursor, part);
    try {
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("No se permiten enlaces simbólicos ni junctions en out/.");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return target;
}

async function atomicWrite(directory: string, name: string, data: Uint8Array) {
  const path = await outputPath(directory, name);
  await mkdir(dirname(path), { recursive: true });
  const temporaryName = `${name}.${randomUUID()}.tmp`;
  const temporary = await outputPath(directory, temporaryName);
  try {
    await writeFile(temporary, data, { flag: "wx" });
    await outputPath(directory, name);
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

const journalSchema = z.object({
  estado: z.enum(["preparado", "confirmado"]),
  archivos: z.array(z.object({ ruta: relativePathSchema, antes: z.string().nullable(), despues: z.string() })),
});
const journalName = ".transaccion.json";
const same = (left: Buffer | null, encoded: string | null) => left === null ? encoded === null : left.toString("base64") === encoded;

export async function recoverTransaction(directory: string) {
  const path = await outputPath(directory, journalName);
  const bytes = await optionalBytes(path);
  if (!bytes) return;
  const journal = journalSchema.parse(JSON.parse(bytes.toString("utf8")));
  for (const file of journal.archivos) {
    if (file.ruta === journalName || file.ruta.includes(".tmp")) throw new Error("Diario de recuperación inválido.");
    const current = await optionalBytes(await outputPath(directory, file.ruta));
    if (journal.estado === "confirmado" && !same(current, file.despues)) throw new Error("El diario confirmado no coincide con el estado de salida; requiere revisión.");
    if (!same(current, file.antes) && !same(current, file.despues)) throw new Error("Recuperación bloqueada: hay cambios externos en los archivos afectados.");
  }
  if (journal.estado === "preparado") {
    for (const file of [...journal.archivos].reverse()) {
      const target = await outputPath(directory, file.ruta);
      if (file.antes === null) await rm(target, { force: true });
      else await atomicWrite(directory, file.ruta, Buffer.from(file.antes, "base64"));
    }
  }
  await rm(path);
}

export type Change = { ruta: string; data: Uint8Array };
export type CommitOptions = {
  // Solo para simular errores de I/O de forma determinista en las pruebas.
  beforeReplace?: (path: string, index: number) => Promise<void> | void;
};

export async function commitFiles(directory: string, changes: Change[], expectedMaster: string, options: CommitOptions = {}) {
  const masterName = "sharepoint/maestro-contratos.csv";
  const masterPath = await outputPath(directory, masterName);
  const verifyMaster = async (expected: string) => {
    if (hashBytes(await readFile(masterPath)) !== expected) throw new Error("El maestro cambió; vuelve a evaluar la operación.");
  };
  await verifyMaster(expectedMaster);
  const journal: z.infer<typeof journalSchema> = { estado: "preparado", archivos: [] };
  for (const file of changes) {
    const before = await optionalBytes(await outputPath(directory, file.ruta));
    journal.archivos.push({ ruta: file.ruta, antes: before?.toString("base64") ?? null, despues: Buffer.from(file.data).toString("base64") });
  }
  const journalPath = await outputPath(directory, journalName);
  if (await optionalBytes(journalPath)) throw new Error("Hay una recuperación pendiente.");
  await atomicWrite(directory, journalName, Buffer.from(JSON.stringify(journal)));
  let expected = expectedMaster;
  try {
    for (const [index, file] of changes.entries()) {
      await options.beforeReplace?.(file.ruta, index);
      await verifyMaster(expected);
      const current = await optionalBytes(await outputPath(directory, file.ruta));
      if (!same(current, journal.archivos[index]!.antes)) throw new Error("Un archivo de salida cambió durante la operación.");
      await atomicWrite(directory, file.ruta, file.data);
      if (file.ruta === masterName) expected = hashBytes(file.data);
    }
    await verifyMaster(expected);
    journal.estado = "confirmado";
    await atomicWrite(directory, journalName, Buffer.from(JSON.stringify(journal)));
  } catch (error) {
    try { await recoverTransaction(directory); }
    catch { throw new Error("Error de escritura y recuperación pendiente; conserva out/ y revisa .transaccion.json antes de continuar."); }
    throw error;
  }
  // Si falla solo la limpieza, el diario confirmado permite completar la recuperación sin repetir el registro.
  await rm(journalPath);
}

export async function appendLog(directory: string, event: unknown) {
  const name = "log.jsonl";
  const current = await optionalBytes(await outputPath(directory, name));
  await atomicWrite(directory, name, appendJsonLine(current ?? Buffer.alloc(0), event));
}
