# =============================================================================
# cicd-workflow-be — Production Dockerfile
#
# Build context: cicd-workflow-be/ (this directory)
#
# The workflow templates live in the central workflow repository. We clone it
# during the build stage so the templates and catalog are baked into the image.
# Set TEMPLATE_REPO_SLUG to point at a different repository or fork, and keep it
# in step with the runtime CENTRAL_WORKFLOW_REPO setting.
# =============================================================================

# ── Stage 1: compile TypeScript + fetch templates ────────────────────────────
FROM node:22-alpine AS builder

ARG TEMPLATE_CLONE_TOKEN
# Git ref (branch/tag) of the central workflow repo whose catalog + templates
# get baked into this image. Defaults to main; set to `test`/`uat` on
# pre-production deploys so those environments see catalog changes before they
# reach main.
ARG TEMPLATE_REPO_REF=main
# owner/name of the central workflow repository. Must match the runtime
# CENTRAL_WORKFLOW_REPO setting: this arg decides which catalog is baked in,
# that one decides which repository generated pipelines call into. Baking one
# repository's catalog while emitting `uses:` for another produces pipelines
# that reference workflows the catalog never described.
ARG TEMPLATE_REPO_SLUG=Alpha-Explora/alphaci-workflow

WORKDIR /app

# git is needed to clone the template repo
RUN apk add --no-cache git

# Install deps first — layer is cached until package.json changes
COPY package*.json ./
RUN npm install

# Compile source
COPY tsconfig*.json nest-cli.json ./
COPY src/ ./src/
RUN npm run build

# Clone workflow templates — uses a separate fine-grained PAT (contents:read
# only) scoped to the repository named by TEMPLATE_REPO_SLUG. Remove .git to
# avoid leaking the credentialed remote URL into any downstream layer.
RUN git clone --depth 1 --branch "${TEMPLATE_REPO_REF}" \
    "https://x-access-token:${TEMPLATE_CLONE_TOKEN}@github.com/${TEMPLATE_REPO_SLUG}.git" \
    /tmp/central-workflow \
  && rm -rf /tmp/central-workflow/.git

# ── Stage 2: production runtime ───────────────────────────────────────────────
FROM node:22-alpine AS runner

ENV NODE_ENV=production
# Absolute path — CatalogService reads from TEMPLATE_REPO_PATH/TEMPLATE_WORKFLOW_DIR
ENV TEMPLATE_REPO_PATH=/app/templates
# TEMPLATE_WORKFLOW_DIR defaults to 'workflow-templates' in app.config.ts

WORKDIR /app

COPY package*.json ./

RUN apk upgrade --no-cache zlib \
  && npm install --omit=dev \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nestjs

# Copy compiled application
COPY --chown=nestjs:nodejs --from=builder /app/dist ./dist
# The cron deployment runs the same compiled application in application
# context; keep its one entrypoint in the image instead of relying on dev
# tooling or a source-only script that is absent from the production layer.
COPY --chown=nestjs:nodejs scripts/process-outbox.cjs ./scripts/process-outbox.cjs

# Bake templates into the image — copied from the cloned repo in stage 1
COPY --chown=nestjs:nodejs --from=builder /tmp/central-workflow/workflow-templates ./templates/workflow-templates
COPY --chown=nestjs:nodejs --from=builder /tmp/central-workflow/catalog ./templates/catalog

USER nestjs

EXPOSE 3000

# start-period:20s — connect-pg-simple runs CREATE TABLE IF NOT EXISTS on boot
# which can take 8-12s on Render shared tier cold starts
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/api/v1/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1); }).on('error', () => process.exit(1));"

# TypeScript's rootDir is the repository root, so Nest emits the entry point
# under dist/src. Keep the web process and the cron runner on the same compiled
# application tree; `dist/main` does not exist in this build layout.
CMD ["node", "dist/src/main.js"]
