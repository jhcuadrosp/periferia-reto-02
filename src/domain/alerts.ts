import { z } from "zod";
import { dateSchema, type MasterRecord } from "./schemas.ts";
import { storedContractSchema } from "./confirmation.ts";

const obligationSchema = z.object({
  id_contrato: z.string(), mensaje_id: z.string(), ts: z.string(),
  obligaciones_pendientes: z.array(z.object({ campo: z.string(), tipo: z.string(), descripcion: z.string() })).optional(),
});
const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

export function generateAlerts(supplied: MasterRecord[], reference: string, history: unknown[] = []) {
  const hoy = dateSchema.parse(reference);
  const records = z.array(storedContractSchema).parse(supplied);
  const dated = records.map((record) => ({ ...record, dias_restantes: day(record.fecha_fin) - day(hoy) }));
  const byEnd = (a: { fecha_fin: string; id_contrato: string }, b: { fecha_fin: string; id_contrato: string }) =>
    a.fecha_fin.localeCompare(b.fecha_fin) || a.id_contrato.localeCompare(b.id_contrato);
  const ids = new Set(records.map((record) => record.id_contrato));
  const obligations = history.flatMap((event) => {
    const parsed = obligationSchema.parse(event);
    return (parsed.obligaciones_pendientes ?? []).filter((warning) => warning.tipo === "AMPLIAR_GARANTIAS" && ids.has(parsed.id_contrato))
      .map((warning) => ({ id_contrato: parsed.id_contrato, mensaje_id: parsed.mensaje_id, ts: parsed.ts, ...warning }));
  });
  return {
    hoy, horizonte_dias: 60, corte: "2026-05-30",
    vencen: dated.filter((record) => record.dias_restantes >= 0 && record.dias_restantes <= 60).sort(byEnd),
    vencidos: dated.filter((record) => record.dias_restantes < 0).sort(byEnd),
    polizas_pendientes: records.filter((record) => record.requiere_poliza && record.estado_poliza !== "vigente")
      .sort((a, b) => a.id_contrato.localeCompare(b.id_contrato)),
    registrados_desde_corte: records.filter((record) => record.fecha_registro >= "2026-05-30" && record.fecha_registro <= hoy)
      .sort((a, b) => a.fecha_registro.localeCompare(b.fecha_registro) || a.id_contrato.localeCompare(b.id_contrato)),
    obligaciones_pendientes: obligations,
    advertencias: records.filter((record) => record.fecha_registro > hoy).map((record) =>
      `${record.id_contrato}: fecha de registro posterior a hoy; no se incluye en el gap cubierto a esta fecha.`),
  };
}

export type Alerts = ReturnType<typeof generateAlerts>;
const cell = (value: string | number) => String(value).replaceAll("|", "\\|").replace(/[\r\n]+/g, " ").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
function table(headers: string[], rows: (string | number)[][]) {
  return rows.length ? [headers, headers.map(() => "---"), ...rows].map((row) => `| ${row.map(cell).join(" | ")} |`).join("\n") : "Sin registros.";
}

export function renderAlerts(report: Alerts) {
  const contractRows = (rows: Alerts["vencen"]) => rows.map((row) => [row.id_contrato, row.cliente, row.fecha_fin, row.dias_restantes]);
  return `# Alertas contractuales\n\nFecha de referencia: ${report.hoy}. Horizonte: 0 a 60 días, inclusive.\n\n` +
    `## 1. Vencimientos\n\n### Próximos (≤ 60 días)\n\n${table(["Contrato", "Cliente", "Fin", "Días restantes"], contractRows(report.vencen))}\n\n` +
    `### Ya vencidos\n\n${table(["Contrato", "Cliente", "Fin", "Días restantes"], contractRows(report.vencidos))}\n\n` +
    `## 2. Pólizas obligatorias no vigentes y obligaciones pendientes\n\n${table(["Contrato", "Cliente", "Estado informado"], report.polizas_pendientes.map((row) => [row.id_contrato, row.cliente, row.estado_poliza]))}\n\n` +
    `### Ampliaciones de garantías pendientes según historial\n\n${table(["Contrato", "Mensaje", "Evidencia / obligación"], report.obligaciones_pendientes.map((row) => [row.id_contrato, row.mensaje_id, row.descripcion]))}\n\n` +
    `El estado histórico vigente no demuestra que se haya realizado una ampliación. No hay fechas de vencimiento de pólizas en el maestro; no se deducen del fin contractual.\n\n` +
    `## 3. Registros desde el corte ${report.corte} hasta ${report.hoy}\n\n${table(["Contrato", "Cliente", "Fecha de registro"], report.registrados_desde_corte.map((row) => [row.id_contrato, row.cliente, row.fecha_registro]))}\n\n` +
    `Las actualizaciones conservan la fecha original de registro; no cuentan como altas nuevas del gap.\n\n` +
    (report.advertencias.length ? `Advertencias:\n${report.advertencias.map((warning) => `- ${cell(warning)}`).join("\n")}\n` : "");
}
