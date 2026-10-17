import { readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";
import { mailSchema, type Mail } from "../domain/schemas.ts";
import { findDuplicates, validationProblems, warning } from "../domain/quality.ts";
import { readJson, readText, type Problem, type ReadResult } from "./files.ts";

type Attachment = { nombre: string; formato: string; legible: boolean; caracteres?: number };
export type MailSummary = {
  carpeta: string;
  archivos: string[];
  correo: Mail | null;
  adjuntos: Attachment[];
  problemas: Problem[];
};

async function inspectAttachment(directory: string, name: string) {
  const archivo = join(directory, name);
  const adjunto: Attachment = { nombre: name, formato: extname(name).toLowerCase(), legible: false };
  const problemas: Problem[] = [];
  try {
    // realpath también impide salir del directorio mediante enlaces simbólicos.
    const destination = relative(await realpath(directory), await realpath(archivo));
    if (isAbsolute(destination) || destination === ".." || destination.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
      problemas.push({ archivo, campo: "adjuntos", tipo: "RUTA_INVALIDA", nivel: "error", descripcion: "El adjunto sale del directorio del mensaje." });
    } else if (!(await stat(archivo)).isFile()) {
      problemas.push({ archivo, campo: "adjuntos", tipo: "NO_ES_ARCHIVO", nivel: "error", descripcion: "El adjunto no es un archivo regular." });
    } else if (adjunto.formato === ".txt") {
      const result = await readText(archivo);
      if (!result.ok) problemas.push(...result.problemas);
      else {
        adjunto.legible = true;
        adjunto.caracteres = result.data.length;
        if (!result.data.trim()) problemas.push(warning(archivo, "contenido", "TEXTO_VACIO", "El adjunto TXT está vacío."));
      }
    } else {
      await Bun.file(archivo).arrayBuffer();
      adjunto.legible = true;
      problemas.push(warning(archivo, "contenido", "FORMATO_NO_INTERPRETADO", "Archivo legible; en esta fase solo se exploran textos TXT."));
    }
  } catch {
    problemas.push({ archivo, campo: "adjuntos", tipo: "ADJUNTO_ILEGIBLE", nivel: "error", descripcion: "El archivo referenciado no existe o no se puede leer." });
  }
  return { adjunto, problemas };
}

async function inspectMessage(directory: string, folder: string): Promise<MailSummary> {
  const summary: MailSummary = { carpeta: folder, archivos: [], correo: null, adjuntos: [], problemas: [] };
  const archivo = join(directory, "correo.json");
  try {
    summary.archivos = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile()).map((entry) => entry.name).sort();
  } catch {
    summary.problemas.push({ archivo: directory, campo: "$", tipo: "DIRECTORIO_ILEGIBLE", nivel: "error", descripcion: "No se pudo listar el directorio del mensaje." });
    return summary;
  }
  const result = await readJson(archivo);
  if (!result.ok) { summary.problemas.push(...result.problemas); return summary; }
  const parsed = mailSchema.safeParse(result.data);
  if (!parsed.success) { summary.problemas.push(...validationProblems(parsed.error, archivo)); return summary; }
  summary.correo = parsed.data;
  if (parsed.data.id !== folder) summary.problemas.push(warning(archivo, "id", "ID_CARPETA", "El ID del correo no coincide con el nombre de la carpeta."));
  if (!parsed.data.cuerpo.trim()) summary.problemas.push(warning(archivo, "cuerpo", "CUERPO_VACIO", "El correo no contiene cuerpo de texto."));
  for (const name of parsed.data.adjuntos) {
    const result = await inspectAttachment(directory, name);
    summary.adjuntos.push(result.adjunto);
    summary.problemas.push(...result.problemas);
  }
  for (const name of findDuplicates(parsed.data.adjuntos)) summary.problemas.push(warning(archivo, "adjuntos", "DUPLICADO", `Adjunto referenciado más de una vez: ${name}.`));
  for (const name of summary.archivos) {
    if (name !== "correo.json" && !parsed.data.adjuntos.includes(name)) summary.problemas.push(warning(archivo, "adjuntos", "NO_REFERENCIADO", `Archivo disponible no referenciado: ${name}.`));
  }
  return summary;
}

export async function readMailbox(directory: string): Promise<ReadResult<MailSummary[]>> {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    const folders = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const messages: MailSummary[] = [];
    for (const folder of folders) messages.push(await inspectMessage(join(directory, folder), folder));
    const ids = messages.flatMap((message) => message.correo ? [message.correo.id] : []);
    for (const id of findDuplicates(ids)) {
      for (const message of messages.filter((message) => message.correo?.id === id)) {
        message.problemas.push(warning(join(directory, message.carpeta, "correo.json"), "id", "DUPLICADO", `ID de mensaje repetido: ${id}.`));
      }
    }
    return { ok: true, data: messages };
  } catch {
    return { ok: false, problemas: [{ archivo: directory, campo: "$", tipo: "BUZON_ILEGIBLE", nivel: "error", descripcion: "No se pudo listar el buzón." }] };
  }
}
