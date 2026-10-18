# 04 — Reconsideración analítica: TypeSafePort mediante SystemOne

**Fecha:** 2026-10-09 (America/Denver) · **Rol:** Analyst · **Binding efectivo revalidado al trabajar:** **Terra xhigh** (header de la sesión actual; no se deriva del rol ni del artefacto histórico).  
**Alcance:** evaluación read-only de la costura Agent Router → SystemOne. No se modificó código, configuración, servicios, claves, ODD ni la infraestructura.

## Dictamen

**Recomiendo una sola ruta: un adaptador estrecho de `TypeSafePort` que hable con un *typed passthrough* nuevo y mínimo dentro de SystemOne, el único lugar que conserva la key de Jev.** El adaptador conserva el contrato `systemOne(request) -> SystemOneResult<Q>` de Agent Router y deja intacto `decision-engine.ts`; SystemOne recibe el `state` y las `questions` tipadas, llama al backend configurado y devuelve el resultado tipado. Empezar con Jev detrás de ese gateway no añade otra key ni otro servicio. Si después se adopta un backend local, se cambia detrás de la misma costura, no en Agent Router ni en ODD.

No recomiendo traducir las tres consultas a los `tools` OpenAI actuales ni adoptar el runtime completo. El frontdoor existente no es un passthrough de `SystemOneRequest`: ignora `tools` suministrados (`systemone-router/main.py:809-821`), extrae únicamente el texto del último mensaje de usuario (`main.py:985-998`) y entrega al dispatcher sólo `{text}` (`main.py:1001-1010`). El `classify` genérico necesita además `candidates` y `question` (`direct_dispatch.py:370-376`); por tanto, cambiar sólo una URL produciría un fallo de contrato, no una integración.

La recomendación es firme sobre la **forma de la costura**, no sobre afirmar que el endpoint ya existe: hoy sólo está documentado/observado `POST /v1/chat/completions`; el handler typed es el parche acotado que debe especificarse y verificarse. No se inventa una ruta ni se llama a `/v1/systemone` en esta evaluación.

## Qué cambió respecto del assessment anterior

El informe `02-analyst.md` era correcto para sus premisas, pero sus conclusiones de adopción amplia no aplican a la corrección de Dimar:

| Premisa anterior que resultó errónea para esta decisión | Corrección y consecuencia |
|---|---|
| Se evaluó Agent Router como posible runtime que reemplazaría u ordenaría ODD. | ODD sigue decidiendo alcance, permiso y proporción. Router sólo asesora **harness/model/effort después** de que ODD ya eligió delegar. No hay competencia de runtimes. |
| La key de TypeSafe se trató como un requisito que debía llegar al Router/pane. | SystemOne ya guarda la key de Jev por confirmación de Dimar. La fuente además muestra que el dispatcher lee la key dentro del servicio y llama a Jev desde ahí (`direct_dispatch.py:50-63,453-484`). El Router no debe leerla ni transportarla. |
| Cuotas, coordinator, reservas y catálogo se elevaron a condición de adopción. | Son datos secundarios para esta ruta. La primera costura no instala coordinación, almacenamiento ni ingeniería de cuotas. |
| “Gateway” podía sugerir privacidad o inferencia local inmediata. | Jev detrás de SystemOne sigue siendo cloud: `direct_dispatch.py:453-475` envía `state` a `api.typesafe.ai`. La privacidad mejora al no copiar la key al Router, **no** equivale a zero-egress. Un backend local posterior podrá cambiar esa propiedad detrás del gateway, pero no existe hoy por este hecho. |

## Diferencia contractual que importa

| Dimensión | SDK TypeSafe que usa Agent Router | Frontdoor OpenAI actual de SystemOne | Implicación de la ruta recomendada |
|---|---|---|---|
| Entrada | `TypeSafePort.systemOne<const Q>(SystemOneRequest<Q>)` preserva `state` y mapa de `questions` (`typesafe-client.ts:8-11`). | `POST /v1/chat/completions`, con `tool_choice` para herramientas fijas (`INTEGRATION.md:86-98`). | El nuevo handler debe aceptar el contrato tipado; no serializarlo como prompt. |
| Preguntas genéricas | `choice` conserva criterios y `score` la escala declarada. | Las definiciones `tools` del cliente se ignoran y el parser pierde argumentos genéricos (`main.py:811-821,985-998`). | No usar `classify`/`score`/`route` de la superficie actual como emulación. |
| Salida | `SystemOneResult<Q>` con respuestas nombradas que consume el motor. | Chat completion con `tool_calls` y extensión `_meta.systemone_router.result` (`main.py:1021-1055`). | El passthrough devuelve respuestas tipadas; el adaptador no debe raspar `content`, `tool_calls` ni `_meta`. |
| Backend | Router antes construía `TypeSafeClient` con una key local (`typesafe-client.ts:25-27`; `runtime.ts:190-197`). | SystemOne resuelve Jev dentro del servicio (`direct_dispatch.py:453-484`). | Mover la dependencia de key al gateway, sin exportarla a panes ni a configuración de Agent Router. |

Las herramientas nativas anunciadas por SystemOne son útiles como evidencia de capacidad, no como contrato sustituible: `structured_decision` acepta un estado y fields (`tools.py:363-380`), `classify` usa `categories` (`tools.py:591-604`), `score` usa criterios (`tools.py:682-694`) y `route` usa rutas (`tools.py:753-763`). Sus formas y su semántica de consenso no son `SystemOneRequest<Q>` ni la respuesta que espera Agent Router.

## Costura mínima: tres consultas, un puerto conservado

`decision-engine.ts` ya concentra toda la inteligencia de selección detrás de `TypeSafePort`; no se debe reescribir ni trasladar a ODD.

1. **Clasificación:** una solicitud tipada con `state={task,candidateCount,enrichment?}` y seis preguntas: `family`, `phase`, `complexity`, `creativity`, `consequence`, `cacheValue` (`decision-engine.ts:73-101`). Las familias y fases son los conjuntos ya declarados (`task-classifier.ts:3-16`, `phase-classifier.ts:3-16`); las cuatro escalas proceden de sus preguntas existentes (`task-scorer.ts:3-20`, `cache-assessor.ts:3-10`).
2. **Ranking:** una solicitud tipada con estado derivado y una pregunta `route`; sus únicos candidatos válidos son los `opaqueId` ya elegibles, con capacidad, effort permitido y ratio proyectado (`decision-engine.ts:140-167`, `route-ranker.ts:4-17`).
3. **Effort:** una solicitud tipada con la familia/fase/scores ya recibidos y una pregunta `effort`, limitada a los efforts soportados y a la regla de top tier existente (`decision-engine.ts:198-224`, `effort-selector.ts:5-10`).

El adaptador sólo traduce transporte y valida resultado. Debe mantener `assertSafeState` —el puerto actual lo aplica antes de cualquier llamada (`typesafe-client.ts:13-22`)— y rechazar respuestas con cualquiera de estos defectos antes de alcanzar el motor: respuesta ausente para una pregunta solicitada; `choice` fuera del conjunto de familia/fase/candidatos/efforts provisto; score que no corresponda a su escala declarada; `confidence` o probabilidades no finitas/fuera de rango; o probabilidades referidas a IDs no proporcionados. La validación es limitada y determinista: no recalifica la tarea ni crea una segunda política.

La comprobación de contrato debe ser exactamente la del verifier: tres payloads sintéticos representando esos tres pasos, con revisión de HTTP, `ok`, backend, respuestas y pertenencia de cada elección. No es un benchmark, no toca tráfico real y no demuestra por sí sola calidad semántica. `05-systemone-contract.md` debe decidir si el frontdoor actual produce el gap exacto o si existe un camino compatible; no se debe falsificar compatibilidad mediante un prompt o un endpoint supuesto.

## Propiedad, cambios y exclusiones

| Cambio propuesto para una fase autorizada | Dueño | No se extrae / no cambia |
|---|---|---|
| Un handler de passthrough tipado dentro del **SystemOne existente**, con la key y selección Jev/local encapsuladas. | SystemOne | No microservicio, pool nuevo, feedback loop, reset, coordinator ni cambio global de backend. |
| Un `SystemOneGatewayClient` que implementa el `TypeSafePort` existente y una sustitución puntual del factory de runtime que hoy crea `TypeSafeClient`. | Agent Router | No refactor de `decision-engine.ts`, no nuevo framework de routing ni nueva API de producto. |
| Adaptación de los tres payloads y validación acotada de respuestas. | Contrato compartido Router/SystemOne; verificación independiente | No prompt-engineering, benchmark general, dataset de evaluación ni “traductor” OpenAI de herramientas genéricas. |
| Al no obtener una respuesta válida o al no estar disponible SystemOne: descartar la recomendación y continuar la delegación manual normal ya elegida por ODD. | Punto de integración de ODD | No hard gate, ticket de ODD, cambio de clasificación, bloqueo de comandos ni reintento/coordinador de cuotas. |
| Una evolución futura Jev → local detrás de la misma interfaz, sólo cuando se demuestre y autorice. | SystemOne | No declarar hoy zero-egress, no instalar modelo local ni cambiar la política de privacidad. |

## Valor incremental y límite de decisión

El valor incremental real no es “hacer ODD inteligente”: es reutilizar, **después de la decisión ODD**, la composición existente de familia/fase/scores, ranking de candidatos y selección de effort. La interfaz está explícitamente desacoplada (`TypeSafePort`, `decision-engine.ts:19-53`) y el fallback de ese motor ya comunica indisponibilidad (`decision-engine.ts:102-109,168-175,213-220`). Eso permite que el gateway sea asesor y que el camino manual siga disponible.

No se deben extraer del Router sus collectors, SQLite, reservas, cuotas personales/compartidas, coordinator, lanzadores Herdr, worktrees, guards de pane ni catálogo como precondición de esta costura. Tampoco se debe reutilizar `classify_routing_brief` para decidir ODD: ése es dominio de ODD y ya fue decidido antes de que esta selección exista.

**Resultado:** proceder, si se autoriza una fase posterior, con el *typed passthrough* de SystemOne + adaptador `TypeSafePort` y nada más. El único bloqueo técnico actual es contractual y acotado; el verifier lo documenta con tres payloads. La disponibilidad del gateway no debe detener ni reclasificar una delegación: sólo elimina esta recomendación auxiliar y se usa la elección manual existente.

## Evidencia y límites

- Confirmación de que SystemOne ya tiene la key Jev: premisa humana de Dimar; no se leyó, solicitó ni registró ningún secreto.
- Salud `needle3/tools16/pool1`: observación heredada del brief; este analyst no ejecutó llamadas HTTP para no duplicar al verifier.
- La inferencia sobre la forma del handler typed es de diseño mínimo a partir de los contratos fuente citados; no afirma que el endpoint exista ni que Jev/local produzcan respuestas correctas para los tres payloads.
- No se evaluaron cuotas, modelos/hardware ajenos, otros nodos, instalaciones, tests masivos ni adopción de runtime.
