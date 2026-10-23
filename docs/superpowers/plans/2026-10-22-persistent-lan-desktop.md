# Persistent LAN Desktop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Provide a persistent XFCE desktop shared by native LAN VNC, OpenClaw WebUI and authorized agents, with terminal and Chrome launchers.

**Architecture:** Keep the existing gateway container and state volume. A small fail-fast entrypoint supervises the private D-Bus, TigerVNC, XFCE and original gateway command in one display environment. OpenClaw attaches to that persistent display rather than owning an on-demand managed session.

**Tech Stack:** OpenClaw 2026.10.1, Docker Compose, Bash/tini, TigerVNC, XFCE, Google Chrome on amd64, Chromium on arm64, Node built-in tests, Python unittest.

**Spec:** `docs/superpowers/specs/2026-10-22-persistent-lan-desktop-design.md`

## Global Constraints

- Work on `feat/persistent-lan-desktop` in the existing isolated worktree, based on `fb03aaa`.
- Do not commit, push, merge or deploy this new change set without the corresponding approval.
- Preserve the existing state volume, original CMD copy-failure guard, ports 18789/18790, model declarations, Hindsight and optional brain overlay.
- Run services as node, keep sandboxing and no-new-privileges, and add no capabilities, host networking or Docker socket. The new ENTRYPOINT must be `["tini", "-s", "--", "/app/deploy/start-desktop.sh"]` so PID 1 still reaps children.
- DISPLAY=:1; DBUS_SESSION_BUS_ADDRESS=unix:path=/run/openclaw-desktop/bus; container VNC port 5900; default host port 5901.
- DESKTOP_VNC_BIND_ADDRESS defaults to 127.0.0.1. LAN use requires an explicit private IPv4 address and a target-host firewall check.
- DESKTOP_VNC_PASSWORD is runtime-only, exactly eight printable ASCII bytes, never a build argument or logged value.
- Runtime credentials live under /run/openclaw-desktop on owner-only tmpfs, not in the persistent state volume.
- Default computer access is additive. Existing noclegi/samorzad denials and all unrelated restrictions remain intact. Do not invent agent entries.
- No model switch. A real vision-model acceptance test requires separate selection and credentials.

## Review Focus

- Missing/malformed VNC secrets: fail before starting a desktop or unauthenticated listener; never reveal the supplied value. Task 1.
- VNC/D-Bus/display death and container shutdown: stop the whole stack, preventing old CUA references from silently targeting a replacement display. XFCE logout must restart only XFCE, not the gateway. Task 1.
- A retained profile after SIGKILL: reopen without deleting user data; Chrome and Chromium must not share profile directories. Task 2.
- Restricted parents spawning subagents: noclegi/samorzad must not recover computer access through the default grant. Task 3.
- Repeated configuration activation: preserve other tool grants, plugin settings, workspaces, models and optional brain mounts. Task 3.

## File Map

- Modify `Dockerfile`: runtime prerequisites, applications, shared display environment, entrypoint and launchers. Keep the existing CMD.
- Modify `docker-compose.yml`: private VNC publication, secret input, runtime tmpfs and graceful shutdown budget. Preserve existing mappings/security/volumes.
- Modify `.env.example`: runtime-only VNC settings without real credentials.
- Create `desktop/start-desktop.sh`: credential preparation and bounded, fail-fast process lifecycle only. It never patches live OpenClaw configuration.
- Create `desktop/run-xfce.sh`: restart an ended XFCE session on the same X server with bounded backoff; stop cleanly when its supervisor terminates.
- Create `tests/native-desktop-proof.mjs`: disposable native-X11/CUA and real parent/subagent-policy feasibility gate.
- Create `desktop/launchers/terminal.desktop` and `desktop/launchers/browser.desktop`: visible, executable launchers.
- Modify `openclaw.json`: first-boot persistent-desktop attachment defaults only.
- Create `desktop/configuration.mjs`: pure, targeted activation-patch generator.
- Modify `tests/deployment.test.mjs`, `tests/desktop-smoke.mjs`, `tests/profile-recreate.mjs`: align contracts and smoke checks with persistent startup.
- Create `tests/persistent-desktop.test.mjs` and `tests/desktop-policy.test.mjs`: lifecycle/authentication and permission-preservation cases.
- Preserve and run `tests/test_deployment.py` and `tests/test_brain_mount.py`; extend fixture env values only where new required inputs demand it.
- Modify `README.md` and `desktop/README.md`: setup, native macOS access, lifecycle/security limits, migration, verification and rollback.

### Task 0: Prove the upstream integration before changing startup

**Consumes:** The existing local OpenClaw 2026.10.1 image and the SDK usage in tests/desktop-smoke.mjs.

**Produces:** A go/no-go result for native Linux CUA and the required real tool-policy inheritance. No production mutation and no product implementation yet.

- [ ] Write tests/native-desktop-proof.mjs to create temporary state, a private D-Bus and a fixed Xvnc display inside a disposable container. Use desktop.host.managed=false and supply DISPLAY and DBUS_SESSION_BUS_ADDRESS to the gateway. Require an actual screenshot and exact typed-text readback through the native CUA route, with no paired node or model credentials.
- [ ] Exercise the real effective-tool resolver with main, an unrestricted fixture agent, noclegi and samorzad, including genuine same-agent child-session context. Do not count a fabricated session-key string as proof of subagent inheritance. Main and unrestricted cases are positive controls before the negative deny assertions.
- [ ] Run: `docker run --rm --init --network none --shm-size=1g --security-opt no-new-privileges:true --security-opt "seccomp=$PWD/desktop/chromium-seccomp.json" --entrypoint node --mount "type=bind,source=$PWD/tests,target=/app/tests,readonly" openclaw-desktop:test /app/tests/native-desktop-proof.mjs`. Expected: native CUA readback succeeds and all allow/deny cases match the spec.
- [ ] If either integration fails, stop and revise the design before implementing the supervisor. Do not weaken restrictions or silently fall back to the old managed desktop.

### Task 1: Persistent desktop lifecycle and authenticated LAN endpoint

**Consumes:** Existing image CMD, state volume, security policy and OpenClaw host-viewer contract.

**Produces:** One persistent :1 display, private D-Bus at the specified path, VncAuth listener on container port 5900, password representations at `/run/openclaw-desktop/vnc-password.txt` and `/run/openclaw-desktop/vnc-password.hash`.

- [ ] Add `tests/persistent-desktop.test.mjs` cases asserting: missing/empty/non-ASCII/wrong-length secrets cause nonzero exit with no listener; logs contain no supplied secret; correct credentials work; an incorrect VNC response is rejected.
- [ ] Add lifecycle cases asserting: one X server exists; the display remains after every viewer disconnects; killing Xvnc or D-Bus stops the gateway/container rather than replacing the display underneath it; XFCE logout/crash restarts only that session while gateway and X-server PIDs stay unchanged; normal shutdown is bounded.
- [ ] Run the new cases against the existing image/configuration and capture expected missing-feature failures. Keep test resources isolated and clearly named.
- [ ] Implement `desktop/start-desktop.sh`. Prepare files with umask 077, create the TigerVNC representation through stdin, unset the password before spawning children, wait for the display with a bounded readiness probe, and supervise all child lifetimes. Pass the original CMD through `/app/docker-entrypoint.mjs` as the gateway child. Preserve nonzero status on unexpected child exit and terminate the whole stack on shutdown.
- [ ] Update Dockerfile/Compose with the shared environment, owner-only runtime tmpfs, secret input, private-address publication and a shutdown budget compatible with gateway draining. Do not expose VNC through the public HTTP proxy.
- [ ] Set the seed to enabled=true, managed=false, port=5900 and the specified plaintext passwordFile. The startup entrypoint must leave a retained config byte-for-byte intact; existing-volume activation belongs to Task 3.
- [ ] Extend `tests/deployment.test.mjs` to render default loopback and explicit private-IP binds, reject an unauthenticated setup, and preserve the other network/security settings.
- [ ] Run `docker build -t openclaw-desktop:lan-test .`, then `OPENCLAW_TEST_IMAGE=openclaw-desktop:lan-test node --test tests/persistent-desktop.test.mjs`. Validate real RFB authentication, not just a listening port. Reuse standard crypto for test-only VncAuth; do not implement production authentication in JavaScript.
- [ ] Run the existing startup-copy and optional-brain tests. No commit at this stage without approval.

### Task 2: Terminal, Chrome and shared-screen verification

**Consumes:** Task 1's persistent display and bus environment.

**Produces:** Visible launchers and sandboxed applications. Google Chrome uses `/home/node/.openclaw/desktop/google-chrome`; Chromium retains `/home/node/.openclaw/desktop/chromium`.

- [ ] Add failing application checks: terminal executable and launcher present; Google Chrome present on amd64; browser starts without --no-sandbox; Chrome and Chromium profile paths are distinct; repeated container replacement preserves each profile.
- [ ] Install xfce4-terminal and required X11 readiness tools. On amd64, install Google Chrome from its official signed APT repository using an isolated signed-by keyring. Keep Chromium for the existing profile and arm64 development. Do not download or execute a third-party installation script.
- [ ] Set CHROME_USER_DATA_DIR to the Chrome profile path and provide desktop/application launchers. Preserve the Chromium launcher configuration and all existing user profile data.
- [ ] Refactor `tests/desktop-smoke.mjs` to attach to a container started through its real entrypoint, rather than spawning an artificial managed gateway. Keep the existing exact form-marker and renderer-sandbox assertions.
- [ ] Extend the smoke test: authenticate a native VNC client, type a random prefix into the test form, then append a CUA-generated suffix and submit it. Assert the server receives the exact combined marker. Also verify the WebUI observer reaches the configured host desktop and a terminal window appears through native computer discovery.
- [ ] Run `node tests/profile-recreate.mjs` with both relevant browser profile selections. Keep the stable hostname; never delete locks from a potentially active profile.
- [ ] Run the image tests on native Linux/amd64 before treating Chrome as accepted. Record arm64 development results separately. No commit at this stage without approval.

### Task 3: Additive agent policy and coordinated rollout

**Consumes:** The persistent-desktop paths and application environment from Tasks 1/2; current authored OpenClaw configuration.

**Produces:** `buildPersistentDesktopPatch(config)` exported from `desktop/configuration.mjs`. It returns a JSON-merge-patch-shaped object and performs no file writes or network requests.

- [ ] Write `tests/desktop-policy.test.mjs` with literal fixtures. Assert the patch sets the four attachment fields, enables cua-computer, appends computer to global alsoAllow, preserves llm-task, and adds cua-computer to an existing plugin allowlist without replacing it.
- [ ] Assert noclegi and samorzad retain all previous deny entries and include computer. Absent protected agents must not be invented. A legacy agents.list array must be rejected with a migration instruction. Other agents, models, routing, workspaces, memory and brain settings must not appear in the patch. Reapplying the patch must be idempotent.
- [ ] Run the tests to obtain an expected failure, then implement the pure helper. Do not add an automatic per-boot config rewrite or output the complete input configuration.
- [ ] Use a disposable gateway and the actual effective-tool policy surface to assert computer is available for main, a new unrestricted agent and their same-agent subagents, but unavailable for noclegi/samorzad and their same-agent subagents. Preserve other explicit sandbox/provider restrictions; report a blocking policy instead of silently removing it.
- [ ] Document the exact retained-state sequence: test the candidate first; acquire the write window; fetch current configuration and revision; generate the patch and an inverse of only changed paths; reject any revision conflict; apply the attachment/policy patch before switching images; deploy immediately; verify. If deployment fails, restore the previous image and changed fields without replacing other state. Explain the brief desktop-viewing interruption and that native VNC input does not automatically pause agents.
- [ ] Document macOS access with `open vnc://<LAN-address>:5901`, password entry, `/systems` for the same WebUI desktop, no SSH tunnel, and the classic VNC encryption/password limits. Correct the README's stale 2026.2.26 default-version statement while updating deployment guidance.
- [ ] Run all tests: `OPENCLAW_TEST_IMAGE=openclaw-desktop:lan-test node --test tests/*.test.mjs`, `python3 -m unittest discover -s tests -p 'test_*.py'`, the real-entrypoint desktop smoke test and `OPENCLAW_TEST_IMAGE=openclaw-desktop:lan-test node tests/profile-recreate.mjs`. Run `git diff --check` and inspect the final diff/status.
- [ ] Obtain one independent whole-branch review. Recheck every actionable finding against code/runtime evidence and fix within scope.
- [ ] Before any production rollout: acquire an exclusive write window, obtain runtime-only credentials without logging them, inspect the actual LAN/firewall, application-network members and generated Coolify Compose, verify a rollback path, and secure approval for commit/push/deploy. Verify that unrelated containers cannot reach the internal VNC listener as well as limiting access to the host-published port. Do not add application capabilities to install firewall rules or bypass a denied tool through another session or interface.
- [ ] After an approved rollout, verify native macOS authentication, WebUI rendering, direct/agent input on the same desktop, default/exception tool policies and profile persistence. Release the write window and update the existing work record.

## Self-review

The tasks cover direct native VNC, persistent lifecycle, browser/terminal usability and the requested permission exceptions. No setting is claimed to force the WebUI panel to stay open across every browser: server persistence is separate from per-viewer layout/pinning. A fresh instance does not acquire invented domain agents. The real entrypoint, native amd64 image and effective permission resolver are acceptance gates, not substitutes for one another.
