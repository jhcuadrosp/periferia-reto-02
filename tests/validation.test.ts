import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { optionalBytes } from "../src/storage/audit.ts";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractContract } from "../src/domain/extraction.ts";
import { diagnoseCommercials, diagnoseMaster } from "../src/domain/quality.ts";
import { objectSimilarity, validateContract } from "../src/domain/validation.ts";
import { mailSchema, validationSchema, type Commercial, type Extraction, type Mail, type MasterRecord } from "../src/domain/schemas.ts";
import { readCsv } from "../src/storage/csv.ts";
import { readJson, readText } from "../src/storage/files.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(root, "fixtures", "reto-02");
const [csv, catalog] = await Promise.all([readCsv(join(fixtures, "maestro-contratos.csv")), readJson(join(fixtures, "comerciales.json"))]);
if (!csv.ok || !catalog.ok) throw new Error("No se pudieron cargar los datos de prueba.");
const realMaster = diagnoseMaster(csv.data, "maestro").registros;
const realCommercials = diagnoseCommercials(catalog.data, "catalogo").registros;

async function realCase(id: string, attachment = "contrato.txt") {
  const path = join(fixtures, "buzon", id);
  const [text, mail] = await Promise.all([readText(join(path, attachment)), readJson(join(path, "correo.json"))]);
  if (!text.ok || !mail.ok) throw new Error("No se pudo leer el caso.");
  const extraction = extractContract(text.data);
  const metadata = mailSchema.parse(mail.data);
  return { extraction, mail: metadata, result: validateContract(extraction, metadata, realMaster, realCommercials) };
}

const commercial: Commercial = { email: "ana@example.com", nombre: "Ana Ejemplo", region: "CO" };
const mail: Mail = { id: "sintetico", de: commercial.email, para: "contratos@example.com", asunto: "Contrato",
  fecha: "2030-01-02T10:00:00-05:00", cuerpo: "Adjunto el documento.", adjuntos: ["contrato.txt"] };
const base: MasterRecord = {
  id_contrato: "BASE-2030-001", cliente: "Cliente Alfa S.A.", nit_cliente: "123456789", pais: "CO",
  objeto: "Servicios de soporte de aplicaciones corporativas.", valor: 120000, moneda: "COP",
  fecha_inicio: "2030-01-01", fecha_fin: "2030-12-31", requiere_poliza: false, tipo_poliza: "",
  estado_poliza: "no_aplica", comercial: "Responsable Original", ruta_sharepoint: "Contratos/2030/alfa/BASE-2030-001.txt",
  fecha_registro: "2030-01-02", fuente: "buzon",
};

function contract(id = "NUEVO-2030-002") {
  return extractContract(`CONTRATO DE SERVICIOS No. ${id}\n\nEntre CLIENTE ALFA S.A., NIT 123.456.789-0, con domicilio en Colombia, y PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7.\n\nPRIMERA. OBJETO. Servicios de soporte de aplicaciones corporativas.\n\nSEGUNDA. VALOR. COP 120000\n\nTERCERA. PLAZO. Desde 2030-01-01 hasta 2030-12-31.\n\nCUARTA. GARANTÍAS. No se requiere póliza.`);
}

function amendment(id = base.id_contrato) {
  return extractContract(`OTROSÍ No. 2 AL CONTRATO No. ${id}\n\nPRIMERA. Modificar la cláusula SEGUNDA (VALOR), así: COP 150000.\n\nSEGUNDA. Modificar la cláusula TERCERA (PLAZO): hasta el 31 de diciembre de 2031.`);
}

function evaluate(extraction = contract(), master: MasterRecord[] = [], metadata = mail) {
  return validateContract(extraction, metadata, master, [commercial]);
}

test("msg-001: nuevo elegible, país del maestro por NIT y póliza pendiente", async () => {
  const { extraction, result } = await realCase("msg-001");
  expect(result.tipo_operacion).toBe("nuevo");
  expect(result.elegible_registro).toBe(true);
  expect(result.requiere_revision).toEqual([]);
  expect(result.datos_propuestos?.pais).toBe("CO");
  expect(result.evidencias.pais.origen).toBe("maestro");
  expect(result.evidencias.pais.evidencia).toContain("890900111");
  expect(result.datos_propuestos?.estado_poliza).toBe("pendiente");
  expect(result.datos_propuestos?.comercial).toBe("Laura Gómez Restrepo");
  expect(extraction.campos.pais.normalizado).toBeNull();
});

test("msg-002: nuevo elegible, exención explícita en correo y estado no_aplica", async () => {
  const { result } = await realCase("msg-002");
  expect(result.tipo_operacion).toBe("nuevo");
  expect(result.estado_validacion).toBe("validado");
  expect(result.elegible_registro).toBe(true);
  expect(result.datos_propuestos?.requiere_poliza).toBe(false);
  expect(result.evidencias.requiere_poliza.origen).toBe("correo");
  expect(result.evidencias.requiere_poliza.evidencia).toContain("no pide póliza");
  expect(result.datos_propuestos?.tipo_poliza).toBe("");
  expect(result.datos_propuestos?.estado_poliza).toBe("no_aplica");
});

test("msg-003: actualización parcial con exactamente dos diferencias", async () => {
  const { result } = await realCase("msg-003", "otrosi.txt");
  expect(result.tipo_operacion).toBe("actualizacion");
  expect(result.id_contrato_existente).toBe("CT-2026-011");
  expect(result.elegible_registro).toBe(true);
  expect(result.diferencias).toEqual([
    { campo: "valor", anterior: 350000, propuesto: 520000 },
    { campo: "fecha_fin", anterior: "2027-05-01", propuesto: "2027-11-01" },
  ]);
  const original = realMaster.find((row) => row.id_contrato === "CT-2026-011")!;
  expect(result.datos_propuestos).toEqual({ ...original, valor: 520000, fecha_fin: "2027-11-01" });
  expect(result.evidencias.objeto.origen).toBe("maestro");
  expect(result.evidencias.valor.origen).toBe("documento");
  expect(result.advertencias.some((warning) => warning.tipo === "AMPLIAR_GARANTIAS")).toBe(true);
});

test("msg-004: duplicado RN1 sin propuestas ni diferencias", async () => {
  const { result } = await realCase("msg-004");
  expect(result.tipo_operacion).toBe("duplicado");
  expect(result.id_contrato).toBe("CT-2026-012");
  expect(result.datos_propuestos).toBeNull();
  expect(result.diferencias).toEqual([]);
  expect(result.elegible_registro).toBe(false);
  expect(result.requiere_revision).toEqual([]);
});

test("msg-005: rechazo de cotización con motivo concreto", async () => {
  const { result } = await realCase("msg-005", "cotizacion.txt");
  expect(result.tipo_operacion).toBe("rechazado");
  expect(result.motivos[0]).toContain("cotización");
  expect(result.datos_propuestos).toBeNull();
  expect(result.elegible_registro).toBe(false);
});

test("msg-006: nuevo con revisión, conserva null, texto íntegro y remitente desconocido", async () => {
  const { result } = await realCase("msg-006");
  expect(result.tipo_operacion).toBe("nuevo");
  expect(result.estado_validacion).toBe("pendiente_revision");
  expect(result.elegible_registro).toBe(false);
  expect(result.valor_indeterminado).toBe(true);
  expect(result.datos_propuestos?.valor).toBeNull();
  expect(result.datos_propuestos?.fecha_inicio).toBeNull();
  expect(result.datos_propuestos?.fecha_fin).toBeNull();
  expect(result.datos_propuestos?.objeto?.length).toBe(222);
  expect(result.requiere_revision).toEqual(expect.arrayContaining(["valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "objeto"]));
  expect(result.requiere_revision).not.toContain("comercial");
  expect(result.advertencias.some((warning) => warning.tipo === "REMITENTE_DESCONOCIDO")).toBe(true);
});

test("Contrato sintético nuevo: elegibilidad no depende de IDs de fixtures", () => {
  const result = evaluate();
  expect(result.tipo_operacion).toBe("nuevo");
  expect(result.elegible_registro).toBe(true);
  expect(result.datos_propuestos?.comercial).toBe(commercial.nombre);
  expect(result.evidencias.comercial.origen).toBe("catalogo");
  expect(result.evidencias.estado_poliza.origen).toBe("regla");
  expect(result.datos_propuestos?.ruta_sharepoint).toBeNull();
  expect(result.datos_propuestos?.fecha_registro).toBeNull();
  expect(result.requiere_revision).not.toContain("ruta_sharepoint");
  expect(result.requiere_revision).not.toContain("fecha_registro");
});

test("Remitente desconocido no bloquea un contrato completo", () => {
  const result = evaluate(contract(), [], { ...mail, de: "otro@example.com" });
  expect(result.tipo_operacion).toBe("nuevo");
  expect(result.elegible_registro).toBe(true);
  expect(result.comercial_remitente).toBeNull();
  expect(result.datos_propuestos?.comercial).toBeNull();
  expect(result.campos_pendientes).toContain("comercial");
  expect(result.requiere_revision).not.toContain("comercial");
});

test("Comercial conocido se resuelve sin distinguir mayúsculas del email", () => {
  expect(evaluate(contract(), [], { ...mail, de: "ANA@example.com" }).comercial_remitente).toBe(commercial.nombre);
});

test("Umbral RN5: 0.8 es válido; 0.79 necesita revisión sin rechazo", () => {
  const extracted = contract();
  extracted.campos.valor.confianza = 0.8;
  expect(evaluate(extracted).elegible_registro).toBe(true);
  extracted.campos.valor.confianza = 0.79;
  const result = evaluate(extracted);
  expect(result.tipo_operacion).toBe("nuevo");
  expect(result.elegible_registro).toBe(false);
  expect(result.requiere_revision).toContain("valor");
  expect(result.motivos.some((reason) => reason.startsWith("valor:"))).toBe(true);
});

test("Un campo esencial ausente produce revisión, no rechazo de todo el contrato", () => {
  const extracted = contract();
  extracted.campos.fecha_fin = { extraido: null, normalizado: null, confianza: 0, evidencia: null };
  const result = evaluate(extracted);
  expect(result.tipo_operacion).toBe("nuevo");
  expect(result.requiere_revision).toContain("fecha_fin");
  expect(result.datos_propuestos?.fecha_fin).toBeNull();
});

test("RN4: sin adjunto, texto desconocido y contrato sin partes ni objeto", () => {
  for (const extracted of [null, extractContract("Una pregunta"), extractContract("CONTRATO No. VACIO-2030-001")]) {
    const result = validateContract(extracted, mail, [], [commercial]);
    expect(result.tipo_operacion).toBe("rechazado");
    expect(result.datos_propuestos).toBeNull();
  }
  expect(evaluate(contract(), [], { ...mail, adjuntos: [] }).tipo_operacion).toBe("rechazado");
});

test("Otrosí sintético conserva los campos originales sin mutar ninguna entrada", () => {
  const extracted = amendment();
  const beforeExtraction = structuredClone(extracted);
  const beforeBase = structuredClone(base);
  const result = evaluate(extracted, [base]);
  expect(result.elegible_registro).toBe(true);
  expect(result.datos_propuestos).toEqual({ ...base, valor: 150000, fecha_fin: "2031-12-31" });
  expect(result.comercial_remitente).toBe(commercial.nombre);
  expect(result.datos_propuestos?.comercial).toBe(base.comercial);
  expect(extracted).toEqual(beforeExtraction);
  expect(base).toEqual(beforeBase);
});

test("Otrosí con cambio ambiguo no borra el valor del maestro", () => {
  const extracted = amendment();
  extracted.campos.valor.normalizado = null;
  extracted.campos.valor.confianza = 0.4;
  const result = evaluate(extracted, [base]);
  expect(result.tipo_operacion).toBe("actualizacion");
  expect(result.datos_propuestos?.valor).toBe(base.valor);
  expect(result.requiere_revision).toContain("valor");
  expect(result.elegible_registro).toBe(false);
});

test("Otrosí que declara un campo sin evidencia queda bloqueado", () => {
  const extracted = amendment();
  extracted.campos.valor = { extraido: null, normalizado: null, confianza: 0, evidencia: null };
  expect(evaluate(extracted, [base]).requiere_revision).toContain("valor");
});

test("Otrosí sin contrato base queda pendiente, no se inserta como nuevo", () => {
  const result = evaluate(amendment(), []);
  expect(result.tipo_operacion).toBe("actualizacion");
  expect(result.requiere_revision).toContain("contrato_base");
  expect(result.id_contrato_existente).toBeNull();
  expect(result.elegible_registro).toBe(false);
});

test("Contrato ordinario con mismo ID y distinto valor aplica RN2", () => {
  const extracted = contract(base.id_contrato);
  extracted.campos.valor.normalizado = 130000;
  const result = evaluate(extracted, [base]);
  expect(result.tipo_operacion).toBe("actualizacion");
  expect(result.diferencias).toContainEqual({ campo: "valor", anterior: 120000, propuesto: 130000 });
});

test("RN1 no se redefine para incluir el objeto ni proponer cambios de redacción", () => {
  const extracted = contract(base.id_contrato);
  extracted.campos.objeto.normalizado = "Otra redacción documental.";
  const result = evaluate(extracted, [base]);
  expect(result.tipo_operacion).toBe("duplicado");
  expect(result.datos_propuestos).toBeNull();
  expect(result.diferencias).toEqual([]);
});

test("Duplicado con moneda contradictoria mantiene RN1 pero informa el conflicto", () => {
  const extracted = contract(base.id_contrato);
  extracted.campos.moneda.normalizado = "USD";
  const result = evaluate(extracted, [base]);
  expect(result.tipo_operacion).toBe("duplicado");
  expect(result.requiere_revision).toContain("moneda");
  expect(result.diferencias).toEqual([]);
  expect(result.datos_propuestos).toBeNull();
});

test("Otrosí explícito tiene precedencia RN2 aunque no cambie los tres campos RN1", () => {
  const extracted = amendment();
  extracted.campos.valor.normalizado = base.valor;
  extracted.campos.fecha_fin.normalizado = base.fecha_fin;
  const result = evaluate(extracted, [base]);
  expect(result.tipo_operacion).toBe("actualizacion");
  expect(result.diferencias).toEqual([]);
});

test("RN2: similitud Jaccard normaliza acentos, signos y orden; respeta 0.9", () => {
  expect(objectSimilarity("Fábrica de software", "software, fabrica de")).toBe(1);
  expect(objectSimilarity("a b c d e f g h i", "a b c d e f g h i j")).toBe(0.9);
  expect(objectSimilarity("a b c d e f g h", "a b c d e f g h i j")).toBe(0.8);
  expect(objectSimilarity("", "")).toBe(0);
});

test("RN2: NIT y objeto semejante identifican base, distinto ID exige revisión", () => {
  const result = evaluate(contract("OTRO-2030-005"), [base]);
  expect(result.tipo_operacion).toBe("actualizacion");
  expect(result.id_contrato_existente).toBe(base.id_contrato);
  expect(result.datos_propuestos?.id_contrato).toBe(base.id_contrato);
  expect(result.requiere_revision).toContain("id_contrato");
  expect(result.elegible_registro).toBe(false);
});

test("Mismo NIT con objeto distinto no basta para actualizar", () => {
  const extracted = contract();
  extracted.campos.objeto.normalizado = "Implementación integral de una plataforma CRM.";
  expect(evaluate(extracted, [base]).tipo_operacion).toBe("nuevo");
});

test("Falta de ID documental conserva generación AUTO para una fase posterior", () => {
  const extracted = contract();
  extracted.campos.id_contrato = { extraido: null, normalizado: null, confianza: 0, evidencia: null };
  const result = evaluate(extracted);
  expect(result.tipo_operacion).toBe("nuevo");
  expect(result.id_contrato).toBeNull();
  expect(result.campos_pendientes).toContain("id_contrato");
  expect(result.elegible_registro).toBe(true);
  expect(result.requiere_revision).not.toContain("id_contrato");
});

test("Fuzzy matching no usa NIT ni objeto de baja confianza para escoger una base", () => {
  const extracted = contract();
  extracted.campos.nit_cliente.confianza = 0.7;
  const result = evaluate(extracted, [base]);
  expect(result.tipo_operacion).toBe("nuevo");
  expect(result.requiere_revision).toContain("nit_cliente");
  expect(result.id_contrato_existente).toBeNull();
});

test("País corporativo no uniforme no permite una inferencia arbitraria", () => {
  const extracted = contract();
  extracted.campos.objeto.normalizado = "Otra actividad contractual.";
  extracted.campos.pais = { extraido: null, normalizado: null, confianza: 0, evidencia: null };
  const result = evaluate(extracted, [base, { ...base, id_contrato: "OTRO-2030-001", pais: "PE" }]);
  expect(result.tipo_operacion).toBe("nuevo");
  expect(result.datos_propuestos?.pais).toBeNull();
  expect(result.requiere_revision).toContain("pais");
});

test("Un catálogo con remitente repetido genera revisión, no selección por orden", () => {
  const result = validateContract(contract(), mail, [], [commercial, { ...commercial, nombre: "Otro Responsable" }]);
  expect(result.requiere_revision).toContain("comercial");
  expect(result.comercial_remitente).toBeNull();
  expect(result.elegible_registro).toBe(false);
});

test("Coincidencias múltiples no seleccionan arbitrariamente una fila", () => {
  const result = evaluate(contract(), [base, { ...base, id_contrato: "SEGUNDO-2030-002" }]);
  expect(result.requiere_revision).toContain("contrato_base");
  expect(result.id_contrato_existente).toBeNull();
  expect(result.elegible_registro).toBe(false);
  expect(result.diferencias).toEqual([]);
});

test("Conflicto de identidad: mismo ID pero diferente NIT bloquea actualización", () => {
  const extracted = contract(base.id_contrato);
  extracted.campos.valor.normalizado = 130000;
  extracted.campos.nit_cliente.normalizado = "987654321";
  const result = evaluate(extracted, [base]);
  expect(result.requiere_revision).toContain("nit_cliente");
  expect(result.elegible_registro).toBe(false);
});

test("País documental en conflicto con el maestro queda pendiente", () => {
  const extracted = contract();
  extracted.campos.objeto.normalizado = "Un objeto distinto del contrato base.";
  extracted.campos.pais.normalizado = "PE";
  const result = evaluate(extracted, [base]);
  expect(result.tipo_operacion).toBe("nuevo");
  expect(result.requiere_revision).toContain("pais");
  expect(result.datos_propuestos?.pais).toBe("PE");
});

test("Ausencia de póliza en TXT y correo no se convierte automáticamente en false", () => {
  const extracted = contract();
  extracted.campos.requiere_poliza = { extraido: null, normalizado: null, confianza: 0, evidencia: null };
  extracted.campos.tipo_poliza = { extraido: null, normalizado: null, confianza: 0, evidencia: null };
  const result = evaluate(extracted);
  expect(result.requiere_revision).toContain("requiere_poliza");
  expect(result.datos_propuestos?.requiere_poliza).toBeNull();
});

test("Una declaración de correo no sustituye una condición documental ambigua", () => {
  const extracted = contract();
  extracted.campos.requiere_poliza = { extraido: "Según órdenes", normalizado: null, confianza: 0.4, evidencia: "Según órdenes" };
  const result = evaluate(extracted, [], { ...mail, cuerpo: "Este contrato no requiere póliza." });
  expect(result.datos_propuestos?.requiere_poliza).toBeNull();
  expect(result.requiere_revision).toContain("requiere_poliza");
});

test("Correo y documento contradictorios sobre póliza exigen revisión", () => {
  const result = evaluate(contract(), [], { ...mail, cuerpo: "Requiere póliza de cumplimiento." });
  expect(result.requiere_revision).toContain("requiere_poliza");
  expect(result.elegible_registro).toBe(false);
});

test("Fechas invertidas y objeto largo bloquean sin truncar", () => {
  const extracted = contract();
  extracted.campos.fecha_fin.normalizado = "2029-12-31";
  extracted.campos.objeto.normalizado = "Objeto contractual completo. ".repeat(12);
  const result = evaluate(extracted);
  expect(result.requiere_revision).toEqual(expect.arrayContaining(["fecha_fin", "objeto"]));
  expect(result.datos_propuestos?.objeto).toBe(extracted.campos.objeto.normalizado);
});

test("Zod rechaza autorizar un duplicado o una operación pendiente", () => {
  const duplicate = evaluate(contract(base.id_contrato), [base]);
  expect(validationSchema.safeParse({ ...duplicate, elegible_registro: true }).success).toBe(false);
  expect(validationSchema.safeParse({ ...duplicate, datos_propuestos: base }).success).toBe(false);
  const pending = contract();
  pending.campos.valor.confianza = 0.5;
  expect(validationSchema.safeParse({ ...evaluate(pending), elegible_registro: true }).success).toBe(false);
  expect(validationSchema.safeParse({ ...evaluate(pending), estado_validacion: "validado" }).success).toBe(false);
  expect(validationSchema.safeParse({ ...evaluate(), datos_propuestos: null }).success).toBe(false);
});

test("La evaluación de los seis casos conserva fixtures, maestro y documentos de control", async () => {
  const paths = [join(root, "PRD.md"), join(root, "AGENTS.md")];
  async function collect(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await collect(path);
      else paths.push(path);
    }
  }
  await collect(join(root, "fixtures"));
  const hashes = () => Promise.all(paths.map(async (path) => {
    const bytes = path === join(root, "AGENTS.md") ? await optionalBytes(path) : await readFile(path);
    return bytes === null ? null : createHash("sha256").update(bytes).digest("hex");
  }));
  const before = await hashes();
  const masterBefore = structuredClone(realMaster);
  const outBefore = await readdir(join(root, "out")).catch(() => null);
  for (const [id, attachment] of [["msg-001", "contrato.txt"], ["msg-002", "contrato.txt"], ["msg-003", "otrosi.txt"],
    ["msg-004", "contrato.txt"], ["msg-005", "cotizacion.txt"], ["msg-006", "contrato.txt"]]) {
    const { result } = await realCase(id!, attachment);
    expect(validationSchema.safeParse(result).success).toBe(true);
  }
  expect(await hashes()).toEqual(before);
  expect(realMaster).toEqual(masterBefore);
  expect(await readdir(join(root, "out")).catch(() => null)).toEqual(outBefore);
});
