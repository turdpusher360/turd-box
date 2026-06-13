FROM node:22-alpine@sha256:968df39aedcea65eeb078fb336ed7191baf48f972b4479711397108be0966920

# git: extract the PR diff. bash: entrypoint.sh uses bash arrays. node ships in the base image.
# No gh CLI — PR review comments are posted via the GitHub REST API (fetch) in lib/github-client.js.
RUN apk add --no-cache git bash

WORKDIR /action

# Copy package manifests first for layer caching and lockfile-reproducible installs
COPY package.json package-lock.json ./

# Install Anthropic SDK only — keep image lean
RUN npm ci --omit=dev --no-audit --no-fund

# Copy action source
COPY entrypoint.sh ./
COPY passes.json ./
COPY lib/ ./lib/

RUN chmod +x entrypoint.sh && chown -R node:node /action

USER node

ENTRYPOINT ["/action/entrypoint.sh"]
