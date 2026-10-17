import { parse } from "csv-parse/sync";
import { fileError, readText, type ReadResult } from "./files.ts";

export type CsvData = { columnas: string[]; registros: Record<string, string>[] };

export function parseCsv(text: string, archivo: string): ReadResult<CsvData> {
  try {
    const rows = parse(text, { bom: true, skip_empty_lines: true, delimiter: "," });
    const [columns, ...records] = rows;
    if (!columns?.length || columns.some((column) => !column.trim())) {
      return fileError(archivo, "CSV_ENCABEZADO", "Falta un encabezado CSV válido.");
    }
    if (new Set(columns).size !== columns.length) {
      return fileError(archivo, "CSV_ENCABEZADO", "El encabezado contiene columnas repetidas.");
    }
    return { ok: true, data: {
      columnas: columns,
      registros: records.map((row) => Object.fromEntries(
        columns.map((column, index) => [column, row[index]!]),
      )),
    } };
  } catch {
    return fileError(archivo, "CSV_INVALIDO", "CSV mal formado: revisa comillas y cantidad de campos por registro.");
  }
}

export async function readCsv(archivo: string): Promise<ReadResult<CsvData>> {
  const result = await readText(archivo);
  return result.ok ? parseCsv(result.data, archivo) : result;
}
