# 02 — Analyst: decisión sobre Agent Router frente a ODD

**Fecha:** 2026-10-09 (America/Denver). **Objeto:** upstream `nidhi-singh02/agent-router` en `fb24d06a62fb33a92c7836b4920ae9f4b1216c63`. **Procedencia de esta evaluación:** análisis de fuentes locales y de `01-scout.md` / `03-verifier.md`; binding de este analista observado: **GPT-6-Sol medium**, no GPT-5.6-Terra xhigh como decía el brief. El verifier se identifica en su propio artefacto como **GLM-5.3 (OpenCode)**. No infiero calidad de modelo a partir de un rol solicitado. Los links `source:Lx` son líneas del commit fijado, no pruebas de comportamiento live.

## Dictamen ejecutivo

**Recomendación firme: diferir la adopción o integración de Agent Router en ODD y conservar la delegación actual; usar este repositorio sólo como referencia de ideas puntuales, sin extracción ahora.** Confianza **alta** para *no adoptar el runtime hoy*; **media** para el valor potencial de una futura utilidad pura de cuota/catálogo, porque no hay medición comparativa en la flota real. Esto no equivale a «el proyecto no sirve»: para un equipo ya comprometido con TypeSafe, Herdr y cuotas compartidas, sus políticas de reserva y trazabilidad podrían tener valor. Para ODD, hoy añade un paso bloqueante externo, una superficie de operación y una semántica de fases distinta de la autorización del usuario, sin demostrar reducción de errores de selección.

**Falsaría esta recomendación:** una prueba posterior, autorizada y aislada, que muestre con tareas representativas que el router mejora decisiones *harness + modelo + esfuerzo* respecto del operador/ODD vigente, preserva read-only/inline y permisos, y tiene disponibilidad, privacidad, latencia y coste aceptados explícitamente. Ni 519 tests unitarios ni un dry-run sin key prueban ese resultado. No propongo ejecutar esa prueba ni instalar nada en esta fase.

## Límites de evidencia y correcciones de procedencia

1. Scout `01-scout.md` dice «hasta tres llamadas HTTP POST consecutivas para cada ruteo»; la fuente permite **hasta tres** `systemOne`, no tres en cada run: `no-candidates`/unsafe abortan antes, fallo o `ask-user` cortan el flujo, y ruta sticky retorna después de la primera clasificación (`packages/router/src/semantic/decision-engine.ts:65-211`). El número real de requests por tarea y su latencia quedan sin medir live.
2. En cuota personal, `projectedRemainingRatio: 1` es **sólo la rama `projected === undefined`**; cuando hay proyección calculable se devuelve la proyección redondeada. Sí se omiten las exclusiones por stale/zero/reserve en personal (`packages/router/src/policy/eligibility.ts:35-64`). Así, «personal puede seguir elegible con cuota agotada» es correcto; «toda cuenta personal se proyecta 100%» no.
3. El marcador Scout **`Local (200)` no es HTTP 200**; significa archivo local leído. Los documentos de este informe son evidencia de checkout, no una comprobación HTTP independiente. `config/models.json` es catálogo **operator-curated**, no prueba de disponibilidad, autenticación, cuota ni acceso a un modelo; `03-verifier.md` C04.
4. Verifier: **519 tests pasaron en 63 suites cargadas, y una suite adicional falló al cargar** (`coordinator/test/worker-entry.test.ts`, dependencia fantasma `better-sqlite3`). No describir como «suite completa verde» ni como 519/520 assertions: la suite no llegó a correr. La instalación de verificación usó pnpm en sandbox, con drift de siete dependencias dev respecto de `package-lock.json`; los cuatro pins runtime citados coincidieron. Por ello los resultados no son un baseline exacto de `npm ci` ni prueban «stack pnpm de la flota». `03-verifier.md` C04/C09.
5. Verifier C07 encontró que el filtro pre-egress bloqueó 11/11 patrones sintéticos y que **`redactCollectorText` sólo cubre `sk-*`**, dejando 10/11 patrones sin redacción *si llegasen a persistencia*. Eso **no demuestra que los 10 secretos bloqueados se guardaran en SQLite**: el camino de `run` puede terminar antes del guardado. Sí identifica dos políticas distintas y una exposición condicionada en otros caminos de persistencia (`packages/router/src/collectors/normalizer.ts:3-5`; `packages/router/src/semantic/typesafe-client.ts:29-47`; `packages/router/src/commands/run.ts` guardado de sesión posterior al lanzamiento). Cuatro de cinco frases benignas sintéticas fueron rechazadas: riesgo de fricción observado en esa batería, no tasa poblacional.

## Seis perspectivas, con tensión y confianza

| Perspectiva | Juicio basado en evidencia | Lo no demostrado |
|---|---|---|
| Staff engineer / adaptabilidad | **Alta:** acoplamiento `executeRun → decideRoute → TypeSafe` es material: `run.ts:329-375` rechaza `typesafe-unavailable` aunque el motor calcula un fallback (`decision-engine.ts:91-109`). Separar una función pequeña es conceptualmente posible, pero no prueba que integrarla sea útil. | Precisión del ranker/effort con prompts reales, estabilidad futura del SDK. |
| Operador de delegación | **Alta:** no sustituye ODD: ODD decide alcance/autorización; Router decide candidato y lanza. Handoff abre pane nuevo sin transcript salvo ruta in-place estrecha; `README.md:281-305`, `handoff/handoff-builder.ts`, `live-effort/in-place.ts`. La continuidad de contexto sigue siendo trabajo del operador. | Ahorro neto de tiempo/elecciones en trabajo diario. |
| SRE y seguridad | **Alta:** hay defensas concretas (revalidación de elegibilidad, reserva, worktree fail-closed, guard de pane/diálogos), pero TUI y statusline son interfaces frágiles; `run.ts:378-441`, `live-effort/switcher.ts`, verifier C05/C06. Un cambio de versión del CLI puede degradar live effort. | Comportamiento frente a incidentes reales, coordinator desplegado, recuperación operacional. |
| Privacidad y coste externo | **Alta para flujo, baja para importe real:** texto de tarea sale a TypeSafe incluso con `--dry-run`; `decision-engine.ts` envía `task`, `run.ts` decide antes de `dryRun`. Guard regex no elimina toda narrativa sensible; el escaneo de redacción es parcial. Precio citado en Scout procede de docs TypeSafe visitadas por Scout, pero no lo revalidé aquí ni equivale a factura medida. | Retención, tratamiento contractual, tokens por ruta, coste mensual y egress efectivo con datos de producción. |
| Developer/end-user friction | **Alta:** sin key, dry-run da exit 2 (verifier C02); con key, configuración, cuotas y consentimiento siguen siendo trabajo previo. `--dry-run` crea DB vacía y en éxito sin worktree puede reservar/liberar; no es «sin efectos» (verifier C05). | Si la UI de decisión compensa la fricción para un operador concreto. |
| Maintainer / madurez | **Media:** README declara prerelease, versión 0.1.0 y catálogo curado; una dependencia fantasma aparece bajo resolución estricta. Son señales de cautela, no prueba de abandono ni de inseguridad. | Cadencia futura, compatibilidad con versiones vigentes de Herdr/CLIs, SLA de soporte. |

## Claims del producto contra implementación

| Claim / mecanismo | Lectura comprobable y consecuencia |
|---|---|
| «Local-first» y TypeSafe | Config, snapshots y SQLite locales, pero decisión semántica requiere TypeSafe SaaS; sin key/offline el fallback se calcula pero `run.ts:364-375` no lo usa. Verifier C02: exit 2 tanto dry-run normal como JSON. Local-first **no** significa offline ni zero-egress. |
| Dry-run | Decide y potencialmente enriquece con `gh` antes de `dryRun`; inicializa SQLite (verifier: 9 tablas, 0 filas en error). En ruta exitosa normal reserva/libera transitoriamente; `--worktree --dry-run` usa `wouldFit` sin escritura de reserva (`run.ts:404-430`). No lanza agente; no afirmar «sin side effects». |
| Cuota personal/compartida | Personal omite bloqueo stale, zero y reserve; proyección 1 sólo si unknown. Shared requiere dato fresco y floor mínimo 40% según config; `eligibility.ts`, `config/config-schema.ts`, verifier C03. Colección/refresh dependen de statuslines o comando; no auto-instala scripts ni garantiza medición oficial. |
| Status cache / colectores | Los statusline caches son entradas externas, pueden faltar o estar caducadas; los comandos CLI de auth/status no equivalen a métricas verificadas de cuota (`collectors/*`, `docs/provider-support.md`). Distinguir `unknown` de «hay capacidad». |
| Catálogo/effort | 11 entradas curadas y flags construidos por `launch/agent-command.ts`; no certifica que `model_id` esté disponible para cuenta actual ni que effort sea aceptado. Live-effort opt-in; parser TUI ligado a formas/versiones y el tope `max`/`ultra` depende del literal «ultra» en tarea (`live-effort/levels.ts:51-53`). |
| Worktree / handoff | Worktree es opt-in y tiene validación previa; un handoff nuevo es prompt estructurado, no traslado de conversación; `workspace/git-worktree.ts`, `handoff/handoff-builder.ts`, README. Continuidad in-place exige misma cuenta/modelo y condiciones de pane (`live-effort/in-place.ts`). |
| Secretos / almacenamiento / salida | `assertSafeState` rechaza patrones reconocidos antes del request a TypeSafe, con falsos positivos; `redactCollectorText` sólo `sk-*`. La tarea de una sesión lanzada se guarda en DB local y el texto de clasificación/ranking/effort viaja a TypeSafe. Coordinator opcional usa fingerprint/HMAC, no texto íntegro de tarea (`semantic/typesafe-client.ts`, `run.ts`, `coordinator/src`, `docs/privacy.md`). No afirmar filtración de secretos sintéticos rechazados. |

## Función por función: ¿extraer algo ahora?

**Regla de decisión:** «extraíble» no implica «conviene extraer». No hay benchmark de exactitud o ahorro real; los impactos abajo son inferencias cualitativas.

| Función | Solape con ODD / coste operativo | Juicio |
|---|---|---|
| Elegibilidad determinista | No duplicada por ODD, pero depende de identidad/cuenta/cuota confiable; personal no protege agotamiento. | **No extraer ahora**; idea útil sólo con fuente real de cuota y política de cuentas. |
| Proyección/reserva de cuota | Aporta shared floor y exclusión de actividad, pero añade snapshots, TTL, estado SQLite y posible coordinator. | **No extraer ahora**; ganancia incierta sin cuentas compartidas/medición. |
| Catálogo de modelos | ODD no cataloga modelos; el catálogo del repo es estimado/curado, puede quedar obsoleto. | **No copiar catálogo**; el mantenimiento/validación vale más que el JSON. |
| Ranker de esfuerzo | ODD decide proporcionalidad de proceso, no effort de modelo; TypeSafe decide effort remoto y «ultra» literal condiciona techo. | **No integrar**; exactitud no medida y podría forzar esfuerzo incorrecto. |
| `buildAgentCommand` | Podría centralizar argv, pero CLIs y flags cambian y existen rutas operativas actuales. | **Referencia**, no wrapper nuevo por anticipación. |
| Lanzador Herdr | Repite transporte/orquestación ya usada; añade dependencia de estado de pane y readiness. | **No reemplazar** la ruta directa establecida. |
| Continuidad de pane | Mejora potencial del contexto sólo en caso same-account/model y TUI compatible; falla cerrado/abre pane. | **No activar** sin prueba de continuidad end-to-end. |
| TypeSafe/Jev | Núcleo diferencial pero externaliza juicio y texto; sin key no hay ruta útil. ODD ya tiene clasificador consultivo con fallback local y overlay de autorización. | **No duplicar ni integrar**; son contratos distintos. |
| Cloudflare coordinator | Resuelve concurrencia de cuentas compartidas, trae despliegue/estado remoto. | **No desplegar** sin necesidad probada y permiso. |
| Hermes heartbeat | Metadatos de actividad/fingerprint para coordinator; no mejora clasificación ODD por sí solo. | **No instalar**. |

## Compatibilidad con ODD vigente

Fuente ODD actual: `~/.hermes/skills/odd-protocol/SKILL.md` v1.6.0 y `scripts/odd-classify.py`; los tests `tests/test_odd_classify.py` prueban read-only, tags iniciales, negación de wargame y fallback local. **ODD es advisory de alcance**, no policy de permisos ni router de modelo. Su clasificador puede llamar a un shim HTTP según host, pero conserva heurística local y overlay de restricciones explícitas. El Router no ofrece ese mismo contrato.

| Recorrido ODD exigible | Resultado al poner Router delante sin adaptación |
|---|---|
| Consulta read-only / explicación | Router presupone seleccionar y quizá lanzar agente; no representa «no escribir/no spawn» como autorización nativa. Riesgo de ampliar alcance. |
| Trivial inline / small cerrado | Coste de TypeSafe + DB + catálogo + Herdr para una operación que ODD mantiene inline o con un Executor. Probable sobreproceso, no ahorro demostrado. |
| Delegated-direct | El Router podría escoger agente/effort, pero no debe inventar planificación, reviewer ni fases por número de archivos. Handoff nuevo pierde transcript. |
| Research / wargame negado | Familia `research` existe; ausencia de regla ODD para negación/tags/permiso. No hay prueba live de que preserve «sin wargame». Verifier C08: siete briefs terminan exit 2 sin key; no se midió exactitud con key. |
| Review de modelo independiente | Router optimiza un candidato; no acredita independencia entre Architect y Reviewer ni reemplaza juicio de riesgo. |
| Privado/no-cloud | Incompatible si el texto no puede salir a TypeSafe; `--dry-run` no resuelve esto. El shim local de ODD tampoco es permiso general para egress externo. |
| Flags autoapprove, callbacks, quota reset | Argv curado no prueba compatibilidad actual; callback de Herdr ya falló en este assessment y no debe reintentarse. Reset requiere snapshot fresco; no extrapolar estado de suscripción de presencia del modelo. |
| Tests/build/comandos normales | ODD rechaza `odd-guard` global y whitelists por conteo/archivo; un router no debe convertirse en gate de cada shell/test. Mantener permisos nativos separados de selección de modelo. |

## Alternativas completas, contradicciones y rival fuerte

| Opción | Valor | Coste / riesgo | Decisión |
|---|---|---|---|
| Adoptar runtime entero | Una sola CLI para elegibilidad, selección, launcher, sesiones y worktrees. | Key externa bloqueante; egress de tarea; cuota de calidad desigual; DB/coordinator opcional; mantenimiento TUI y nuevas rutas de error. | **No** para ODD hoy. |
| Adaptación mínima conceptual | Consumir sólo una señal acotada de cuota/effort tras autorización ODD, sin que Router decida permisos ni metodología. | Aun exige fuente de cuota confiable, semántica de fallback, ownership y evaluación; coste de integración **estimación amplia: días a semanas**, no benchmark. | **Diferir**; no contrato implementable aún. |
| Extraer feature pura | Elegibilidad o formateo argv, sin TypeSafe/Herdr. | Copia/fork que mantener, tests y datos externos; posible duplicación prematura. | **No extraer ahora**. |
| Usarlo sin modificar ODD | Operador invoca Router voluntariamente para rutas no sensibles y compara decisión; evita acoplamiento a ODD. | Mejor rival: obtiene información con menor irreversibilidad, pero sin key ni datos reales no ofrece decisión y puede provocar egress incluso en dry-run. | **Rival fuerte, sólo si Dimar acepta explícitamente key/egress**; no activarlo aquí. |
| No adoptarlo y continuar ODD + delegación directa | Sin dependencia nueva; conserva proceso mínimo y permiso/alcance separados. | Selección manual de harness/model/effort; posible oportunidad perdida en cuentas compartidas. | **Elegida** hasta evidencia incremental contraria. |

**Contradicciones que no deben «promediarse»:** (a) «local-first» describe almacenamiento, no inferencia offline; (b) «quota-aware» se comporta distinto para personal y shared; (c) dry-run evita launch pero no toda escritura/red; (d) tests verdes de módulos no prueban catálogo accesible, exactitud semántica ni compatibilidad live. La defensa más fuerte del Router es la política determinista y revalidación alrededor de una decisión probabilística; la objeción más fuerte es que la decisión central depende de un tercero sin fallback operativo, justo donde ODD necesita continuidad y fricción baja.

## Inputs que faltan antes de cambiar dirección

Decisiones reservadas a Dimar, **no microaprobaciones ahora**: ¿existe necesidad real de coordinar cuentas compartidas y qué cuota confiable está disponible? ¿Se permite que texto de tareas potencialmente privadas salga a TypeSafe, bajo qué contrato? ¿Qué benchmark de rutas reales y coste de errores justificaría reemplazar selección actual? ¿Qué CLIs/versiones/flags operan efectivamente en cada nodo? ¿Cuál es el límite de latencia/coste aceptable y quién mantiene el catálogo? ¿La prioridad es reducir decisiones erróneas o sólo automatizar un paso? Sin esas respuestas, un contrato de integración sería especulación.

**Pendientes técnicos, sin acción en este assessment:** prueba TypeSafe live con consentimientos y datos sintéticos; estudio de precisión/latencia contra baseline ODD/delegación; revisión de retención/egress; compatibilidad de TUI y callbacks en entorno real; análisis de persistencia de secretos por caminos alcanzables; baseline `npm ci` exacto si alguna vez se requiere. El verifier probó lo descrito en `03-verifier.md`, no lo pendiente. No se implementó, instaló, llamó TypeSafe live, desplegó ni modificó ODD.

## Receipt

Artefacto durable: `research/assessment/02-analyst.md`. El callback al orquestador falló en canary; **no se reintenta Herdr**. Este archivo y la línea de cierre son la entrega.
