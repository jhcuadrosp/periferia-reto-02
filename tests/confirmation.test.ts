import { afterEach, expect } from "bun:test";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createConfirmation, decideConfirmation, evaluateRegistration, getConfirmation, inspectReview,
  persistConfirmedRegistration, persistRegistration, type StorageResult } from "../src/storage/persistence.ts";
import { hashBytes, optionalBytes } from "../src/storage/audit.ts";
import { readCsv } from "../src/storage/csv.ts";
import type { Confirmation } from "../src/domain/confirmation.ts";
import { integrationTests } from "./helpers/integration.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories: string[] = [];
const { test, waitForCompletion } = integrationTests();
const reviewer = { id: "revisor-prueba", modo: "simulado_local" as const };
const clock = { now: () => "2030-01-02T12:00:00.000Z" };
const source = { justificacion: "Dato proporcionado explícitamente en una simulación de pruebas.", procedencia: "ACTA SINTÉTICA, sin valor contractual real" };
const corrections = [{ campo: "valor", valor: 1500, ...source }, { campo: "moneda", valor: "USD", ...source }];

function unwrap<T>(result: StorageResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
const command = (request: Confirmation) => ({ solicitud_id: request.solicitud_id, datos_hash: request.datos_hash });
const output = (directory: string, name: string) => join(directory, "out", name);
const requestPath = (directory: string, request: Confirmation) => output(directory, `confirmaciones/${request.solicitud_id}.json`);

afterEach(async () => {
  await waitForCompletion();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
}, 60_000);

async function project(conditional = false) {
  const directory = await mkdtemp(join(tmpdir(), "periferia-confirmation-test-"));
  directories.push(directory);
  await cp(join(root, "fixtures"), join(directory, "fixtures"), { recursive: true });
  const folder = join(directory, "fixtures/reto-02/buzon/msg-sintetico");
  await mkdir(folder);
  await writeFile(join(folder, "correo.json"), JSON.stringify({ id: "msg-sintetico", de: "lgomez@periferia-ficticia.com",
    para: "contratos@periferia-ficticia.com", asunto: "SIMULACIÓN", fecha: clock.now(), cuerpo: "Ejemplo sintético.", adjuntos: ["contrato.txt"] }));
  const object = conditional ? "Servicios sintéticos bajo órdenes de trabajo. ".repeat(8) : "Servicio sintético de soporte.";
  await writeFile(join(folder, "contrato.txt"), `CONTRATO No. SYN-2030-HIL\n\nEntre CLIENTE SINTÉTICO S.A., NIT 111.222.333-0, con domicilio en Colombia, y PERIFERIA IT GROUP S.A.S.\n\nPRIMERA. OBJETO. ${object}\n\nSEGUNDA. VALOR. ${conditional ? "El contrato no tiene un valor determinado." : "Importe pendiente de aclaración."}\n\nTERCERA. PLAZO. ${conditional ? "Duración de doce (12) meses a partir de la fecha de su firma." : "Desde 2030-01-01 hasta 2030-12-31."}\n\nCUARTA. GARANTÍAS. ${conditional ? "Para cada orden cuyo valor supere COP 100000, se constituirá póliza de cumplimiento." : "No se requiere póliza."}\n\nSe firma en el mes de enero de 2030.`);
  const ticket = unwrap(await evaluateRegistration(directory, "msg-sintetico", "contrato.txt"));
  return { directory, ticket, folder };
}

async function pendingRequest() {
  const context = await project();
  const request = unwrap(await createConfirmation(context.directory, context.ticket, corrections, reviewer, clock));
  return { ...context, request };
}

async function approvedRequest() {
  const context = await pendingRequest();
  unwrap(await decideConfirmation(context.directory, { ...command(context.request), accion: "aprobar" }, reviewer, clock));
  return context;
}

async function rowCount(directory: string) {
  const csv = await readCsv(output(directory, "sharepoint/maestro-contratos.csv"));
  if (!csv.ok) throw new Error("Maestro ilegible.");
  return csv.data.registros.length;
}

async function logs(directory: string) {
  const text = await readFile(output(directory, "log.jsonl"), "utf8");
  return text.trim() ? text.trim().split("\n").map((line) => z.record(z.string(), z.unknown()).parse(JSON.parse(line))) : [];
}

test("Vista de msg-006: evidencia documental, propuesta, campos, motivos y comercial no bloqueante", async () => {
  const { directory } = await project();
  const ticket = unwrap(await evaluateRegistration(directory, "msg-006", "contrato.txt"));
  const view = unwrap(await inspectReview(directory, ticket, clock));
  expect(view.revisable).toBe(true);
  expect(view.id_contrato).toBe("CM-2026-03");
  expect(view.campos.map((field) => field.campo)).toEqual(expect.arrayContaining(["valor", "moneda", "fecha_inicio", "fecha_fin", "requiere_poliza", "objeto", "comercial"]));
  expect(view.campos.find((field) => field.campo === "comercial")?.bloqueante).toBe(false);
  expect(view.datos_documentales?.valor.normalizado).toBeNull();
  expect(view.datos_documentales?.valor.evidencia).toContain("no tiene un valor determinado");
  expect(view.motivos.length).toBeGreaterThan(0);
});

test("msg-006 sin aclaraciones completas continúa bloqueado, sin solicitud ni registro", async () => {
  const { directory } = await project();
  const ticket = unwrap(await evaluateRegistration(directory, "msg-006", "contrato.txt"));
  const result = await createConfirmation(directory, ticket, [{ campo: "moneda", valor: "COP", ...source }], reviewer, clock);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toContain("Revisión incompleta");
  expect(await rowCount(directory)).toBe(8);
  expect(await Bun.file(output(directory, "sharepoint/historial.jsonl")).text()).toBe("");
  expect(await readdir(output(directory, "confirmaciones")).catch(() => [])).toEqual([]);
});

test("Correcciones faltantes se validan, auditan y preparan una solicitud pendiente", async () => {
  const { directory, ticket, request } = await pendingRequest();
  expect(ticket.validacion.requiere_revision).toEqual(expect.arrayContaining(["valor", "moneda"]));
  expect(request.estado).toBe("pendiente");
  expect(request.datos_registro.valor).toBe(1500);
  expect(request.datos_registro.moneda).toBe("USD");
  expect(request.validacion_revisada.evidencias.valor.origen).toBe("humano");
  expect(request.correcciones[0]?.anterior).toBeNull();
  expect(request.correcciones[0]?.revisor_id).toBe(reviewer.id);
  expect(request.correcciones[0]?.fecha).toBe(clock.now());
  expect(request.extraccion_original.campos.valor.normalizado).toBeNull();
  expect(await rowCount(directory)).toBe(8);
});

test("Una revisión parcial conserva la corrección aceptada en auditoría, sin autorización", async () => {
  const { directory, ticket } = await project();
  expect((await createConfirmation(directory, ticket, [corrections[0]], reviewer, clock)).ok).toBe(false);
  const entry = (await logs(directory)).find((entry) => entry.resumen === "revision_incompleta")!;
  const recorded = z.array(z.object({ campo: z.string(), anterior: z.null(), valor: z.number(), revisor_id: z.string(), fecha: z.string() })).parse(entry.correcciones);
  expect(recorded[0]?.campo).toBe("valor");
  expect(recorded[0]?.valor).toBe(1500);
  expect(await rowCount(directory)).toBe(8);
});

test("Zod rechaza importes negativos, fechas imposibles, campos del sistema y justificación vacía", async () => {
  const { directory, ticket } = await project();
  for (const correction of [
    { campo: "valor", valor: -1, ...source }, { campo: "fecha_fin", valor: "2030-02-30", ...source },
    { campo: "ruta_sharepoint", valor: "../fuera.txt", ...source }, { campo: "valor", valor: 1500, justificacion: "", procedencia: "Acta" },
    { campo: "valor_indeterminado", valor: false, ...source },
  ]) expect((await createConfirmation(directory, ticket, [correction], reviewer, clock)).ok).toBe(false);
  expect(await rowCount(directory)).toBe(8);
});

test("No se cambian campos documentales que no están pendientes", async () => {
  const { directory, ticket } = await project();
  expect((await createConfirmation(directory, ticket, [...corrections, { campo: "cliente", valor: "Otro cliente", ...source }], reviewer, clock)).ok).toBe(false);
});

test("Correcciones duplicadas o incoherentes no generan autorización", async () => {
  const { directory, ticket } = await project();
  expect((await createConfirmation(directory, ticket, [corrections[0], corrections[0]], reviewer, clock)).ok).toBe(false);
  const invalid = [...corrections, { campo: "fecha_fin", valor: "2029-01-01", ...source }];
  expect((await createConfirmation(directory, ticket, invalid, reviewer, clock)).ok).toBe(false);
});

test("Duplicados y cotizaciones no pueden confirmarse", async () => {
  const { directory } = await project();
  for (const [id, attachment] of [["msg-004", "contrato.txt"], ["msg-005", "cotizacion.txt"]]) {
    const ticket = unwrap(await evaluateRegistration(directory, id!, attachment!));
    expect((await createConfirmation(directory, ticket, [], reviewer, clock)).ok).toBe(false);
  }
});

test("Un conflicto RN1 conserva duplicado y no permite aprobarlo como escritura", async () => {
  const { directory } = await project();
  const path = join(directory, "fixtures/reto-02/buzon/msg-004/contrato.txt");
  await writeFile(path, (await readFile(path, "utf8")).replace("COP $210.000.000", "USD 210.000.000"));
  const ticket = unwrap(await evaluateRegistration(directory, "msg-004", "contrato.txt"));
  expect(ticket.validacion.tipo_operacion).toBe("duplicado");
  expect(ticket.validacion.requiere_revision).toContain("moneda");
  expect((await createConfirmation(directory, ticket, [{ campo: "moneda", valor: "COP", ...source }], reviewer, clock)).ok).toBe(false);
});

test("Solicitud enlaza hashes, revisor, mensaje y fila concreta sin escribir contrato", async () => {
  const { directory, ticket, request } = await pendingRequest();
  expect(request.maestro_hash).toBe(ticket.maestro_hash);
  expect(request.entrada_hash).toBe(ticket.entrada_hash);
  expect(request.revisor).toEqual(reviewer);
  expect(request.datos_hash).toHaveLength(64);
  expect(request.contenido_hash).toHaveLength(64);
  expect(request.mensaje_id).toBe("msg-sintetico");
  expect(request.datos_registro.id_contrato).toBe("SYN-2030-HIL");
  expect(await rowCount(directory)).toBe(8);
});

test("Sin decisión explícita no se escribe aunque los datos revisados sean válidos", async () => {
  const { directory, request } = await pendingRequest();
  expect((await persistConfirmedRegistration(directory, command(request), reviewer, clock)).ok).toBe(false);
  expect(await rowCount(directory)).toBe(8);
  expect(unwrap(await getConfirmation(directory, request.solicitud_id, clock)).estado).toBe("pendiente");
});

test("Aprobar no registra; ejecutar registra solo los valores aprobados y consume la solicitud", async () => {
  const { directory, request } = await approvedRequest();
  expect(await rowCount(directory)).toBe(8);
  const result = unwrap(await persistConfirmedRegistration(directory, command(request), reviewer, clock));
  expect(result.accion).toBe("registrado");
  expect(await rowCount(directory)).toBe(9);
  const csv = await readCsv(output(directory, "sharepoint/maestro-contratos.csv"));
  if (!csv.ok) throw new Error("CSV inválido.");
  const row = csv.data.registros.find((row) => row.id_contrato === "SYN-2030-HIL")!;
  expect(row.valor).toBe(String(request.datos_registro.valor));
  expect(row.moneda).toBe(request.datos_registro.moneda);
  expect(row.fecha_registro).toBe(request.datos_registro.fecha_registro);
  const consumed = unwrap(await getConfirmation(directory, request.solicitud_id, clock));
  expect(consumed.estado).toBe("utilizada");
  expect(consumed.decision?.revisor_id).toBe(reviewer.id);
  expect(consumed.utilizada_en).toBe(clock.now());
});

test("Rechazo explícito queda auditado y nunca permite persistir", async () => {
  const { directory, request } = await pendingRequest();
  const rejected = unwrap(await decideConfirmation(directory, { ...command(request), accion: "rechazar" }, reviewer, clock));
  expect(rejected.estado).toBe("rechazada");
  expect((await persistConfirmedRegistration(directory, command(request), reviewer, clock)).ok).toBe(false);
  expect(await rowCount(directory)).toBe(8);
  expect((await logs(directory)).some((entry) => entry.resumen === "solicitud_rechazada")).toBe(true);
});

test("No acepta confirmado=true, valores añadidos ni otra identidad de revisor", async () => {
  const { directory, ticket, request } = await pendingRequest();
  expect((await decideConfirmation(directory, { ...command(request), confirmado: true }, reviewer, clock)).ok).toBe(false);
  expect((await decideConfirmation(directory, { ...command(request), accion: "aprobar", datos_registro: { valor: 999 } }, reviewer, clock)).ok).toBe(false);
  expect((await decideConfirmation(directory, { ...command(request), accion: "aprobar" }, { ...reviewer, id: "otro-revisor" }, clock)).ok).toBe(false);
  expect((await persistRegistration(directory, { ...ticket, validacion: request.validacion_revisada }, clock)).ok).toBe(false);
  expect(await rowCount(directory)).toBe(8);
});

test("Hash diferente no autoriza valores distintos", async () => {
  const { directory, request } = await pendingRequest();
  const result = await decideConfirmation(directory, { solicitud_id: request.solicitud_id, datos_hash: "f".repeat(64), accion: "aprobar" }, reviewer, clock);
  expect(result.ok).toBe(false);
  expect(unwrap(await getConfirmation(directory, request.solicitud_id, clock)).estado).toBe("pendiente");
});

test("Modificación de valores o correcciones almacenadas se detecta antes de aprobar", async () => {
  for (const target of ["valores", "correcciones"]) {
    const { directory, request } = await pendingRequest();
    const changed = structuredClone(request);
    if (target === "valores") changed.datos_registro.valor = 9999;
    else changed.correcciones_input[0]!.valor = 9999;
    await writeFile(requestPath(directory, request), JSON.stringify(changed));
    expect((await decideConfirmation(directory, { ...command(request), accion: "aprobar" }, reviewer, clock)).ok).toBe(false);
    expect(await rowCount(directory)).toBe(8);
  }
});

test("Una solicitud no se puede marcar aprobada sin una decisión coherente", async () => {
  const { directory, request } = await pendingRequest();
  await writeFile(requestPath(directory, request), JSON.stringify({ ...request, estado: "aprobada" }));
  expect((await persistConfirmedRegistration(directory, command(request), reviewer, clock)).ok).toBe(false);
  expect(await rowCount(directory)).toBe(8);
});

test("Confirmación y consumo repetidos no agregan filas ni historial", async () => {
  const { directory, request } = await approvedRequest();
  expect((await decideConfirmation(directory, { ...command(request), accion: "aprobar" }, reviewer, clock)).ok).toBe(false);
  unwrap(await persistConfirmedRegistration(directory, command(request), reviewer, clock));
  const before = await readFile(output(directory, "sharepoint/historial.jsonl"));
  expect((await persistConfirmedRegistration(directory, command(request), reviewer, clock)).ok).toBe(false);
  expect(await rowCount(directory)).toBe(9);
  expect(await readFile(output(directory, "sharepoint/historial.jsonl"))).toEqual(before);
});

test("Solicitudes caducadas no se aprueban ni se ejecutan", async () => {
  const { directory, request } = await pendingRequest();
  const later = { now: () => "2030-01-02T12:31:00.000Z" };
  expect((await decideConfirmation(directory, { ...command(request), accion: "aprobar" }, reviewer, later)).ok).toBe(false);
  unwrap(await decideConfirmation(directory, { ...command(request), accion: "aprobar" }, reviewer, clock));
  expect((await persistConfirmedRegistration(directory, command(request), reviewer, later)).ok).toBe(false);
  expect(await rowCount(directory)).toBe(8);
});

test("Maestro modificado después de aprobar bloquea y mantiene la solicitud sin consumir", async () => {
  const { directory, request } = await approvedRequest();
  const path = output(directory, "sharepoint/maestro-contratos.csv");
  const external = `${await readFile(path, "utf8")}\n`;
  await writeFile(path, external);
  expect((await persistConfirmedRegistration(directory, command(request), reviewer, clock)).ok).toBe(false);
  expect(await readFile(path, "utf8")).toBe(external);
  expect(unwrap(await getConfirmation(directory, request.solicitud_id, clock)).estado).toBe("aprobada");
});

test("Documento o catálogo modificado después de aprobar invalida las fuentes", async () => {
  for (const name of ["fixtures/reto-02/buzon/msg-sintetico/contrato.txt", "fixtures/reto-02/comerciales.json"]) {
    const { directory, request } = await approvedRequest();
    const path = join(directory, name);
    await writeFile(path, `${await readFile(path, "utf8")}\n`);
    expect((await persistConfirmedRegistration(directory, command(request), reviewer, clock)).ok).toBe(false);
    expect(await rowCount(directory)).toBe(8);
  }
});

test("Dos solicitudes para la misma operación no permiten registrar dos veces", async () => {
  const { directory, ticket, request } = await approvedRequest();
  const second = unwrap(await createConfirmation(directory, ticket, corrections, reviewer, clock));
  unwrap(await decideConfirmation(directory, { ...command(second), accion: "aprobar" }, reviewer, clock));
  unwrap(await persistConfirmedRegistration(directory, command(request), reviewer, clock));
  expect((await persistConfirmedRegistration(directory, command(second), reviewer, clock)).ok).toBe(false);
  expect(await rowCount(directory)).toBe(9);
});

test("Consumo concurrente se serializa: una aplicación y una negativa", async () => {
  const { directory, request } = await approvedRequest();
  const results = await Promise.all([persistConfirmedRegistration(directory, command(request), reviewer, clock),
    persistConfirmedRegistration(directory, command(request), reviewer, clock)]);
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(await rowCount(directory)).toBe(9);
});

test("Fallo de escritura revierte el consumo de autorización y permite reintento", async () => {
  const { directory, request } = await approvedRequest();
  const result = await persistConfirmedRegistration(directory, command(request), reviewer, { ...clock, beforeReplace: (path) => {
    if (path === "log.jsonl") throw new Error("Fallo simulado de commit autorizado.");
  } });
  expect(result.ok).toBe(false);
  expect(await rowCount(directory)).toBe(8);
  expect(await readFile(output(directory, "sharepoint/historial.jsonl"), "utf8")).toBe("");
  expect(unwrap(await getConfirmation(directory, request.solicitud_id, clock)).estado).toBe("aprobada");
  expect(unwrap(await persistConfirmedRegistration(directory, command(request), reviewer, clock)).accion).toBe("registrado");
});

test("Caducidad durante el commit revierte todos los archivos y no consume la solicitud", async () => {
  const { directory, request } = await approvedRequest();
  let time = clock.now();
  const result = await persistConfirmedRegistration(directory, command(request), reviewer, {
    now: () => time, beforeReplace: (path) => { if (path === "log.jsonl") time = "2030-01-02T12:31:00.000Z"; },
  });
  expect(result.ok).toBe(false);
  expect(await rowCount(directory)).toBe(8);
  expect(unwrap(await getConfirmation(directory, request.solicitud_id, clock)).estado).toBe("aprobada");
  expect(await readFile(output(directory, "sharepoint/historial.jsonl"), "utf8")).toBe("");
});

test("Otrosí corregido y confirmado conserva la fila original y las obligaciones de ampliación", async () => {
  const { directory } = await project();
  const path = join(directory, "fixtures/reto-02/buzon/msg-003/otrosi.txt");
  await writeFile(path, (await readFile(path, "utf8")).replace("520,000.00", "520.000"));
  const ticket = unwrap(await evaluateRegistration(directory, "msg-003", "otrosi.txt"));
  expect(ticket.validacion.requiere_revision).toContain("valor");
  const request = unwrap(await createConfirmation(directory, ticket, [{ campo: "valor", valor: 520000, ...source }], reviewer, clock));
  expect(request.datos_registro.estado_poliza).toBe("vigente");
  unwrap(await decideConfirmation(directory, { ...command(request), accion: "aprobar" }, reviewer, clock));
  const result = unwrap(await persistConfirmedRegistration(directory, command(request), reviewer, clock));
  expect(result.accion).toBe("actualizado");
  expect(await rowCount(directory)).toBe(8);
  const history = z.object({ obligaciones_pendientes: z.array(z.object({ tipo: z.string() })), cambios: z.array(z.object({ campo: z.string() })) })
    .parse(JSON.parse((await readFile(output(directory, "sharepoint/historial.jsonl"), "utf8")).trim()));
  expect(history.obligaciones_pendientes[0]?.tipo).toBe("AMPLIAR_GARANTIAS");
  expect(history.cambios.map((change) => change.campo)).toEqual(["valor", "fecha_fin"]);
});

test("Cambio de fecha automática no se autoriza con el hash de ayer", async () => {
  const { directory, ticket } = await project();
  const beforeMidnight = { now: () => "2030-01-02T04:55:00.000Z" };
  const afterMidnight = { now: () => "2030-01-02T05:05:00.000Z" };
  const request = unwrap(await createConfirmation(directory, ticket, corrections, reviewer, beforeMidnight));
  unwrap(await decideConfirmation(directory, { ...command(request), accion: "aprobar" }, reviewer, beforeMidnight));
  expect((await persistConfirmedRegistration(directory, command(request), reviewer, afterMidnight)).ok).toBe(false);
  expect(await rowCount(directory)).toBe(8);
});

const conditionalCorrections = [
  { campo: "tratamiento_valor", valor: "indeterminado_como_cero", ...source },
  { campo: "moneda", valor: "USD", ...source },
  { campo: "fecha_inicio", valor: "2030-01-01", ...source },
  { campo: "fecha_fin", valor: "2030-12-31", ...source },
  { campo: "requiere_poliza", valor: false, ...source },
  { campo: "tratamiento_poliza", valor: "condicion_no_activada", ...source },
  { campo: "objeto", valor: "Servicios sintéticos de soporte sujetos a órdenes de trabajo.", ...source },
];

test("Contrato sintético indeterminado: representación cero solo tras decisión explícita y aprobación", async () => {
  const { directory, ticket } = await project(true);
  const request = unwrap(await createConfirmation(directory, ticket, conditionalCorrections, reviewer, clock));
  expect(request.extraccion_original.campos.valor.normalizado).toBeNull();
  expect(request.extraccion_original.valor_indeterminado.normalizado).toBe(true);
  expect(request.extraccion_original.campos.objeto.normalizado!.length).toBeGreaterThan(200);
  expect(request.datos_registro.valor).toBe(0);
  expect(request.datos_registro.requiere_poliza).toBe(false);
  expect(await rowCount(directory)).toBe(8);
  expect((await persistConfirmedRegistration(directory, command(request), reviewer, clock)).ok).toBe(false);
  unwrap(await decideConfirmation(directory, { ...command(request), accion: "aprobar" }, reviewer, clock));
  unwrap(await persistConfirmedRegistration(directory, command(request), reviewer, clock));
  const history = z.object({ revision_humana: z.object({ tratamiento_valor: z.string(),
    valor_indeterminado_documental: z.object({ normalizado: z.boolean() }),
    condicion_poliza_documental: z.object({ evidencia: z.string() }) }) })
    .parse(JSON.parse((await readFile(output(directory, "sharepoint/historial.jsonl"), "utf8")).trim()));
  expect(history.revision_humana.tratamiento_valor).toBe("indeterminado_como_cero");
  expect(history.revision_humana.valor_indeterminado_documental.normalizado).toBe(true);
  expect(history.revision_humana.condicion_poliza_documental.evidencia).toContain("Para cada orden");
});

test("Valor indeterminado no se reemplaza por un importe o cero real arbitrario", async () => {
  const { directory, ticket } = await project(true);
  for (const amount of [0, 5000]) {
    expect((await createConfirmation(directory, ticket, [{ campo: "valor", valor: amount, ...source }], reviewer, clock)).ok).toBe(false);
  }
});

test("Póliza condicional requiere aclaración explícita y tratamiento coherente", async () => {
  const { directory, ticket } = await project(true);
  const withoutTreatment = conditionalCorrections.filter((correction) => correction.campo !== "tratamiento_poliza");
  expect((await createConfirmation(directory, ticket, withoutTreatment, reviewer, clock)).ok).toBe(false);
  const contradictory = conditionalCorrections.map((correction) => correction.campo === "tratamiento_poliza" ? { ...correction, valor: "condicion_activada" } : correction);
  expect((await createConfirmation(directory, ticket, contradictory, reviewer, clock)).ok).toBe(false);
});

test("Comercial corregido explícitamente conserva origen humano, no un nombre inferido", async () => {
  const { directory, folder } = await project();
  const metadata = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(join(folder, "correo.json"), "utf8")));
  metadata.de = "sin-catalogo@example.com";
  await writeFile(join(folder, "correo.json"), JSON.stringify(metadata));
  const ticket = unwrap(await evaluateRegistration(directory, "msg-sintetico", "contrato.txt"));
  const request = unwrap(await createConfirmation(directory, ticket, [...corrections,
    { campo: "comercial", valor: "Responsable SINTÉTICO", ...source }], reviewer, clock));
  expect(request.validacion_revisada.evidencias.comercial.origen).toBe("humano");
  unwrap(await decideConfirmation(directory, { ...command(request), accion: "aprobar" }, reviewer, clock));
  unwrap(await persistConfirmedRegistration(directory, command(request), reviewer, clock));
  const history = z.object({ derivados: z.object({ comercial_origen: z.string() }) })
    .parse(JSON.parse((await readFile(output(directory, "sharepoint/historial.jsonl"), "utf8")).trim()));
  expect(history.derivados.comercial_origen).toBe("humano");
});

test("Auditoría separa solicitud, decisión y escritura; historial solo cambia al aplicar", async () => {
  const { directory, request } = await pendingRequest();
  expect(await readFile(output(directory, "sharepoint/historial.jsonl"), "utf8")).toBe("");
  unwrap(await decideConfirmation(directory, { ...command(request), accion: "aprobar" }, reviewer, clock));
  expect(await readFile(output(directory, "sharepoint/historial.jsonl"), "utf8")).toBe("");
  unwrap(await persistConfirmedRegistration(directory, command(request), reviewer, clock));
  expect((await logs(directory)).map((entry) => entry.resumen)).toEqual(["solicitud_creada", "solicitud_aprobada", "registrado"]);
  const history = z.object({ revision_humana: z.object({ solicitud_id: z.string(), datos_hash: z.string(),
    correcciones: z.array(z.object({ campo: z.string(), anterior: z.null(), revisor_id: z.string() })) }) })
    .parse(JSON.parse((await readFile(output(directory, "sharepoint/historial.jsonl"), "utf8")).trim()));
  expect(history.revision_humana.solicitud_id).toBe(request.solicitud_id);
  expect(history.revision_humana.datos_hash).toBe(request.datos_hash);
  expect(history.revision_humana.correcciones).toHaveLength(2);
});

test("Fixtures, maestro operativo y filas originales se conservan durante pruebas aisladas", async () => {
  async function hashes(directory: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) Object.assign(result, await hashes(path));
      else result[path] = hashBytes(await readFile(path));
    }
    return result;
  }
  const before = { fixtures: await hashes(join(root, "fixtures")), out: await hashes(join(root, "out")),
    prd: await readFile(join(root, "PRD.md")), agents: await optionalBytes(join(root, "AGENTS.md")) };
  const { directory, request } = await approvedRequest();
  const original = await readCsv(output(directory, "sharepoint/maestro-contratos.csv"));
  unwrap(await persistConfirmedRegistration(directory, command(request), reviewer, clock));
  const after = await readCsv(output(directory, "sharepoint/maestro-contratos.csv"));
  if (!original.ok || !after.ok) throw new Error("CSV ilegible.");
  expect(after.data.registros.slice(0, 8)).toEqual(original.data.registros);
  expect(await hashes(join(root, "fixtures"))).toEqual(before.fixtures);
  expect(await hashes(join(root, "out"))).toEqual(before.out);
  expect(await readFile(join(root, "PRD.md"))).toEqual(before.prd);
  expect(await optionalBytes(join(root, "AGENTS.md"))).toEqual(before.agents);
});
