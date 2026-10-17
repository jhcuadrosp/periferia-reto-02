import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConfirmation, decideConfirmation, evaluateRegistration, inspectReview, persistConfirmedRegistration,
  type StorageResult } from "./src/storage/persistence.ts";
import { readCsv } from "./src/storage/csv.ts";

function unwrap<T>(result: StorageResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

const project = fileURLToPath(new URL("./", import.meta.url));
const directory = await mkdtemp(join(tmpdir(), "periferia-revision-demo-"));
await cp(join(project, "fixtures"), join(directory, "fixtures"), { recursive: true });
const clock = { now: () => "2030-01-02T12:00:00.000Z" };
const reviewer = { id: "analista-simulado", modo: "simulado_local" as const };
console.log(`Demostración aislada: ${directory}. La identidad y las correcciones siguientes son sintéticas.`);

const actual = unwrap(await evaluateRegistration(directory, "msg-006", "contrato.txt"));
const view = unwrap(await inspectReview(directory, actual, clock));
console.log(JSON.stringify({ mensaje_real_sin_respuestas_inventadas: {
  mensaje_id: view.mensaje_id, id_contrato: view.id_contrato, campos: view.campos,
  motivos: view.motivos, advertencias: view.advertencias },
  sin_correcciones: await createConfirmation(directory, actual, [], reviewer, clock) }, null, 2));

const folder = join(directory, "fixtures/reto-02/buzon/msg-sintetico");
await mkdir(folder);
await writeFile(join(folder, "correo.json"), JSON.stringify({ id: "msg-sintetico", de: "lgomez@periferia-ficticia.com",
  para: "contratos@periferia-ficticia.com", asunto: "SIMULACIÓN de revisión", fecha: clock.now(),
  cuerpo: "Ejemplo sintético, sin valor probatorio para contratos reales.", adjuntos: ["contrato.txt"] }));
await writeFile(join(folder, "contrato.txt"), `CONTRATO No. SYN-2030-HIL\n\nEntre CLIENTE SINTÉTICO S.A., NIT 111.222.333-0, con domicilio en Colombia, y PERIFERIA IT GROUP S.A.S.\n\nPRIMERA. OBJETO. Servicio sintético de soporte de aplicaciones.\n\nSEGUNDA. VALOR. Importe pendiente de aclaración.\n\nTERCERA. PLAZO. Desde 2030-01-01 hasta 2030-12-31.\n\nCUARTA. GARANTÍAS. No se requiere póliza.`);
const evaluated = unwrap(await evaluateRegistration(directory, "msg-sintetico", "contrato.txt"));
const syntheticView = unwrap(await inspectReview(directory, evaluated, clock));
console.log(JSON.stringify({ pendiente_sintetico: { mensaje_id: syntheticView.mensaje_id,
  campos: syntheticView.campos, motivos: syntheticView.motivos } }, null, 2));
const corrections = [
  { campo: "valor", valor: 1500, justificacion: "Importe supuesto únicamente para esta simulación.", procedencia: "Acta SINTÉTICA de prueba" },
  { campo: "moneda", valor: "USD", justificacion: "Moneda supuesta únicamente para esta simulación.", procedencia: "Acta SINTÉTICA de prueba" },
];
const request = unwrap(await createConfirmation(directory, evaluated, corrections, reviewer, clock));
console.log(JSON.stringify({ solicitud: { solicitud_id: request.solicitud_id, mensaje_id: request.mensaje_id,
  estado: request.estado, revisor: request.revisor, caduca_en: request.caduca_en,
  maestro_hash: request.maestro_hash, entrada_hash: request.entrada_hash, datos_hash: request.datos_hash,
  valores_a_autorizar: request.datos_registro, correcciones: request.correcciones } }, null, 2));
const command = { solicitud_id: request.solicitud_id, datos_hash: request.datos_hash };
console.log(JSON.stringify({ sin_aprobacion: await persistConfirmedRegistration(directory, command, reviewer, clock) }, null, 2));
const approved = unwrap(await decideConfirmation(directory, { ...command, accion: "aprobar" }, reviewer, clock));
console.log(JSON.stringify({ decision_explicita: approved.decision,
  registro: unwrap(await persistConfirmedRegistration(directory, command, reviewer, clock)) }, null, 2));
const master = await readCsv(join(directory, "out/sharepoint/maestro-contratos.csv"));
if (!master.ok) throw new Error("No se pudo verificar el maestro de la demostración.");
console.log(JSON.stringify({ registros: master.data.registros.length,
  contrato_sintetico: master.data.registros.find((row) => row.id_contrato === "SYN-2030-HIL"),
  msg006_registrado: master.data.registros.some((row) => row.id_contrato === "CM-2026-03"),
  auditoria: `${directory}/out/log.jsonl`,
  eventos_auditoria: (await readFile(join(directory, "out/log.jsonl"), "utf8")).trim().split("\n").length }, null, 2));
