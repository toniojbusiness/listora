# syntax=docker/dockerfile:1
# The Listora application image. One image runs both services; ECS chooses the entry point
# per service (infra/src/containers.ts). Node runs the TypeScript sources directly, so there is
# no build stage: install the production dependencies and copy the sources.
# Built and pushed by .github/workflows/deploy.yml; CI builds and smoke-tests it on every PR.
FROM node:26-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec

ENV NODE_ENV=production
WORKDIR /app

# Amazon RDS certificate authorities, so connections verify the database certificate
# (DATABASE_URL uses sslmode=verify-full in AWS).
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem

# Manifests and the shared packages first: the dependency layer is reused while only the
# API or worker sources change.
COPY package.json package-lock.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY infra/package.json infra/
COPY packages/ packages/
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY apps/api/src apps/api/src
COPY apps/worker/src apps/worker/src

# Files stay owned by root; the processes run unprivileged and never write to the image.
USER node
EXPOSE 3000
CMD ["node", "apps/api/src/main.ts"]
