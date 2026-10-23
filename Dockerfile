ARG OPENCLAW_VERSION=2026.10.1
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_VERSION}

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium chromium-sandbox \
        dbus-daemon dbus-x11 dbus-bin \
        x11-utils \
        fonts-liberation fonts-noto-color-emoji \
        tigervnc-standalone-server tigervnc-tools \
        xfce4 xfce4-terminal at-spi2-core \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /run/openclaw-desktop /tmp/.X11-unix /tmp/.ICE-unix \
    && chown node:node /run/openclaw-desktop \
    && chmod 0700 /run/openclaw-desktop \
    && chmod 1777 /tmp/.X11-unix /tmp/.ICE-unix
RUN if [ "$(dpkg --print-architecture)" = amd64 ]; then \
        apt-get update \
        && apt-get install -y --no-install-recommends ca-certificates curl gpg \
        && key_dir="$(mktemp -d)" \
        && curl --fail --silent --show-error --location \
            https://dl.google.com/linux/linux_signing_key.pub -o "$key_dir/google.asc" \
        && gpg --batch --dearmor --output /usr/share/keyrings/google-chrome.gpg "$key_dir/google.asc" \
        && chmod 0644 /usr/share/keyrings/google-chrome.gpg \
        && printf '%s\n' 'deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main' \
            > /etc/apt/sources.list.d/google-chrome.list \
        && apt-get update \
        && apt-get install -y --no-install-recommends google-chrome-stable \
        && rm -rf "$key_dir" /var/lib/apt/lists/*; \
    fi
COPY desktop/chromium-profile /etc/chromium.d/openclaw-profile
COPY desktop/openclaw-desktop-browser /usr/local/bin/
COPY desktop/launchers/ /app/deploy/launchers/
COPY desktop/start-desktop.sh desktop/run-xfce.sh /app/deploy/
COPY desktop/prepare-runtime.mjs desktop/configuration.mjs /app/deploy/
RUN chmod 0755 /usr/local/bin/openclaw-desktop-browser \
    /app/deploy/start-desktop.sh /app/deploy/run-xfce.sh /app/deploy/launchers/*.desktop
ENV DISPLAY=:1 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/run/openclaw-desktop/bus \
    CHROME_USER_DATA_DIR=/home/node/.openclaw/desktop/google-chrome
USER node

# Seed ownership for a new volume; Chromium creates any missing profile directory.
RUN mkdir -p /home/node/.openclaw/desktop/chromium \
    /home/node/.openclaw/desktop/google-chrome /home/node/.config \
    && for directory in Desktop Downloads Documents; do \
        mkdir -p "/home/node/.openclaw/desktop/$directory" \
        && test ! -e "/home/node/$directory" \
        && ln -s "/home/node/.openclaw/desktop/$directory" "/home/node/$directory" || exit 1; \
    done \
    && mkdir -p /home/node/.openclaw/desktop/xfce4 \
    && test ! -e /home/node/.config/xfce4 \
    && ln -s /home/node/.openclaw/desktop/xfce4 /home/node/.config/xfce4
COPY --chown=node:node desktop/user-dirs.dirs /home/node/.config/user-dirs.dirs
COPY --chown=node:node openclaw.json /app/deploy/openclaw.json

ENTRYPOINT ["tini", "-s", "--", "/app/deploy/start-desktop.sh"]

# Do not launch an unconfigured gateway when the initial config copy fails.
CMD ["sh", "-c", "([ -f /home/node/.openclaw/openclaw.json ] || cp /app/deploy/openclaw.json /home/node/.openclaw/) && exec node openclaw.mjs gateway --allow-unconfigured --bind lan"]
