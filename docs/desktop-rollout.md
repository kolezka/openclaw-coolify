# Desktop rollout gates

This is an operator checklist, not permission to change production. The default
mode is WebUI-only. Direct LAN VNC is a separate, explicitly enabled step.

## 1. Freeze the inputs

Choose one writer and an approved maintenance window. Record the candidate image
ID, source commit, existing image ID, stable hostname, state volume identity, brain
bind source and the actual Compose start command. Compare the generated deployment
with those values; a new empty volume is not a migration.

Keep private brain instruction activation separate. Retain an already-active brain
bind and its overlay without changing agent workspaces, instructions, memory or
model defaults. Do not infer the live mounts from a saved base Compose file: an
overlay may have added them.

Confirm the candidate's exact source/image match and run both test groups:

```sh
CANDIDATE_IMAGE=openclaw-desktop:lan-test
OPENCLAW_TEST_IMAGE="$CANDIDATE_IMAGE" node --test --test-concurrency=1 tests/*.test.mjs
python3 -B -I -m unittest discover -s tests -p 'test_*.py'
python3 -B -I tests/brain-runtime.py --image "$CANDIDATE_IMAGE"
```

The brain harness intentionally accepts only a local Docker Desktop context.
Native amd64 Chrome and production network/client checks are separate evidence.
Do not disable that harness's local-only guard to test a production volume.

## 2. Prepare recovery and file migration

Use the operator's approved encrypted recovery process, outside this repository.
Quiesce writes before taking a consistent state snapshot. Validate its structure,
compare the copied data with the source and verify a second recoverable copy exists
on another machine. A tar file or successful copy command alone is not a backup.
Do not place credentials, session data or private configuration in source control,
model output or the worklog.

Preserve the old image and the old deployment configuration. Inventory Desktop,
Downloads, Documents and XFCE settings in the old container's writable layer. Copy
those into the corresponding state-volume directories only after checking existing
destinations. Refuse collisions and symlink destinations for files being replaced;
do not follow links outside the selected source tree. Preserve the originals until
recovery is verified. Do not recursively change ownership of unrelated state.

Rehearse the operation on disposable fixtures first. Require decoded file contents
and an unchanged existing destination on refusal, not just a successful exit.
The repository's file-replacement tests prove the persistent paths; they do not
claim to have migrated an operator's existing files.

## 3. Activate WebUI-only mode first

Keep `DESKTOP_VNC_BIND_ADDRESS=127.0.0.1`. This deliberately does not offer native
VNC through the host's loopback port. In-container VNC remains password-protected
for the authenticated gateway viewer, and X11 clients require the runtime cookie.

Set the VNC password through the secret UI as runtime-only, never a build variable
or a shell argument. Use exactly eight printable ASCII bytes. Compose does not require
it, because Coolify interpolates the file during the build without runtime-only values;
the container refuses a missing or invalid password at startup. Verify the generated
container retains the private runtime tmpfs, seccomp, no-new-privileges, state
volume, brain overlay and shutdown budget.

Read the fresh application configuration and revision. Generate the targeted patch
with `desktop/configuration.mjs`; save the original values of only the affected
fields, including complete arrays. Prepare and review the inverse patch: restore
original values and use merge-patch null only for fields absent in the original.
If an original field explicitly contains null, do not treat deletion as an exact
restore; resolve the rollback method before applying anything.

Apply the forward patch using the revision from the same read, then switch to the
verified candidate image immediately. This briefly interrupts desktop viewing.
Abort on a revision conflict. Do not overwrite the configuration with the seed or
silently remove a restrictive tool/provider policy.

Before LAN enablement, verify gateway health, WebUI rendering and native CUA on the
same display. Confirm Docker peers can reach the expected gateway endpoint but
cannot connect to VNC. Confirm the protected agents still deny computer, including
spawned children. If ACP is used, check its inherited-policy compatibility.

## 4. Enable LAN only after host isolation is ready

An explicit private `DESKTOP_VNC_BIND_ADDRESS` enables VNC on the container's network
interfaces. That address selects the host publication; it is not assigned to the
container and must not be passed blindly to TigerVNC's `-interface` option.

Before enabling it, review a host-specific filter and its exact undo operation:

- Permit the published VNC port only from the intended LAN source and interface.
  Do not use RFC1918 membership alone as proof that a caller is trusted.
- Block direct access to container VNC from every other attached Docker peer,
  including a shared proxy or memory service, while preserving gateway loopback.
- Account for forwarding rules that accept before `DOCKER-USER`, including VPN
  rules, and for same-bridge traffic that may never traverse the IPv4 filter chain.
  Verify the bridge filtering mechanism rather than assuming a sysctl exists.
- Account for container address changes on replacement. A rule protecting only the
  old container IP must not leave the replacement exposed.
- Keep existing SSH, gateway, proxy and other application flows unchanged. Do not
  give the application NET_ADMIN, host networking or the Docker socket to install
  host policy.

No generic firewall script is supplied here: rule ordering, bridge hooks and VPN
paths must be verified on the actual host. Do not flush shared rulesets. Install
only the approved scoped rules, with a working rescue channel and a prepared undo.

Require both positive and negative connectivity tests: an allowed Mac authenticates
and displays the desktop; an unauthorized source and a Docker peer cannot reach
VNC; WebUI still works. A closed port before the new listener starts proves nothing
about its future isolation. Classic VncAuth remains unencrypted with an eight-byte
password limit; this mode is not suitable for an untrusted network.

## 5. Roll back without replacing unrelated state

If activation fails, restore the previous image and deployment settings, keeping
the same state volume and brain bind. Use a fresh config revision for the inverse
patch. If any affected field no longer equals the value applied in this window,
stop and reconcile rather than overwrite another writer's change.

Remove or restrict the new VNC publication and undo only the firewall rules added
in this window. Disabling the WebUI Desktop source does not stop a native listener.
Keep migrated files and the original recovery material until rollback is verified.
Check gateway health and preserved state through the restored runtime, not merely
by observing that Docker restarted a container.
