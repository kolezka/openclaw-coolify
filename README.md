# openclaw-coolify

[OpenClaw](https://github.com/openclaw/openclaw) on Coolify, routed through a LiteLLM proxy.

The official image binds to loopback and has no model configured. This repo adds a
`Dockerfile` that starts the gateway with `--bind lan` and seeds `openclaw.json` on first
boot. The config references env vars (`${LITELLM_API_KEY}` etc.), which OpenClaw resolves
at load time, so no secret is written to disk and changing a value in Coolify takes
effect on restart.

## Deploy

1. Coolify: New Resource, Docker Compose, point at this repo.
2. Set the env vars from `.env.example`. All five are required; the container refuses to
   start without them. `OPENCLAW_ALLOWED_ORIGINS` is the dashboard URL you will attach in
   step 3, e.g. `https://openclaw.example.com`, so decide it before deploying.
3. Attach the domain to port `18789`. That is the only exposed port. If an older deploy
   attached a domain to `18791`, remove it in Coolify; that port is browser control, not
   the dashboard.
4. Deploy. Open the dashboard, paste `OPENCLAW_GATEWAY_TOKEN`. On "pairing required",
   approve your browser from the container terminal in Coolify:
   ```
   node openclaw.mjs devices list
   node openclaw.mjs devices approve <REQUEST_ID>
   ```

Use HTTPS for the domain. The dashboard needs a secure context outside localhost, so a
plain `http://` hostname will connect but not authenticate.

## Desktop (Labs)

The image adds Chromium, TigerVNC, XFCE and D-Bus for OpenClaw's native **Desktop**
panel. This is a full Linux desktop inside the gateway container, not the Browser
panel or the host machine's physical desktop. The `cua-computer` provider controls
that same display. Both Host Desktop and Linux CUA are experimental upstream.

Use `OPENCLAW_VERSION=2026.10.1`, the version this configuration targets. An existing
Coolify environment value overrides the Dockerfile and Compose defaults; update it
explicitly when deploying this change. Do not keep an older override that lacks
these APIs.

For a new volume, the seed enables `desktop.host.enabled`,
`desktop.host.managed`, `plugins.entries.cua-computer.enabled`, and the `computer`
tool. OpenClaw starts its private TigerVNC/XFCE session on demand. Use the **Desktop**
panel and select **This machine / Gateway host**. The built-in viewer connects
through the authenticated gateway. Do not publish port 5900 or add a separate
noVNC endpoint. The gateway still runs as `node`; the service does not need
privileged mode, host networking, a Docker socket, or access to the host display.

Compose uses a [dedicated seccomp policy](desktop/README.md) and
`no-new-privileges:true`. The policy retains Moby's default deny rules and adds
`clone`, `setns` and `unshare` permissions needed by Chromium's user-namespace
sandbox. These exceptions apply to the whole gateway container. Chromium does not
use `--no-sandbox`, and no `SYS_ADMIN` capability is added. The target host must
allow unprivileged user namespaces; confirm Coolify retains these settings before
activation. Debian may use `/tmp` for Chromium shared memory despite the service's
1 GB `/dev/shm` allocation.

Chromium is available in XFCE's application menu. Debian's Chromium launcher reads
`desktop/chromium-profile`, which places its profile at
`/home/node/.openclaw/desktop/chromium` inside `openclaw_state`. Cookies and logins
survive container recreation and must stay out of Git. The stable container
hostname lets Chromium recognize its stale lock after an unclean replacement;
never run two live containers against the same profile. XFCE preferences outside
that volume are not persisted. Existing remote Browserless profiles are not
changed; use `computer`, rather than `browser`, when the agent should operate the
visible desktop.

### Activate on an existing volume

Deploying the image alone does **not** modify an existing `openclaw.json`. Do not
replace that file with the seed: it would discard agents, models, memory plugins,
and access rules. Before making live changes, export the current configuration to
private storage outside this repository and verify that it can be read back.
Deployment and live configuration changes require a separate approval.

For a volume from an older OpenClaw release, rehearse the upgrade on a private copy
of the full state with the target image, including
`node openclaw.mjs doctor --fix --non-interactive`, before switching production.
This repository's shell-based seed command does not trigger the upstream image's
automatic doctor migration. Do not assume a successful test on an empty volume
proves an older volume can upgrade, and do not run repairs on the only live copy.

After deploying the image, use the container console or the dashboard Config editor.
If `desktop.host.port` is set, it selects an external VNC server instead of managed
mode. Check that configuration before proceeding; do not silently repoint an
existing desktop. For the managed desktop, leave `port` unset.

```sh
node openclaw.mjs config set desktop.host.managed true --strict-json
node openclaw.mjs config set desktop.host.enabled true --strict-json
node openclaw.mjs plugins enable cua-computer
```

In the Config editor, append `computer` to the existing `tools.alsoAllow` array.
Keep all existing entries such as `llm-task`. If a `plugins.allow` list is present,
include `cua-computer` without dropping other plugins. Leave agent-specific
`tools.deny` rules intact; agents that deny `computer` must remain restricted.
Plugin activation may require a gateway restart; follow the CLI's instruction in
the approved deployment window.

```sh
node openclaw.mjs config validate --json
node openclaw.mjs doctor --lint --only cua-computer/driver-artifacts
```

A desktop-control session needs a vision-capable model. Select an existing working
vision model for that session and verify image support through its provider. Do not
mark a text-only model as image-capable or change every agent's default model just
to enable desktop use.

### Verify after deployment

1. Open the Desktop panel, select the gateway, and confirm the XFCE desktop appears.
2. Open Chromium from the application menu and load a neutral page.
3. Ask the permitted agent to use `computer` on the gateway, type into a harmless
   form, and confirm that the visible input matches. Do not test with credentials.
4. Verify the browser profile remains after a planned container recreation.

Viewing the desktop alone does not prove agent control works. Neither a successful
image build nor configuration validation replaces these checks.

To stop desktop access, disable Host Desktop in Labs and disable `cua-computer` if
no other workflow needs it. Remove only the `computer` tool grant added here.
Preserve the volume and its profile. If rolling back to an older OpenClaw version,
restore that version's compatible configuration first.

### Local checks

The contract tests render Compose with dummy credentials and check the desktop
configuration, private ports and persistent volume:

```sh
node --test tests/deployment.test.mjs
```

Build and exercise the image in a disposable local container. The smoke test uses
a local form and direct CUA RPCs, not an LLM or production credentials. It checks
the WebUI desktop stream, a screenshot, typed form submission and profile location.
It publishes no ports and mounts no production state.

```sh
docker build -t openclaw-desktop:test .
docker run --rm --init --network none --shm-size=1g --entrypoint node \
  --security-opt no-new-privileges:true \
  --security-opt "seccomp=$PWD/desktop/chromium-seccomp.json" \
  --mount "type=bind,source=$PWD/tests,target=/app/tests,readonly" \
  openclaw-desktop:test /app/tests/desktop-smoke.mjs
node tests/profile-recreate.mjs
```

Local verification was run on Linux/arm64 in Docker Desktop. The target server is
Linux/amd64; its runtime and Coolify security-option handling still need a separate
check before deployment. The automated test validates the Desktop stream and CUA
input, not an interactive browser login to the Control UI.

Upstream references: [Host Desktop](https://docs.openclaw.ai/gateway/config-browser-ui-desktop#desktop)
and [Computer use](https://docs.openclaw.ai/nodes/computer-use#gateway-desktop).

## LiteLLM

`LITELLM_MODEL` is the `model_name` alias from your LiteLLM `model_list`. The seeded
config declares it with a 128k context window and 8k max output; edit `openclaw.json`
in the volume (or Config in the dashboard) if your model differs. To confirm traffic
actually goes through LiteLLM, check its spend logs for the virtual key after a chat.

## State

Everything lives in the `openclaw_state` volume at `/home/node/.openclaw`. The seeded
config is only copied when that file does not exist yet, so dashboard edits survive
redeploys.

The first version of this repo mounted volumes under `/root`, but the image runs as
`node`, so that data landed in the container's writable layer. Before redeploying an app
created from that version, copy it out: `docker cp <old-container>:/home/node/.openclaw ./export`.
