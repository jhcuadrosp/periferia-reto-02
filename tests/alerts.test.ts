import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { generateAlerts, renderAlerts } from "../src/domain/alerts.ts";
import { masterRecordSchema, type MasterRecord } from "../src/domain/schemas.ts";
import { parseCsv } from "../src/storage/csv.ts";

const csv = parseCsv(await readFile(new URL("../fixtures/reto-02/maestro-contratos.csv", import.meta.url), "utf8"), "fixture");
if (!csv.ok) throw new Error("Fixture ilegible.");
const original = csv.data.registros.map((row) => masterRecordSchema.parse(row));
const row = (id: string, end: string, changes: Partial<MasterRecord> = {}): MasterRecord =>
  ({ ...original[0]!, id_contrato: id, fecha_fin: end, ...changes });

test("Alertas: límites -1, 0, 1, 60 y 61 días sin mezclar vencidos", () => {
  const report = generateAlerts([row("ayer", "2026-09-02"), row("hoy", "2026-09-03"), row("uno", "2026-09-04"),
    row("sesenta", "2026-11-02"), row("fuera", "2026-11-03")], "2026-09-03");
  expect(report.vencen.map((record) => [record.id_contrato, record.dias_restantes])).toEqual([["hoy", 0], ["uno", 1], ["sesenta", 60]]);
  expect(report.vencidos.map((record) => record.id_contrato)).toEqual(["ayer"]);
});

test("Fecha configurable, año bisiesto y calendario UTC no dependen del reloj local", () => {
  const records = [row("bisiesto", "2028-03-01")];
  expect(generateAlerts(records, "2028-02-28").vencen[0]!.dias_restantes).toBe(2);
  expect(generateAlerts(records, "2028-03-02").vencidos).toHaveLength(1);
  expect(() => generateAlerts(records, "2026-02-29")).toThrow();
});

test("Pólizas obligatorias: pendiente, vencida y no_aplica incoherente se reportan sin inventar estados", () => {
  const report = generateAlerts([row("a", "2027-01-01", { estado_poliza: "pendiente" }),
    row("b", "2027-01-01", { estado_poliza: "vencida" }), row("c", "2027-01-01", { estado_poliza: "no_aplica" }),
    row("d", "2027-01-01", { estado_poliza: "vigente" }), row("e", "2027-01-01", { requiere_poliza: false, estado_poliza: "pendiente" })], "2026-09-03");
  expect(report.polizas_pendientes.map((record) => record.id_contrato)).toEqual(["a", "b", "c"]);
});

test("Corte inclusivo 2026-05-30, hasta hoy; actualizaciones no cambian la fecha de alta", () => {
  const report = generateAlerts([row("antes", "2027-01-01", { fecha_registro: "2026-05-29" }),
    row("corte", "2027-01-01", { fecha_registro: "2026-05-30" }), row("actual", "2027-01-01", { fecha_registro: "2026-09-03" }),
    row("futuro", "2027-01-01", { fecha_registro: "2026-09-04" })], "2026-09-03");
  expect(report.registrados_desde_corte.map((record) => record.id_contrato)).toEqual(["corte", "actual"]);
  expect(report.advertencias[0]).toContain("futuro");
});

test("Ampliación pendiente se conserva desde historial aunque la póliza figure vigente", () => {
  const record = original.find((record) => record.id_contrato === "CT-2026-011")!;
  const report = generateAlerts([record], "2026-09-03", [{ id_contrato: record.id_contrato, mensaje_id: "msg-003", ts: "2026-09-03T00:00:00Z",
    obligaciones_pendientes: [{ campo: "estado_poliza", tipo: "AMPLIAR_GARANTIAS", descripcion: "Ampliación exigida por otrosí, sin evidencia de ejecución." }] }]);
  expect(report.polizas_pendientes).toHaveLength(0);
  expect(report.obligaciones_pendientes[0]!.id_contrato).toBe("CT-2026-011");
  expect(renderAlerts(report)).toContain("no demuestra que se haya realizado una ampliación");
});

test("Maestro original a 2026-09-03: dos próximos, dos vencidos, una póliza pendiente", () => {
  const before = structuredClone(original);
  const report = generateAlerts(original, "2026-09-03");
  expect(report.vencen.map((record) => record.id_contrato)).toEqual(["CT-2026-009", "CT-2026-004"]);
  expect(report.vencidos).toHaveLength(2);
  expect(report.polizas_pendientes.map((record) => record.id_contrato)).toEqual(["CT-2026-004"]);
  expect(report.registrados_desde_corte).toHaveLength(0);
  expect(original).toEqual(before);
  expect(generateAlerts(original, "2026-09-03")).toEqual(report);
});

test("Markdown conserva tres secciones y escapa delimitadores de tablas y saltos", () => {
  const markdown = renderAlerts(generateAlerts([row("a", "2026-09-04", { cliente: "A | B\n<ejemplo>" })], "2026-09-03"));
  expect(markdown.match(/^## /gm)).toHaveLength(3);
  expect(markdown).toContain("A \\| B &lt;ejemplo&gt;");
  expect(markdown).toContain("No hay fechas de vencimiento de pólizas");
  expect(renderAlerts(generateAlerts([], "2026-09-03"))).toContain("Sin registros.");
});

test("Datos o historial malformados no producen un informe de éxito", () => {
  expect(() => generateAlerts([row("a", "fecha ausente")], "2026-09-03")).toThrow();
  expect(() => generateAlerts(original, "2026-09-03", [{ obligaciones_pendientes: "malformado" }])).toThrow();
});
