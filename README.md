# Periferia — Reto 02

Proyecto TypeScript con Bun para construir progresivamente una solución de
registro de contratos. Incluye persistencia local y confirmación humana controlada
(Fase 5.2), herramientas deterministas y alertas (Fase 6.1), y demo integral
sin LLM (Fase 6.2), y motor conversacional con proveedor simulado (Fase 7.1).
Todavía no integra un proveedor LLM real ni frontend.

## Requisitos e instalación

- Bun 1.4.3, versión verificada en este proyecto.
- TypeScript 7.0.2 y tipos de Bun existentes.
- Zod como dependencia de ejecución para esquemas y validaciones.
- csv-parse para leer CSV con comillas, campos vacíos y delimitadores sin
  mantener un parser propio. Su API síncrona basta para los archivos pequeños
  del reto; no hace falta introducir streams ni procesamiento por lotes.

Desde esta carpeta, en PowerShell:

```powershell
bun install --frozen-lockfile
```

Si PowerShell no encuentra Bun, agrega su instalación al PATH de la sesión:

```powershell
$env:Path = "$env:USERPROFILE\.bun\bin;$env:Path"
```

## Comandos disponibles

```powershell
bun run index.ts
bun run typecheck
bun test
bun run diagnostico
bun run extraccion
bun run validacion
bun run registro
bun run revision
bun run herramientas
bun run demo
bun run agente:mock
```

`bun run test` también ejecuta las pruebas. El chequeo de tipos usa `bun check`
y la configuración existente de `tsconfig.json`, sin emitir archivos compilados.

`bun run demo` ejecuta los seis casos dos veces en un proyecto temporal nuevo,
con reloj fijo y aserciones. No utiliza claves ni modifica el out/ operativo.

## Estructura inicial

- `index.ts`: ejemplo de ejecución TypeScript; no contiene lógica del reto.
- `src/domain/schemas.ts`: estructuras Zod del maestro, comerciales y correo.
- `src/domain/quality.ts`: diagnóstico, duplicados internos y advertencias.
- `src/domain/normalization.ts`: importes, monedas, fechas e identificadores.
- `src/domain/extraction.ts`: extracción pura a partir del contenido del TXT.
- `src/domain/validation.ts`: reglas RN1–RN5, enriquecimiento trazable y propuesta
  de operación en memoria.
- `src/domain/registration.ts`: prepara filas completas, IDs AUTO y rutas de archivo.
- `src/domain/review.ts`: presenta pendientes, valida correcciones y conserva su procedencia.
- `src/domain/confirmation.ts`: esquemas, hashes y comprobación de autorizaciones concretas.
- `src/domain/alerts.ts`: cálculo puro de vencimientos, pólizas, altas y representación Markdown.
- `src/storage/files.ts`: lectura de TXT y JSON con errores controlados.
- `src/storage/csv.ts`: lectura CSV mediante csv-parse; conserva campos como texto.
- `src/storage/mailbox.ts`: inventario de mensajes y comprobación de adjuntos.
- `src/storage/persistence.ts`: inicialización, evaluación y registro revalidado,
  idempotencia por mensaje y control de versión del maestro.
- `src/storage/audit.ts`: rutas dentro de out/, escrituras temporales, diario de
  recuperación y composición de eventos JSONL.
- `src/tools/contratos.ts`: cinco herramientas del PRD importables sin servidor ni modelo.
- `tests/setup.test.ts`: comprueba la ejecución del ejemplo y la disponibilidad
  de Zod con entradas válidas e inválidas.
- `tests/data.test.ts`: lectura real, entradas inválidas, errores y conservación
  de originales. Los archivos de prueba se crean fuera de fixtures.
- `tests/extraction.test.ts`: seis documentos, normalización, ambigüedades,
  evidencias, confianza, determinismo e integridad de los originales.
- `tests/validation.test.ts`: seis casos y límites sintéticos del motor de reglas.
- `tests/persistence.test.ts`: pruebas en proyectos temporales con copias de fixtures,
  reloj fijo, errores de escritura, recuperación, rutas e idempotencia.
- `tests/confirmation.test.ts`: revisión, decisiones explícitas, caducidad,
  integridad, consumo único y persistencia autorizada en copias temporales.
- `tests/alerts.test.ts`: fronteras de fechas, corte, pólizas y obligaciones del historial.
- `tests/tools.test.ts`: contratos de herramientas, errores, auditoría y autorizaciones en proyectos temporales.
- `diagnostico.ts`: presenta el diagnóstico completo como JSON en consola.
- `extraccion.ts`: muestra los resultados de extracción de los TXT del buzón.
- `validacion.ts`: evalúa el buzón contra el maestro y el catálogo originales.
- `registro.ts`: procesa el buzón contra el maestro de salida sin borrar resultados anteriores.
- `revision.ts`: demuestra revisión y autorización en un proyecto temporal aislado.
- `herramientas.ts`: muestra las cinco herramientas y genera un informe temporal sin tocar out/ operativo.
- `demo.ts`: verificación integral de los seis casos, segunda pasada y alertas.
- `tests/demo.test.ts`: ejecución CLI reproducible y detección de una discrepancia en datos de prueba.
- `agent/prompt.md`: comportamiento y restricciones del agente en español.
- `src/agent/provider.ts`: protocolo del proveedor y validación de respuestas.
- `src/agent/mock-provider.ts`: guion simulado independiente para cada sesión.
- `src/agent/session.ts`: historial, eventos, tickets y vínculos de revisión en memoria.
- `src/agent/tool-executor.ts`: lista permitida, contratos Zod y ejecución controlada.
- `src/agent/runner.ts`: ciclo conversacional, límites y coordinación de sesiones.
- `src/agent/human-review.ts`: comandos externos de revisión y decisión, separados del proveedor.
- `agente-mock.ts` y `tests/agent.test.ts`: muestra aislada y pruebas deterministas del motor.
- `fixtures/reto-02/`: datos originales de solo lectura.
- `PRD.md`: requisitos originales, sin modificaciones.
- `out/`: resultados generados en ejecución y excluidos de Git.

Las carpetas vacías de `src/` incluyen `.gitkeep` para conservarlas en Git.
No se necesitan claves ni variables de entorno para esta fase.

## Lectura y calidad de datos

El flujo es: archivo → lectura → validación Zod → registros válidos y problemas.
Este diagnóstico no escribe resultados en `out/` ni modifica los originales.
Las rutas de fixtures se resuelven desde la ubicación de `diagnostico.ts`,
independientemente del directorio desde el que se ejecute.

Cada problema incluye `archivo`, `campo`, `tipo`, `nivel` y `descripcion`:

- Un error de lectura, sintaxis o encabezado impide procesar ese archivo.
- Un error de estructura invalida solo el registro o los metadatos afectados;
  el diagnóstico continúa con los demás.
- Una advertencia informa duplicados o incoherencias sin descartar el registro.

El comando termina con código 1 si hay errores y con código 0 si no los hay.
Las advertencias no producen un código de error.

Las 16 columnas del maestro deben estar presentes. Todos los campos deben
tener un valor válido; `tipo_poliza` permite vacío cuando no se exige póliza.
No se convierte una celda vacía en cero, falso o null. Los importes aceptan
decimales con punto y sin separadores de miles. Como criterio de calidad,
se comprueba que sean finitos y no negativos. Los identificadores tributarios
se conservan como texto de dígitos, sin validar fiscalmente cada país.
El PRD no fija un patrón único para `id_contrato`: se exige texto no vacío,
sin imponer el prefijo CT- ni generar identificadores en esta fase.

El catálogo requiere `email`, `nombre` y `region`. Los correos requieren las
siete propiedades reales: `id`, `de`, `para`, `asunto`, `fecha`, `cuerpo` y
`adjuntos`. Un cuerpo vacío es advertencia; una lista de adjuntos vacía es
válida estructuralmente y no implica una clasificación contractual.

Los adjuntos TXT se leen solo para comprobar disponibilidad y contenido vacío;
el diagnóstico muestra su longitud, no extrae cláusulas ni campos del contrato.
Los demás formatos se comprueban como archivos legibles, sin interpretar su
contenido. Las rutas de adjuntos no pueden salir del directorio del mensaje.
No se comprueba la existencia de los PDF históricos del maestro, porque esos
documentos no forman parte de los fixtures entregados.

## Próxima etapa

La demo integral de Fase 6.2 se describe al final de este documento. La etapa siguiente requiere
aprobación y definición de alcance; no se avanza automáticamente.

## Extracción determinista (Fase 3)

`bun run extraccion` imprime JSON en consola, sin crear archivos en `out/`.
Reutiliza `readMailbox` y `readText`. La función `extractContract(text)` no lee
el maestro, el catálogo ni los correos: su única entrada es el texto documental.

El flujo es TXT → localizar encabezado y cláusulas → normalizar → validar
el resultado con Zod. No hay tablas de resultados por mensaje: un cambio de
ID, importe o fechas en el texto cambia la salida conforme a las mismas reglas.

La salida contiene:

- `tipo_documento`: contrato, otrosi, cotizacion o desconocido, según el
  encabezado. Describe la forma documental, no una operación de registro.
- `id_documento`: distingue el número de oferta o de otrosí del ID contractual.
- `campos`: las 16 propiedades del maestro, cada una con `extraido`,
  `normalizado`, `confianza` y `evidencia`.
- `valor_indeterminado`, `plazo_meses` y `condicion_poliza`: conservan datos
  adicionales que el CSV por sí solo no representa.
- `campos_modificados`: campos expresados en cláusulas modificatorias del
  otrosí. El ID es la referencia al contrato; los null de otros campos no
  son instrucciones para borrar ni reemplazar valores del maestro.
- `requiere_revision`: observaciones sobre campos documentales pendientes o
  de baja confianza; no decide registrar ni rechazar un documento.
- `advertencias`: problemas y limitaciones localizados por campo.

Los campos enriquecidos `comercial`, `estado_poliza`, `ruta_sharepoint`,
`fecha_registro` y `fuente` permanecen ausentes (extraído, normalizado y evidencia
null, confianza 0). No generan advertencias ni se incluyen en `requiere_revision`,
porque no se espera obtenerlos del TXT. Su resolución corresponde a etapas
posteriores, manteniendo la extracción documental original como evidencia:

| Campo enriquecido | Fuente futura |
|---|---|
| `comercial` | Remitente del correo y catálogo de comerciales. |
| `estado_poliza` | Maestro y reglas de negocio, nunca solo la cláusula de obligación. |
| `ruta_sharepoint` | Resultado del archivo del documento. |
| `fecha_registro` | Fecha efectiva de la operación de registro. |
| `fuente` | Canal de entrada comprobado por el proceso, como buzón o carga manual. |

La extracción no consulta estas fuentes. El motor de Fase 4 complementa los
campos que puede resolver con evidencia; ruta de archivo y fecha de registro
siguen reservadas para la ejecución futura.
Tampoco se genera un ID AUTO durante la extracción de un documento sin identificador.

### Reglas y decisiones

- El cliente se toma de la primera parte identificada, sin confundirlo con
  Periferia. El NIT pierde puntos y dígito de verificación; el RUC conserva
  sus dígitos. Son transformaciones sintácticas, no verificación fiscal.
- Solo se acepta un país mencionado explícita e inequívocamente en la primera
  parte, correspondiente al cliente. El nombre literal se conserva en `extraido`,
  su código en `normalizado` y el fragmento original en `evidencia`. No se usa el
  país del contratista para completar el del cliente, ni se infiere CO por NIT
  o por una ciudad. Sin evidencia suficiente, se conserva null con confianza 0.
  El extractor no aplica reglas de país inferido. El motor de validación puede
  complementarlo desde el maestro bajo el criterio documentado más adelante,
  sin modificar la extracción original.
- Solo se busca el importe contractual en la cláusula VALOR. En cotizaciones
  se usa el total estimado, no el importe mensual. No se toman porcentajes ni
  umbrales de las garantías como valor contractual.
- Se soportan importes numéricos como `265.000.000`, `120,000.00` y `1.234,56`.
  Un único separador con tres cifras finales (`1.234`) queda ambiguo. No se
  convierten importes escritos exclusivamente en letras ni se comprueba su
  equivalencia con la cifra. No se adivina la moneda a partir de `$`.
- Se reconocen fechas ISO y días en español con o sin cifra entre paréntesis.
  Se comprueba el calendario y la concordancia entre día escrito y numérico.
  No se derivan fechas por meses ni se usa la fecha del correo. El plazo
  explícito en meses se conserva separado.
- Sin cláusula de póliza, `requiere_poliza` queda null, no false. En msg-002
  y msg-004 hará falta evidencia adicional del correo, maestro o revisión.
  Una exención explícita sí permite false. Las condiciones por órdenes de
  servicio se conservan sin convertirlas en una obligación incondicional.
- En otrosíes se extraen el ID de referencia y los cambios explícitos de valor,
  moneda y fin. Se conserva la condición de ampliación de garantías sin
  modificar estados ni completar los demás campos desde el contrato base.
- En msg-006, `valor_indeterminado.normalizado = true` y `valor.normalizado = null`:
  el documento no contiene un monto fijo. Se conserva la cláusula original y
  el valor queda pendiente de revisión, con confianza 0.60. Un cero expresamente
  escrito en un documento sí se normaliza como 0; son situaciones distintas.
  El PRD 7.2 exige cero en el maestro para contratos por demanda: esa conversión
  se realizará mediante una futura regla de persistencia, validada y trazable,
  sin alterar el resultado de extracción. Su moneda queda null; el COP del umbral de
  póliza no demuestra la moneda de todas las órdenes. Agosto sin día de firma
  deja inicio y fin null. La prórroga automática queda en la evidencia del plazo.
- El objeto completo se conserva tanto en `extraido` como en `normalizado`, sin
  recorte ni pérdida de confianza por longitud. El esquema Zod de extracción
  permite ese texto completo. El esquema del maestro mantiene el máximo de
  200 caracteres del PRD 7.2: su adaptación requerirá una decisión posterior
  de validación o persistencia, sin sobrescribir ni perder el objeto original.

### Confianza

Son puntuaciones heurísticas explicables, no probabilidades calibradas:

| Puntuación | Criterio |
|---|---|
| 0 | Campo ausente: extraído, normalizado y evidencia null. |
| 0.98 | Dato explícito con interpretación inequívoca. |
| 0.65 | Importe explícito pero estimado en una cotización. |
| 0.60 | Valor expresamente indeterminado: normalizado null, con revisión. |
| 0.40 | Condición o formato no resuelto: conserva texto y normalizado null. |
| 0.30 | Fechas ligadas a una firma sin fecha exacta. |

Una cifra explícita puede estar bien leída sin ser un valor contractual
definitivo. Por eso se separan la representación original, la normalización y
la confianza. Los campos operativos no se incluyen en `requiere_revision`;
siguen visibles como null. En otrosíes solo se revisan la referencia y los
cambios extraídos; en cotizaciones los datos explícitos de la oferta.

### Límites

El extractor reconoce los encabezados, cláusulas y formatos documentados en
los fixtures. Otros diseños, monedas, importes en letras, cláusulas contradictorias
o múltiples condiciones requieren ampliar las reglas y sus pruebas. Se conservan
evidencias y advertencias; no constituye revisión jurídica ni un registro válido.

## Motor de reglas (Fase 4)

`bun run validacion` carga el maestro y catálogo con los lectores y diagnósticos
existentes, recorre los mensajes y llama a `validateContract(extraction, mail,
master, commercials)`. El motor es una función sin operaciones de archivos ni
servicios externos. Cada evaluación usa el maestro original: ninguna propuesta
se aplica al siguiente mensaje ni se escribe en disco.

### Orden y correspondencia con el PRD

1. **RN4 / HU-1:** sin adjunto contractual interpretable, cotización o texto no
   contractual se devuelve `rechazado`. Un contrato sin partes ni objeto
   identificables también se rechaza. La falta aislada de un campo esencial
   produce revisión, no rechazo automático. Los otrosíes pueden identificar
   partes y objeto a través del contrato base.
2. **RN1:** contrato ordinario con igual ID, valor y fechas inicial/final es
   `duplicado`. Datos propuestos null y diferencias vacías: no se modifica nada.
3. **RN2:** ID existente, o mismo NIT y objeto con similitud >= 0.9, identifica
   una posible actualización. Un otrosí explícito aplica RN2 antes de RN1.
   Se conserva la fila base en una copia y solo se superponen los campos
   modificados del otrosí; un cambio ilegible no reemplaza el original por null.
4. **RN3:** documento contractual sin coincidencia es `nuevo`, incluso si
   necesita revisión humana por información incompleta.
5. **RN5:** confianza menor que 0.8, falta esencial o contradicción bloquea la
   elegibilidad. Exactamente 0.8 cumple el umbral. La confirmación se incorpora
   separadamente en Fase 5.2; la clasificación por sí sola no autoriza.

RN1 y RN2 se solapan: RN1 no incluye moneda ni objeto. Se documenta esta
precedencia para no redefinir sus criterios. Una moneda contradictoria en un
duplicado se informa como revisión y no habilita ninguna modificación. Un
otrosí ya aplicado sigue siendo RN2 aunque no tenga diferencias; su idempotencia
por mensaje se resolverá con la persistencia futura.

El PRD no especifica la métrica de similitud. Se usa **Jaccard de conjuntos de
palabras**: intersección / unión, tras normalizar mayúsculas, acentos y signos.
El orden no afecta al resultado; no se interpreta semántica. Se exige NIT y
objeto con confianza >= 0.8 para usar esta coincidencia alternativa. Si el ID
documental difiere del encontrado por similitud, se conserva el ID del maestro
y se pide revisión. Varias coincidencias o un otrosí sin base localizada quedan
bloqueados como actualización pendiente, sin seleccionar una fila arbitraria.

### Enriquecimiento y procedencia

- **HU-3:** el correo del remitente se busca sin distinguir mayúsculas en el
  catálogo. En un nuevo contrato se propone el nombre resuelto. En una
  actualización se conserva el responsable original y se informa aparte el
  comercial remitente. Un remitente desconocido se advierte y no bloquea por
  sí solo; un catálogo con coincidencias múltiples sí requiere aclaración.
- **País, PRD 7.2:** si falta documentalmente, el NIT conocido y de confianza
  suficiente permite consultar los registros del mismo cliente. Solo se usa
  su país si es uniforme. Se marca origen maestro con IDs y NIT como evidencia;
  esto no es la regla eliminada NIT -> CO. Un país contradictorio requiere revisión.
- **Póliza, PRD 7.2:** una ausencia en el TXT puede completarse con una
  declaración explícita e incondicional del correo. No tener cláusula no
  significa false. Un correo no elimina una condición ambigua del documento;
  las contradicciones requieren revisión.
- En nuevos contratos con póliza se propone estado `pendiente`; sin póliza,
  tipo vacío y estado `no_aplica`. En otrosíes se conserva el estado del
  maestro y se advierte la ampliación de garantías exigida por el documento.
- El canal comprobado se propone como `fuente = buzon`. `ruta_sharepoint` y
  `fecha_registro` no se exigen al TXT y se dejan para la futura ejecución.
  El ID ausente también queda pendiente de generación AUTO (PRD 7.2), sin
  reservar secuencias durante una evaluación sin persistencia.

### Resultado y revisión humana

`validationSchema` comprueba mensaje e ID, operación, estado, elegibilidad,
campos de revisión, motivos, pendientes, propuesta, diferencias y evidencias.
Cada evidencia distingue documento, maestro, catálogo, correo, regla o pendiente,
con su puntuación heurística, respaldo y regla aplicada. No son probabilidades.
La extracción original y el objeto completo nunca se alteran.

`elegible_registro` significa **candidato según reglas**, no escritura ni
autorización ejecutada. Solo puede ser true para nuevo/actualización sin
revisiones. `estado_validacion` es `validado`, `pendiente_revision` o `no_aplica`.
Los campos operativos pendientes no se confunden con revisión humana.

| Mensaje | Operación | Elegible | Observación |
|---|---|---|---|
| msg-001 | nuevo | Sí | País complementado desde maestro; póliza pendiente. |
| msg-002 | nuevo | Sí | Correo declara que no pide póliza; no_aplica. |
| msg-003 | actualizacion | Sí | Valor 350000 -> 520000 PEN; fin 2027-05-01 -> 2027-11-01. |
| msg-004 | duplicado | No | Ninguna propuesta ni diferencia. |
| msg-005 | rechazado | No | Es una cotización. |
| msg-006 | nuevo | No | Revisión de valor, moneda, fechas, póliza y objeto. |

En msg-006 se preserva valor null y `valor_indeterminado = true`; la regla de
persistencia a cero sigue pendiente. Su objeto íntegro excede el límite de
200 caracteres del maestro, por lo que requiere adaptación revisada. El país
se complementa desde el mismo cliente existente. El remitente desconocido se
advierte, pero no es el motivo del bloqueo.

### Límites y evolución del registro

- `validacion.ts` sigue siendo un diagnóstico sin escrituras. `registro.ts`
  incorpora RN6, RN7, archivo, procesados e historial en Fase 5.1, como se detalla abajo.
- La escritura local revalida maestro, entradas y elegibilidad. Concurrencia
  multiproceso, almacenamiento remoto y durabilidad ante fallos físicos quedan fuera.
- La confirmación de Fase 5.2 está vinculada a los campos y valores revisados.
  No se ha autorizado ningún contrato mediante un booleano externo.
- El esquema final del maestro se comprueba antes de guardar. Para un remitente
  desconocido se conserva su email real como identificador provisional del
  comercial, con origen correo en auditoría y sin inventar un nombre (HU-3).
- Similitud, correlación por NIT y declaraciones del correo son reglas
  deterministas documentadas, no una validación jurídica ni de identidad fiscal.

## Persistencia contractual y trazabilidad (Fase 5.1)

```powershell
bun run registro
# Repetir el mismo comando demuestra idempotencia; no reinicia out/.
bun run registro
```

El primer procesamiento de los fixtures pasa de ocho a diez filas. Inserta
msg-001 y msg-002, actualiza msg-003, audita el duplicado msg-004 y el rechazo
msg-005 sin cambios contractuales, y deja msg-006 pendiente. En la segunda
ejecución los cinco primeros son `ya_procesado`; msg-006 permanece disponible
y se vuelve a auditar como pendiente, sin autorización automática.

### Inicialización y archivos

Se crea exclusivamente dentro del out/ de la raíz del proyecto:

```text
out/
  sharepoint/
    maestro-contratos.csv
    Contratos/
    historial.jsonl
  procesados.json
  log.jsonl
```

El maestro se copia de fixtures solo cuando no existe. Inicializar de nuevo no
reemplaza una copia con operaciones previas. Un maestro inválido o procesados
malformado bloquea el registro; no se repara ni reinicia silenciosamente.

Los nuevos documentos se archivan como
`Contratos/<año_inicio>/<cliente-slug>/<id_contrato>.txt`, con sus bytes originales.
Los otrosíes se conservan aparte como
`Contratos/<año_inicio>/<cliente-slug>/otrosies/<mensaje_id>/<id_contrato>.txt`.
Esta versión adicional evita reemplazar el contrato original: el maestro
conserva su ruta anterior y el historial guarda `ruta_archivo` del otrosí.
Los PDF históricos referenciados por el fixture no se inventan ni reconstruyen.
Un destino ya existente nunca se sobrescribe como documento.

Solo si se desea borrar los resultados de una demostración expresamente:

```powershell
bun run registro --reiniciar-demostracion
```

Ese comando elimina **todo out/** y vuelve a inicializarlo; no toca fixtures.
No se usa en el procesamiento normal. Las pruebas utilizan copias de fixtures
en directorios temporales aislados y reinicios explícitos dentro de esas copias.

### Flujo de registro y revalidación

1. `evaluateRegistration` lee el maestro de salida, correo, adjunto y catálogo.
   Ejecuta las reglas y devuelve un ticket con la validación y hashes SHA-256
   del maestro y de las entradas. No reserva IDs ni escribe contratos.
2. `persistRegistration` relee las fuentes y recalcula la validación. Rechaza
   tickets alterados, campos extra como `confirmado`, entradas modificadas y
   cualquier cambio del maestro desde la evaluación. El hash cubre todo el
   CSV, no solo la fila a actualizar. Se debe volver a evaluar tras un cambio.
3. La fila final se prepara únicamente si sigue elegible. Se generan ID AUTO
   cuando falta, fecha de registro y ruta de archivo. El ID AUTO toma el año
   inicial y la siguiente secuencia existente bajo la serialización local.
   La fecha usa el reloj de la operación y zona America/Cancun; en pruebas el
   reloj está fijado. Se valida nuevamente con el esquema Zod completo del maestro.
4. En actualizaciones se aplican solo las diferencias revalidadas y se
   conservan literalmente los demás campos CSV. Se vuelve a comprobar la base.
   No se cambia comercial, ruta original, fuente ni fecha original de registro.
5. Se prepara el conjunto de archivos, se comprueba de nuevo la versión del
   maestro antes de cada reemplazo y se aplica la escritura recuperable.

Si un remitente no está en el catálogo pero el contrato está completo, se
conserva su email como identificador verificable en `comercial`. El historial
indica `comercial_catalogado: false`, origen correo y evidencia del remitente;
no se presenta ese identificador como nombre resuelto. Msg-006 sigue bloqueado
por sus otros campos pendientes. No se convierte valor indeterminado a cero,
no se resume el objeto ni se implementa confirmación humana en esta fase.

### Auditoría, historial y obligaciones

- `historial.jsonl` contiene únicamente altas y actualizaciones efectivas:
  `{ ts, id_contrato, accion, cambios, mensaje_id }`, más ruta archivada,
  evidencias, derivados y advertencias. El otrosí original tiene dos diferencias.
- `log.jsonl` conserva cada intento de procesamiento, incluidos errores,
  duplicados, rechazos, pendientes y reintentos. Mantiene el formato RN7:
  `{ ts, herramienta, mensaje_id, ok, resumen }`, con validación detallada,
  hashes de fuentes, resultado y obligaciones. `herramienta` es `registro_local`
  porque aún no se han creado herramientas del agente.
- La exención de msg-002 conserva explícitamente origen `correo` y el texto
  que dice que no pide póliza, tanto en log como en historial del alta.
- Los conflictos de moneda, identidad o póliza en duplicados conservan RN1,
  advertencia `CONFLICTO_DUPLICADO`, valores enfrentados y revisión. No hay
  cambios contractuales ni archivado; si hay revisión, el mensaje no se marca
  terminado y sigue disponible.
- El otrosí conserva el estado histórico `vigente`. En ambos registros se
  almacena `obligaciones_pendientes` con `AMPLIAR_GARANTIAS`: vigente no prueba
  que la ampliación haya sido realizada. No se crea un estado de póliza nuevo.
- `procesados.json` contiene solo mensajes terminados, con hash de entrada,
  clasificación, ID y timestamp. Los pendientes permanecen fuera; sus motivos
  y evidencias quedan en log y el documento sigue en el buzón original.

Un mensaje terminado no se repite, aunque el ticket original tenga un hash
anterior del maestro. Si el contenido de un mensaje ya procesado cambia, se
bloquea para revisión. Un contrato reenviado bajo otro mensaje se detecta por
las reglas; un otrosí cuyo cambio ya está aplicado se audita como `sin_cambios`,
conservando RN2 pero sin nuevo historial ni archivo contractual.

### Fallos, rutas y alcance transaccional

Las escrituras usan temporal y rename dentro del mismo directorio. Antes del
conjunto de reemplazos se crea `out/.transaccion.json`, un diario pequeño con
imágenes anteriores y propuestas. Un error controlado revierte los archivos.
Después de una interrupción, la siguiente inicialización revierte un diario
preparado o termina la limpieza de uno confirmado. `confirmado` en ese diario
significa commit de archivos, nunca confirmación humana de datos.

Si aparecen cambios externos que no coinciden con ninguna imagen, se bloquea
la recuperación y se conserva el diario para revisión, sin sobrescribir esos
cambios. Si tampoco puede escribirse el log de error, la respuesta lo informa.
Los JSONL previos se comprueban antes de incorporar otra línea, y no se
concatenan sobre contenido JSON malformado.

Todas las rutas de escritura y recuperación deben permanecer dentro de out/.
Se rechazan rutas absolutas, ascensos, nombres inseguros y enlaces simbólicos
o junctions en su recorrido. El reinicio valida el destino antes de borrar.

La cola en memoria serializa operaciones del mismo proyecto **en un proceso**.
El diario ofrece recuperación local, no una transacción de base de datos:
no hay bloqueo distribuido ni garantías ante dos procesos, modificaciones
externas maliciosas concurrentes o pérdida física de almacenamiento. No se
debe ejecutar más de un escritor sobre el mismo out/. Para producción se
necesitarán bloqueo y almacenamiento transaccional apropiados.

## Confirmación humana controlada (Fase 5.2)

```powershell
bun run typecheck
bun test
bun run revision
```

La demostración copia los fixtures a un directorio temporal y muestra su ruta.
No utiliza ni modifica el out/ operativo. Primero presenta msg-006, sus campos
y motivos; sin aclaraciones completas continúa bloqueado. Después crea un
mensaje sintético independiente, con importe y moneda ausentes, y demuestra
la corrección explícita a 1500 USD, aprobación y registro. Estos datos ficticios
no se atribuyen al contrato CM-2026-03. El reloj de esa demostración está fijado
en 2030 y el maestro temporal pasa de ocho a nueve filas.

### Flujo y responsabilidades

1. `evaluateRegistration` genera el ticket existente. `inspectReview` presenta
   extracción original, propuesta enriquecida, valores actuales, evidencias,
   advertencias y motivos. Un comercial desconocido aparece como observación
   no bloqueante, conforme a HU-3.
2. `createConfirmation` recibe ticket, correcciones y revisor. Solo permite
   nuevos o actualizaciones pendientes; no habilita duplicados ni rechazos.
   Cada corrección contiene campo, valor propuesto, justificación y procedencia.
   Se añaden valor anterior, revisor y fecha, se comprueba con Zod y se ejecuta
   nuevamente `validateContract` sobre una copia. El original permanece íntegro.
3. Si quedan pendientes, se auditan las correcciones válidas y se informa
   revisión incompleta, sin generar autorización. Un nuevo intento debe enviar
   el conjunto completo de correcciones: no se acumulan cambios implícitos.
4. Con propuesta válida se genera `out/confirmaciones/<UUID>.json`. Incluye
   mensaje, contrato, operación, hashes del maestro y entradas, extracción y
   validaciones, correcciones, revisor y las 16 columnas concretas del registro.
   `datos_hash` vincula los valores finales y `contenido_hash` toda la revisión.
   La solicitud nace pendiente, sin modificar el maestro.
5. `decideConfirmation` exige `{ solicitud_id, datos_hash, accion }`, con acción
   `aprobar` o `rechazar`, más el contexto del revisor. Registra decisión y fecha.
   Aprobar no escribe el contrato. Una decisión no se cambia ni reutiliza.
6. `persistConfirmedRegistration` recibe `{ solicitud_id, datos_hash }` y el
   revisor. Relee la solicitud aprobada, revalida fuentes, maestro, reglas y
   correcciones, y compara la fila final con los valores autorizados. Rechaza
   mensajes ya procesados y operaciones equivalentes. Reutiliza la transacción
   de Fase 5.1: archivo, maestro, historial, procesados, log y solicitud utilizada
   se aplican juntos. Un fallo controlado revierte el conjunto y deja la
   solicitud aprobada disponible para reintentar si sigue vigente.

Estados: `pendiente → aprobada → utilizada`, o `pendiente → rechazada`.
La vigencia por defecto es de 30 minutos, configurable entre 1 y 60. Se comprueba
antes de cada reemplazo; una caducidad durante la escritura provoca reversión.
Si la fecha local del registro cambia entre revisión y ejecución, se exige nueva
revisión para no almacenar una fecha distinta de la autorizada. También se
bloquea cualquier cambio del maestro, documento, correo o catálogo relevante.
La ruta normal `persistRegistration` conserva sus comprobaciones y no acepta
una validación editada ni un argumento externo `confirmado=true` como autorización.

### Tratamientos pendientes de msg-006

- **Valor:** sigue siendo null e indeterminado en la extracción original. Una
  corrección `tratamiento_valor = indeterminado_como_cero` permite preparar cero
  para el maestro, conforme al PRD 7.2. Se persiste exclusivamente después de
  aprobar la solicitud completa; el historial aclara que no es un importe real.
  No se permite reemplazar ese valor por un importe fijo inventado.
- **Moneda y fechas:** requieren aclaraciones expresas y fechas exactas válidas;
  no se infieren del umbral de póliza ni de una firma sin día conocido.
- **Póliza:** resolver una condición requiere tanto `requiere_poliza` como
  `tratamiento_poliza = condicion_activada` o `condicion_no_activada`, coherentes
  y con fundamento documentado. No basta la ausencia de póliza. La condición
  original se conserva para auditoría. Los otrosíes mantienen el estado histórico
  de póliza y las obligaciones de ampliación pendientes.
- **Objeto:** se admite una adaptación humana de hasta 200 caracteres; el texto
  contractual completo continúa en la extracción, solicitud y archivo original.
- **Comercial:** puede aclararse con nombre y procedencia humana. Si sigue sin
  resolver, se conserva el criterio de Fase 5.1: email del remitente con origen
  correo, sin inventar un nombre y sin bloquear únicamente por ese motivo.

Las correcciones solo afectan campos pendientes o ausentes, nunca rutas,
fechas de registro, fuente o estado histórico. La revalidación no concede una
excepción general a conflictos semánticos: si una regla sigue detectando un
conflicto, el registro permanece bloqueado. La puntuación 1 en una corrección
identifica una declaración humana explícita; no es una probabilidad calibrada.

### Auditoría y límites

`out/log.jsonl` conserva revisión incompleta, creación de solicitud, aprobación
o rechazo, intentos y errores. La solicitud conserva las correcciones con
anterior/propuesto, justificación, procedencia, actor y fecha. Solo una operación
realmente aplicada añade `revision_humana` al historial contractual: solicitud,
hash autorizado, decisión, correcciones, condición original y tratamiento del
valor. La exención proveniente del correo conserva su procedencia existente.

El revisor usa `{ id, modo: "simulado_local" }` como contexto separado de los
argumentos de decisión. Esto no equivale a autenticación real. Los hashes detectan
cambios dentro de este flujo, no son firmas ni protegen de una persona con
control completo de los archivos y el código. Se conserva la limitación de un
solo proceso escritor de Fase 5.1. No se añaden dependencias, servicios externos,
LLM, frontend, herramientas del agente, alertas ni `demo.ts` en esta etapa.

## Herramientas deterministas y alertas (Fase 6.1)

`src/tools/contratos.ts` exporta exactamente los cinco objetos obligatorios.
Cada objeto tiene `description`, `args` (campos Zod con descripción) y
`execute(args, ctx): Promise<string>`. El nombre público se forma como indica
el PRD: archivo `contratos` + nombre exportado. No se necesita servidor.

| Nombre público / export | Argumentos y Zod | Resultado y responsabilidad | Reutilización / reglas |
|---|---|---|---|
| `contratos_leer_buzon` / `leer_buzon` | `{}` estricto | `{ mensajes[] }`, excluye procesados, incluye `tiene_contrato`, clasificación y problemas por mensaje | `readMailbox`, `evaluateRegistration`, procesados; HU-1, RN4 |
| `contratos_extraer` / `extraer` | `{ mensaje_id }`, ID seguro | Extracción original con confianza y evidencia; cotización sigue identificada como tal | `inspectMessageInput`, `extractContract`; HU-2 |
| `contratos_validar` / `validar` | `{ mensaje_id, contrato }`, `extractionSchema` | Clasificación, diferencias, revisión y `contrato` como ticket íntegro para registrar | `evaluateRegistration`, `validateContract`; RN1–RN5 |
| `contratos_registrar` / `registrar` | `{ mensaje_id, contrato, confirmado? }`, `registrationTicketSchema` y booleano opcional | Acción realmente aplicada, pendiente o sin escritura contractual | `persistRegistration`, `persistConfirmedRegistration`; RN1–RN7 y Fase 5.2 |
| `contratos_alertas` / `alertas` | `{ hoy }`, `dateSchema` | `{ ruta, vencen, vencidos, polizas_pendientes, registrados_desde_corte, obligaciones_pendientes, ... }` y `out/alertas.md` | Maestro de salida e historial; HU-5 |

Los lectores, la extracción, RN1–RN5 y la persistencia no se reimplementan en
las herramientas. Los nuevos adaptadores de `persistence.ts` comparten su cola
local, recuperación y comprobaciones: consultar una instantánea, leer entradas,
auditar llamadas y escribir el informe. La inicialización de out/ sigue RN6;
las llamadas de lectura también generan auditoría, pero no registran contratos.

### Entradas y salidas

El nombre `contrato` de la firma del PRD representa dos estados sucesivos:
en `validar` recibe la extracción de `extraer`; en `registrar` recibe el ticket
devuelto por `validar`. El ticket conserva versión del maestro, hash de entradas
y validación, para detectar cambios entre ambas llamadas. No se permite enviar
una propuesta libre directamente a persistencia. Los argumentos de nivel
superior son estrictos; las correcciones siguen el flujo humano de Fase 5.2.

```ts
import { extraer, validar, registrar, alertas } from "./src/tools/contratos.ts";

const ctx = { directory: raizDelProyecto, sessionId: "sesion-local" };
const extraido = JSON.parse(await extraer.execute({ mensaje_id: "msg-001" }, ctx));
if (!extraido.ok) throw new Error(extraido.error);
const evaluado = JSON.parse(await validar.execute({ mensaje_id: "msg-001", contrato: extraido.data }, ctx));
if (!evaluado.ok) throw new Error(evaluado.error);
const resultado = await registrar.execute({ mensaje_id: "msg-001", contrato: evaluado.data.contrato }, ctx);
const informe = await alertas.execute({ hoy: "2026-09-03" }, ctx);
```

Ejemplos de respuestas resumidas (la salida real incluye más campos):

```json
{"ok":true,"data":{"accion":"registrado","estado":"aplicado","id_contrato":"CT-2026-015"}}
{"ok":true,"data":{"accion":"pendiente_revision","estado":"requiere_revision","aplicado":false,"requiere_revision":["valor","moneda","fecha_inicio","fecha_fin","requiere_poliza","objeto"]}}
{"ok":false,"error":"confirmado=true no concede autorización humana; falta solicitud aprobada."}
```

Un pendiente es una evaluación completada sin escritura contractual. Los
duplicados, rechazos y reintentos terminados se distinguen con su acción y
estado `sin_escritura_contractual`; no se anuncian como altas nuevas.
Los argumentos inválidos, archivos ilegibles y autorizaciones inválidas devuelven
`ok:false`. `execute` captura errores para que el consumidor pueda continuar.

### Autorización y auditoría

Se conserva `confirmado?: boolean` en la firma obligatoria. Para true, el
consumidor local debe proporcionar además `ctx.autorizacion = { solicitud_id,
datos_hash, revisor }`, obtenida mediante revisión y decisión explícita de Fase 5.2.
Ese contexto no forma parte de los argumentos de la herramienta y no debe ser
controlado por un futuro modelo. Las herramientas no crean ni aprueban solicitudes.
La identidad sigue simulada y no equivale a autenticación.

Antes de ejecutar se compara el ticket con la solicitud almacenada; persistencia
revalida fuentes, maestro, correcciones, elegibilidad, datos finales, caducidad
y consumo único. Un true aislado, una elegibilidad editada, un hash distinto o
una solicitud reutilizada no autorizan. Para datos originalmente completos se
mantiene el registro normal sin confirmación, conforme a HU-4.

Todas las llamadas dejan RN7 en log.jsonl con nombre público, mensaje, sesión,
resultado y timestamp. La auditoría detallada del registro y de la autorización
se conserva además mediante los módulos existentes. Si no se puede escribir
el log, la respuesta añade `error_auditoria`. Una escritura contractual ya
aplicada no se presenta como fallida por un error posterior al auditar la llamada.
Un contexto inválido puede impedir disponer de un destino confiable de auditoría;
se informa ese fallo expresamente, sin escribir en otra ruta.

### Reglas exactas de alertas

- `hoy` es obligatorio. Los cálculos usan días de calendario UTC, sin consultar
  el reloj actual. Vence hoy corresponde a 0 días; próximos son 0–60 inclusive.
  Los negativos aparecen separados en `vencidos`, sin mezclarse con los próximos.
- Póliza pendiente significa `requiere_poliza=true` y `estado_poliza!=vigente`:
  incluye pendiente, vencida y una posible incoherencia no_aplica. Se muestra el
  estado recibido, sin crear estados ni deducir expiraciones de póliza desde
  la fecha final contractual; el maestro no contiene su fecha de vencimiento.
- El corte del PRD es inclusivo: `fecha_registro >= 2026-05-30`. El reporte es
  a la fecha `hoy`, así que registros con fecha posterior se advierten y no se
  cuentan todavía como gap cubierto. Un otrosí conserva la fecha original y no
  se cuenta como alta nueva solo por tener historial reciente.
- Las obligaciones `AMPLIAR_GARANTIAS` se recuperan de operaciones aplicadas en
  historial, sin nombres de contratos codificados en la regla. Así se mantiene
  visible la de CT-2026-011 aunque su estado histórico sea vigente. No existe
  todavía una operación para certificar su cumplimiento: la alerta conserva
  expresamente el carácter pendiente según la evidencia disponible.
- El Markdown contiene las tres secciones de HU-5, con subsecciones para
  vencidos y ampliaciones. Las tablas ordenan los resultados y conservan las
  evidencias; el maestro no se modifica. Una nueva generación reemplaza solo
  `out/alertas.md` mediante escritura recuperable, comprobando la versión del
  maestro y del historial. Datos inválidos bloquean el informe sin borrar uno previo.

### Muestra local y siguiente fase

```powershell
bun run herramientas
```

El comando crea un proyecto temporal con copia de fixtures, lista el buzón,
aplica únicamente el otrosí msg-003, demuestra el bloqueo de msg-006 y genera
alertas para 2026-09-03. Imprime la ruta absoluta del informe. No borra ni cambia
el out/ operativo. El resultado esperado es dos contratos próximos a vencer,
dos vencidos, una póliza obligatoria no vigente, ninguna alta desde el corte y
la ampliación pendiente de CT-2026-011.

Las pruebas usan copias temporales y cubren las cinco herramientas, argumentos,
errores, JSON, idempotencia, revisión, autorizaciones inválidas y reutilizadas,
límites 0/60/61 días, bisiestos, integridad y reporte repetible.

Las pruebas de herramientas, confirmación y persistencia disponen de 30 segundos
por caso mediante `tests/helpers/integration.ts`, por sus operaciones reales de
archivos. La limpieza espera a que termine el
cuerpo, incluso si Bun lo declaró agotado: el timeout no cancela sus promesas.
Así no se borran temporales mientras una transacción sigue escribiendo o
recuperándose. Una operación que supera el límite continúa siendo una prueba
fallida; no se silencian los errores de persistencia. El hook de limpieza tiene
un límite independiente de 60 segundos.

Límites: sigue siendo almacenamiento local con un proceso escritor; no hay
autenticación real, LLM ni frontend. Solo se interpretan adjuntos TXT. Varios
TXT requieren aclaración; no se elige uno arbitrariamente. Los mensajes con
errores se reportan por separado y no detienen el inventario completo.
Las alertas son un informe, no notificaciones enviadas a terceros.

La Fase 6.2 utiliza estas mismas herramientas mediante `demo.ts`, como se
detalla a continuación. No se incorpora todavía el ciclo conversacional.

## Demo integral determinista (Fase 6.2)

```powershell
bun run typecheck
bun test
bun run demo
```

El script llama directamente a los cinco métodos `execute`. Comprueba con Zod
los sobres JSON y los resultados; un error de herramienta o de auditoría queda
como fallo y no se presenta como éxito. Los errores de un mensaje no impiden
intentar los restantes. Las reglas de extracción, clasificación, registro y
alertas continúan en sus módulos existentes. Los IDs de los fixtures solo se
usan para comprobar expectativas, nunca para decidir las reglas aplicadas.

Cada invocación crea `periferia-demo-<sufijo>` dentro del directorio temporal
del sistema y copia allí fixtures. `leer_buzon` inicializa el maestro de ocho
filas según RN6. El reloj de las herramientas es `2026-09-03T12:00:00.000Z`;
la referencia de alertas es `2026-09-03`. No se utiliza el reloj real para decidir
registros ni vencimientos. El script no elimina ni reinicia el out/ del proyecto.
Se conservan los resultados temporales para poder abrirlos durante la defensa;
la consola informa su ruta. Las pruebas limpian únicamente sus propios temporales.

### Casos y segunda pasada

| Mensaje | Clasificación inicial esperada | Primera acción | Segunda acción |
|---|---|---|---|
| msg-001 | nuevo | registrado, póliza pendiente | ya_procesado |
| msg-002 | nuevo | registrado, no_aplica y exención con origen correo | ya_procesado |
| msg-003 | actualizacion | actualizado: valor y fecha_fin | ya_procesado |
| msg-004 | duplicado | sin modificación contractual | ya_procesado |
| msg-005 | rechazado | sin registro contractual | ya_procesado |
| msg-006 | nuevo | pendiente_revision | pendiente_revision |

La consola muestra por mensaje clasificación, estado de validación, acción y
motivos de revisión o rechazo. Las aserciones comparan la primera clasificación
y las acciones con esta tabla. En la segunda pasada msg-001 y msg-002 se
clasifican actualmente como duplicados porque ya están en el maestro; la
persistencia reconoce su mensaje original y responde `ya_procesado`.

El resumen debe mostrar **8 → 10 → 10** filas, dos altas, una actualización,
dos operaciones iniciales sin modificación y un pendiente. El historial tiene
exactamente tres operaciones y no crece en la segunda pasada. Se comparan
maestro, historial y documentos archivados byte a byte entre pasadas. Los logs
operativos sí crecen: auditar un reintento no duplica una operación contractual.

Se verifica que CT-2026-011 termine con `valor=520000`, `moneda=PEN` y
`fecha_fin=2027-11-01`, conservando todos sus demás campos y el resto de filas
originales. Los tres documentos archivados se comparan con los bytes originales
de sus adjuntos, incluido el otrosí en su ruta adicional. La exención de
msg-002 mantiene origen correo y texto de respaldo en historial.

### Revisión humana y alcance de la confirmación

Msg-006 conserva valor indeterminado, moneda y fechas pendientes, obligación
condicional y objeto completo. No se aportan aclaraciones ficticias. Después
de ambas pasadas se muestra una llamada con `confirmado:true` y sin autorización
humana: debe devolver error y conservar intactos maestro e historial. Esto
muestra la llamada pedida por PRD 6.6 y el bloqueo seguro aprobado en Fase 5.2;
no constituye una confirmación válida ni registra CM-2026-03.

El registro con revisión aprobada permanece demostrado mediante los casos
sintéticos de `bun run revision` y sus pruebas. Para registrar el msg-006 real
siguen siendo necesarias aclaraciones completas y una solicitud aprobada que
autorice esos valores concretos.

### Alertas esperadas después de procesar este escenario

| Grupo | Resultado a 2026-09-03 |
|---|---|
| Próximos vencimientos | CT-2026-009: 27 días; CT-2026-004: 42 días |
| Ya vencidos | CT-2025-018 y CT-2026-002 |
| Pólizas obligatorias no vigentes | CT-2026-004 y el nuevo CT-2026-015 |
| Altas desde el corte inclusivo 2026-05-30 | CT-2026-015 y CT-2026-016 |
| Ampliación pendiente | CT-2026-011, sin interpretar vigente como evidencia de ampliación |

El informe `out/alertas.md` está dentro del proyecto temporal; la consola muestra
su ruta absoluta. Los conteos difieren de `bun run herramientas`, cuya muestra
solo aplica el otrosí. La demo verifica las listas por ID, los días restantes,
las tres secciones Markdown y la conservación de maestro e historial.

### Aserciones, reproducibilidad y límites

Un fallo de aserción produce resultado global `FALLIDO` y código de salida 1;
errores de preparación o lectura también terminan con código 1. Las aserciones
incluyen integridad por SHA-256 de PRD, AGENTS, fixtures y out/ operativo, y de
la copia temporal de fixtures. Un resultado correcto devuelve código 0.

Las pruebas de integración ejecutan la CLI dos veces desde cero y comparan la
salida normalizada y todos los archivos de out/ byte a byte. También cambian
un importe únicamente en una copia de prueba: el proceso sigue intentando los
seis mensajes, pero detecta la diferencia y devuelve código 1. Las rutas
temporales cambian entre ejecuciones; el reloj, resultados y archivos finales
son reproducibles. No se necesitan resultados de ejecuciones anteriores.

Esta etapa no añade dependencias ni modifica firmas o reglas existentes.
Antes de integrar el agente siguen pendientes el enlace entre una respuesta
humana y su solicitud desde una sesión confiable, el control de iteraciones y
errores del proveedor y la presentación visible de herramientas y revisiones.
Se mantienen los límites del escritor local único y de la identidad simulada.
No se avanza a esas funcionalidades sin aprobación.

## Motor conversacional sin proveedor real (Fase 7.1)

```powershell
bun run typecheck
bun test
bun run agente:mock
```

El comando crea un directorio temporal propio, copia fixtures y muestra una
conversación de guion fijo. No entiende lenguaje natural ni llama a modelos.
Consulta el buzón, extrae y valida msg-006, termina el turno en revisión y
demuestra que el texto «confirmo» no genera autorización. Comprueba que el
contrato sigue ausente del maestro. Conserva el temporal para inspeccionar
su log; el out/ operativo y demo.ts permanecen intactos.

### Arquitectura y protocolo

`createAgent` recibe un directorio local y un `Provider`, carga el prompt desde
agent/prompt.md y mantiene sus sesiones. El proveedor implementa una única
operación `send(request)`. Recibe mensajes, las cinco definiciones de herramientas,
el presupuesto restante y una señal de aborto. Devuelve una respuesta final
`{ type: "final", text, usage? }` o llamadas `{ type: "tools", calls, usage? }`.
Cada llamada incluye ID, nombre y argumentos como string JSON. `usage` informa
`input_tokens` y `output_tokens` cuando estén disponibles. Zod rechaza formatos
inesperados, respuestas vacías, campos extra e IDs de llamadas repetidos.

El historial distingue sistema, usuario, asistente y resultados de herramienta.
El prompt se añade desde el archivo en cada envío; no puede reemplazarse con
un mensaje de usuario. Los resultados conservan rol tool y su ID de llamada:
documentos y correos se tratan como datos, sin convertirse en instrucciones.
El proveedor recibe copias, no referencias mutables al historial o al registro
de herramientas. El mock tiene un cursor de guion separado para cada sesión.

El ciclo recibe texto, recupera la sesión, consulta al proveedor, comprueba la
respuesta y ejecuta llamadas secuencialmente. El ejecutor admite exclusivamente
los cinco nombres del PRD, usa sus argumentos Zod originales y llama a sus
métodos execute. Incorpora cada resultado al historial y continúa hasta una
respuesta final o un límite. No implementa nuevamente RN1–RN7 ni alertas.

Los eventos locales muestran nombre, argumentos y resultado de cada llamada.
Los rechazos del ejecutor y las llamadas omitidas se auditan con sesión en
log.jsonl, además de la auditoría existente de las herramientas. Una revisión
pendiente termina el turno y emite `review_required` con mensaje y campos.
Si hay más llamadas en ese lote, se devuelven resultados de no ejecución para
conservar los pares de llamada/resultado; esas llamadas no modifican contratos.

Después de usar herramientas, la respuesta factual final se construye a partir
de sus resultados reales. Un texto del proveedor como «registré 99 contratos»
no reemplaza el resultado efectivo de persistencia. Los detalles completos
siguen disponibles en los eventos. En conversación sin herramientas se admite
texto final del proveedor; esta fase no contiene un verificador semántico
general de afirmaciones libres. Para conectar un LLM se deberá mantener el
respaldo verificable de los hechos contractuales, también en preguntas de seguimiento.

### Sesiones y límites

| Control | Valor predeterminado | Alcance |
|---|---|---|
| Iteraciones del proveedor | 10, máximo configurable 25 | Por turno |
| Llamadas a herramientas | 20 | Por turno; un lote que excede se rechaza completo |
| Mensajes | 80, incluido el mensaje de sistema | Contexto acumulado de sesión |
| Tamaño de contexto | 200000 caracteres de la representación JSON | Contexto de sistema e historial; no es una estimación de tokens |
| Tokens informados | 20000 | Acumulados por sesión |
| Espera del proveedor | 15000 ms | Por solicitud; aborta la espera y no ejecuta resultados tardíos |

Se configuran con `limits` al crear el agente. El motor no elimina partes del
historial para ganar espacio. Si un resultado excede el contexto, conserva el
evento local completo, informa el límite al proveedor y detiene el turno. La
respuesta de límite se devuelve aunque no quede espacio para añadirla al
historial. No se permiten turnos ni decisiones simultáneos en la misma sesión.

Cuando falta consumo de tokens, `usageComplete=false`: el contador solo suma
lo informado, nunca supone que un valor desconocido sea consumo cero. Los
límites de herramientas e iteraciones siguen vigentes. Se comunica el máximo
restante al proveedor y se bloquean herramientas si informa agotar el presupuesto;
no se puede impedir retroactivamente un gasto ya producido por un proveedor.
El adaptador real deberá aplicar su límite de generación y sus políticas de costo.

Las sesiones viven en memoria, sin autenticación ni almacenamiento duradero.
Reiniciar el proceso pierde historial, tickets y vínculos de sesión; las
solicitudes locales de Fase 5.2 no se importan automáticamente a otra sesión.
No se implementan todavía TTL ni límite de cantidad de sesiones. El contexto
del proveedor sí está acotado, pero los eventos completos pueden ocupar más
memoria; el uso está limitado aquí a los archivos pequeños de los fixtures.

### Canal humano y seguridad de escritura

El directorio, reloj, permisos de registro e identidad humana pertenecen al
consumidor local de confianza. No forman parte de los argumentos del proveedor.
`send(sessionId, texto)` consulta por defecto. Para habilitar registros en ese
turno, el controlador local debe pasar `{ allowRegistration: true }`; ese
permiso no equivale a aprobar campos pendientes. También exige un ticket
obtenido mediante validar en esa misma sesión, idéntico al recibido.

El proveedor no dispone de herramientas para crear o aprobar solicitudes.
El controlador externo usa métodos separados:

```ts
const solicitud = await agent.prepareReview(sessionId, {
  mensaje_id, correcciones, revisor: { id: "analista-simulado", modo: "simulado_local" }
});
// Si es válida, presentar solicitud.data.values a la persona y esperar su decisión.
const decision = await agent.decideReview(sessionId, {
  solicitud_id, datos_hash, accion: "aprobar", // o "rechazar"
  revisor: { id: "analista-simulado", modo: "simulado_local" }
});
// Una aprobación no registra automáticamente. La ejecución es un paso posterior.
await agent.send(sessionId, "Ejecuta la operación autorizada", { allowRegistration: true });
```

Estas son funciones locales, no endpoints ni mensajes especiales del chat.
PrepareReview recibe aclaraciones expresas y reutiliza createConfirmation;
decideReview reutiliza decideConfirmation. El vínculo privado relaciona sesión,
ticket, solicitud, hash de valores y revisor. Una sesión distinta, un hash o
revisor incorrectos, una decisión repetida o una solicitud usada se bloquean.
Si falla solo el evento adicional de auditoría de sesión, se informa mediante
`error_auditoria`, sin negar que la solicitud o decisión ya se aplicó.

Solo un vínculo aprobado permite inyectar la autorización al contexto de
contratos_registrar. El proveedor nunca recibe esa capacidad como argumento.
Persistencia vuelve a verificar fuentes, maestro, valores, vigencia y consumo
único. Un mensaje «confirmo», un argumento confirmado=true o datos documentales
maliciosos no crean una aprobación. Se mantiene el registro normal de datos
completos sin revisión cuando el controlador habilita el turno.

La identidad continúa siendo simulada. El futuro servidor debe autenticar o
controlar el origen de estos comandos; exponerlos directamente al modelo o
confiar en un ID de sesión público eliminaría esa separación. El adaptador de
proveedor es código local de confianza; no se pretende aislar código JavaScript
arbitrario que se ejecute dentro del mismo proceso.

### Prompt, errores y pruebas

El prompt completo está en agent/prompt.md: rol administrativo, cuándo usar
cada herramienta, prohibición de inventar valores, incertidumbre y evidencias,
revisión obligatoria, canal humano separado, datos no confiables y comunicación
profesional en español. La lista de herramientas, contratos, permisos, límites
y verificaciones de autorización también se aplican en código.

Las pruebas cubren conversaciones, continuidad y aislamiento, cadenas de
extracción/validación/registro, alertas, errores JSON/Zod, herramientas inexistentes,
respuestas inesperadas, timeout, tokens, límites, IDs duplicados e instrucciones
maliciosas en documentos. Los flujos sintéticos de aprobación y rechazo prueban
la vinculación de sesión, la escritura autorizada única y la conservación del
bloqueo cuando cambia el maestro. No se inventan respuestas oficiales para msg-006.

Se devuelven errores controlados sin trazas del proveedor ni rutas internas.
Un fallo de herramienta puede corregirse dentro del mismo turno y sus límites;
una revisión o fallo de auditoría detiene las llamadas restantes.

Para Fase 7.2 queda elegir e implementar un adaptador real de Provider, convertir
el protocolo a su API, validar formatos y consumo y definir cómo fundamentar
las respuestas libres con datos de herramientas. Será necesario conservar la
separación del canal humano y controlar el acceso a sesiones antes de exponer
una API. Esta fase no instala SDK, no llama a un LLM, no crea frontend ni despliega.
