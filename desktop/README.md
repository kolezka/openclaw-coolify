# Desktop security policy

`chromium-seccomp.json` derives from Moby's default seccomp policy at revision
`4b8214fc4971e06172938a1f1554ccff6647ee80`:

https://github.com/moby/profiles/blob/4b8214fc4971e06172938a1f1554ccff6647ee80/seccomp/default.json

The upstream license is included in `seccomp.LICENSE` (Apache-2.0).

The local change is one extra `SCMP_ACT_ALLOW` rule for `clone`, `setns` and
`unshare`. Chromium needs these calls for its user-namespace sandbox. Every other
rule and the default deny action are retained. `clone3` retains the upstream
ENOSYS fallback for containers without `CAP_SYS_ADMIN`.

These exceptions apply to the entire gateway container, not just Chromium, and
allow more than user-namespace creation alone. Kernel capability checks still
apply. Compose also enables `no-new-privileges`, so the sandbox does not rely on
the setuid helper gaining root privileges. Do not replace this policy with
`seccomp=unconfined`, add `SYS_ADMIN`, or pass `--no-sandbox` to Chromium.

The host must permit unprivileged user namespaces. An AppArmor or host sysctl
restriction can still block the browser even with this policy; diagnose that on
the target host rather than disabling its protections automatically. Verify that
Coolify preserves both `security_opt` entries and can read this repository file
when it creates the container.

When updating this vendored policy, compare it with the pinned upstream file,
review new syscall permissions, and rerun both image tests. Keep the upstream
revision and license with the modified policy.
