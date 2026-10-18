# Agent Router + ODD + SystemOne — evaluación reconsiderada

**Fecha:** 2026-10-09 · **Reemplaza el dictamen** de `2026-10-09-agent-router-odd-assessment.md` (que queda como evidencia histórica).
**Insumos:** `04-reconsideration-analyst.md`, `05-systemone-contract.md` y las correcciones editoriales posteriores a la revisión del verifier. Sin investigación nueva, código, config, keys ni instalaciones.

---

## 1. Recomendación

**Adoptar la costura, no el runtime.** Agent Router entra como *selector* de harness/modelo/effort **después** de que ODD autorizó delegar, y habla con SystemOne mediante el puerto `TypeSafePort` que ya existe. SystemOne conserva la key y la inferencia (Jev hoy, modelo local después, detrás de la misma interfaz).

Lo que se aprovecha de Agent Router es poco y concreto: el `decision-engine.ts` (clasificación → ranking → effort), aislado tras `TypeSafePort`, y la validación local `assertSafeState` antes de enviar nada. Lo demás —collectors, SQLite, reservas, cuotas, coordinator, lanzadores Herdr, guards de pane, catálogo— **no es requisito** y no se extrae.

Confianza: **alta** en la forma de la costura; **media** en que Jev responda bien a los tres payloads (no se ha probado, ver §5).

## 2. Errores de mi evaluación anterior

1. **Evalué el escenario equivocado:** el runtime completo compitiendo con ODD. No hay competencia: ODD decide alcance, proporción y permiso; Router sólo elige *cómo* lanzar lo ya autorizado.
2. **Olvidé la key:** traté la key de TypeSafe como algo que debía llegar al Router. SystemOne ya la administra (premisa de Dimar; el dispatcher la lee dentro del servicio, `direct_dispatch.py:50-63,453-484`). El Router no debe leerla ni transportarla.
3. **Exageré las cuotas:** las elevé a condición de adopción. Para esta costura son secundarias.

Retiro la recomendación de «diferir»: evaluó el escenario equivocado y omitió el servicio que ya tenemos para esta integración.

## 3. Flujo de tres capas

```
ODD            ¿se delega? ¿cuánto proceso? ¿qué está permitido?   (sin cambios)
  │ sí, delegar
  ▼
Agent Router   familia/fase/scores → ranking de candidatos → effort  (decision-engine, intacto)
  │ TypeSafePort.systemOne({state, questions}) → {answers}
  ▼
SystemOne      única key, único backend: Jev cloud hoy → local después
```

Si SystemOne no responde o la respuesta no valida, se descarta la recomendación y **la delegación normal ya elegida por ODD sigue**. Sin bloqueo de comandos, sin `odd_guard`, sin nuevo gate.

## 4. Intervención mínima

| Quién | Qué | Qué no cambia |
|---|---|---|
| **SystemOne** | Un handler tipado dentro del servicio existente: recibe `state` + `questions`, llama al backend, devuelve respuestas nombradas. Nombre de ruta: *propuesto*, no actual. | Sin microservicio nuevo, sin pool, sin cambio global de backend. |
| **Agent Router** | Un cliente que implemente `TypeSafePort` contra SystemOne y sustituya el factory que hoy crea `TypeSafeClient` con key local (`typesafe-client.ts:25-27`; `runtime.ts:190-197`). | `decision-engine.ts`, scorers y classifiers intactos. |
| **Contrato** | Validar respuestas: pregunta ausente, `choice` fuera del conjunto dado, score fuera de escala, confidence/probabilidades no finitas o con IDs ajenos → rechazar. | Sin segunda política, sin recalificar la tarea. |
| **ODD** | Punto de integración que consume la recomendación como consejo. | Clasificación, tickets, guards y permisos. |

Las tres consultas son las que el motor ya hace: clasificación (6 preguntas: `family`, `phase`, `complexity`, `creativity`, `consequence`, `cacheValue`), ranking (`route` sobre `opaqueId` elegibles) y effort (limitado a los soportados y a la regla de top tier) — `decision-engine.ts:73-101,140-167,198-224`.

## 5. Hechos, premisas e inferencias (separados)

**Hechos de fuente / servicio** (verifier 05, evidencia en `reconsideration-evidence/`):
- `GET /health` → 200: `{"status":"ok","model":"needle3","tools":16,"pool_size":1}`. El servicio está vivo.
- OpenAPI de `systemone-router 4.0.0`: no existe `/v1/systemone`. El frontdoor es `POST /v1/chat/completions`.
- El SDK (typesafe-sdk-js v0.6.0) hace `POST {baseURL}/v1/systemone` con `{state, questions, model}` y espera `answers` tipados. El Router consume ese contrato.
- Las 16 tools (`classify`, `route`, `score`, `structured_decision`…) son equivalentes *semánticos* de las consultas, con **otro contrato** (args de tool-call, no `questions` tipadas).
- El frontdoor ignora `tools` del cliente y sólo pasa `{text}` al dispatcher (`main.py:809-821,985-1010`; `direct_dispatch.py:370-376`).

**Probes de contexto libre** (no candidatos tipados — sólo prueban la frontera de formato):
- **Probe 1** (classify): HTTP 200, pero clasificó contra categorías fijas del gateway (`billing/technical/urgent`) ignorando las del caller. Salida = texto verbalizado con JSON embebido.
- **Probe 2** (route): HTTP 200 con `needle_meta.success=false` y contenido sin estructura.
- **Probe 3** (`POST /v1/systemone`): HTTP 404 exacto `{"detail":"Not Found"}`. Fue un POST a ruta no listada (desviación declarada, sin efectos).

Estos probes **no** prueban que Jev falle con payloads tipados, ni que el adaptador ya exista. Sólo muestran que el frontdoor actual no transporta el contrato. `model=jev` en la respuesta es eco del request y HTTP 200 no equivale a éxito semántico; la procedencia upstream Jev cloud queda **inferida**, no verificada. Un fallo de contrato **no** significa "Jev caído" ni "key mala" sin evidencia.

**Premisa de usuario (no verificada, no cuestionada):** SystemOne ya tiene la key Jev. No se leyó ni registró ningún secreto.

**Inferencia de factibilidad (mía):** que un handler tipado resuelva el gap con cambios acotados. Es diseño mínimo a partir de contratos citados, no una prueba.

## 6. Correcciones al verifier y a mis propias lecturas

- **Fallback del Router:** `decision-engine` *calcula* un fallback determinista cuando `systemOne` lanza, pero `executeRun` **lo ignora**; no es un fallback operativo hoy. La continuidad manual debe ser **requisito de la integración**, no algo que ya se tenga.
- **`baseURL` configurable no basta:** el runtime exige la key (`keychain:model-router-typesafe` o `env:TYPESAFE_API_KEY`) y sin ella usa `unavailableTypeSafe()`. Hay que resolver **factory/cliente además del endpoint**, o el puerto quedará deshabilitado aunque el gateway responda.
- **Gap SDK ↔ frontdoor:** `{state, questions} → answers` frente a chat-completions con tools fijas es un ajuste **acotado**, no motivo para descartar. Se resuelve con factory + cliente adaptador y el handler tipado; no hace falta servicio nuevo ni rediseño.
- Opción alternativa del verifier (adaptar `questions` a tool-calls del frontdoor): descartada. El frontdoor pierde argumentos y categorías del caller (probe 1) y obligaría a raspar `content`/`_meta`.

## 7. Jev ahora, local después

- **Ahora:** Jev detrás de SystemOne **sigue siendo cloud**: `direct_dispatch.py:453-475` envía `state` a `api.typesafe.ai`. Lo que mejora es que la key no se copia al Router ni a los panes. **No** es privacidad total ni zero-egress.
- **Después:** un backend local se cambia detrás del mismo handler, sin tocar Router ni ODD. SystemOne ya documenta backends locales; en esta pasada no se probó su paridad con las tres consultas tipadas. No se instalaron modelos ni se cambió el backend o la política de privacidad.

## 8. Límites reales

- El endpoint tipado **no existe**; su forma exacta es propuesta.
- No se sabe si Jev/local responden bien a los tres payloads: no hay prueba de calidad semántica ni se pide benchmark para decidir esta costura.
- Cuotas, reservas, coordinator, lanzamiento Herdr y guards de pane no se evaluaron aquí y no condicionan la integración.
- Latencia y comportamiento bajo carga: sin medir.
- Aspectos de Router citados de la revisión (p. ej. `executeRun` ignora el fallback) no se re-verificaron en esta pasada.

## 9. Siguientes pasos (pendientes de aprobación)

1. **Aprobación única de Dimar** para implementar la fase mínima: handler tipado en SystemOne + cliente `TypeSafePort` + sustitución del factory en Router + continuidad manual real cuando falle la selección. Si Dimar ya pidió el patch, este paso se da por autorizado.
2. **Prueba de cierre del contrato, proporcional:** tres payloads sintéticos (clasificación, ranking, effort) de punta a punta; comprobar HTTP, `ok`, backend, respuestas nombradas y pertenencia de cada elección. No es un benchmark ni toca tráfico real.
3. Sólo entonces, y con evidencia, evaluar Jev → local detrás del mismo handler.

**Fuera de alcance:** runtime completo, ingeniería de cuotas, extracción de coordinator, cambios en ODD, instalaciones, claves y publicaciones.
