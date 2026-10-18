# Agent Router frente a ODD — assessment inicial (recomendación en reconsideración)

> Corrección de alcance de Dimar: SystemOne ya tiene la key Jev y debe ser el único gateway para Agent Router, primero Jev y después modelo local; cuotas no son bloqueo de esta integración. La recomendación de diferir de este documento evaluó el runtime completo y omitió esa costura. Se conserva como evidencia histórica; no usar su dictamen como vigente hasta la reconsideración en 04/05 y el informe revisado. Los hechos de código/pruebas conservan sus límites originales.

**Fecha:** 2026-10-09 · **Objeto:** `nidhi-singh02/agent-router` en el commit fijado [`fb24d06`](https://github.com/nidhi-singh02/agent-router/commit/fb24d06a62fb33a92c7836b4920ae9f4b1216c63) (Merge PR #37, *live-effort-switch*; el checkout local coincide, `git rev-parse HEAD` leído al redactar).
**Naturaleza:** investigación solamente. No se implementó, desplegó ni se llamó a TypeSafe, y no hubo instalación, configuración ni integración *live* (ni en el sistema, ni en ODD, Hermes o SystemOne). Distinción: el Verifier sí instaló dependencias, pero sólo en una copia sandbox aislada (§3). Este documento no es una aprobación de adopción ni de integración.
**Insumos:** `01-scout.md`, `02-analyst.md`, `03-verifier.md` y `TRACKING.md`, leídos completos. Donde se contradicen, se indica cuál prevalece y por qué. Releí en el checkout sólo los pasajes de código que sostienen los hallazgos centrales (marcados «releído» en §9); no ejecuté pruebas.

**Bindings de rol observados** (declarados por cada artefacto, no inferidos): Scout Gemini 3.8 Flash High · Analyst GPT-6-Sol medium (el brief pedía GPT-5.6-Terra xhigh) · Verifier GLM-5.3-Flash (el brief pedía GLM-5.3 max) · Redactor Sonnet medium. La calidad de cada análisis se juzga por su evidencia, no por el modelo asignado.

---

## 1. Recomendación y resumen ejecutivo

**Recomendación única: diferir. No adoptar Agent Router en ODD ahora, no integrarlo y no extraer piezas de él todavía. Conservar ODD más la delegación directa actual.** El fork `wiseconnex/agent-router` y el clon local existen desde antes de este assessment; no cuentan como aceptación y no requieren ninguna acción derivada de este informe.

Confianza **alta** en «no adoptar el runtime hoy»; **media** en que una utilidad pura de cuota/catálogo pudiera valer algo más adelante, porque nadie midió nada comparativo en la flota real.

**Para qué sí sirve el proyecto.** Para un operador que ya usa Herdr con varias suscripciones de agentes (Cursor, Claude Code, Codex, OpenCode), comparte cuentas entre personas y acepta delegar la clasificación de tareas a un servicio externo. En ese caso ofrece algo real: una política determinista de reserva (piso del 40 % en cuentas compartidas), reservas transitorias de capacidad, guards cuidadosos antes de teclear en un pane y un rechazo local de credenciales antes de la red.

**Para qué no sirve hoy en ODD.**
- ODD decide *cuánto proceso* merece una tarea y qué está autorizado; Router decide *qué agente, modelo y esfuerzo* lanzar. Son contratos distintos, y Router no trae una noción nativa de «solo lectura», «sin wargame» ni «sin spawn».
- Su valor diferencial (clasificar, ordenar rutas, elegir esfuerzo) es una llamada remota a un servicio de pago en prerelease. Eso es una decisión de producto legítima, pero para ODD añade dependencia externa, salida del texto de la tarea y latencia sin que exista una sola medición de que mejore la selección actual.
- Lo que sí es verificable y reutilizable (política de cuota) depende de una fuente de cuota confiable; si existe una hoy en esta máquina es **desconocido**, porque no se inspeccionaron caches reales de statusline.

**Estado de la investigación.** Completa en lo estático y en lo ejecutable sin credenciales; vacía en lo que decidiría una adopción: exactitud del ranking, latencia, coste real, comportamiento con TUIs vigentes y lanzamiento real en Herdr. Nada de eso se midió (§7).

---

## 2. Qué hace de verdad y qué no

### Qué es
Una CLI de Node/TypeScript (`router`, v0.1.0, MIT, `private: true`, README declara *pre-release*) que, dada una tarea en texto, filtra candidatos de un catálogo de 11 perfiles de modelo en 4 agentes, pide a TypeSafe System One que clasifique la tarea, ordene las rutas elegibles y proponga un nivel de esfuerzo, y lanza el agente elegido en un pane de Herdr con un handoff formateado. Opcionalmente cambia el esfuerzo de Opus 5.5 y de GPT-6 Astra en caliente, usa worktrees y coordina cuentas compartidas mediante un Worker de Cloudflare.

### Qué no es
- **No es una política de seguridad ni un guard.** No sustituye a `odd-guard` ni a los permisos nativos de cada CLI. Lo único que inyecta en el handoff es una instrucción textual («Do not deploy or publish anything without asking the user»), que es una petición al agente, no una barrera.
- **No es una metodología.** No decide proporcionalidad de proceso, ni reviewer, ni fases por criterio ODD.
- **No es un daemon.** Es una invocación síncrona; la cuota se refresca a mano (`router usage refresh`) o la deja una statusline del usuario.

### README frente a código probado

| Afirmación del README | Lo que el código muestra | Cómo se sabe |
|---|---|---|
| «Local-first»: config, snapshots, decisiones e historial quedan en tu máquina | Cierto para el almacenamiento (SQLite 0600 en directorio 0700). Falso si se lee como «funciona sin red»: el texto de la tarea viaja a TypeSafe para cada decisión | Fuente + `docs/privacy.md` (que lo dice con honestidad) |
| «Quota-aware» | Estricto en cuentas **compartidas** (dato fresco, piso 40 %, actividad). En cuentas **personales** no excluye por dato caducado, cuota agotada ni piso de reserva | Fuente releída + 7 tests de elegibilidad ejecutados por el Verifier |
| Dry-run | No lanza el agente, pero decide antes (hay llamada a TypeSafe), puede invocar `gh` para enriquecer, crea la DB vacía y, sin `--worktree`, reserva y libera capacidad de forma transitoria | Fuente releída + ejecución del Verifier (C05) |
| Catálogo de modelos y esfuerzos | 11 perfiles *curados por el operador*; el propio JSON dice que no afirma que un modelo esté disponible hoy | `config/models.json`, Verifier C04 |
| Handoff entre fases | Un prompt formateado en un pane nuevo; no viaja el transcript. La única continuidad real es el cambio de esfuerzo in-place, y sólo con misma cuenta y mismo modelo | README:281-305, `handoff-builder.ts`, `in-place.ts` |

### Los cuatro puntos finos

**TypeSafe y «local-first».** Para clasificar y rankear, Router llama a TypeSafe **hasta tres veces por tarea** (clasificación, rerank, esfuerzo). *Corrección al Scout*: no son tres en cada ejecución; un `no-candidates`, un estado inseguro, un fallo, un `ask-user` o una ruta *sticky* cortan antes (`decision-engine.ts:65-211`, según Analyst). El número real de llamadas por tarea y su latencia no se midieron. Además, el motor *sí calcula* un `deterministicFallback`, pero `run.ts:364-375` (releído) sale con código 2 ante cualquier estado distinto de `selected`, de modo que el fallback no se usa. Sin key o sin red, el comando termina con exit 2 (Verifier C02: ejecutado con y sin `--json`; con `--json` se pierde el hint de la key).

**Sobre la ausencia de API key.** No la trato como defecto por sí misma. Un router cuyo núcleo es un clasificador remoto necesita credencial, igual que un cliente de cualquier API de pago. Lo que sí cuenta como trade-off de flujo es la combinación: (a) la clasificación es 100 % remota, sin heurística local de reserva; (b) el fallo es exit 2 en lugar de degradar a una elección manual; (c) el mismo egress ocurre en dry-run. El Verifier probó sin key *por diseño del brief*, así que lo que vio es el camino de fallo, no el camino feliz.

**Cuotas.** En cuenta personal, el código (releído):
- no excluye por snapshot caducado, cuota en cero ni piso de reserva;
- si no hay proyección calculable, devuelve elegible con `projectedRemainingRatio: 1`;
- si hay proyección, devuelve la proyección redondeada.

*Corrección al Scout*: «toda cuenta personal se proyecta al 100 %» es incorrecto; el 1 es sólo la rama «sin dato». Lo correcto: **una cuenta personal agotada puede seguir siendo elegible**. La cuota no se calcula de forma nativa: depende de archivos de statusline (`~/.cursor`, `~/.claude`, `~/.codex`, con TTL de 15 min según Scout) que debe producir el usuario. Los colectores por CLI (`agent status`, `claude auth status`, `codex login status`) no equivalen a métricas de cuota verificadas; el parser de Claude contiene un fixture con fecha fija (Scout, sin re-ejecutar). `unknown` no significa «hay capacidad».

**Catálogo, esfuerzo y techo.** Los niveles `max`/`ultra` sólo se ofrecen si la tarea *raíz* contiene la palabra «ultra» (`levels.ts:51-53`, releído; las tareas continuadas heredan el permiso). El cambio de esfuerzo en caliente funciona sólo para Opus y Astra, con mecanismos distintos por CLI (`switcher.ts:246-305` y `382-435`, releídos):
- **Claude Code:** teclea sólo `/effort` **sin nivel** (el comentario del código explica que `/effort <nivel>` guardaría el nivel como predeterminado para toda sesión nueva), pulsa Enter únicamente si la caja contiene exactamente `/effort`, espera a que se abra el slider, lo lleva con flechas izquierda/derecha al nivel y aplica con `s`, que vale sólo para la sesión.
- **Codex:** no usa `/effort`; envía `Alt+.` / `Alt+,` para subir o bajar un nivel sin guardarlo, verifica el nivel leyendo la barra de estado y, si hay turno en curso, encola la continuación con Tab.

Los parsers son fail-closed y están fijados a versiones concretas de Claude Code (2.1.283) y codex-cli (0.156.1) según el Verifier. Una actualización de esas CLIs **puede** invalidar los parsers o la continuación in-place y forzar el camino de «pane nuevo»; no se probó que eso ocurra siempre ni que sea silencioso.

---

## 3. Calidad y madurez

| Dimensión | Estado | Evidencia |
|---|---|---|
| Licencia | MIT, © 2026 Nidhi Singh | Verifier C01 |
| Edad y mantenimiento | Repo creado 2026-09-17, último push 2026-09-27, autoría principalmente unipersonal; 112 estrellas, 13 forks, 2 PRs abiertos | Scout, API de GitHub (no re-consultado) |
| Tamaño | ~7,3 k LOC de fuente en `router/src`, ~10 k de tests; 18,2 k totales en `packages/` | Scout (conteos por comando, no re-ejecutados) |
| Versión | 0.1.0, no publicado en npm, README «pre-release» | Verifier C01 (`router --version` ejecutado) |
| Dependencias runtime | `better-sqlite3` 13.0.3, `@typesafe-ai/sdk` 0.6.0, `commander` 15.0.0, `zod` 4.6.5; las cuatro versiones coinciden con `package-lock.json` | Verifier, Desv. 2 |
| Advisories | 0 en `pnpm audit` sobre el grafo pnpm del sandbox | Verifier C09 |
| Riesgo de instalación nativa | `better-sqlite3`: sin script `install`, prebuilds en el tarball, cargado y probado en darwin-arm64 | Verifier Desv. 3 |
| Seguridad independiente | Ninguna auditoría formal hallada; sólo un escaneo heurístico de terceros con descargo de no-certificación | Scout §9 |

### Pruebas ejecutadas y sus límites

Cifras exactas, sin redondear a verde:
- **519 tests pasaron, 0 fallaron, 0 omitidos, en 63 suites cargadas. Una suite adicional no cargó** (`coordinator/test/worker-entry.test.ts`, 0 tests ejecutados de ella). El runner reporta `success=false`. No debe leerse como «suite completa verde» ni como 519/520.
- **Causa del fallo de carga:** la suite importa `better-sqlite3` sin declararlo en el `package.json` del coordinator (dependencia fantasma). Es un defecto de empaquetado real. Que cargue bajo el hoisting de npm es una **inferencia** del Verifier; no se probó porque npm estaba denegado en el entorno.
- **No es el baseline `npm ci` del upstream.** Se instaló con `pnpm install --ignore-scripts`, resuelto por semver; `pnpm import` falló con la dependencia de workspace. Siete dependencias **de desarrollo** derivaron respecto del lock (eslint 10.10.0→10.12.0, esbuild 0.28.1→0.28.2, chai 6.2.2→6.3.0, acorn 8.18.0→8.19.0, vitest 5.0.1→5.0.3, @types/node 22.20.3→22.20.5, typescript-eslint 8.70→8.71.1). Node 22.23.1 frente a `.nvmrc` = 20 (cumple `engines >=20`).
- **Todo lo que depende de TypeSafe corrió contra mocks** (`createRecordingClient`). Los tests prueban el contrato y la lógica, no la calidad del ranking.
- **No se lanzó ninguna TUI real ni se ejecutó el lanzador Herdr del router** (Herdr sí se usó para coordinar los panes de este research, sin relación con la evidencia del router). La verificación del switcher en vivo es de fuente más tests dedicados.

---

## 4. Comparación con ODD vigente

**ODD** (`odd-protocol/SKILL.md` v1.6.0 y `scripts/odd-classify.py`) es una guía conductual de proporcionalidad: *lo pequeño se queda pequeño*. Su clasificador es consultivo, local (<1 ms) con un shim HTTP opcional y heurística propia de reserva. Fuente: lectura de Scout y Analyst, no re-ejecutada aquí.

**Fricción reciente del guard.** Según el propio protocolo, `odd-guard` se mantiene desactivado y no debe exigirse como sustituto del routing, porque una lista cerrada o un ticket exacto por comando bloquea tests, builds, scripts, parches y coordinación legítimos. Esto condiciona cualquier evaluación: lo que importa es si una pieza ajena **conserva la libertad operativa**, no sólo si niega bypasses. Router, bien usado, no es un gate de comandos; mal integrado podría convertirse en uno.

### Matriz función por función

«Extraíble» no implica «conviene extraer». Los impactos son juicio cualitativo; no hay medición.

| Función de Router | Solapa con ODD | Coste / complejidad | Riesgo | Decisión |
|---|---|---|---|---|
| Elegibilidad determinista | No; ODD no modela cuentas | Necesita identidad de cuenta y cuota fiable | Personal no protege del agotamiento | **No extraer ahora**; idea útil si hay cuentas compartidas |
| Proyección y reserva de cuota | No | Snapshots, TTL, SQLite, quizá coordinator | Estado nuevo que mantener | **No extraer ahora**; ganancia incierta sin medición |
| Catálogo de modelos | No | El JSON es lo barato; validarlo y mantenerlo es lo caro | Envejece; no prueba disponibilidad | **No copiar** |
| Ranker de esfuerzo (TypeSafe) | No: ODD decide proceso, no esfuerzo | Servicio de pago externo | Exactitud no medida; puede forzar esfuerzo incorrecto | **No integrar** |
| Clasificador de tarea (TypeSafe) | **Sí**, parcial: ODD ya clasifica | Duplica un contrato con otra semántica | Familias sin «solo lectura» ni negación (Verifier C08) | **No duplicar** |
| `buildAgentCommand` | Parcial: ODD ya delega por rutas directas | Flags de CLIs cambian | Se queda obsoleto | **Referencia**, no wrapper |
| Lanzador Herdr | **Sí**: la ruta directa ya existe | Estado de pane y readiness | Nuevas rutas de error | **No reemplazar** |
| Cambio de esfuerzo en caliente | No | Acoplado a TUIs de versión exacta | Un autoupdate puede invalidar parsers o la continuación in-place (efecto y visibilidad no probados) | **No activar** sin prueba end-to-end |
| Coordinator (Cloudflare) | No | Despliegue y estado remoto | Superficie nueva | **No desplegar** sin necesidad probada |
| Hermes heartbeat | No | Metadatos para el coordinator | — | **No instalar** |

### Recorridos ODD frente a Router sin adaptación

| Recorrido ODD | Resultado probable |
|---|---|
| Consulta de solo lectura / explicación | Router presupone lanzar un agente; no representa «no escribir, no spawn» → riesgo de ampliar alcance |
| Trivial inline / small cerrado | Coste de red + DB + catálogo + Herdr para algo que ODD resuelve inline → sobreproceso probable |
| Delegated-direct | Podría elegir agente y esfuerzo, pero no debe inventar fases ni reviewer; el handoff pierde transcript |
| Research / wargame negado | La familia `research` existe; no hay negación ni tags. Con 7 consultas ODD el Verifier obtuvo exit 2 (sin key); la calidad con key es desconocida |
| Review de modelo independiente | Router optimiza un candidato; no acredita independencia |
| Privado / sin nube | Incompatible si el texto no puede salir; `--dry-run` no lo resuelve |
| Tests, builds y comandos normales | Un router no debe pasar a ser gate de shell; mantener permisos nativos separados |

---

## 5. Alternativas y recomendación

| Opción | Qué obtiene | Qué cuesta | Veredicto |
|---|---|---|---|
| **A. No adoptar; ODD + delegación directa** | Cero dependencias nuevas; alcance y permisos intactos | Selección manual de harness/modelo/esfuerzo; posible oportunidad perdida en cuentas compartidas | **Elegida** |
| B. Usar el stock, a mano y fuera de ODD | Información sobre las decisiones de Router con baja irreversibilidad | Exige key y egress aceptados; la salida del texto ocurre también en dry-run | **Rival más fuerte** (ver abajo) |
| C. Fork o adaptación ligera | Control del código; podría desacoplar la decisión remota | Mantener un fork de un proyecto de semanas; reabrir el diseño del fallback; sin contrato implementable aún | Diferir |
| D. Extraer una función pura | Poca superficie | Copia sin benchmark, duplicación prematura | No ahora |
| E. Adopción completa | Una sola CLI de punta a punta | Key bloqueante, egress, TUI frágil, DB, coordinator opcional | No |

**La recomendación es A.** El pedido original de «integrarlo» no equivale a aprobación ahora: Dimar pidió assessment primero, y el assessment no muestra un beneficio demostrado que justifique las nuevas dependencias.

**Mejor argumento contra esta recomendación.** B es barata y reversible: si Dimar acepta una key y datos sintéticos o no sensibles, podría comparar las elecciones de Router con las propias durante unas semanas y decidir con datos. Perder esa información tiene un coste. Sin embargo, B exige justo lo que hoy no está decidido (egress, contrato con el proveedor, retención), así que no puedo recomendarla por defecto; queda como la primera opción si esas decisiones se toman.

**Qué haría una versión «fork o ligera» más sensata.** Si algún día se justifica, la modificación mínima y útil sería usar el `deterministicFallback` que el código ya calcula, de modo que la ausencia de TypeSafe degrade en vez de abortar. Es una observación de diseño, no un plan.

**Nota sobre el argumento del Verifier.** Su contraargumento afirma que la política de cuota, reservas y guards son «~2 k líneas de lógica pura, trivialmente extraíbles». Esa cifra no se midió y «trivialmente» es una opinión; el Analyst, con la misma fuente, concluye que no conviene extraer ahora. Prevalece el Analyst.

---

## 6. Privacidad, coste y dependencias externas

### Qué sale y adónde

| Destino | Qué viaja | Qué no | Opcional |
|---|---|---|---|
| TypeSafe `POST https://api.typesafe.ai/v1/systemone` | Texto íntegro de la tarea; en cambios de esfuerzo, tipo de paso, fallos consecutivos y rangos de archivos y líneas; identificadores opacos de candidatos y ratios de capacidad | Credenciales con prefijo reconocido (se rechazan antes) | No: es el núcleo; ocurre también con `--dry-run` |
| `gh` (enriquecimiento) | Si la tarea menciona `#PR`, owner y repo hacia GitHub; hacia TypeSafe sólo cubetas de tamaño | — | Sí: `--no-enrich` o config |
| Coordinator (Cloudflare) | HMAC-SHA256 del id de cuenta, lease aleatorio, TTL | Texto de tarea, etiquetas, credenciales | Sí; no hay despliegue público hallado |
| SQLite local | Tarea y payload de sesión; permisos 0600/0700 | — | No |

Los dos guards difieren:
- **Antes de salir** (`assertSafeState`): bloqueó 11/11 patrones sintéticos (sk-, github_pat_, ghp_, xoxb-, AKIA, AIza, `password:`, Bearer, PEM, URL con credenciales, token de Telegram). Fail-closed: cualquier texto que contenga esos marcadores literales devuelve exit 2, incluso en prosa legítima. Eso es un **coste de disponibilidad a presupuestar**, no necesariamente un defecto.
- **Antes de guardar** (`redactCollectorText`): sólo reemplaza `sk-[A-Za-z0-9_-]+` (releído).

*Corrección a la lectura inicial.* Que 10 de 11 patrones queden fuera de la redacción de persistencia es **cobertura teórica**, no un leak probado: en el flujo de `run`, una credencial reconocida se bloquea antes de guardar. La exposición real queda limitada a secretos que el guard no reconoce, a texto sensible no secreto (PII, lógica de negocio, código pegado) y a campos de error generados localmente. `docs/privacy.md` ya advierte que la narrativa sensible arbitraria es responsabilidad de quien llama.

*Sobre los «ejemplos benignos» rechazados.* El Analyst cuenta «cuatro de cinco» como fricción; el Verifier aclara que esos cuatro ejemplos **contenían marcadores de credencial literales**. Prevalece el Verifier: es una batería sintética pequeña, no una tasa poblacional de falsos positivos.

### Coste
- TypeSafe publica Jev 1.13 a **$0.042 por millón de tokens de entrada** (Scout, docs del proveedor; no revalidado por Analyst ni por mí). Es un precio de lista, no una factura. No hay tokens por ruta ni coste mensual medido, y no hay benchmark independiente: el «86 % menos tokens» citado en el ecosistema proviene de un post informal sin dataset reproducible (Scout §9).
- El coste operativo (mantener cuota y statuslines, vigilar versiones de TUIs, revisar el catálogo) es mayor y no se cuantificó. Cualquier cifra de horas sería inventada.

### Candidatos, esfuerzos y proveedores: verificado frente a no verificado

| Aspecto | Estado |
|---|---|
| Bindings de los cuatro roles de este assessment | **Observado** en los propios artefactos (arriba) |
| Existencia y contenido de `config/models.json` (11 perfiles, 4 agentes) | **Verificado** (Verifier C04, coherente con README) |
| Que `cursor:grok-4.6`, `openai:gpt-6-astra`, `gpt-5.6-*`, `claude-opus`, etc. estén disponibles hoy con las cuentas de Dimar | **No verificado.** El propio JSON lo desmiente como afirmación |
| Que los flags de lanzamiento sean aceptados por las versiones actuales de las CLIs | **No verificado** (Verifier ejecutó `--help`/`--version` de `router`, no de los agentes) |
| Disponibilidad de cada nivel de esfuerzo por nodo | **No verificado** |
| Estado de cuota de las suscripciones de Dimar | **Desconocido**; no se leyó ni se debe inferir de lo que el modelo recuerde |

Nada de lo anterior debe tomarse de memoria de modelo como hecho.

---

## 7. Contradicciones, perspectivas, lo no medido y disparadores

### Contradicciones resueltas o preservadas

| Tema | Fuentes | Resolución |
|---|---|---|
| ¿«tres llamadas por ruteo»? | Scout: tres por ruteo · Analyst: hasta tres | **Hasta tres.** El Analyst es correcto; número real sin medir |
| ¿Personal siempre al 100 %? | Scout · Analyst | **Sólo si no hay proyección.** Pero sigue sin excluir por agotamiento, caducidad ni piso |
| «Local (200)» | Scout lo lista como estado HTTP | **No es HTTP 200**; es archivo local leído |
| Redacción de persistencia | Scout/Analyst: sólo cubre `sk-*` · Verifier: cobertura teórica, no leak | **Verifier**: función limitada, sin demostración de fuga |
| «Ejemplos benignos» | Analyst: 4 de 5 rechazados · Verifier: contenían marcadores | **Verifier** |
| Baseline de pruebas | Analyst: «519 unit tests» · Verifier: 519 + 1 suite no cargó, `success=false` | **Verifier**: reportar ambos |
| Origen del baseline | — | pnpm con drift dev-only de 7 paquetes; **no** es `npm ci` exacto |
| Fallback de TypeSafe | Scout: «código muerto» · Verifier/Analyst: calculado pero ignorado por `run.ts` | Coinciden; yo uso «calculado y no usado» |
| ¿Diagnóstico de Herdr (`agent_not_ready`)? | Scout §6.2 lo presenta como «causa arquitectónica comprobada en código» | **Sin respaldo en los demás insumos.** El fallo del callback de este assessment no se diagnosticó y no se reintentó. No se usa como evidencia |
| «~2 k líneas triviales de extraer» | Verifier | **No medido**; el Analyst concluye lo contrario |

### Las seis perspectivas, con su tensión

| Perspectiva | Lo respaldado por evidencia | Lo que sigue abierto |
|---|---|---|
| Staff engineer | El acoplamiento `executeRun → decideRoute → TypeSafe` es material, y el fallback existente no se usa | Precisión del ranker; estabilidad del SDK 0.6.0 |
| Operador de delegación | Router no sustituye a ODD; handoff sin transcript | Ahorro neto de tiempo o de errores de selección |
| SRE / seguridad | Revalida elegibilidad antes de lanzar, guards de pane y diálogos, worktree fail-closed. TUI y statusline son interfaces frágiles | Comportamiento en incidentes reales, coordinator desplegado |
| Privacidad / coste | El texto sale a TypeSafe incluso en dry-run; guards parciales | Retención, contrato, importe real |
| Fricción de desarrollador | Requiere key, config y cuotas; el dry-run no es «sin efectos» | Si compensa para este operador |
| Mantenedor / madurez | Prerelease, ~3 semanas, un autor principal, catálogo curado, 1 dependencia fantasma | Cadencia futura, compatibilidad con Herdr y CLIs vigentes |

### Lo que no se midió
Exactitud de clasificación y ranking con TypeSafe real; latencia por ruta; coste mensual; llamadas reales por tarea; comportamiento de la TUI con las versiones vigentes; lanzamiento real en Herdr; colectores contra cuentas reales; coordinator desplegado; puente de navegador (apagado por defecto); calidad de reconocimiento de los 5 casos ODD sin familia directa (C08). **Ningún número de exactitud, latencia o coste en este informe procede de una medición.**

### Disparadores que invalidarían o revertirían la recomendación
1. Una prueba autorizada y aislada muestra, con tareas representativas, que Router mejora la elección de harness + modelo + esfuerzo frente al operador/ODD actual, sin ampliar alcance ni egress no aceptado.
2. Dimar acepta explícitamente el egress a TypeSafe, la key y su contrato, y la latencia/coste son aceptables.
3. Aparecen cuentas compartidas con contención real y una fuente de cuota fiable.
4. Upstream conecta el fallback determinista (o separa la decisión remota del resto).
5. Upstream declara la dependencia fantasma y estabiliza el SDK.

Disparadores que **refuerzan** la recomendación: cambios de TUI que rompan el switcher, cambio de precio o términos de TypeSafe, o hallazgos de privacidad en la retención.

---

## 8. Condiciones mínimas de un eventual piloto opt-in (sin implementar)

Sólo si Dimar decide explorar la opción B o una adaptación futura. Esto no es un plan.

1. **Opt-in explícito y por invocación.** El operador llama a Router a propósito; ODD no lo antepone. ODD sigue decidiendo alcance y autorización.
2. **Datos permitidos.** Sólo texto de tareas que Dimar acepte que salga a un tercero, en un perfil o entorno separado del normal, con key propia de baja exposición.
3. **Sin bloqueo del flujo normal.** Si Router falla, falta la key o la red, el trabajo continúa por la ruta actual. Nada puede quedar entre el operador y sus tests, builds, scripts, parches o coordinación; no se exige ticket exacto, ni lista cerrada, ni conteo de archivos.
4. **Validación positiva, no sólo negativa.** Antes de darlo por útil debe demostrarse que lo legítimo sigue funcionando: tests, builds y scripts normales; una tarea de solo lectura que no lance nada; un trivial que se resuelva inline; un research con «sin wargame»; y continuidad real entre fases (que el agente siguiente reciba lo necesario y no dependa de un plan que el anterior no guardó).
5. **Comparación contra una línea base.** Registrar la elección propia antes de ver la de Router en un conjunto de tareas reales y comparar, con una métrica decidida de antemano. Sólo metadatos y logs; no fabricar latencia ni exactitud.
6. **Reversibilidad total.** Todo se puede apagar sin dejar estado en ODD, Hermes o SystemOne.

### Decisiones pendientes de Dimar antes de implementar nada
- ¿Hay necesidad real de coordinar cuentas compartidas, y qué fuente de cuota fiable existe?
- ¿Puede el texto de las tareas salir a TypeSafe, bajo qué contrato y con qué retención?
- ¿Qué métrica y qué muestra de tareas reales justificarían reemplazar la selección actual?
- ¿Qué CLIs, versiones y flags operan hoy en cada nodo?
- ¿Qué latencia y coste son aceptables, y quién mantiene el catálogo?
- ¿Se quiere reducir decisiones erróneas, o sólo automatizar un paso?
- ¿Qué se hace con el fork y el clon ya creados? (No se tocan aquí.)

---

## 9. Fuentes y tabla de claims

### Fuentes principales (todas en el commit `fb24d06`)
- Repositorio: <https://github.com/nidhi-singh02/agent-router/tree/fb24d06a62fb33a92c7836b4920ae9f4b1216c63>
- README: <https://github.com/nidhi-singh02/agent-router/blob/fb24d06a62fb33a92c7836b4920ae9f4b1216c63/README.md> (líneas 16, 25-28, 160-169, 218-230, 281-305)
- `docs/privacy.md`, `docs/configuration.md`, `docs/operations.md`, `docs/provider-support.md`, `docs/repo-map.md` (misma ruta base)
- `packages/router/src/commands/run.ts` (L325-332, 364-375, 404-412 **releído**; L378-441 según Analyst)
- `packages/router/src/policy/eligibility.ts` L35-64 (**releído**)
- `packages/router/src/collectors/normalizer.ts` L3-5 (**releído**)
- `packages/router/src/live-effort/levels.ts` L51-53 (**releído**), `in-place.ts`, `switcher.ts`
- `packages/router/src/semantic/decision-engine.ts` L65-211, `typesafe-client.ts` L29-47, `fallback.ts` (según Analyst/Scout)
- `packages/router/config/models.json`
- Vendor: `https://docs.typesafe.ai/models.md`, `/api.md`, `/llms.txt` (según Scout; no re-consultados)
- ODD: `~/.hermes/skills/odd-protocol/SKILL.md` v1.6.0, `scripts/odd-classify.py` (según Scout/Analyst)
- Artefactos del assessment: `research/assessment/01-scout.md`, `02-analyst.md`, `03-verifier.md`, `TRACKING.md`; evidencia del Verifier en `research/assessment/verifier-evidence/` (`01-run1-dryrun-exit2.json`, `05-pnpm-audit.json`, `06-tests-summary.txt`) y logs crudos en `~/.hermes/cache/scratch/agent-router/verifier/`

### Claims frente a evidencia

| # | Claim | Estado | Base |
|---|---|---|---|
| 1 | Licencia MIT, v0.1.0, prerelease | **Verificado** | Verifier C01, ejecución de `--version` |
| 2 | Sin key/offline, la CLI sale con exit 2 también en `--dry-run` | **Verificado (runtime)** | Verifier C02; fuente releída |
| 3 | El fallback determinista se calcula y no se usa | **Verificado (fuente)** | `run.ts:364-375` releído |
| 4 | Hasta tres llamadas a TypeSafe por tarea | **Verificado (fuente)**, número real **no medido** | Analyst, `decision-engine.ts` |
| 5 | Cuenta personal agotada puede seguir elegible | **Verificado (fuente + 7 tests)** | `eligibility.ts` releído; Verifier C03 |
| 6 | Shared: dato fresco y piso 40 % por defecto y mínimo | **Verificado (fuente + tests)** | Verifier C03, `config-schema.ts` |
| 7 | 519 tests pasaron; 1 suite no cargó; `success=false` | **Verificado (ejecución)** | Verifier C04, `06-tests-summary.txt` |
| 8 | La suite que no cargó lo hace por una dependencia fantasma | **Verificado** (causa en fuente); que **cargue bajo npm** es **inferido** | Verifier C04/C09 |
| 9 | Pins runtime idénticos al lock; drift de 7 paquetes dev | **Verificado** | Verifier Desv. 2 |
| 10 | 0 advisories | **Verificado**, sobre el grafo pnpm | Verifier C09 |
| 11 | `better-sqlite3` sin compilación nativa en install | **Verificado** | Verifier Desv. 3 |
| 12 | `assertSafeState` bloquea 11/11 patrones sintéticos | **Verificado (runtime)** | Verifier C07 |
| 13 | `redactCollectorText` sólo cubre `sk-*` | **Verificado (fuente)**; fuga real **no demostrada** | `normalizer.ts` releído; Verifier C07 |
| 14 | Dry-run crea la DB (9 tablas, 0 filas) y puede reservar/liberar | **Verificado (runtime + fuente)** | Verifier C05; `run.ts:404-412` releído |
| 15 | Texto de tarea sale a TypeSafe incluso con `--dry-run` | **Verificado (fuente)**; **no probado con red real** | Scout/Analyst; el Verifier no tenía key |
| 16 | `max`/`ultra` requieren «ultra» en la tarea raíz | **Verificado (fuente)** | `levels.ts` releído |
| 17 | Switcher de Claude teclea sólo `/effort` sin nivel (slider + `s`, sólo sesión); el de Codex usa `Alt+.`/`Alt+,`, no `/effort`; ambos fallan cerrado | **Verificado (fuente `switcher.ts:246-305`, `382-435` releída + tests)**; **sin TUI real** | Verifier C06 |
| 18 | Catálogo curado; no certifica disponibilidad | **Verificado** | `models.json`, Verifier C04 |
| 19 | Router no entiende solo-lectura ni negación de wargame | **Inferido** de las familias del clasificador | Verifier C08 (2/7 familias directas) |
| 20 | Calidad de reconocimiento de los 5 casos restantes con key | **No probado** | Verifier C08 |
| 21 | Exactitud, latencia y coste reales | **No probado** | — |
| 22 | Jev 1.13 a $0.042/Mtok | **Citado** del vendor por Scout; no revalidado | Scout §2 |
| 23 | 112 estrellas, 13 forks, 2 PRs, push 2026-09-27 | **Citado** del API por Scout; no revalidado | Scout §2 |
| 24 | «86 % menos tokens» | **No respaldado** (post informal) | Scout §9 |
| 25 | Causa del fallo de callback de Herdr | **No respaldada** | Scout §6.2 sin soporte en otros insumos |
| 26 | ODD descarta guard global y whitelists por ticket | **Citado** del protocolo | Scout/Analyst |
| 27 | Estado de cuotas/suscripciones de Dimar | **Desconocido** | — |

---

*Las únicas escrituras de este trabajo son este archivo. Ningún source, config, skill de ODD, Hermes o SystemOne fue modificado. No se reintentó Herdr.*
