# openclaw-coolify

[OpenClaw](https://github.com/openclaw/openclaw) on Coolify, routed through a LiteLLM proxy.

The Dockerfile starts the gateway with `--bind lan` and copies `openclaw.json` into the
state volume on first boot. If that copy fails, startup stops. An existing config is
never overwritten. The seed uses `${ENV}` references for credentials; OpenClaw resolves
them at load time. This does not prevent the running application from storing other
credentials or private state in its volume.

## Deploy

1. In Coolify, create a Docker Compose resource pointing at this repository.
2. In Coolify's environment UI, set the required values from `.env.example`:
   gateway token, dashboard origin, LiteLLM URL/key/model and `DESKTOP_VNC_PASSWORD`.
   The VNC password must be runtime-only, not a build variable. Keep VNC bound to
   loopback until the LAN checks below pass. For local use, put real values in an
   uncommitted `.env`, never in `.env.example`. Compose rejects missing values.
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
configuration compatibility. `OPENCLAW_VERSION` defaults to `2026.10.1`; that default
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

## Persistent desktop

The container runs one XFCE session on display `:1`, shared by native VNC, the
OpenClaw **Desktop** panel and the `cua-computer` provider. It is not the host's
physical desktop or the Browser/Browserless panel. Closing viewers does not stop
the session. XFCE logout restarts only the visual session; a failed X server or
private D-Bus ends the stack so Docker starts a fresh, consistent one.

The image includes `xfce4-terminal`, Google Chrome on amd64, and Chromium on both
amd64 and arm64. The **Web Browser** desktop shortcut selects Chrome when installed
and Chromium otherwise. Existing Browserless routing is not changed. The current
OpenClaw pin is `2026.10.1`; Host Desktop and Linux CUA remain experimental upstream.

### Connect from macOS or WebUI

Set `DESKTOP_VNC_BIND_ADDRESS` to the Docker host's private IPv4 address only after
checking the host firewall and Docker-network boundaries. Its default is
`127.0.0.1`, which intentionally does not allow a remote Mac to connect. The default
host port is `5901`; `DESKTOP_VNC_PORT` can change that publication.

On the Mac, replace this example address with the host's actual LAN address:

```sh
open vnc://192.168.1.10:5901
```

Enter the VNC password in macOS Screen Sharing. No SSH tunnel or Linux login is
needed. In OpenClaw WebUI, open `/systems`, select the gateway host and open
**Desktop**. The sidebar's **Dashboards** page is a different feature. Pinning a
navigation item is a viewer preference, separate from keeping this server alive.

### Credentials and network boundaries

Set `DESKTOP_VNC_PASSWORD` as a literal, runtime-only Coolify secret. VncAuth has an
eight-byte effective limit; startup requires exactly eight printable ASCII bytes
rather than truncating a longer value. Use a random password, not an account or
gateway password. Do not put it in a URL, command argument, build argument or logs.

The plaintext file used by the WebUI and TigerVNC's password representation live
in owner-only tmpfs under `/run/openclaw-desktop`. Startup refuses to store them on
persistent disk. The secret is removed from supervised child environments; it is
still an operator-managed Docker/Coolify environment secret.

Classic VNC does not encrypt screen/input traffic. Anyone with its password can
operate the terminal as `node` and access container state. Bind only the intended
LAN address, do not add an Internet/router forward, and verify source filtering
for both the host-published port and direct access from other Docker containers.
Private binding alone is not a firewall. Keep the gateway's loopback connection
to container port 5900 available. Disabling Host Desktop in Labs hides the WebUI
source; it does not stop the independent native VNC listener.

The gateway remains non-root and uses the [dedicated seccomp policy](desktop/README.md)
with `no-new-privileges:true`. No `--no-sandbox`, `SYS_ADMIN`, host network or Docker
socket is needed. The namespace exceptions affect the whole container. Verify
Coolify retains the security settings and private tmpfs. Debian may use `/tmp` for
Chromium shared memory despite the service's 1 GB `/dev/shm` allocation.

### Persistent files

Google Chrome uses `/home/node/.openclaw/desktop/google-chrome`; Chromium keeps its
separate `/home/node/.openclaw/desktop/chromium` profile. Desktop, Downloads and
Documents under `/home/node` point to matching directories under
`/home/node/.openclaw/desktop`. XFCE settings at `/home/node/.config/xfce4` point to
`/home/node/.openclaw/desktop/xfce4`. These paths share the existing state volume;
the rest of the home directory is not mounted. Missing directories and default
launchers are seeded at startup; existing user files are not overwritten.

Do not share a browser profile between live containers. The stable hostname helps
recover its lock after an unclean replacement. Container replacement preserves
these files, not process memory or every open window. Other home files outside the
state volume remain volatile. Before replacing an older container, copy valuable
files and XFCE settings from its writable layer into the corresponding persistent
paths during the exclusive write window. Check for existing destination files and
resolve conflicts rather than overwriting them. This migration is not automatic.

### Activate on an existing volume

Do not deploy this image over an on-demand managed configuration without preparing
the transition. Startup deliberately rejects that mismatch. Do not replace live
`openclaw.json` with the seed: that loses agents, models, memory and access rules.

1. Test the candidate image in isolation. Rehearse older OpenClaw upgrades on a
   private state copy; the existing shell CMD does not trigger the upstream
   entrypoint's automatic doctor migration. Do not repair the only live copy.
2. Acquire one production-write window. Verify recovery copies against their source
   and retain the previous image, source/Compose revision, environment settings and
   original values of every configuration path being changed.
3. Set the runtime-only VNC secret and intended private bind address in Coolify.
   Inspect generated Compose, network membership and firewall behavior before use.
4. Generate a fresh, minimal activation patch using `desktop/configuration.mjs`.
   It reads JSON5 and prints a **merge patch**, never a complete config or an
   automatic write. It preserves current allowlist entries and other settings.
   From the same snapshot, prepare an inverse patch containing the original value
   of each changed field, or `null` if that field did not exist. Save original arrays
   whole, including `alsoAllow`, plugin `allow` and each changed agent `deny` list.
   Review both patches before proceeding; the helper emits only the forward patch.
5. Apply it through `config.patch` using the `hash` from the same fresh `config.get`
   snapshot as `baseHash`. Put the serialized patch in `raw`. Abort and recompute on
   a revision conflict. **Do not paste the patch over the whole Raw editor.** In the
   editor, change only those paths in the existing document.
6. Switch immediately to the candidate image. The transition briefly interrupts
   desktop viewing. Confirm `changedPaths`, active config and process health rather
   than treating persistence alone as an applied change.

The helper is included at `/app/deploy/configuration.mjs` in the candidate image.
An operator can run it with `--entrypoint node`, `--network none` and only the
configuration file mounted read-only. This is an explicitly approved administrative
preview, not a test against production state. Never export the full private config
into this repository or a public log.

The attachment fields are `desktop.host.enabled=true`, `managed=false`, `port=5900`
and `passwordFile=/run/openclaw-desktop/vnc-password.txt`. The gateway's DISPLAY and
private D-Bus environment point to the same persistent desktop. Do not turn managed
mode back on for this image. Preflight reads literal JSON5 fields, not `$include`
or environment substitutions in these attachment fields. Resolve them to explicit
values during the reviewed activation step. The CLI patch preview also expects a
self-contained configuration; use the resolved `config.get` snapshot when settings
come from includes. Do not treat a patch generated from an unresolved file as safe.

The helper explicitly enables `cua-computer`, appends `computer` to global
`tools.alsoAllow`, preserves entries such as `llm-task`, and updates an existing
plugin allowlist without replacing it. Existing `noclegi` and `samorzad` entries
retain their deny lists and gain an explicit `computer` denial if needed. Absent
agents are not invented. Reapply the appropriate exception when creating or
recreating one of those agent definitions.

These are tool-policy restrictions, not OS/tenant isolation. An agent that retains
shell/file access may still reach resources owned by the same container user. Do
not use this shared desktop for mutually untrusted agents. Native VNC input and
agent input share one keyboard; serialize interactive work. Native VNC does not
pause the agent automatically.

A model-driven desktop session requires a vision-capable model. Keep existing model
metadata/defaults until a suitable model is selected and verified; do not relabel a
text-only model as image-capable.

Validate with `node openclaw.mjs config validate --json` and the focused
`node openclaw.mjs doctor --lint --only cua-computer/driver-artifacts` check. See the
[config RPC contract](https://docs.openclaw.ai/gateway/configuration/config-rpc)
for revision checks and deferred-application handling.

### Verify after deployment

1. Confirm the image/revision, non-root user, security options, tmpfs and private
   port binding on the actual container. Test that unrelated network peers cannot
   reach VNC. Do not infer this from Compose text alone.
2. Open the same desktop through macOS Screen Sharing and WebUI. Launch Terminal
   and Chrome and load a neutral page; leave one viewer open while closing the other.
3. Ask KWAK to use `computer` on the gateway and type into a harmless form. Confirm
   the visible result and effective tool denial for `noclegi`/`samorzad`, including
   their subagents. Do not test with credentials.
4. Exercise profile recovery only in an isolated copy or an approved maintenance
   window. A real-container restart closes applications even though files persist.

Viewing alone does not prove model-driven control, and a successful build does not
prove native macOS acceptance. Keep these outcomes separate.

For rollback, restore the previous source/Compose revision and image, the changed
configuration paths and any environment values introduced by this rollout. Apply
the saved inverse with a fresh `config.get` hash as `baseHash`. If a changed field
no longer matches the value applied during rollout, stop and reconcile that edit
instead of overwriting it. Remove
or restrict the new VNC publication and revoke its secret if appropriate. Do not
leave a new native listener exposed merely because Host Desktop was disabled in
Labs. Preserve the state volume and user files.

### Image and policy checks

Tests use disposable containers, dummy credentials, private test volumes and
`--network none`, without publishing ports or mounting production state. They test
the actual entrypoint, VncAuth, process lifetimes, retained configuration, launchers,
browser sandbox, combined native-VNC/CUA input and real parent/child tool policies.
No LLM credentials are used. The Node tests require a built image and Docker Compose.

```sh
docker build -t openclaw-desktop:lan-test .
OPENCLAW_TEST_IMAGE=openclaw-desktop:lan-test \
  node --test --test-concurrency=1 tests/*.test.mjs
OPENCLAW_TEST_IMAGE=openclaw-desktop:lan-test \
  node tests/profile-recreate.mjs
```

On a native amd64 Docker engine, add `OPENCLAW_REQUIRE_NATIVE_AMD64=1` to the Node
test command and also run profile recovery with
`OPENCLAW_TEST_BROWSER=google-chrome-stable`. ARM Chromium coverage is not Chrome
acceptance. Set `OPENCLAW_TEST_CPUS`, `OPENCLAW_TEST_MEMORY` and
`OPENCLAW_TEST_PIDS_LIMIT` to cap test-container resources on a shared test host.
The tests do not replace a real macOS Screen Sharing check or a production firewall
check. The build recipe also works with Docker's legacy builder; it does not need
Buildx-only COPY flags.

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

The image tests above require Node 20+ and Docker. Python 3.10+ and Docker Compose
are required for the lightweight checks below. These Python tests do not contact
LiteLLM, build images, start containers or use real credentials:

```sh
python3 -B -m unittest discover -s tests -v
```

They execute the Dockerfile's startup command against temporary files with a gateway
stub, validate the example model against the seed, and render the actual Compose files.
A missing Compose executable fails the suite. Runtime checks with the pinned image
and a disposable state volume are a separate requirement before deployment.
