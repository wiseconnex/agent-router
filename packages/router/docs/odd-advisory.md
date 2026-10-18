# ODD advisory (`router advise`)

`router advise` is a **post-delegation** recommendation entry point. The Hermes orchestrator runs ODD classification first, decides whether to delegate, then writes a machine request file and invokes:

```bash
router advise --request /path/to/advisory-request.json
```

The command returns JSON with a harness/model/effort recommendation or a safe fallback. It does **not** launch agents, read router config accounts, open the session database, or call quota collectors.

## Request file

| Field | Meaning |
| --- | --- |
| `delegationDecided` | Must be `true` before any inference runs. `false` → `status: "skipped"`. |
| `task` | Task text for the semantic engine (already scoped by ODD). |
| `candidates` | Closed set supplied by the orchestrator (`opaqueId`, `agent`, `modelId`, `launchName`, `supportedEfforts`, `capabilities`, optional `projectedRemainingRatio`). |
| `knownChoice` | Optional prior choice; preserved when the gateway is unavailable or the response is invalid. |
| `topTierUnlocked` | Whether `max` / `ultra` efforts are allowed. |
| `private` | When `true`, no cloud gateway calls are made. |

Unknown `projectedRemainingRatio` values are omitted from TypeSafe state; they are never invented as zero or “full quota”.

## Gateway

Inference uses **only** `MODEL_ROUTER_SYSTEMONE_URL` (loopback) via the T11 `createSystemOneGatewayClient` and the existing `decideRoute` chain. Missing URL, private tasks, timeouts, and invalid answers never fall back to TypeSafe API keys, Keychain, or the first candidate.

## Result origins

| `status` | `origin` | Meaning |
| --- | --- | --- |
| `skipped` | — | Delegation not decided. |
| `deterministic` | `deterministic` | Exactly one candidate with one supported effort that is allowed (top tier requires `topTierUnlocked`). |
| `selected` | `recommended` | Semantic route accepted. |
| `preserved-known` | `known-fallback` | Valid `knownChoice` kept after outage/invalid response. |
| `needs-choice` | — | Orchestrator must ask the operator; no silent default. |

Synthetic fixture tests exercise the HTTP client on ephemeral loopback servers. Live Jev cloud checks and real Herdr delegation are performed by the parent orchestrator, not by this subset.

## Limits

- No global hook or odd-classify integration.
- No `router run`, reservations, or Herdr launch.
- No quota/access claims in output; reasons are stable and do not echo upstream error bodies.
