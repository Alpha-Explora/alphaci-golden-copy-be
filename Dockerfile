# =============================================================================
# cicd-workflow-be — Production Dockerfile
#
# Build context: cicd-workflow-be/ (this directory)
#
# The workflow templates live in the sibling repo cicd-workflow/.
# We clone it during the build stage so the templates are baked into the
# image. Set TEMPLATE_REPO_URL as a build arg to point at your org's fork.
# =============================================================================

# ── Stage 1: compile TypeScript + fetch templates ────────────────────────────
FROM node:22-alpine AS builder

ARG NPM_TOKEN
ARG TEMPLATE_CLONE_TOKEN
# Git ref (branch/tag) of cicd-workflow whose catalog + templates get baked
# into this image. Defaults to main; set to `test`/`uat` on pre-production
# deploys so those environments see catalog changes before they reach main.
ARG TEMPLATE_REPO_REF=main

WORKDIR /app

# git is needed to clone the template repo
RUN apk add --no-cache git

# Install deps first — layer is cached until package.json changes
COPY package*.json ./
RUN echo "@implementsprint:registry=https://npm.pkg.github.com" > .npmrc \
  && echo "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}" >> .npmrc \
  && npm install \
  && rm -f .npmrc

# Compile source
COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/
RUN npm run build

# Clone workflow templates — uses a separate fine-grained PAT (contents:read only)
# scoped to ImplementSprint/cicd-workflow. Remove .git to avoid leaking the
# credentialed remote URL into any downstream layer.
RUN git clone --depth 1 --branch "${TEMPLATE_REPO_REF}" \
    "https://x-access-token:${TEMPLATE_CLONE_TOKEN}@github.com/cicd-external-project/cicd-workflow.git" \
    /tmp/cicd-workflow \
  && rm -rf /tmp/cicd-workflow/.git

# ── Stage 2: production runtime ───────────────────────────────────────────────
FROM node:22-alpine AS runner

ARG NPM_TOKEN

ENV NODE_ENV=production
# Absolute path — CatalogService reads from TEMPLATE_REPO_PATH/TEMPLATE_WORKFLOW_DIR
ENV TEMPLATE_REPO_PATH=/app/templates
# TEMPLATE_WORKFLOW_DIR defaults to 'workflow-templates' in app.config.ts

WORKDIR /app

COPY package*.json ./

RUN echo "@implementsprint:registry=https://npm.pkg.github.com" > .npmrc \
  && echo "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}" >> .npmrc \
  && apk upgrade --no-cache zlib \
  && npm install --omit=dev \
  && rm -f .npmrc \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nestjs

# Copy compiled application
COPY --chown=nestjs:nodejs --from=builder /app/dist ./dist
# The cron deployment runs the same compiled application in application
# context; keep its one entrypoint in the image instead of relying on dev
# tooling or a source-only script that is absent from the production layer.
COPY --chown=nestjs:nodejs scripts/process-outbox.cjs ./scripts/process-outbox.cjs

# Bake templates into the image — copied from the cloned repo in stage 1
COPY --chown=nestjs:nodejs --from=builder /tmp/cicd-workflow/workflow-templates ./templates/workflow-templates
COPY --chown=nestjs:nodejs --from=builder /tmp/cicd-workflow/catalog ./templates/catalog

USER nestjs

EXPOSE 3000

# start-period:20s — connect-pg-simple runs CREATE TABLE IF NOT EXISTS on boot
# which can take 8-12s on Render shared tier cold starts
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/v1/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

CMD ["node", "dist/main"]
