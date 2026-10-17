import { z } from "zod";
import { commercialSchema, masterColumns, masterRecordSchema, type MasterRecord } from "./schemas.ts";
import type { CsvData } from "../storage/csv.ts";
import type { Problem } from "../storage/files.ts";

export function validationProblems(error: z.ZodError, archivo: string, prefix = ""): Problem[] {
  return error.issues.map((issue) => ({
    archivo,
    campo: [prefix, ...issue.path.map(String)].filter(Boolean).join(".") || "$",
    tipo: issue.code,
    nivel: "error",
    descripcion: issue.message,
  }));
}

export function warning(archivo: string, campo: string, tipo: string, descripcion: string): Problem {
  return { archivo, campo, tipo, nivel: "advertencia", descripcion };
}

export function findDuplicates(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function recordWarnings(record: MasterRecord, archivo: string, row: number): Problem[] {
  const problems: Problem[] = [];
  const add = (campo: string, descripcion: string) =>
    problems.push(warning(archivo, `registro[${row}].${campo}`, "INCONSISTENCIA", descripcion));
  if (record.fecha_fin < record.fecha_inicio) add("fecha_fin", "La fecha final es anterior a la inicial.");
  if (record.requiere_poliza && !record.tipo_poliza.trim()) add("tipo_poliza", "Se exige póliza pero no se indica su tipo.");
  if (!record.requiere_poliza && record.tipo_poliza !== "") add("tipo_poliza", "No se exige póliza pero se indica un tipo.");
  if (record.requiere_poliza === (record.estado_poliza === "no_aplica")) {
    add("estado_poliza", "El estado de la póliza no es coherente con requiere_poliza.");
  }
  return problems;
}

export function diagnoseMaster(csv: CsvData, archivo: string) {
  const problemas: Problem[] = [];
  const registros: MasterRecord[] = [];
  for (const column of masterColumns) {
    if (!csv.columnas.includes(column)) problemas.push({
      archivo, campo: column, tipo: "COLUMNA_FALTANTE", nivel: "error",
      descripcion: "Falta una columna obligatoria del maestro.",
    });
  }
  for (const column of csv.columnas) {
    if (!masterColumns.includes(column)) problemas.push(warning(archivo, column, "COLUMNA_EXTRA", "Columna no definida en el PRD; se conserva en los datos originales."));
  }
  const vacios = Object.fromEntries(csv.columnas.map((column) => [
    column, csv.registros.filter((row) => !row[column]?.trim()).length,
  ]));
  csv.registros.forEach((row, index) => {
    const parsed = masterRecordSchema.safeParse(row);
    if (!parsed.success) problemas.push(...validationProblems(parsed.error, archivo, `registro[${index + 1}]`));
    else {
      registros.push(parsed.data);
      problemas.push(...recordWarnings(parsed.data, archivo, index + 1));
    }
  });
  const duplicados = findDuplicates(csv.registros.map((row) => row.id_contrato ?? "").filter((id) => id.trim()));
  for (const id of duplicados) problemas.push(warning(archivo, "id_contrato", "DUPLICADO", `Identificador repetido: ${id}. No se modifica ningún registro.`));
  return { archivo, total: csv.registros.length, columnas: csv.columnas,
    validos: registros.length, vacios, duplicados, registros, problemas };
}

export function diagnoseCommercials(data: unknown, archivo: string) {
  const root = z.array(z.unknown()).safeParse(data);
  if (!root.success) return { archivo, total: 0, validos: 0, registros: [], duplicados: [],
    problemas: validationProblems(root.error, archivo) };
  const registros: z.infer<typeof commercialSchema>[] = [];
  const problemas: Problem[] = [];
  root.data.forEach((row, index) => {
    const parsed = commercialSchema.safeParse(row);
    if (!parsed.success) problemas.push(...validationProblems(parsed.error, archivo, `registro[${index + 1}]`));
    else registros.push(parsed.data);
  });
  const duplicados = findDuplicates(registros.map((row) => row.email.toLowerCase()));
  for (const email of duplicados) problemas.push(warning(archivo, "email", "DUPLICADO", `Correo repetido: ${email}.`));
  return { archivo, total: root.data.length, validos: registros.length, registros, duplicados, problemas };
}
