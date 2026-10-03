# Backend monitoring and instrumentation

NodePilot keeps two inputs strictly apart:

1. **Health endpoints**: explicitly approved URLs checked periodically. They answer
   *"is the service reachable?"* — nothing more. A 200 says nothing about output quality.
2. **Execution telemetry**: authenticated node events sent by your backend. They answer
   *"did each node run, how long did it take, did it fail?"*, plus explicit
   **evaluation** events for *"did the output pass a functional check?"*.

The Backends panel shows four separate indicators per service: *Service reachable*,
*Workflow executing*, *Functional evaluation*, *Telemetry freshness*. If telemetry goes
stale, only the freshness indicator changes; recorded run outcomes are never rewritten.
Externally observed runs are listed under **External telemetry** and can be overlaid on
the canvas (nodes show an `EXT` badge). NodePilot never calls your backend's endpoints
other than the approved health URL.

## 1. Create a service and token

**Connections → Backends → Create & get token**. The ingest token (`npi_…`) is shown once;
store it in your backend's environment as `NODEPILOT_INGEST_TOKEN`. It can only post
telemetry for that service. Rotate it any time.

## 2. Instrument your code

`packages/instrument` has no dependencies and works in any Node 18+ service:

```ts
import { createReporter } from '@nodepilot/instrument';

const np = createReporter({
  endpoint: 'http://127.0.0.1:4317',
  token: process.env.NODEPILOT_INGEST_TOKEN!,
  workflowId: 'example-scene-pipeline',   // the NodePilot workflow this backend implements
  workflowRevision: 7,                     // optional: revision you deployed against
  environment: 'staging',                  // optional
  codeRevision: process.env.GIT_SHA,       // optional
});

const runId = crypto.randomUUID();
const hits = await np.traceNode(runId, 'n_scanner', () => scanner.scan(plan), {
  summarize: (r) => `${r.length} hits`,          // sanitized metadata only, never raw output
  usage: (r) => ({ inputTokens: r.usage?.in }),  // only if your provider reports it
});
np.evaluation(runId, 'n_score_combiner', { name: 'golden-set', passed: score >= 0.8, score, threshold: 0.8 });
```

`traceNode` emits `started` and then `succeeded` or `failed` (with sanitized error text and
duration) and rethrows your errors unchanged. Delivery happens in the background, retries
with backoff, buffers up to 2000 events, and never throws into your code. Common credential
formats are stripped before sending; the server redacts again.

Event shape (`POST /api/telemetry/events`, `Authorization: Bearer npi_…`, ≤256 KB, ≤500 events):

```json
{ "events": [{
  "eventId": "unique-per-event", "runId": "r-123", "nodeId": "n_scanner",
  "workflowId": "example-scene-pipeline", "workflowRevision": 7,
  "environment": "staging", "codeRevision": "abc1234",
  "timestamp": "2026-10-03T12:00:00.000Z", "status": "succeeded",
  "durationMs": 840, "error": null, "output": { "summary": "12 hits" }
}]}
```

`status` ∈ `started | succeeded | failed | evaluation_passed | evaluation_failed`.
Duplicates (same `eventId`) are ignored and counted. Out-of-order delivery is handled: a
terminal status is never replaced by a late `started`, and within the same rank the newer
timestamp wins.

## 3. Map nodes

Telemetry is matched to canvas nodes by `nodeId`. For nodes implemented only by your
backend, set their implementation to **Observed external service** (service id = your
service). NodePilot will then never execute them locally.

## 4. Health endpoint

Add the URL under *Health endpoints*, linked to the service id. Targets must be http(s), may
not embed credentials, may not resolve to cloud-metadata/link-local addresses, and may only
redirect within the same origin.

## Example backend

```bash
npm run build
NODEPILOT_INGEST_TOKEN=npi_... npm run example-backend     # http://127.0.0.1:4400
curl -X POST http://127.0.0.1:4400/run -H "content-type: application/json" -d "{\"query\":\"storm rescue\"}"
curl -X POST http://127.0.0.1:4400/run -H "content-type: application/json" -d "{\"failAt\":\"n_scanner\"}"
```

It implements the example pipeline in plain TypeScript, reports every node, and emits an
evaluation event for the final score. `scripts/e2e-monitoring.mjs` automates this check in a browser.
