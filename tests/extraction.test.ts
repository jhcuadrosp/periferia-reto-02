import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { optionalBytes } from "../src/storage/audit.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractContract } from "../src/domain/extraction.ts";
import { extractionSchema, masterRecordSchema, type Extraction } from "../src/domain/schemas.ts";
import { normalizeAmount, normalizeCurrency, normalizeDate, normalizeTaxId } from "../src/domain/normalization.ts";
import { readText } from "../src/storage/files.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const mailbox = join(root, "fixtures", "reto-02", "buzon");

async function document(message: string, attachment = "contrato.txt") {
  const result = await readText(join(mailbox, message, attachment));
  if (!result.ok) throw new Error("No se pudo leer el documento de prueba.");
  return result.data;
}

test("Contrato ordinario: ID, primera contraparte, NIT sin DV, país y objeto", async () => {
  const result = extractContract(await document("msg-001"));
  expect(result.tipo_documento).toBe("contrato");
  expect(result.campos.id_contrato.normalizado).toBe("CT-2026-015");
  expect(result.campos.cliente.normalizado).toBe("INDUSTRIAS DELTA S.A.S.");
  expect(result.campos.nit_cliente.normalizado).toBe("890900111");
  expect(result.campos.pais).toEqual({ extraido: null, normalizado: null, confianza: 0, evidencia: null });
  expect(result.campos.objeto.normalizado).toContain("CRM");
  expect(result.campos.valor.normalizado).toBe(265000000);
  expect(result.campos.moneda.normalizado).toBe("COP");
  expect(result.campos.fecha_inicio.normalizado).toBe("2026-08-01");
  expect(result.campos.fecha_fin.normalizado).toBe("2027-07-31");
  expect(result.campos.requiere_poliza.normalizado).toBe(true);
  expect(result.campos.tipo_poliza.normalizado).toBe("cumplimiento");
  expect(result.requiere_revision).toEqual(["pais"]);
});

test("Contrato ecuatoriano: el país del contratista no sustituye al del cliente", async () => {
  const result = extractContract(await document("msg-002"));
  expect(result.campos.id_contrato.normalizado).toBe("CT-2026-016");
  expect(result.campos.nit_cliente.normalizado).toBe("1790012345001");
  expect(result.campos.pais.normalizado).toBe("EC");
  expect(result.campos.valor.normalizado).toBe(120000);
  expect(result.campos.moneda.normalizado).toBe("USD");
  expect(result.campos.fecha_inicio.normalizado).toBe("2026-08-15");
  expect(result.campos.fecha_fin.normalizado).toBe("2027-08-14");
  expect(result.plazo_meses.normalizado).toBe(12);
  expect(result.campos.requiere_poliza.normalizado).toBeNull();
  expect(result.campos.requiere_poliza.confianza).toBe(0);
});

test("Otrosí: ID de referencia y cambios explícitos, sin heredar campos del maestro", async () => {
  const result = extractContract(await document("msg-003", "otrosi.txt"));
  expect(result.tipo_documento).toBe("otrosi");
  expect(result.id_documento.normalizado).toBe("1");
  expect(result.campos.id_contrato.normalizado).toBe("CT-2026-011");
  expect(result.campos.valor.normalizado).toBe(520000);
  expect(result.campos.moneda.normalizado).toBe("PEN");
  expect(result.campos.fecha_fin.normalizado).toBe("2027-11-01");
  expect(result.campos_modificados).toEqual(["valor", "moneda", "fecha_fin"]);
  for (const key of ["cliente", "nit_cliente", "objeto", "fecha_inicio", "requiere_poliza", "estado_poliza"] as const) {
    expect(result.campos[key].normalizado).toBeNull();
    expect(result.campos[key].confianza).toBe(0);
  }
  expect(result.condicion_poliza.evidencia).toContain("deberán ampliarse");
});

test("Clínica: extrae sus datos sin decidir si es duplicado", async () => {
  const result = extractContract(await document("msg-004"));
  expect(result.campos.id_contrato.normalizado).toBe("CT-2026-012");
  expect(result.campos.valor.normalizado).toBe(210000000);
  expect(result.campos.fecha_inicio.normalizado).toBe("2026-05-15");
  expect(result.campos.fecha_fin.normalizado).toBe("2026-11-14");
  expect(result).not.toHaveProperty("clasificacion");
});

test("Cotización: separa el ID de oferta y el total estimado del importe mensual", async () => {
  const result = extractContract(await document("msg-005", "cotizacion.txt"));
  expect(result.tipo_documento).toBe("cotizacion");
  expect(result.id_documento.normalizado).toBe("COT-2026-088");
  expect(result.campos.id_contrato.normalizado).toBeNull();
  expect(result.campos.cliente.normalizado).toBe("Universidad del Valle del Río");
  expect(result.campos.objeto.normalizado).toContain("dos (2) desarrolladores");
  expect(result.campos.valor.normalizado).toBe(192000000);
  expect(result.campos.valor.confianza).toBeLessThan(0.8);
  expect(result.campos.fecha_inicio.normalizado).toBeNull();
  expect(result.campos.fecha_fin.normalizado).toBeNull();
  expect(result.plazo_meses.normalizado).toBeNull();
  expect(result).not.toHaveProperty("clasificacion");
});

test("Contrato marco: no confunde umbral de póliza con valor ni inventa fechas", async () => {
  const result = extractContract(await document("msg-006"));
  expect(result.campos.id_contrato.normalizado).toBe("CM-2026-03");
  expect(result.valor_indeterminado.normalizado).toBe(true);
  expect(result.campos.valor.normalizado).toBeNull();
  expect(result.campos.valor.extraido).toContain("no tiene un valor determinado");
  expect(result.campos.valor.confianza).toBeLessThan(0.8);
  expect(result.campos.moneda.normalizado).toBeNull();
  expect(result.campos.fecha_inicio.normalizado).toBeNull();
  expect(result.campos.fecha_fin.normalizado).toBeNull();
  expect(result.campos.fecha_inicio.evidencia).toContain("agosto de 2026");
  expect(result.plazo_meses.normalizado).toBe(12);
  expect(result.campos.requiere_poliza.normalizado).toBeNull();
  expect(result.condicion_poliza.evidencia).toContain("COP $100.000.000");
  expect(result.campos.tipo_poliza.normalizado).toBe("cumplimiento");
  expect(result.requiere_revision).toEqual(expect.arrayContaining(["valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza"]));
});

test("Objeto largo: extracción completa compatible con Zod sin adaptar al maestro", async () => {
  const result = extractContract(await document("msg-006"));
  expect(result.campos.objeto.extraido!.length).toBeGreaterThan(200);
  expect(result.campos.objeto.normalizado).toBe(result.campos.objeto.extraido);
  expect(result.campos.objeto.normalizado!.length).toBeGreaterThan(200);
  expect(result.campos.objeto.normalizado).toContain("órdenes de servicio suscritas por las partes.");
  expect(result.campos.objeto.confianza).toBe(0.98);
  expect(result.requiere_revision).not.toContain("objeto");
  expect(result.advertencias.some((item) => item.campo === "objeto")).toBe(false);
  expect(extractionSchema.safeParse(result).success).toBe(true);
  // El esquema del maestro mantiene su restricción, sin imponerla al documento.
  expect(masterRecordSchema.shape.objeto.safeParse(result.campos.objeto.normalizado).success).toBe(false);
});

test("Valor indeterminado y cero explícito son resultados documentales diferentes", async () => {
  const indeterminate = extractContract(await document("msg-006"));
  const zero = extractContract("CONTRATO No. XX-2030-01\n\nSEGUNDA. VALOR. COP 0");
  expect(indeterminate.campos.valor.normalizado).toBeNull();
  expect(indeterminate.campos.valor.confianza).toBe(0.6);
  expect(indeterminate.valor_indeterminado.normalizado).toBe(true);
  expect(indeterminate.campos.valor.evidencia).toBe(indeterminate.campos.valor.extraido);
  expect(indeterminate.requiere_revision).toContain("valor");
  expect(zero.campos.valor.normalizado).toBe(0);
  expect(zero.campos.valor.confianza).toBe(0.98);
  expect(zero.valor_indeterminado.normalizado).toBeNull();
  expect(extractionSchema.safeParse(indeterminate).success).toBe(true);
  expect(extractionSchema.safeParse(zero).success).toBe(true);
});

test("País explícito del cliente: prevalece sobre identificador y país del contratista", () => {
  for (const [country, code] of [["Colombia", "CO"], ["ecuador", "EC"], ["Perú", "PE"], ["Panamá", "PA"], ["Honduras", "HN"]] as const) {
    const text = `CONTRATO No. XX-2030-01\n\nEntre CLIENTE S.A., NIT 123456789-0, con domicilio en ${country}, y PERIFERIA IT GROUP S.A.S., NIT 900123456-7, con domicilio en Colombia.`;
    const result = extractContract(text);
    expect(result.campos.pais.extraido).toBe(country!);
    expect(result.campos.pais.normalizado).toBe(code!);
    expect(result.campos.pais.confianza).toBe(0.98);
    expect(result.campos.pais.evidencia).toContain(`con domicilio en ${country}`);
    expect(result.campos.pais.evidencia).not.toContain("PERIFERIA");
  }
});

test("País sin evidencia suficiente: no infiere CO por NIT ni por el contratista", () => {
  for (const location of ["Bogotá", "Medellín", "Barranquilla", "Colombiana", "Ecuador y Perú"]) {
    const result = extractContract(`CONTRATO No. XX-2030-01\n\nEntre CLIENTE S.A., NIT 123456789-0, con domicilio en ${location}, y PERIFERIA IT GROUP S.A.S., con domicilio en Colombia.`);
    expect(result.campos.pais).toEqual({ extraido: null, normalizado: null, confianza: 0, evidencia: null });
    expect(result.requiere_revision).toContain("pais");
  }
});

test("Importes: interpreta separadores inequívocos y rechaza ambigüedades", () => {
  for (const [text, expected] of [
    ["265.000.000", 265000000], ["120,000.00", 120000], ["520,000.00", 520000],
    ["1.234,56", 1234.56], ["1,234.56", 1234.56], ["120000.50", 120000.5],
    ["0", 0], ["0,50", 0.5], [" 20 ", 20],
  ] as const) expect(normalizeAmount(text)).toBe(expected);
  for (const text of ["", "1.234", "1,234", "12,34,567", "-5", "NaN", "doscientos", "999999999999999999999"]) {
    expect(normalizeAmount(text)).toBeNull();
  }
});

test("Monedas e identificadores: no inventa códigos y conserva ceros iniciales", () => {
  expect(normalizeCurrency("cop")).toBe("COP");
  expect(normalizeCurrency("EUR")).toBeNull();
  expect(normalizeCurrency("$")).toBeNull();
  expect(normalizeTaxId("890.900.111-4", "NIT")).toBe("890900111");
  expect(normalizeTaxId("08019995123456", "RUC")).toBe("08019995123456");
  expect(normalizeTaxId("1790012345001", "RUC")).toBe("1790012345001");
  expect(normalizeTaxId("abc", "NIT")).toBeNull();
});

test("Fechas: interpreta español e ISO y conserva ambigüedades sin normalizar", () => {
  for (const [text, expected] of [
    ["primero (1) de agosto de 2026", "2026-08-01"],
    ["treinta y uno (31) de julio de 2027", "2027-07-31"],
    ["15 de agosto de 2026", "2026-08-15"],
    ["el primero de noviembre de 2027", "2027-11-01"],
    ["2024-02-29", "2024-02-29"],
  ] as const) expect(normalizeDate(text)).toBe(expected);
  for (const text of ["agosto de 2026", "2026-02-30", "31 de abril de 2026", "03/09/2026", "doce meses desde la firma", "treinta (1) de agosto de 2026"]) {
    expect(normalizeDate(text)).toBeNull();
  }
});

test("Reglas por contenido: extrae otro ID, importe y fechas sin depender de msg-001", async () => {
  const text = (await document("msg-001")).replaceAll("CT-2026-015", "AC-2030-099")
    .replace("265.000.000", "1,234.50")
    .replace("primero (1) de agosto de 2026", "2029-03-10")
    .replace("treinta y uno (31) de julio de 2027", "2030-03-09");
  const result = extractContract(text);
  expect(result.campos.id_contrato.normalizado).toBe("AC-2030-099");
  expect(result.campos.valor.normalizado).toBe(1234.5);
  expect(result.campos.fecha_inicio.normalizado).toBe("2029-03-10");
  expect(result.campos.fecha_fin.normalizado).toBe("2030-03-09");
});

test("Importe o moneda no soportados permanecen pendientes con su evidencia", () => {
  const result = extractContract("CONTRATO No. XX-2030-01\n\nSEGUNDA. VALOR. EUR 1.234");
  expect(result.campos.moneda.normalizado).toBeNull();
  expect(result.campos.moneda.extraido).toBe("EUR");
  expect(result.campos.valor.normalizado).toBeNull();
  expect(result.campos.valor.extraido).toBe("1.234");
  expect(result.advertencias.map((item) => item.tipo)).toEqual(expect.arrayContaining(["MONEDA_DESCONOCIDA", "IMPORTE_AMBIGUO"]));
});

test("Varios importes en una cláusula no producen una elección arbitraria", () => {
  const result = extractContract("CONTRATO No. XX-2030-01\n\nSEGUNDA. VALOR. COP 100000 o USD 2000");
  expect(result.campos.valor.normalizado).toBeNull();
  expect(result.campos.moneda.normalizado).toBeNull();
  expect(result.advertencias[0]?.tipo).toBe("IMPORTES_MULTIPLES");
});

test("La falta de cláusula de valor no reutiliza el umbral de las garantías", () => {
  const result = extractContract("CONTRATO No. XX-2030-01\n\nCUARTA. GARANTÍAS. Para cada orden cuyo valor supere COP 100000 se constituirá póliza de cumplimiento.");
  expect(result.campos.valor.normalizado).toBeNull();
  expect(result.campos.valor.confianza).toBe(0);
  expect(result.campos.requiere_poliza.normalizado).toBeNull();
});

test("Una exención explícita de póliza sí se conserva como false", () => {
  const result = extractContract("CONTRATO No. XX-2030-01\n\nCUARTA. GARANTÍAS. No se requiere póliza.");
  expect(result.campos.requiere_poliza.normalizado).toBe(false);
  expect(result.campos.tipo_poliza.normalizado).toBe("");
});

test("Campo ausente: null, confianza cero y sin evidencia inventada", () => {
  const result = extractContract("CONTRATO No. XX-2030-01");
  expect(result.campos.cliente).toEqual({ extraido: null, normalizado: null, confianza: 0, evidencia: null });
  expect(result.requiere_revision).toContain("cliente");
});

test("Campos enriquecidos: ausentes sin advertencias ni revisiones en los seis documentos", async () => {
  for (const [id, attachment] of [["msg-001", "contrato.txt"], ["msg-002", "contrato.txt"],
    ["msg-003", "otrosi.txt"], ["msg-004", "contrato.txt"], ["msg-005", "cotizacion.txt"], ["msg-006", "contrato.txt"]]) {
    const result = extractContract(await document(id!, attachment));
    for (const key of ["comercial", "estado_poliza", "ruta_sharepoint", "fecha_registro", "fuente"] as const) {
      expect(result.campos[key]).toEqual({ extraido: null, normalizado: null, confianza: 0, evidencia: null });
      expect(result.requiere_revision).not.toContain(key);
      expect(result.advertencias.some((item) => item.campo === key)).toBe(false);
    }
  }
});

test("Texto vacío o inesperado devuelve advertencias sin lanzar errores", () => {
  for (const text of ["", " \n\t", "Una pregunta sin estructura contractual"]) {
    const result = extractContract(text);
    expect(result.tipo_documento).toBe("desconocido");
    expect(result.campos.valor.normalizado).toBeNull();
    expect(result.advertencias).toHaveLength(1);
    expect(extractionSchema.safeParse(result).success).toBe(true);
  }
});

function allFields(result: Extraction) {
  return [...Object.values(result.campos), result.id_documento, result.valor_indeterminado,
    result.plazo_meses, result.condicion_poliza];
}

test("Los seis resultados tienen confianza válida y evidencia literal del documento", async () => {
  for (const [id, attachment] of [["msg-001", "contrato.txt"], ["msg-002", "contrato.txt"],
    ["msg-003", "otrosi.txt"], ["msg-004", "contrato.txt"], ["msg-005", "cotizacion.txt"], ["msg-006", "contrato.txt"]]) {
    const text = await document(id!, attachment);
    const result = extractContract(text);
    expect(extractionSchema.safeParse(result).success).toBe(true);
    for (const field of allFields(result)) {
      expect(field.confianza).toBeGreaterThanOrEqual(0);
      expect(field.confianza).toBeLessThanOrEqual(1);
      if (field.extraido !== null) {
        expect(text).toContain(field.extraido);
        expect(text).toContain(field.evidencia!);
      } else {
        expect(field.normalizado).toBeNull();
        expect(field.confianza).toBe(0);
      }
    }
  }
});

test("Esquema de extracción rechaza confianza inválida y evidencia ausente", () => {
  const result = extractContract("CONTRATO No. XX-2030-01");
  for (const confidence of [-1, 1.1]) {
    expect(extractionSchema.safeParse({ ...result, id_documento: { ...result.id_documento, confianza: confidence } }).success).toBe(false);
  }
  expect(extractionSchema.safeParse({ ...result, id_documento: { ...result.id_documento, evidencia: null } }).success).toBe(false);
  expect(extractionSchema.safeParse({ ...result, campos: { ...result.campos,
    cliente: { extraido: null, normalizado: "Inventado", confianza: 0, evidencia: null } } }).success).toBe(false);
});

test("Extracción repetida: salida determinista y originales intactos", async () => {
  const paths = [join(root, "PRD.md"), join(root, "AGENTS.md")];
  async function collect(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else paths.push(path);
    }
  }
  await collect(join(root, "fixtures"));
  async function hashes() {
    return Promise.all(paths.map(async (path) => {
      const bytes = path === join(root, "AGENTS.md") ? await optionalBytes(path) : await readFile(path);
      return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
    }));
  }
  const before = await hashes();
  for (const path of paths.filter((path) => path.endsWith(".txt"))) {
    const text = await readFile(path, "utf8");
    expect(extractContract(text)).toEqual(extractContract(text));
  }
  expect(await hashes()).toEqual(before);
});
