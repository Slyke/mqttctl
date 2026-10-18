"""Run with python3 tests/multiarch-build.test.py; requires Docker Buildx."""
import json
import os
from pathlib import Path
import subprocess
import unittest

ROOT = Path(__file__).resolve().parents[1]

class BuildPlanTest(unittest.TestCase):
    def plan(self, **values):
        env = dict(os.environ)
        for key in ("VERSION", "BUILD_HASH", "IMAGE_PREFIX", "EXTRA_IMAGE_PREFIX"):
            env.pop(key, None)
        env.update(values)
        result = subprocess.run(
            ["docker", "buildx", "bake", "-f", "docker-bake.hcl", "--print"],
            cwd=ROOT, env=env, check=True, capture_output=True, text=True)
        return json.loads(result.stdout)

    def test_default_only_builds_ui_and_broker_for_both_architectures(self):
        plan = self.plan()
        self.assertEqual(set(plan["group"]["default"]["targets"]), {"mqttctl", "broker-agent"})
        self.assertEqual(set(plan["target"]), {"mqttctl", "broker-agent"})
        for target in plan["target"].values():
            self.assertEqual(target["platforms"], ["linux/amd64", "linux/arm64"])
            self.assertEqual(len(target["tags"]), 1)
            self.assertTrue(target["tags"][0].endswith(":dev"))
            self.assertNotIn("output", target)  # Publishing is explicit.

    def test_release_tags_and_metadata_for_both_registries(self):
        plan = self.plan(VERSION="v0.0.8", BUILD_HASH="d90b7f4d7c4b",
                         IMAGE_PREFIX="example", EXTRA_IMAGE_PREFIX="registry.example/example")
        for name, target in plan["target"].items():
            image = "mqttctl" if name == "mqttctl" else "mqttctl-broker-agent"
            expected = {
                f"{prefix}/{image}:{tag}"
                for prefix in ("example", "registry.example/example")
                for tag in ("latest", "v0.0.8", "v0.0.8-d90b7f4d7c4b")
            }
            self.assertEqual(set(target["tags"]), expected)
            self.assertEqual(target["args"]["BUILD_HASH"], "d90b7f4d7c4b")

if __name__ == "__main__":
    unittest.main()
