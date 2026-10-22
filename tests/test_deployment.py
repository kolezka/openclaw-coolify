import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SEED = b'{"fixture": "initial configuration"}\n'


def run_startup(existing_config: bytes | None, seed_available: bool):
    command = json.loads(next(
        line.removeprefix("CMD ")
        for line in (ROOT / "Dockerfile").read_text().splitlines()
        if line.startswith("CMD ")
    ))
    with tempfile.TemporaryDirectory(prefix="openclaw-startup-") as directory:
        root = Path(directory)
        state, seed, binaries = (root / name for name in ("state", "seed", "bin"))
        for path in (state, seed, binaries):
            path.mkdir()
        config = state / "openclaw.json"
        if existing_config is not None:
            config.write_bytes(existing_config)
        if seed_available:
            (seed / "openclaw.json").write_bytes(SEED)
        marker = root / "gateway-arguments"
        node = binaries / "node"
        node.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$GATEWAY_MARKER"\n')
        node.chmod(0o700)
        script = command[2].replace("/home/node/.openclaw", shlex.quote(str(state)))
        script = script.replace("/app/deploy", shlex.quote(str(seed)))
        result = subprocess.run(
            [*command[:2], script],
            env={"PATH": f"{binaries}{os.pathsep}/usr/bin:/bin", "GATEWAY_MARKER": str(marker)},
            text=True, capture_output=True, timeout=10,
        )
        arguments = marker.read_text().splitlines() if marker.exists() else None
        stored = config.read_bytes() if config.exists() else None
        return result, arguments, stored


class StartupTests(unittest.TestCase):
    def test_copy_failure_blocks_gateway(self):
        result, arguments, stored = run_startup(None, seed_available=False)
        self.assertIsNone(arguments, "gateway launched after failed config copy")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("openclaw.json", result.stderr)
        self.assertIsNone(stored)

    def test_fresh_seed_starts_gateway(self):
        result, arguments, stored = run_startup(None, seed_available=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr, "")
        self.assertEqual(arguments, ["openclaw.mjs", "gateway", "--allow-unconfigured", "--bind", "lan"])
        self.assertEqual(stored, SEED)

    def test_existing_config_is_unchanged(self):
        original = b'{ "customSetting": ["keep", "unchanged"] }\n'
        for seed_available in (False, True):
            with self.subTest(seed_available=seed_available):
                result, arguments, stored = run_startup(original, seed_available)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stderr, "")
                self.assertEqual(arguments, ["openclaw.mjs", "gateway", "--allow-unconfigured", "--bind", "lan"])
                self.assertEqual(stored, original)


class ModelConfigurationTests(unittest.TestCase):
    def test_example_model_is_explicitly_declared(self):
        example = dict(
            line.split("=", 1)
            for line in (ROOT / ".env.example").read_text().splitlines()
            if line and not line.startswith("#") and "=" in line
        )
        alias = example["LITELLM_MODEL"]
        config = json.loads((ROOT / "openclaw.json").read_text().replace("${LITELLM_MODEL}", alias))
        provider = config["models"]["providers"]["litellm"]
        matches = [model for model in provider["models"] if model["id"] == alias]
        self.assertEqual(len(matches), 1, "example alias would use fallback model metadata")
        self.assertEqual(config["agents"]["defaults"]["model"]["primary"], f"litellm/{alias}")
        self.assertGreater(matches[0]["contextWindow"], 0)
        self.assertGreater(matches[0]["maxTokens"], 0)
        self.assertLessEqual(matches[0]["maxTokens"], matches[0]["contextWindow"])
        self.assertEqual(provider["baseUrl"], "${LITELLM_BASE_URL}")
        self.assertEqual(provider["apiKey"], "${LITELLM_API_KEY}")

    def test_deepseek_tool_history_compatibility_is_preserved(self):
        models = json.loads((ROOT / "openclaw.json").read_text())["models"]["providers"]["litellm"]["models"]
        by_id = {model["id"]: model for model in models}
        for alias in ("deepseek/deepseek-v4-pro", "deepseek/deepseek-v4-flash"):
            with self.subTest(alias=alias):
                compat = by_id[alias]["compat"]
                self.assertEqual(compat["thinkingFormat"], "deepseek")
                self.assertTrue(compat["requiresReasoningContentOnAssistantMessages"])


if __name__ == "__main__":
    unittest.main()
