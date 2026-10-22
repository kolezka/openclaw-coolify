import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
FIXTURE_ENV = {
    "OPENCLAW_VERSION": "2026.2.26",
    "OPENCLAW_GATEWAY_TOKEN": "fixture-token-not-a-secret",
    "OPENCLAW_ALLOWED_ORIGINS": "https://openclaw.example.com",
    "LITELLM_BASE_URL": "http://127.0.0.1:9/v1",
    "LITELLM_API_KEY": "fixture-key-not-a-secret",
    "LITELLM_MODEL": "deepseek/deepseek-v4-pro",
}


def compose_config(brain_path=None, *, overlay=True):
    environment = {key: os.environ[key] for key in ("PATH", "HOME") if key in os.environ}
    environment.update(FIXTURE_ENV)
    if brain_path is not None:
        environment["OPENCLAW_BRAIN_PATH"] = str(brain_path)
    command = [
        "docker", "compose", "--env-file", os.devnull,
        "--project-name", "openclaw-brain-tests",
        "-f", str(ROOT / "docker-compose.yml"),
    ]
    if overlay:
        command += ["-f", str(ROOT / "docker-compose.brain.yml")]
    return subprocess.run(
        [*command, "config", "--format", "json"], env=environment,
        capture_output=True, text=True, timeout=30,
    )


class BrainMountTests(unittest.TestCase):
    def test_base_does_not_require_brain(self):
        result = compose_config(overlay=False)
        self.assertEqual(result.returncode, 0, result.stderr)
        service = json.loads(result.stdout)["services"]["openclaw"]
        self.assertEqual(
            [(mount["type"], mount["target"]) for mount in service["volumes"]],
            [("volume", "/home/node/.openclaw")],
        )
        self.assertEqual(
            [(port["host_ip"], port["target"]) for port in service["ports"]],
            [("127.0.0.1", 18789), ("127.0.0.1", 18790)],
        )

    def test_overlay_preserves_state_and_ports(self):
        with tempfile.TemporaryDirectory(prefix="brain-mount-") as path:
            base_result = compose_config(overlay=False)
            result = compose_config(path)
            self.assertEqual(base_result.returncode, 0, base_result.stderr)
            self.assertEqual(result.returncode, 0, result.stderr)
            base = json.loads(base_result.stdout)
            combined = json.loads(result.stdout)
            base_service = base["services"]["openclaw"]
            service = combined["services"]["openclaw"]
            mounts = service.pop("volumes")
            original_mounts = base_service.pop("volumes")
            self.assertEqual(service, base_service)
            self.assertEqual(combined["volumes"], base["volumes"])
            self.assertEqual(len(mounts), len(original_mounts) + 1)
            for original in original_mounts:
                self.assertIn(original, mounts)
            brain = next(mount for mount in mounts if mount["target"] == "/home/node/brain")
            self.assertEqual(brain["type"], "bind")
            self.assertEqual(brain["source"], path)
            self.assertFalse(brain.get("read_only", False))
            self.assertEqual(brain["bind"]["create_host_path"], False)

    def test_brain_path_is_required(self):
        for value in (None, ""):
            with self.subTest(value=value):
                result = compose_config(value)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("OPENCLAW_BRAIN_PATH", result.stderr)

    def test_brain_path_with_spaces(self):
        with tempfile.TemporaryDirectory(prefix="brain path with spaces ") as path:
            result = compose_config(path)
            self.assertEqual(result.returncode, 0, result.stderr)
            mounts = json.loads(result.stdout)["services"]["openclaw"]["volumes"]
            brain = next(mount for mount in mounts if mount["target"] == "/home/node/brain")
            self.assertEqual(brain["source"], path)


if __name__ == "__main__":
    unittest.main()
