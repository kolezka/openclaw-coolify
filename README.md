# openclaw-coolify

[OpenClaw](https://github.com/openclaw/openclaw) on Coolify, routed through a LiteLLM proxy.

The Dockerfile starts the gateway with `--bind lan` and copies `openclaw.json` into the
state volume on first boot. If that copy fails, startup stops. An existing config is
never overwritten. The seed uses `${ENV}` references for credentials; OpenClaw resolves
them at load time. This does not prevent the running application from storing other
credentials or private state in its volume.

## Deploy

1. In Coolify, create a Docker Compose resource pointing at this repository.
2. In Coolify's environment UI, set the five variables listed in `.env.example`:
   gateway token, dashboard origin, LiteLLM URL, key and model alias. For local use,
   put real values in an uncommitted `.env`, never in `.env.example`. Compose rejects
   missing or empty values.
3. Attach an HTTPS dashboard domain to gateway port `18789`. Use that exact origin
   for `OPENCLAW_ALLOWED_ORIGINS`, including the scheme, without a path. The current
   template accepts one origin. Port `18791` is not the dashboard.
4. Deploy, open the dashboard and supply the gateway token. On "pairing required",
   approve the browser from the container terminal:

   ```sh
   node openclaw.mjs devices list
   node openclaw.mjs devices approve <REQUEST_ID>
   ```

Before redeploying an existing installation, confirm its actual image version and
configuration compatibility. `OPENCLAW_VERSION` defaults to `2026.2.26`; that default
is not evidence of what an existing deployment runs. Do not downgrade a newer state
volume blindly. Plain HTTP on a non-localhost domain does not provide the secure
context needed by the dashboard.

### Network boundaries

The gateway listens on the container network (`--bind lan`); both `18789` and `18790`
are published only on the Docker host's `127.0.0.1`. Do not change the container bind
to loopback: Docker's published port must reach the container interface. `expose` is
metadata, not a firewall between containers.

Publishing a loopback port does not create a remote HTTPS route. Upstream source at
`v2026.2.26` (commit `bc50708`) mounts canvas on the gateway at `/__openclaw__/canvas/`.
Separately, deployment fix `a2af273` records that publishing `18790` resolved artifact
connection errors. The source reading does not verify the deployed version or undo
that operational evidence. Keep the existing mapping until the actual running version
and generated, authenticated canvas URL have been checked through the intended HTTPS
proxy. Do not add or remove routes based on the upstream source reading alone.

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

`LITELLM_MODEL` must match your proxy alias and an explicit entry in
`models.providers.litellm.models`. The example selects the existing
`deepseek/deepseek-v4-pro` declaration; your proxy must expose that alias too.

The current catalogue contains model-specific context/output limits and DeepSeek
wire-compatibility settings. Those values are configuration, not measured provider
capabilities. Keep the DeepSeek compatibility flags when using those routes: a
provider named `litellm` does not automatically get DeepSeek's tool-history format.

For another alias, add its own declaration with the correct `contextWindow`,
`maxTokens`, input types and compatibility settings before first boot. For an existing
installation, edit the persisted config or use the dashboard Config editor. Do not
rely on undeclared aliases: the pinned resolver can accept one while borrowing the
first model's limits and generic reasoning settings. Selecting a model is not enough
to verify inference; check a real response and the proxy's request record separately.

## State

The named `openclaw_state` volume is mounted at `/home/node/.openclaw`. Configuration,
sessions and existing workspaces remain there unless explicitly configured otherwise.
Editing the seed in this repository does not update an existing volume. Preserve
customized agents, skills, tools and memory integrations when changing live config.

The first repository version mounted state under `/root`, while the image runs as
`node`. Before recreating a deployment from that version, preserve its actual state,
for example with `docker cp <old-container>:/home/node/.openclaw ./export`. Validate
the exported contents against the source and keep a separate second copy before
relying on it for recovery. A copied directory alone is not a verified backup.

## Optional host-shared brain

Keep instructions, shared skills and curated notes in a separate **private**
`openclaw-brain` checkout. Do not put that checkout, agent memory or live config in
this public deployment repository. The brain is mounted at `/home/node/brain`,
separately from `openclaw_state`.

### Prepare and render

1. Place the brain checkout on the **Docker host**. A laptop path is not a path on a
   remote Coolify server. Use an absolute path; for example `/srv/openclaw-brain`.
2. Check the actual container UID/GID (`id` in its terminal) and arrange read/write
   access for that user on this specific directory. Do not recursively change an
   existing tree's ownership or make it world-writable. Check the host user's access
   too if the host and container use different IDs.
3. Set `OPENCLAW_BRAIN_PATH` in your uncommitted environment file, quoting paths with
   spaces, and explicitly enable both Compose files:

   ```sh
   docker compose --env-file .env \
     -f docker-compose.yml -f docker-compose.brain.yml config --quiet
   ```

The base Compose file does not require a brain path. The overlay requires a nonempty
path and uses `create_host_path: false` so a missing source fails at container creation
rather than silently creating an empty checkout. Rendering alone does not check that
the path exists or that the container user can write to it.

### Validate before activation

Use an isolated test deployment first. Verify the resolved configuration retains the
state volume and existing port mappings and adds a read-write bind at `/home/node/brain`.
Then put a known fixture on the host, read its exact contents from the container, write
a different result back as the actual non-root container user, and verify that result
on the host. Also test a missing source and an unwritable directory. Do not count a
successful container start as proof of read/write sharing.

### Coolify activation is not yet verified

The overlay above is the local/testing integration. This change does not provide a
verified activation recipe for Coolify. Before using it there, confirm that Coolify's
Compose-file selection and generated configuration preserve **both** files and the host bind. Do not assume its storage UI or Compose
rewrite supports this overlay. If the bind cannot be retained, activation is blocked;
copying the brain into the image does not meet the host-sharing requirement. No live
Coolify activation is performed by this repository.

After validation, append `/home/node/brain/skills` to the existing
`skills.load.extraDirs` in the persisted config. Keep all other entries and check for
duplicate skill names. Follow the actual gateway version's reload/restart requirements.
The mount alone does not activate skills.

Do not change `agents.defaults.workspace`, replace agent instructions or reseed config
as part of mounting the brain. Migrate one agent only in a separate, reviewed step,
with its existing files preserved and a rollback. Keep internal `agentDir`, credentials
and sessions in the state volume. Git synchronization and Hindsight changes are not
part of this setup. A bind mount is neither remote synchronization nor a backup.

## Tests

Python 3.10+ and Docker Compose are required. These tests do not contact LiteLLM, build
images, start containers or use real credentials:

```sh
python3 -B -m unittest discover -s tests -v
```

They execute the Dockerfile's startup command against temporary files with a gateway
stub, validate the example model against the seed, and render the actual Compose files.
A missing Compose executable fails the suite. Runtime checks with the pinned image
and a disposable state volume are a separate requirement before deployment.
