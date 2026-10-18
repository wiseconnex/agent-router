# 05 — Contrato SystemOne ↔ Router (verifier, reconsideración)

Fecha: 2026-10-09 · Rol: Verifier (GLM 5.3 Flash Z.AI) · Request: `ar-reconsideration-verifier`
Alcance: chequeo focal de contrato, READ-ONLY en fuentes; 3 POST sintéticos permitidos y ejecutados. Sin installs, sin suite, sin cambios source/config. Sin lecturas de keys/plist/env/db.

## Veredicto corto

El contrato `TypeSafePort.systemOne()` del Router NO es compatible hoy con SystemOne local: el gateway (systemone-router 4.0.0) no expone `/v1/systemone` (404) y su frontdoor `POST /v1/chat/completions` no transporta ni `state`+`questions` tipadas ni categorías/candidatos del caller. El gap es pequeño y acotado: adapter `TypeSafePort` hacia los tools existentes del gateway, o passthrough tipado mínimo. No requiere reemplazo de ODD ni grand redesign.

## R1 — Health (KNOWN, verificado fresco)

- `GET http://127.0.0.1:8077/health` → **HTTP 200**, 4 ms: `{"status":"ok","model":"needle3","tools":16,"pool_size":1}`. Coincide con lo ya observado en el brief. Evidencia: `reconsideration-evidence/ar-health.json`.

## R2 — Contrato de ambas seams (KNOWN, fuente primaria dual)

**Lado SDK** (typesafe-sdk-js v0.6.0, `src/client.ts` desde GitHub — fuente primaria; no hay node_modules en el repo y no se instalaron):

- `TypeSafeClient.systemOne(request)` → **POST `{baseURL}/v1/systemone`**, body `{state, questions, model}` con `model` default `jev-latest`, header `Authorization: Bearer <key>`.
- `baseURL` es configurable por constructor (`config.baseURL`) → apuntar el SDK al gateway local es posible sin tocar el SDK; lo que falta es el endpoint.
- Resultado: `SystemOneResult` con `answers` tipados (choice/confidence/probabilities; score; noul).

**Lado Router** (source local):

- `packages/router/src/semantic/typesafe-client.ts`: `TypeSafePort { calls; systemOne(SystemOneRequest<Q>): Promise<SystemOneResult<Q>> }`; `createLiveTypeSafeClient(apiKey)` = `new TypeSafeClient({ apiKey })` con baseURL default cloud; `assertSafeState` bloquea patrones sensibles en `state` antes de enviar.
- `semantic/decision-engine.ts`: 3 llamadas `systemOne` — clasificación (family/phase/complexity/creativity/consequence/cacheValue, 6 preguntas), ranking (route con candidates tipados), effort (con supportedEfforts). Fallback determinista si `systemOne` lanza.
- `commands/runtime.ts`: key vía `keychain:model-router-typesafe` o `env:TYPESAFE_API_KEY`; sin key → `unavailableTypeSafe()` (deshabilitado, no crashea). Ninguna key fue leída ni impresa.

**Lado SystemOne local** (OpenAPI live, `systemone-router 4.0.0`):

- Paths: `/health`, `/v1/models`, `/tools`, `/pool`, `/pool/metrics`, `/v1/diagnostics`, `POST /v1/reset-feedback`, `/v1/confidence-threshold`, `/v1/verbalize-models`, `POST /v1/chat/completions`. **No existe `/v1/systemone`.**
- Frontdoor `ChatCompletionRequest` props: `model, messages, temperature, top_p, max_tokens, stream, tools, tool_choice, routing, verbalize, verbalize_model`; requerido sólo `messages`. El campo `routing` es objeto libre **sin documentación** en el schema.
- `/tools` (16): shapes tool-args OpenAI, p. ej. `classify{text, categories:[{name,description}]}`, `route{input, routes:[{name,description}]}`, `score{item, criteria}`, `structured_decision{state, fields}`. Cubren las mismas 3 funciones semánticas que las consultas del decision-engine, pero con **otro contrato** (args de tool-call, no `questions` tipadas del SDK).

**Conclusión R2**: las dos seams no casan. No hay passthrough tipado; la equivalencia es semántica (classify↔family/phase, route↔route, score↔scores), no de contrato.

## R3 — Semántica Jev vía frontdoor (3 POST sintéticos, presupuesto completo)

Registro HTTP y semántica separados. Nota metodológica: `model=jev` en la respuesta es **eco del request**, no prueba de backend; la prueba estructural disponible en la respuesta es `needle_meta.success`; el campo `"backend":"jev-cloud"` aparece sólo **dentro del content verbalizado**, por lo que la procedencia upstream queda INFERIDA, no verificada estructuralmente (no se observó un `_meta.result` estructural en el payload de respuesta).

- **Probe 1 — classify por texto libre**: HTTP 200, 1.15 s. `needle_meta.success=true`, confidence 0.41. Content = preámbulo conversacional + JSON embebido: `{"type":"choice","model":"jev-1.13.0","choice":"technical","confidence":1.0,"probabilities":{"billing":0.0,"technical":1.0,"urgent":0.0},"note":"Jev API (cloud…) ~$0.001/request"}`. **HTTP 200 ≠ decisión útil**: clasificó contra las categorías fijas del gateway (billing/technical/urgent), ignorando las categorías sintéticas inline del prompt (mantenimiento|documentacion|investigacion). Pertenencia del choice al set declarado por el caller: FALLA. Salida = texto verbalizado con JSON embebido, parse frágil.
- **Probe 2 — route por texto libre**: HTTP 200, 0.70 s, pero `needle_meta.success=false`, confidence 0.07, content alucinado sin JSON ni estructura. Route por texto libre a través del frontdoor directo: NO confiable.
- **Probe 3 — `POST /v1/systemone`**: HTTP 404 `{"detail":"Not Found"}`, 3 ms. **Desviación declarada**: fue un POST a un path no listado en el OpenAPI (contrario a la indicación de no usar endpoints no listados); se conserva únicamente como evidencia del 404 exacto que recibiría el SDK con `baseURL` apuntando al gateway. Sin efectos laterales.

Evidencia cruda: `reconsideration-evidence/probe{1,2,3}-headers.txt` y `probe{1,2,3}-response.json`.

**Premisa de usuario conservada**: la key Jev ya existe server-side en SystemOne (conocido de usuario, no re-verificado ni cuestionado). Consistente con la observación: el gateway atendió los POST sin que este proceso proveyera credencial alguna.

## R4 — Fit y veredicto

- **Lo comprobado**: (a) no hay endpoint tipado para el contrato SDK — 404; (b) el frontdoor directo no transporta argumentos/candidatos del caller (probe 1: categorías ignoradas; probe 2: sin salida estructurada); (c) los tools del gateway son semánticamente equivalentes a las 3 consultas del decision-engine; (d) `baseURL` del SDK es configurable, así que un passthrough tipado en el gateway haría el resto funcionar sin tocar el cliente Router.
- **Lo inferido (no probado)**: que la procedencia upstream es Jev cloud (por payload embebido verbalizado + `needle_meta.success` del probe 1); que forzar `tools`+`tool_choice` en el frontdoor produciría salida estructurada fiable (el schema lo acepta, no se probó — presupuesto agotado).
- **Untested explícito**: POST con `tools`+`tool_choice` explícitos; comportamiento del campo `routing`; `n_consensus`; latencia bajo carga; si el frontdoor emite `tool_calls` nativos parseables.
- **Gap → ruta mínima** (no implementada, sólo caracterizada): adapter `TypeSafePort` que traduzca `questions`→args de tool-call contra el frontdoor, **o** passthrough tipado mínimo `/v1/systemone` en el gateway. Ambas reutilizan lo existente; ninguna justifica reemplazar ODD ni redesign. Fallback determinista actual del Router cubre indisponibilidad del servicio sin hard-gate.

## Desviaciones y límites respetados

- Desviación: probe 3 a path no listado (arriba, declarada, sin efectos).
- Respetados: sin installs, sin suite, sin reset-feedback, sin cambios source/config, sin lecturas de secretos, sin explorar otros proyectos/nodos, payloads sintéticos inocuos (nada de datasets de eval ni requests reales de usuario).
