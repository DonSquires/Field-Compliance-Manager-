# Kodee Brief: Build the Real Bob Backend Environment

## Mission

Build the real Bob controller/worker backend from application source, publish one deployable Docker image through CI, and prepare an isolated VPS Compose deployment.

The current VPS nginx placeholder is not the backend and must not be started or evolved. The live Bob frontend already occupies port `3010` and must remain unchanged.

## Design authority

Use the attached repository design file as the implementation specification:

`kodee-bob-environment-build-runbook.md`

Read and follow that runbook before creating source, Docker, CI, or deployment files. It defines the architecture, boundaries, environment contract, Compose shape, verification requirements, and definition of done.

## Required implementation

Create a separate Bob backend application repository. It must contain:

- real controller/API source
- real worker source
- production Dockerfile
- controller runtime command
- worker runtime command
- `GET /health` readiness endpoint
- `env.example` with no secrets
- tests and container smoke tests
- CI workflow that builds and publishes the image
- manual-only deployment workflow
- isolated Compose deployment definition

The controller and worker may use the same image, but they must run distinct runtime roles. The worker must start with concurrency `1` and must not publish a host port.

## Deployment constraints

- Keep the live frontend on port `3010` unchanged.
- Do not touch the FCM Compose project.
- Do not start or modify the nginx placeholder backend.
- Run the controller on internal port `8080`.
- Expose no host port for the worker.
- Use persistent volumes for Bob state, workspace, and logs.
- Do not add Redis, a database, or other infrastructure unless the application code actually requires it.
- Keep production deployment manual until the basic path is proven.
- Deploy by immutable image tag, not only `latest`.

## CI requirements

The CI pipeline must:

1. install dependencies;
2. run tests and static checks;
3. build the production image;
4. start and test the controller health endpoint;
5. start and smoke-test the worker role;
6. publish an immutable commit-based image tag;
7. report the exact registry image reference.

The deployment workflow must be manually triggered, accept an explicit image tag, pull that image on the VPS, restart only the isolated Bob controller and worker services, wait for controller health, verify one worker with concurrency `1`, and fail clearly if verification does not pass.

## Existing environment context

- VPS ID: `1601189`
- VPS hostname: `srv1601189.hstgr.cloud`
- Frontend port: `3010`
- Existing FCM stack: leave untouched
- Existing Gitea repository: `Iron-Eagle-Security-Ltd/field-compliance-manager`
- That repository is currently an empty/deployment-shell repository, not the Bob backend source.

## Completion criteria

Do not describe the environment as complete until the following are available:

- separate backend source repository
- working controller and worker processes
- production image published to a VPS-readable registry
- exact immutable image reference
- isolated Compose project using that image
- manual-only deployment workflow
- passing controller health check
- verified one-job controller-to-worker path
- no changes to the frontend on `3010` or the FCM stack

After this basic path is proven, add production approval gates for deployments, migrations, secret changes, and broad infrastructure changes. Do not add those gates before the basic path works.