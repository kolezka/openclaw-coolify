ARG OPENCLAW_VERSION=2026.2.26
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}

# Image runs as node; the dir must exist so the named volume inherits its ownership.
RUN mkdir -p /home/node/.openclaw
COPY --chown=node:node openclaw.json /app/deploy/openclaw.json

CMD ["sh", "-c", "[ -f /home/node/.openclaw/openclaw.json ] || cp /app/deploy/openclaw.json /home/node/.openclaw/; exec node openclaw.mjs gateway --allow-unconfigured --bind lan"]
