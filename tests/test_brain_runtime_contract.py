"""Docker-free contracts for the guards in the opt-in brain runtime suite."""

import importlib.util
from pathlib import Path
import re
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("brain_runtime", ROOT / "tests" / "brain-runtime.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)
DOCKERFILE = (ROOT / "Dockerfile").read_text()
VERSION = runtime.ENV["OPENCLAW_VERSION"]


def source_image():
    """A fake image tree that matches this checkout exactly."""
    copies = runtime.dockerfile_copies(DOCKERFILE)
    expected = {target: path.read_bytes() for target, path in copies.items()}
    executables = runtime.dockerfile_executables(DOCKERFILE, expected)
    actual = {target: ("file", 0o755 if target in executables else 0o644, data)
              for target, data in expected.items()}
    config = {"Entrypoint": runtime.dockerfile_exec_form(DOCKERFILE, "ENTRYPOINT"),
              "Cmd": runtime.dockerfile_exec_form(DOCKERFILE, "CMD"), "User": "node",
              "Labels": {"org.opencontainers.image.version": VERSION}}
    return config, expected, executables, actual


class BrainRuntimeContractTests(unittest.TestCase):
    def test_fixture_env_satisfies_every_required_compose_variable(self):
        required = set()
        for name in ("docker-compose.yml", "docker-compose.brain.yml"):
            required |= set(re.findall(r"\$\{([A-Z0-9_]+):\?", (ROOT / name).read_text()))
        # The suite sets the brain path per test so it can point at a missing directory.
        self.assertEqual(required - set(runtime.ENV), {"OPENCLAW_BRAIN_PATH"})
        self.assertRegex(runtime.ENV["DESKTOP_VNC_PASSWORD"], r"^[\x20-\x7e]{8}$")

    def test_source_matched_image_passes(self):
        config, expected, executables, actual = source_image()
        self.assertEqual(runtime.image_config_mismatches(config, DOCKERFILE, VERSION), [])
        self.assertEqual(runtime.runtime_file_mismatches(expected, executables, actual), [])
        for target in ("/app/deploy/start-desktop.sh", "/app/deploy/prepare-runtime.mjs",
                       "/app/deploy/run-xfce.sh", runtime.SEED):
            self.assertIn(target, expected)
        self.assertIn("/app/deploy/start-desktop.sh", executables)

    def test_old_image_without_desktop_entrypoint_is_rejected(self):
        config, *_ = source_image()
        old = {**config, "Entrypoint": ["docker-entrypoint.sh"]}
        problems = runtime.image_config_mismatches(old, DOCKERFILE, VERSION)
        self.assertEqual(len(problems), 1)
        self.assertIn("ENTRYPOINT", problems[0])

    def test_stale_or_missing_runtime_files_are_rejected(self):
        _, expected, executables, actual = source_image()
        script = "/app/deploy/start-desktop.sh"
        cases = {
            "content": ({**actual, script: ("file", 0o755, b"#!/bin/sh\nexec old\n")}, "sha256"),
            "mode": ({**actual, script: ("file", 0o644, expected[script])}, "not executable"),
            "missing": ({k: v for k, v in actual.items() if k != runtime.SEED}, "missing"),
            "extra": ({**actual, "/app/deploy/old-start.sh": ("file", 0o755, b"")}, "not copied"),
        }
        for name, (tree, message) in cases.items():
            with self.subTest(name):
                problems = runtime.runtime_file_mismatches(expected, executables, tree)
                self.assertEqual(len(problems), 1, problems)
                self.assertIn(message, problems[0])

    def test_seedless_fixture_hides_only_the_seed(self):
        _, expected, executables, actual = source_image()
        deploy = {k: v for k, v in actual.items() if k.startswith("/app/deploy/")}
        deploy["/app/deploy"] = ("dir", 0o755, b"")
        deploy["/app/deploy/launchers"] = ("dir", 0o755, b"")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            written = runtime.write_deploy_without_seed(deploy, root)
            self.assertEqual(written, {k for k, v in deploy.items() if v[0] == "file"} - {runtime.SEED})
            self.assertFalse((root / "openclaw.json").exists())
            for target in written:
                local = root / target.removeprefix("/app/deploy/")
                self.assertEqual(local.read_bytes(), expected[target])
                self.assertEqual(bool(local.stat().st_mode & 0o100), target in executables)


if __name__ == "__main__":
    unittest.main()
