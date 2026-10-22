ARG OPENCLAW_VERSION=2026.10.1
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium chromium-sandbox \
        dbus-daemon dbus-x11 \
        fonts-liberation fonts-noto-color-emoji \
        tigervnc-standalone-server tigervnc-tools \
        xfce4 \
    && rm -rf /var/lib/apt/lists/*
COPY desktop/chromium-profile /etc/chromium.d/openclaw-profile
USER node

# Seed ownership for a new volume; Chromium creates any missing profile directory.
RUN mkdir -p /home/node/.openclaw/desktop/chromium
COPY --chown=node:node openclaw.json /app/deploy/openclaw.json

# Do not launch an unconfigured gateway when the initial config copy fails.
CMD ["sh", "-c", "([ -f /home/node/.openclaw/openclaw.json ] || cp /app/deploy/openclaw.json /home/node/.openclaw/) && exec node openclaw.mjs gateway --allow-unconfigured --bind lan"]
