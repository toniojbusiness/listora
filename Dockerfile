# syntax=docker/dockerfile:1
# The Listora images, from one set of sources. `app` (the default target, the last stage) runs
# the API, the worker, and the migrations; ECS chooses the entry point per service
# (infra/src/containers.ts). `runner` runs the on-demand browser runner
# (apps/worker/src/runner/main.ts): the same files on top of Playwright's headless Chromium.
# Node runs the TypeScript sources directly, so there is no build stage: install the production
# dependencies and copy the sources.
# Built and pushed by .github/workflows/deploy.yml; CI builds and smoke-tests both when an image
# input changes.
FROM node:26-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Amazon RDS certificate authorities, so connections verify the database certificate
# (DATABASE_URL uses sslmode=verify-full in AWS).
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
# Some BuildKit versions (Docker 29) also give the directories ADD creates mode 644, which leaves
# /etc/ssl unsearchable and stops node from reading OpenSSL's config as the unprivileged user.
RUN chmod 755 /etc/ssl /etc/ssl/certs
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem

# The application: manifests and the shared packages first, so the dependency layer is reused
# while only the API or worker sources change.
FROM runtime AS base
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY infra/package.json infra/
COPY packages/ packages/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY apps/api/src apps/api/src
COPY apps/worker/src apps/worker/src

# Headless Chromium at the build the locked playwright-core pins, with the system libraries
# and fonts it needs. It depends only on the lockfile, so its large layers are rebuilt, pushed,
# and stored again only when the dependencies change, not with every commit.
FROM runtime AS chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
COPY package-lock.json /tmp/playwright-version/
RUN version=$(node -p "require('/tmp/playwright-version/package-lock.json').packages['node_modules/playwright-core'].version") \
  && npx --yes "playwright-core@$version" install --with-deps --only-shell --no-progress chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm /tmp/playwright-version

# The browser runner. The task's root file system is read-only; Chromium's profile and caches
# go to /tmp, a volume ECS mounts writable. Fargate creates that volume owned by root with mode
# 0755, which the unprivileged user cannot write (Chromium then does not start), unless the
# image declares the path a VOLUME: then it copies the image's directory, owner included, into
# it. So /tmp belongs to node here, and the task definition mounts the volume at this path.
FROM chromium AS runner
ENV HOME=/tmp
COPY --from=base /app /app
RUN chown node:node /tmp
USER node
VOLUME ["/tmp"]
# Fails the build, whatever the builder, if the unprivileged user cannot start node.
RUN node -e '' && test -r "$NODE_EXTRA_CA_CERTS"
CMD ["node", "apps/worker/src/runner/main.ts"]

# Files stay owned by root; the processes run unprivileged and never write to the image.
FROM base AS app
USER node
# Fails the build, whatever the builder, if the unprivileged user cannot start node.
RUN node -e '' && test -r "$NODE_EXTRA_CA_CERTS"
EXPOSE 3000
CMD ["node", "apps/api/src/main.ts"]
