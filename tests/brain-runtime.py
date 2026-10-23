"""Opt-in local Docker acceptance; never pulls/builds or uses existing state."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
STATE = "/home/node/.openclaw"
BRAIN = "/home/node/brain"
DOCKER = ["docker", "--context", "desktop-linux"]
ENV = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
ENV.update({
    "OPENCLAW_VERSION": "2026.10.1",
    "OPENCLAW_GATEWAY_TOKEN": "brain-runtime-fixture-token-not-a-secret",
    "OPENCLAW_ALLOWED_ORIGINS": "http://localhost:18789",
    "LITELLM_BASE_URL": "http://127.0.0.1:9/v1",
    "LITELLM_API_KEY": "brain-runtime-fixture-key-not-a-secret",
    "LITELLM_MODEL": "deepseek/deepseek-v4-pro",
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


def digest(data):
    return hashlib.sha256(data).hexdigest()


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
        expected = json.loads(next(line[4:] for line in (ROOT / "Dockerfile").read_text().splitlines()
                                   if line.startswith("CMD ")))
        if image["Config"]["Cmd"] != expected or image["Config"]["User"] != "node":
            raise AssertionError("image CMD/User does not match the current Dockerfile")
        if image["Config"]["Labels"]["org.opencontainers.image.version"] != ENV["OPENCLAW_VERSION"]:
            raise AssertionError("image is not the target OpenClaw release")
        print("IMAGE", cls.image, image["Architecture"], "CMD matches source", flush=True)

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
        if hide_seed:
            empty = self.root / "empty seed"
            empty.mkdir(exist_ok=True)
            mounts.append({"type": "bind", "source": str(empty), "target": "/app/deploy",
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
        return result

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
        print("PASS real image first boot and existing config preserved with/without seed", flush=True)

    def assert_seed_failure(self):
        self.create()
        self.start()
        result = docker("wait", self.container, timeout=30)
        self.assertNotEqual(int(result.stdout.strip()), 0)
        logs = docker("logs", self.container)
        text = logs.stdout + logs.stderr
        self.assertIn("cp:", text)
        self.assertNotIn("[gateway]", text)
        print("PASS first boot failed closed; exit", result.stdout.strip(), text.strip(), flush=True)
        return text

    def test_first_boot_readonly_state_fails(self):
        self.configure(state_read_only=True)
        self.assertIn("Read-only file system", self.assert_seed_failure())

    def test_first_boot_missing_seed_fails(self):
        self.configure(hide_seed=True)
        self.assertIn("No such file or directory", self.assert_seed_failure())


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Already built local image matching this source tree")
    arguments = parser.parse_args()
    BrainRuntimeTests.image = arguments.image
    unittest.main(argv=[__file__], verbosity=2)
