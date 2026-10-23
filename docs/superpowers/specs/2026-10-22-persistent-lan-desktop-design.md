# Persistent LAN Desktop

## Goal

Provide one persistent Linux desktop for OpenClaw WebUI, direct macOS VNC access on the LAN, and authorized agents. Add a terminal and Google Chrome with visible launchers. A user must not need an SSH tunnel to view it.

## Agreed requirements

- Native VNC at the deployment host's LAN address, using port 5901. The intended host address is supplied through Coolify, not hardcoded into the image.
- The same XFCE session serves WebUI and native VNC. Closing either viewer must not stop it.
- Terminal and Google Chrome on the production Linux/amd64 host.
- Computer access is allowed by default. KWAK and its same-agent subagents may use it; noclegi and samorzad must retain explicit computer denials and their other restrictions.
- Preserve OpenClaw state, existing Chromium data, agent workspaces, models, Hindsight configuration and the optional brain mount.
- Never disable Chromium/Chrome sandboxing or enable privileged mode, host networking or SYS_ADMIN.

## Current evidence

The deployed OpenClaw is 2026.10.1. Its managed desktop starts lazily and ends when its observers and computer executions release it. The current image contains Chromium but neither Google Chrome nor xfce4-terminal/xterm.

The shipped computer service chooses a native desktop whenever managed mode is not selected, and gives its helper the gateway process environment. Therefore the persistent desktop and gateway must share DISPLAY and DBUS_SESSION_BUS_ADDRESS. Merely publishing a managed VNC port is insufficient.

The gateway's host viewer accepts an existing loopback RFB listener and a plaintext passwordFile. Existing config is first-boot seeded only; changing the repository seed does not activate settings on a retained volume.

## Architecture

Use a persistent X11 session inside the existing gateway container. A small process-supervision entrypoint runs a private D-Bus daemon, TigerVNC, XFCE and the existing gateway command. All run as node. DISPLAY is :1 and the private bus lives at /run/openclaw-desktop/bus.

The entrypoint keeps tini as PID 1 and preserves the current CMD and its fail-closed, first-boot-only config copy. It delegates gateway execution through the existing /app/docker-entrypoint.mjs adapter. It does not rewrite live OpenClaw configuration. D-Bus, Xvnc and the gateway share a lifetime: an unexpected exit ends the container instead of silently replacing the display under an active computer execution. The Docker restart policy then starts a fresh stack. XFCE logout or a session-manager crash restarts only the visual session on the same X server, with bounded backoff; it must not restart the gateway or interrupt unrelated agent work.

TigerVNC listens on container port 5900 with VncAuth. Docker publishes it on one explicitly chosen host IPv4 address and host port 5901. The default bind is 127.0.0.1; LAN activation requires selecting the host's private address. No new HTTPS/public proxy route is added. Preserve the current 18789/18790 mappings and optional brain overlay.

OpenClaw uses desktop.host.enabled=true, managed=false, port=5900, and passwordFile=/run/openclaw-desktop/vnc-password.txt. This avoids a second managed display. The gateway receives the same display and bus environment as XFCE, so native CUA controls the visible desktop.

## Authentication and boundaries

DESKTOP_VNC_PASSWORD is a runtime-only Coolify secret. Classic VncAuth has an eight-byte effective password limit; require exactly eight printable ASCII bytes rather than silently truncating. Reject missing/invalid secrets before starting VNC or the gateway. Never put a real password in source, command arguments, logs or the worklog.

Create plaintext and TigerVNC password representations in an owner-only tmpfs directory. Use the native tigervncpasswd tool through stdin; remove the secret from child environments after writing the runtime files. Retain the existing custom seccomp policy and no-new-privileges.

Classic VNC does not encrypt the screen or input. LAN binding is not a substitute for a source firewall. Before deployment, inspect the host's actual subnet, application-network membership and Docker firewall backend. Verify or configure a narrowly scoped LAN-only rule with an explicit rollback, covering both the published port and direct access to container port 5900 from other containers. Preserve gateway loopback access for WebUI. Do not assume a shared Docker network is trusted, add NET_ADMIN to the application, change unrelated firewall policy, or claim private binding alone excludes routed traffic.

## Applications and persistence

Install xfce4-terminal. Install Google Chrome on amd64 from Google's signed repository using a repository-scoped keyring. Retain Chromium for existing profiles and arm64 development; an arm64 Chromium test is not proof of production Chrome compatibility.

Use CHROME_USER_DATA_DIR=/home/node/.openclaw/desktop/google-chrome for Google Chrome on Linux. Keep the existing Chromium profile separate. Provide executable desktop launchers for Chrome/Chromium and Terminal without exposing credentials. The normal application menu must work too.

Closing a viewer preserves the session. Container replacement recreates the desktop and applications; it preserves browser profile files, not running-process memory or every open window.

Scope approved on 2026-10-23: persist Desktop, Downloads, Documents and XFCE settings in the existing state volume. Link the standard home paths to named directories under `/home/node/.openclaw/desktop`; keep other home paths unchanged. Create missing directories on retained volumes without overwriting user files. Verify saved content after container replacement. Migrating files from an older container's writable layer is an explicit pre-rollout step, not an automatic overwrite.

## Agent policy

Enable cua-computer explicitly and add computer to the existing global alsoAllow list without dropping other entries. For existing noclegi and samorzad entries, retain their deny lists and ensure computer is present. Do not create placeholder agents or change routing, workspace, model, memory or cross-agent spawning permissions.

A pure policy-patch helper may produce only these targeted changes; it must not rewrite configuration at startup. Regenerate list values from a fresh config at apply time and use the configuration revision/hash to detect a concurrent edit. The pinned version uses agents.entries; reject a legacy agents.list array rather than partly replacing it. A new unrestricted agent inherits default access. Validate KWAK/main, an unrestricted fixture agent, their subagents, and the two excluded agents plus their same-agent subagents through the real policy resolver before committing to this architecture.

One shared desktop does not provide independent simultaneous keyboards. Interactive work must be serialized; do not silently lower global agent concurrency or claim native VNC pauses agent input. A vision-capable model remains necessary for model-driven interaction. Do not change model declarations or defaults without separate agreement.

## Retained-volume transition

Build and test the candidate before touching production. In an exclusive deployment window, read the latest config and its revision, prepare the targeted patch and an inverse patch of only changed paths, then apply attachment/policy changes before switching images. This briefly interrupts desktop viewing while the old gateway has no persistent VNC server; do not schedule desktop work in that window. Switch immediately to the tested image. On failure, restore the old image and the changed fields without replacing unrelated state. Abort and re-read on a revision conflict.

The startup wrapper must not auto-migrate agents or overwrite the retained configuration. A mismatched desktop configuration must fail visibly in preflight rather than quietly selecting another display. Native CUA feasibility and real subagent-policy inheritance are required disposable-environment proofs before implementing the permanent supervisor.

## Acceptance and rollout

1. Fresh and retained-volume startup preserve the existing copy guard and config bytes.
2. Missing/invalid VNC credentials fail closed; incorrect VNC authentication is rejected.
3. Native VNC and WebUI reach the same display. Closing all viewers does not stop it.
4. Native VNC input followed by CUA input reaches one test form with the exact combined marker.
5. Terminal launches; production Chrome launches with sandboxing enabled and uses its persistent profile.
6. Browser profiles reopen after an unclean container replacement.
7. Effective computer access allows main/unrestricted agents and rejects noclegi/samorzad, including their subagents.
8. Test the target linux/amd64 image and macOS Screen Sharing before declaring production acceptance.
9. Coordinate one production writer. Stage only targeted config changes during a deployment window, verify rollback first, and do not overwrite the live configuration with the seed.

## Non-goals

No Internet-facing VNC, no SSH tunnel requirement, no separate desktop per agent, no automatic migration of browser cookies, no new unrestricted agent permissions beyond computer, and no automatic model switch. This work does not activate or rewrite the separate brain deployment.
