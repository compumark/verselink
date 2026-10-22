# DEV Node.js 22.23.4 security build

This document describes the isolated DEV image build for issue #133. It does not authorize publishing or deployment. Do not use it for PROD.

## Source and metadata

- Application source snapshot: `8f7cde87a5eecae1bcdade4c166a99a8875df337` (`codex/telemetry-128-collapse-history`).
- Security update branch starts from this exact commit, whose parent is `5ce1758b79b16a83c7a19e81fa48b841cb1b9903`.
- The root `Dockerfile` builds the runtime from `node:22.23.4-alpine`.
- `APP_COMMIT` remains the application-source commit above; `APP_ENVIRONMENT=DEV` and `APP_VERSION=c10-smoke` remain unchanged.
- `APP_SECURITY_BUILD_COMMIT` and OCI label `org.opencontainers.image.revision` identify the commit containing this security-only build change. This deliberately distinguishes the application snapshot from the security build.
- The existing `c10-smoke-8f7cde87a5eecae1bcdade4c166a99a8875df337` tag must remain untouched. The proposed new tag is `c10-smoke-node-22.23.4`.

## Isolated image build and publish

The repository's `.github/workflows/docker-publish.yml` only publishes the moving `dev` and SHA tags on pushes to `main`, or stable release tags through manual dispatch. It cannot publish a uniquely tagged image from this security branch. After the PR has been reviewed and publication is approved, check out the reviewed PR head, confirm it is the intended source, authenticate to GHCR interactively, and run from the repository root in PowerShell:

```powershell
$SecurityBuildCommit = (git rev-parse HEAD).Trim()
if ((git rev-parse HEAD).Trim() -ne '<REVIEWED_PR_HEAD_SHA>') { throw 'Checkout does not match the reviewed PR head.' }
docker login ghcr.io
docker buildx build --pull --platform linux/amd64 --file Dockerfile `
  --tag ghcr.io/compumark/verselink:c10-smoke-node-22.23.4 `
  --label "org.opencontainers.image.revision=$SecurityBuildCommit" `
  --build-arg VERSELINK_COMMIT=8f7cde87a5eecae1bcdade4c166a99a8875df337 `
  --build-arg VERSELINK_ENVIRONMENT=DEV `
  --build-arg VERSELINK_VERSION=c10-smoke `
  --build-arg "VERSELINK_SECURITY_BUILD_COMMIT=$SecurityBuildCommit" `
  --push .
```

Run the reviewed-head guard only after substituting the exact head SHA reported by the PR. The command pushes only the new DEV tag. Do not substitute `dev`, `latest`, any stable tag, or the existing smoke tag.

## DEV-only Portainer update and rollback

Before any later deployment, record the running `verselink-dev-app` image reference, image ID and container health. Keep its current immutable image/tag available. In the DEV Portainer stack only, change the app's `image` to `ghcr.io/compumark/verselink:c10-smoke-node-22.23.4`, retain `pull_policy: always`, and redeploy only that DEV stack. Verify `APP_COMMIT=8f7cde87a5eecae1bcdade4c166a99a8875df337`, `APP_ENVIRONMENT=DEV`, `APP_VERSION=c10-smoke`, `APP_SECURITY_BUILD_COMMIT` equals the reviewed security commit, `node --version` reports `v22.23.4`, the container healthcheck passes, and the C10 history timeline works.

For rollback, restore the previously recorded DEV image reference exactly:

```yaml
image: ghcr.io/compumark/verselink:c10-smoke-8f7cde87a5eecae1bcdade4c166a99a8875df337
```

Redeploy only the DEV stack and verify its health. Do not alter the database, volumes, secrets, ports, PROD stack or any running container during this source/PR task.

## CI exception

GitHub Actions validation is unavailable because the account's Actions quota is exhausted (as reported for this task). Record the local checks in the PR; do not represent CI as passed. Re-enable/confirm hosted CI separately when quota is restored.
