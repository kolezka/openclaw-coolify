"""Opt-in local Docker acceptance; never pulls/builds or uses existing state."""

import argparse
import fnmatch
import hashlib
import io
import json
import os
from pathlib import Path
import shlex
import subprocess
import tarfile
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
STATE = "/home/node/.openclaw"
BRAIN = "/home/node/brain"
SEED = "/app/deploy/openclaw.json"
DOCKER = ["docker", "--context", "desktop-linux"]
ENV = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
ENV.update({
    "OPENCLAW_VERSION": "2026.10.1",
    "OPENCLAW_GATEWAY_TOKEN": "brain-runtime-fixture-token-not-a-secret",
    "OPENCLAW_ALLOWED_ORIGINS": "http://localhost:18789",
    "LITELLM_BASE_URL": "http://127.0.0.1:9/v1",
    "LITELLM_API_KEY": "brain-runtime-fixture-key-not-a-secret",
    "LITELLM_MODEL": "deepseek/deepseek-v4-pro",
    # Dummy value: exactly eight printable ASCII bytes, as prepare-runtime requires.
    "DESKTOP_VNC_PASSWORD": "fixture8",
    "DESKTOP_VNC_BIND_ADDRESS": "127.0.0.1",
})


def run(args, *, check=True, timeout=45, env=None):
    print("COMMAND", shlex.join(args), flush=True)
    result = subprocess.run(args, cwd=ROOT, env=env or ENV, capture_output=True,
                            text=True, timeout=timeout)
    if check and result.returncode:
        raise AssertionError(f"exit={result.returncode}\n{result.stdout}\n{result.stderr}")
    return result


def docker(*args, **kwargs):
    return run([*DOCKER, *args], **kwargs)


def docker_bytes(*args, timeout=60):
    command = [*DOCKER, *args]
    print("COMMAND", shlex.join(command), flush=True)
    result = subprocess.run(command, cwd=ROOT, env=ENV, capture_output=True, timeout=timeout)
    if result.returncode:
        raise AssertionError(f"exit={result.returncode}\n{result.stderr.decode(errors='replace')}")
    return result.stdout


def digest(data):
    return hashlib.sha256(data).hexdigest()


def dockerfile_lines(text):
    """Logical Dockerfile instructions with line continuations joined."""
    lines, current = [], ""
    for line in text.splitlines():
        stripped = line.strip()
        if not current and (not stripped or stripped.startswith("#")):
            continue
        current += " " + stripped.removesuffix("\\").strip() if current else stripped.removesuffix("\\").strip()
        if not stripped.endswith("\\"):
            lines.append(current)
            current = ""
    return lines


def dockerfile_exec_form(text, instruction):
    values = [json.loads(line[len(instruction) + 1:]) for line in dockerfile_lines(text)
              if line.startswith(instruction + " ")]
    if len(values) != 1:
        raise AssertionError(f"Dockerfile must contain exactly one exec-form {instruction}")
    return values[0]


def dockerfile_copies(text, root=ROOT):
    """Map every image path written by a COPY to its source file."""
    files = {}
    for line in dockerfile_lines(text):
        if not line.startswith("COPY "):
            continue
        tokens = shlex.split(line)[1:]
        if any(token.startswith("--from") for token in tokens):
            raise AssertionError("multi-stage COPY is not supported by this check: " + line)
        tokens = [token for token in tokens if not token.startswith("--")]
        *sources, target = tokens
        for source in sources:
            path = root / source
            if path.is_dir():
                for item in sorted(path.rglob("*")):
                    if item.is_file():
                        files[target.rstrip("/") + "/" + item.relative_to(path).as_posix()] = item
            elif target.endswith("/"):
                files[target + path.name] = path
            elif len(sources) == 1:
                files[target] = path
            else:
                raise AssertionError("multi-source COPY needs a directory target: " + line)
    return files


def dockerfile_executables(text, targets):
    """Image paths the Dockerfile marks executable with `RUN chmod 0755`."""
    patterns = []
    for line in dockerfile_lines(text):
        tokens = shlex.split(line)
        if tokens[:3] == ["RUN", "chmod", "0755"]:
            patterns += tokens[3:]
    return {target for target in targets if any(fnmatch.fnmatchcase(target, pattern) for pattern in patterns)}


def image_config_mismatches(config, text, version):
    problems = []
    for key, instruction in (("Entrypoint", "ENTRYPOINT"), ("Cmd", "CMD")):
        expected = dockerfile_exec_form(text, instruction)
        if config.get(key) != expected:
            problems.append(f"{instruction} {config.get(key)!r} != source {expected!r}")
    if config.get("User") != "node":
        problems.append(f"User {config.get('User')!r} != 'node'")
    if (config.get("Labels") or {}).get("org.opencontainers.image.version") != version:
        problems.append("image is not the target OpenClaw release " + version)
    return problems


def runtime_file_mismatches(expected, executables, actual):
    """expected: image path -> source bytes; actual: image path -> (kind, mode, bytes)."""
    problems = []
    for target, data in sorted(expected.items()):
        if target not in actual:
            problems.append(f"{target} missing from image")
            continue
        kind, mode, content = actual[target]
        if kind != "file":
            problems.append(f"{target} is a {kind}, not a file")
        elif content != data:
            problems.append(f"{target} sha256 {digest(content)} != source {digest(data)}")
        elif target in executables and mode & 0o111 != 0o111:
            problems.append(f"{target} mode {mode:o} is not executable")
    # A stale image may carry deploy files the current source no longer ships.
    for target in sorted(actual):
        if (target.startswith("/app/deploy/") and actual[target][0] == "file"
                and target not in expected):
            problems.append(f"{target} is in the image but not copied by the Dockerfile")
    return problems


def tar_tree(data, image_path):
    """Decode `docker cp <container>:<path> -` output into absolute image paths."""
    parent = image_path.rstrip("/").rsplit("/", 1)[0] or ""
    tree = {}
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        for member in archive.getmembers():
            path = parent + "/" + member.name.rstrip("/")
            if member.isfile():
                tree[path] = ("file", member.mode & 0o7777, archive.extractfile(member).read())
            elif member.isdir():
                tree[path] = ("dir", member.mode & 0o7777, b"")
            elif member.issym():
                tree[path] = ("symlink", 0, member.linkname.encode())
            else:
                tree[path] = ("other", member.mode & 0o7777, b"")
    return tree


def write_deploy_without_seed(tree, directory, seed="/app/deploy/openclaw.json"):
    """Recreate the image's own /app/deploy minus the seed, so only the seed is hidden."""
    written = set()
    for path, (kind, mode, content) in sorted(tree.items()):
        if path == "/app/deploy" or path == seed:
            continue
        if not path.startswith("/app/deploy/"):
            raise AssertionError("unexpected path in deploy tree: " + path)
        local = directory / path.removeprefix("/app/deploy/")
        if kind == "dir":
            local.mkdir(parents=True, exist_ok=True)
            local.chmod(mode & 0o755 | 0o700)
        elif kind == "file":
            local.parent.mkdir(parents=True, exist_ok=True)
            local.write_bytes(content)
            local.chmod(mode & 0o755 | 0o400)
            written.add(path)
        else:
            raise AssertionError(f"{path} is a {kind}; refusing to approximate it in the fixture")
    return written


class BrainRuntimeTests(unittest.TestCase):
    image = None

    @classmethod
    def setUpClass(cls):
        context = json.loads(run(["docker", "context", "inspect", "desktop-linux"]).stdout)[0]
        if not context["Endpoints"]["docker"]["Host"].startswith("unix://"):
            raise AssertionError("desktop-linux must use a local Unix socket")
        print("ENGINE", docker("info", "--format", "{{.OSType}}/{{.Architecture}}").stdout.strip())
        image = json.loads(docker("image", "inspect", cls.image).stdout)[0]
        cls.image = image["Id"]
        source = (ROOT / "Dockerfile").read_text()
        problems = image_config_mismatches(image["Config"], source, ENV["OPENCLAW_VERSION"])
        if problems:
            raise AssertionError("image does not match the current Dockerfile:\n" + "\n".join(problems))
        cls.entrypoint = dockerfile_exec_form(source, "ENTRYPOINT")
        copies = dockerfile_copies(source)
        expected = {target: path.read_bytes() for target, path in copies.items()}
        executables = dockerfile_executables(source, expected)
        roots = sorted({"/app/deploy" if target.startswith("/app/deploy/") else target
                        for target in expected} | {STATE})
        # Never started: only used to read image files with `docker cp`.
        name = "brain-acceptance-" + uuid.uuid4().hex[:16] + "-files"
        docker("create", "--pull", "never", "--network", "none",
               "--label", f"local.brain-acceptance={name}", "--name", name, cls.image)
        try:
            trees = {root: tar_tree(docker_bytes("cp", f"{name}:{root}", "-"), root) for root in roots}
        finally:
            info = json.loads(docker("inspect", name).stdout)[0]
            if info["Config"]["Labels"].get("local.brain-acceptance") != name or info["State"]["StartedAt"][:4] != "0001":
                raise AssertionError("refusing to remove an inspection container this suite did not own")
            docker("rm", info["Id"])
        actual = {path: entry for root in roots if root != STATE for path, entry in trees[root].items()}
        problems = runtime_file_mismatches(expected, executables, actual)
        if problems:
            raise AssertionError("image runtime files do not match this checkout:\n" + "\n".join(problems))
        cls.deploy_tree = trees["/app/deploy"]
        cls.image_state = trees[STATE]
        for target in sorted(expected):
            print("SOURCE/IMAGE SHA256", target, digest(expected[target]),
                  "exec" if target in executables else "", flush=True)
        print("IMAGE", cls.image, image["Architecture"], "ENTRYPOINT, CMD and",
              len(expected), "runtime files match source", flush=True)

    def setUp(self):
        self.project = "brain-acceptance-" + uuid.uuid4().hex[:16]
        self.container = self.project + "-gateway"
        self.volume = self.project + "_openclaw_state"
        self.temp = tempfile.TemporaryDirectory(prefix=self.project + " ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.brain = self.root / "brain path with spaces"
        self.brain.mkdir()
        self.addCleanup(self.brain.chmod, 0o755)
        self.environment = {**ENV, "OPENCLAW_BRAIN_PATH": str(self.brain)}
        self.override = self.root / "runtime.yml"
        self.compose = [*DOCKER, "compose", "--env-file", os.devnull, "-p", self.project,
                        "-f", str(ROOT / "docker-compose.yml"),
                        "-f", str(ROOT / "docker-compose.brain.yml"),
                        "-f", str(self.override)]
        self.assertEqual(self.resources("container"), [])
        self.assertEqual(self.resources("volume"), [])
        self.assertEqual(docker("container", "ls", "--all", "--filter",
                                f"name=^/{self.container}$", "--format", "{{.ID}}").stdout.strip(), "")
        self.assertNotIn(self.volume, docker("volume", "ls", "--filter", f"name={self.volume}",
                                            "--format", "{{.Name}}").stdout.splitlines())
        self.addCleanup(self.cleanup_resources)

    def resources(self, kind):
        args = [kind, "ls", "--filter", f"label=com.docker.compose.project={self.project}",
                "--format", "{{.ID}}" if kind == "container" else "{{.Name}}"]
        if kind == "container":
            args.insert(2, "--all")
        return docker(*args).stdout.splitlines()

    def cleanup_resources(self):
        for container in self.resources("container"):
            info = json.loads(docker("inspect", container).stdout)[0]
            self.assertEqual(info["Name"], "/" + self.container)
            self.assertEqual(info["Config"]["Labels"]["local.brain-acceptance"], self.project)
            docker("rm", "--force", info["Id"])
        for volume in self.resources("volume"):
            info = json.loads(docker("volume", "inspect", volume).stdout)[0]
            self.assertEqual(info["Name"], self.volume)
            self.assertEqual(info["Labels"]["com.docker.compose.project"], self.project)
            docker("volume", "rm", self.volume)
        self.assertEqual(self.resources("container"), [])
        self.assertEqual(self.resources("volume"), [])
        print("CLEANUP verified no containers/volumes for", self.project, flush=True)

    def configure(self, *, probe=False, state_read_only=False, hide_seed=False):
        service = {
            "image": self.image, "pull_policy": "never", "restart": "no",
            "container_name": self.container, "network_mode": "none",
            "labels": {"local.brain-acceptance": self.project},
        }
        if probe:
            service["entrypoint"] = ["node"]
            service["command"] = ["-e", "setInterval(() => {}, 1000)"]
        mounts = []
        if state_read_only:
            mounts.append({"type": "volume", "source": "openclaw_state", "target": STATE,
                           "read_only": True})
        self.seedless = None
        if hide_seed:
            # Hide only the seed: an empty /app/deploy would also hide the entrypoint.
            self.seedless = self.root / "deploy without seed"
            if not self.seedless.exists():
                self.seedless.mkdir()
                written = write_deploy_without_seed(self.deploy_tree, self.seedless)
                image_files = {path for path, entry in self.deploy_tree.items() if entry[0] == "file"}
                self.assertEqual(written, image_files - {SEED})
                for argument in self.entrypoint:
                    if argument.startswith("/app/deploy/"):
                        self.assertIn(argument, written)
            mounts.append({"type": "bind", "source": str(self.seedless), "target": "/app/deploy",
                           "read_only": True, "bind": {"create_host_path": False}})
        if mounts:
            service["volumes"] = mounts
        # YAML reset removes the base published ports, not the actual brain overlay.
        self.override.write_text("services:\n  openclaw:\n    ports: !reset []\n" +
                                 "".join(f"    {key}: {json.dumps(value)}\n"
                                         for key, value in service.items()))
        rendered = json.loads(run([*self.compose, "config", "--format", "json"],
                                  env=self.environment).stdout)["services"]["openclaw"]
        self.assertFalse(rendered.get("ports"))
        self.assertEqual(rendered["network_mode"], "none")
        self.assertEqual(rendered["hostname"], "openclaw-desktop")
        self.assertEqual(int(rendered["shm_size"]), 1073741824)
        self.assertEqual(len(rendered["security_opt"]), 2)
        self.assertTrue(any(option.startswith("seccomp=") for option in rendered["security_opt"]))
        self.assertTrue(any(option.replace("=", ":") == "no-new-privileges:true"
                            for option in rendered["security_opt"]))
        brain = next(mount for mount in rendered["volumes"] if mount["target"] == BRAIN)
        self.assertEqual(brain["source"], str(self.brain))
        self.assertFalse(brain["bind"]["create_host_path"])
        self.assertFalse(brain.get("read_only", False))
        state = next(mount for mount in rendered["volumes"] if mount["target"] == STATE)
        self.assertEqual((state["type"], state["source"]), ("volume", "openclaw_state"))

    def create(self, *, check=True):
        result = run([*self.compose, "create", "--no-build", "--pull", "never", "openclaw"],
                     env=self.environment, check=check)
        if result.returncode == 0:
            info = json.loads(docker("inspect", self.container).stdout)[0]
            self.assertEqual(info["HostConfig"]["NetworkMode"], "none")
            self.assertFalse(info["HostConfig"]["PortBindings"])
            self.assertEqual(info["HostConfig"]["ShmSize"], 1073741824)
            self.assertEqual(info["Config"]["Hostname"], "openclaw-desktop")
            self.assertEqual(info["Config"]["User"], "node")
            self.assertTrue(any(option.startswith("seccomp=")
                                for option in info["HostConfig"]["SecurityOpt"]))
            self.assertTrue(any(option.startswith("no-new-privileges")
                                for option in info["HostConfig"]["SecurityOpt"]))
            mounts = {mount["Destination"]: mount for mount in info["Mounts"]}
            self.assertEqual(mounts[STATE]["Name"], self.volume)
            self.assertEqual(mounts[BRAIN]["Source"], str(self.brain))
            self.assertTrue(mounts[BRAIN]["RW"])
            if self.seedless:
                self.assertEqual(mounts["/app/deploy"]["Source"], str(self.seedless))
                self.assertFalse(mounts["/app/deploy"]["RW"])
            else:
                self.assertNotIn("/app/deploy", mounts)
        return result

    def state_snapshot(self):
        """Decoded state volume tree; works on created and exited containers."""
        return tar_tree(docker_bytes("cp", f"{self.container}:{STATE}", "-"), STATE)

    def start(self):
        docker("start", self.container)

    def node(self, code, *, check=True):
        return docker("exec", self.container, "node", "-e", code, check=check)

    def stored_config(self):
        result = self.node(f"process.stdout.write(require('fs').readFileSync('{STATE}/openclaw.json'))")
        return result.stdout.encode()

    def healthy(self):
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            state = json.loads(docker("inspect", "--format", "{{json .State}}", self.container).stdout)
            if not state["Running"]:
                self.fail("gateway exited: " + docker("logs", self.container).stdout +
                          docker("logs", self.container).stderr)
            result = self.node("fetch('http://127.0.0.1:18789/healthz', {signal: AbortSignal.timeout(1500)})"
                               ".then(async r => {console.log(r.status, await r.text());"
                               "if (!r.ok) process.exit(1)}).catch(e => {console.error(e.message);process.exit(1)})",
                               check=False)
            if result.returncode == 0:
                status, body = result.stdout.split(" ", 1)
                self.assertEqual(status, "200")
                self.assertEqual(json.loads(body), {"ok": True, "status": "live"})
                print("HEALTH decoded", result.stdout.strip(), flush=True)
                return
            time.sleep(1)
        self.fail("gateway did not become healthy: " + docker("logs", self.container).stdout)

    def test_bidirectional_spaces_uid_and_image_files(self):
        incoming = {"direction": "host to container", "text": "Shared brain fixture: żółw", "id": self.project}
        outgoing = {"direction": "container to host", "text": "Decoded write confirmed: żółw", "id": self.project}
        (self.brain / "incoming.json").write_text(json.dumps(incoming))
        self.configure(probe=True)
        self.create()
        self.start()
        result = self.node("const fs=require('fs'); console.log(JSON.stringify({uid:process.getuid(),"
                           "gid:process.getgid(),status:fs.readFileSync('/proc/self/status','utf8'),"
                           f"incoming:JSON.parse(fs.readFileSync('{BRAIN}/incoming.json','utf8'))" + "}));"
                           f"fs.writeFileSync('{BRAIN}/outgoing.json', JSON.stringify({json.dumps(outgoing)}));")
        observed = json.loads(result.stdout)
        self.assertEqual((observed["uid"], observed["gid"]), (1000, 1000))
        self.assertRegex(observed["status"], r"NoNewPrivs:\s+1")
        self.assertRegex(observed["status"], r"Seccomp:\s+2")
        self.assertEqual(observed["incoming"], incoming)
        self.assertEqual(json.loads((self.brain / "outgoing.json").read_text()), outgoing)
        for source, target in [("openclaw.json", "/app/deploy/openclaw.json"),
                               ("desktop/chromium-profile", "/etc/chromium.d/openclaw-profile")]:
            actual = self.node(f"process.stdout.write(require('fs').readFileSync({json.dumps(target)}))").stdout.encode()
            expected = (ROOT / source).read_bytes()
            print("SOURCE/IMAGE SHA256", source, digest(expected), digest(actual))
            self.assertEqual(actual, expected)
        packages = docker("exec", self.container, "dpkg-query", "--show", "--showformat=${Package} ${Status}\n",
                          "chromium", "chromium-sandbox", "dbus-daemon", "dbus-x11", "fonts-liberation",
                          "fonts-noto-color-emoji", "tigervnc-standalone-server", "tigervnc-tools", "xfce4").stdout
        self.assertEqual(packages.count("install ok installed"), 9, packages)
        print("PACKAGES", packages.strip())
        print("PASS UID/GID 1000:1000; host read", incoming, "; host decoded write", outgoing, flush=True)

    def test_missing_source_fails_without_creation(self):
        self.brain = self.root / "missing brain with spaces"
        self.environment["OPENCLAW_BRAIN_PATH"] = str(self.brain)
        self.configure(probe=True)
        self.assertFalse(self.brain.exists())
        result = self.create(check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("bind source path does not exist", result.stderr)
        self.assertIn(str(self.brain), result.stderr)
        self.assertFalse(self.brain.exists())
        print("PASS missing source remained absent:", result.stderr.strip(), flush=True)

    def test_nonwritable_source_is_visible_to_nonroot(self):
        self.configure(probe=True)
        self.create()
        self.start()
        # Same path/user positive control rules out a broken write probe.
        code = ("const fs=require('fs'); console.log('uid='+process.getuid());"
                f"fs.writeFileSync('{BRAIN}/permission-check', 'write control passed');")
        self.node(code)
        self.assertEqual((self.brain / "permission-check").read_text(), "write control passed")
        (self.brain / "permission-check").unlink()
        self.brain.chmod(0o555)
        result = self.node(code, check=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("uid=1000", result.stdout)
        self.assertIn("EACCES: permission denied", result.stderr)
        self.assertIn(BRAIN + "/permission-check", result.stderr)
        self.assertFalse((self.brain / "permission-check").exists())
        print("PASS nonroot write rejected:", result.stdout.strip(), result.stderr.strip(), flush=True)

    def test_first_boot_seed_and_existing_config_preservation(self):
        self.configure()
        self.create()
        self.start()
        self.healthy()
        original = self.stored_config()
        expected = (ROOT / "openclaw.json").read_bytes()
        print("SEED SHA256 source/stored", digest(expected), digest(original))
        self.assertEqual(original, expected)
        config = json.loads(original)
        config["models"]["providers"]["litellm"]["models"][0]["name"] = "Preserved brain runtime fixture"
        preserved = (json.dumps(config, indent=2) + "\n").encode()
        self.node(f"require('fs').writeFileSync('{STATE}/openclaw.json', {json.dumps(preserved.decode())})")
        self.assertNotEqual(digest(expected), digest(preserved))
        for hide_seed in (False, True):
            docker("stop", "--time", "10", self.container)
            # Identity was checked by create(); remove only this allocated container.
            info = json.loads(docker("inspect", self.container).stdout)[0]
            self.assertEqual(info["Config"]["Labels"]["local.brain-acceptance"], self.project)
            docker("rm", info["Id"])
            self.configure(hide_seed=hide_seed)
            self.create()
            self.start()
            self.healthy()
            stored = self.stored_config()
            print("PRESERVED SHA256 expected/stored", digest(preserved), digest(stored), "seed hidden", hide_seed)
            self.assertEqual(stored, preserved)
            # Positive control: the real entrypoint ran while only the seed was hidden.
            visible = json.loads(self.node(
                "const fs=require('fs'); console.log(JSON.stringify(" +
                json.dumps([SEED, *[a for a in self.entrypoint if a.startswith("/")]]) +
                ".map(p => fs.existsSync(p))))").stdout)
            self.assertEqual(visible[0], not hide_seed)
            self.assertTrue(all(visible[1:]), visible)
        print("PASS real image first boot and existing config preserved with/without seed", flush=True)

    def assert_preflight_failure(self, reason):
        """Fresh state: the entrypoint preflight reads the seed before any state write
        or the CMD copy, so failure must stop there with its own diagnostic."""
        self.create()
        before = self.state_snapshot()
        # A fresh volume holds exactly the image's copied-up state, without config.
        self.assertEqual(before, self.image_state)
        self.assertNotIn(STATE + "/openclaw.json", before)
        self.start()
        result = docker("wait", self.container, timeout=30)
        logs = docker("logs", self.container)
        text = logs.stdout + logs.stderr
        self.assertEqual((int(result.stdout.strip()), text), (1, reason + "\n"))
        after = self.state_snapshot()
        self.assertNotIn(STATE + "/openclaw.json", after)
        self.assertEqual(after, before)
        print("PASS preflight failed closed; exit", result.stdout.strip(), "log", repr(text),
              "state unchanged:", len(after), "entries", flush=True)

    def test_first_boot_readonly_state_fails(self):
        self.configure(state_read_only=True)
        self.assert_preflight_failure("Desktop initialization failed (EROFS)")

    def test_first_boot_missing_seed_fails(self):
        self.configure(hide_seed=True)
        self.assert_preflight_failure("Desktop initialization failed (ENOENT)")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Already built local image matching this source tree")
    arguments = parser.parse_args()
    BrainRuntimeTests.image = arguments.image
    unittest.main(argv=[__file__], verbosity=2)
