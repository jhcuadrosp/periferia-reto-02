import { readFile } from "node:fs/promises";

export type Problem = {
  archivo: string;
  campo: string;
  tipo: string;
  nivel: "error" | "advertencia";
  descripcion: string;
};

export type ReadResult<T> =
  | { ok: true; data: T }
  | { ok: false; problemas: Problem[] };

export function fileError(archivo: string, tipo: string, descripcion: string): ReadResult<never> {
  return { ok: false, problemas: [{ archivo, campo: "$", tipo, nivel: "error", descripcion }] };
}

export async function readText(archivo: string): Promise<ReadResult<string>> {
  try {
    return { ok: true, data: await readFile(archivo, "utf8") };
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "LECTURA";
    return fileError(archivo, code, "No se pudo leer el archivo. Comprueba su existencia y permisos.");
  }
}

export async function readJson(archivo: string): Promise<ReadResult<unknown>> {
  const result = await readText(archivo);
  if (!result.ok) return result;
  try {
    const data: unknown = JSON.parse(result.data);
    return { ok: true, data };
  } catch {
    return fileError(archivo, "JSON_INVALIDO", "El contenido no es JSON válido.");
  }
}
