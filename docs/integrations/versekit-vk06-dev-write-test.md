# VK-06 — isolated DEV testing for VerseKit `orders:write`

**Status:** preparation only. No DEV deployment, PROD activation, merge or credential rotation is authorized by this document.

## 1. Safety and capability gate

The normal application starts with `orders:read` only. A write scope is mounted and advertised **only** if all three environment values are exact:

```text
VERSEKIT_ENABLED=true
APP_ENVIRONMENT=DEV
VERSEKIT_ORDERS_WRITE=true
```

`APP_ENVIRONMENT` is injected into the candidate GHCR image at build time using `VERSELINK_ENVIRONMENT=DEV`. The general `VERSEKIT_ORDERS_WRITE` flag is supported in DEV and Production; this VK-06 runbook remains scoped to DEV validation. An unset, false or malformed flag leaves `orders:read` only; `VERSEKIT_ENABLED=false` leaves the entire adapter disabled. The deprecated `VERSEKIT_DEV_ORDERS_WRITE` alias remains a fallback only in DEV when `VERSEKIT_ORDERS_WRITE` is unset. An explicit new value, including `false`, takes precedence. This is a controlled operations opt-in, not a security boundary against someone who can change all container environment variables and run code.

Keep the existing independent DEV `VERSEKIT_TOKEN_PEPPER`, fixed DEV `VERSEKIT_GROUP_ID`, and HTTPS `VERSEKIT_PUBLIC_URL`. Do not touch `SINK_TOKEN_PEPPER`.

## 2. Pre-deployment provenance / compatibility gate (mandatory)

Before deploying the candidate, record **the actually running** DEV app container image reference, immutable digest, `APP_COMMIT`, `APP_SECURITY_BUILD_COMMIT` if present, `APP_ENVIRONMENT`, `APP_VERSION`, Node version and image revision label. Check About → System Information in the DEV UI and the container/image metadata. For example (substitute the actual app container name):

```bash
docker inspect -f '{{.Config.Image}}' <DEV_APP_CONTAINER>
docker inspect -f '{{.Image}}' <DEV_APP_CONTAINER>
docker exec <DEV_APP_CONTAINER> node --version
docker exec <DEV_APP_CONTAINER> node -e 'for (const k of ["APP_COMMIT","APP_SECURITY_BUILD_COMMIT","APP_ENVIRONMENT","APP_VERSION"]) console.log(k + "=" + (process.env[k] || "<unset>"))'
```

Verify the old DEV image's C10 telemetry history, presence/pairing, profile, Orders, Inventory and UI features against the candidate branch. **Do not infer continuity from an image tag** (e.g. a historical C10 smoke tag). If any DEV-only functionality would be lost, stop and reconcile ancestry before deployment.

Back up DEV PostgreSQL **and verify it is the DEV database**; export the Portainer DEV stack/compose configuration and secret references (securely). Do not change volumes, host paths, published ports, reverse-proxy hostnames or DEV group. Do not connect to PROD PostgreSQL. Save the exact old image digest and rollback flags. No automatic migration/cleanup is requested.

## 3. Candidate image (no shared tag overwrite)

The feature branch's isolated publish workflow runs tests first, then publishes:

```text
ghcr.io/compumark/verselink:vk06-write-dev-<FULL_GIT_COMMIT_SHA>
```

Use its **exact published tag or digest** in Portainer. Do not use or overwrite `:dev`, `:latest`, stable tags, or the older C10 smoke tags. Confirm the image's OCI revision equals the workflow commit and `APP_ENVIRONMENT=DEV`, `APP_VERSION=vk06-write-dev`; record the resulting digest and Node version. The Dockerfile uses the current `node:22-alpine` base; validate the **actual** Node patch version rather than assuming it matches an older C10 image.

If the publish workflow was not run or failed, do **not** guess a tag. Resolve CI/build issues before deployment.

## 4. Safe staged Portainer configuration

Use the isolated **existing DEV** deployment, with its own PostgreSQL data, logs and hostname. When using a Compose environment mapping, pass `VERSEKIT_ORDERS_WRITE` into the app container. For legacy stacks, `VERSEKIT_DEV_ORDERS_WRITE` remains accepted only when the new flag is unset. When using a Portainer Web Editor stack, add the app container environment key explicitly.

**Stage A — new candidate image, still read-only**:

```text
VERSEKIT_ENABLED=true
VERSEKIT_ORDERS_WRITE=false
VERSEKIT_GROUP_ID=<EXISTING_DEV_GROUP_UUID>
VERSEKIT_PUBLIC_URL=https://<EXISTING_DEV_HOSTNAME>
VERSEKIT_TOKEN_PEPPER=<EXISTING_INDEPENDENT_DEV_VERSEKIT_PEPPER>
```

After a separately approved DEV image replacement, verify `/healthz`, login, C10 capabilities, normal Orders, and `GET /.well-known/versekit-org.json` showing **only** `["orders:read"]` in `versions["1"].scopes_supported`. Confirm a write URL returns 404 and old read-only VerseKit connection remains functional.

**Stage B — explicit DEV write opt-in**, only after Stage A passes:

```text
VERSEKIT_ORDERS_WRITE=true
```

Redeploy/restart **only the DEV app** with the same image and other settings. Verify discovery lists `["orders:read","orders:write"]` and the delivery route no longer returns 404. A token with only `orders:read` must still receive `403 SCOPE_MISSING` when attempting a delivery. Do not set the flag on PROD.

## 5. Real VerseKit client functional test

Use the **unmodified** VerseKit client and a logged-in DEV group member. If an existing connection only grants `orders:read`, reconnect/reauthorize and explicitly approve `orders:write` in the VerseLink browser consent UI; scope selection must not be prechecked. The fixed configured group and member checks still apply.

1. In VerseLink DEV create a **new** small material Order with an unambiguous material name and required quantity (for example 5 SCU). Do not use a legacy order with pre-ledger cached progress.
2. In the VerseKit client locate the same order ID, submit a delivery of 2 SCU, and verify delivery response, persistent `material_order_deliveries`, browser progress 2/5 and the contributor's identity.
3. Retry the **same HTTP request with the same Idempotency-Key** where the client/test harness permits; response must replay and ledger entry count must remain one. Use a **new key** for another 3 SCU and verify completion and exactly one completed-order notification.
4. Test invalid item, missing key, excess quantity, cancelled order and hidden/cross-group order. Test a read-only token and a member whose group membership is removed.
5. Verify browser reporting still works and concurrent Browser/VerseKit reporting cannot exceed the required amount.
6. If the unmodified client UI does not expose delivery submission, record that limitation explicitly: a contract-level HTTP test is *not* proof of real-client write functionality. Do not patch the third-party client as part of this task.

Compare v1 response shapes/error codes to the [official OpenAPI](https://github.com/Xharig/VerseKit/blob/main/tools/orga-standard/v1/openapi.yaml) and record exact test steps, timestamps, results and client version. If available, run official conformance checks with write tests explicitly enabled; do not claim skipped tests passed. Only test against DEV test orders.

## 6. Monitoring and rollback

Observe error rates, failed authorization, DB consistency and growth of `versekit_order_delivery_idempotency` (rows retained indefinitely by accepted design). Example safe metadata-only check on **DEV DB only**:

```sql
SELECT COUNT(*) AS keys_total, MIN(created_at) AS oldest, MAX(created_at) AS newest
FROM versekit_order_delivery_idempotency;
```

If an issue occurs, first set `VERSEKIT_ORDERS_WRITE=false` and restart the DEV app; verify discovery reverts to `orders:read` only and delivery endpoint returns 404. Revert to the **recorded previous DEV image/digest** and original flags if necessary; preserve DEV database and volumes. Restore the DEV DB backup only as a separate, explicitly reviewed recovery operation. Do not rotate peppers, revoke grants, or run legacy-cleanup scripts just to switch the flag off.

## 7. Completion record / hold points

Record verified former DEV image/digest/commit, candidate image tag/digest/commit, Node version, backup check, default-off smoke results, write-on real VerseKit client results, consent/group isolation, idempotency, browser parity, regressions, rollback check and all limitations.

**Stop after preparation** until the owner approves deployment. **Stop after DEV validation** until separately approved Production rollout; Production activation requires its own explicit change review and opt-in configuration.
