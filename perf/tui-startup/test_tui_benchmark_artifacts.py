import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import tui_benchmark


OID_A = "a" * 40
OID_B = "b" * 40
OID_C = "c" * 40
TOOLING = {
    "tui_benchmark_sha256": "1" * 64,
    "tui_probe_sha256": "2" * 64,
    "terminal_screen_sha256": "3" * 64,
}
HOST = {
    "os": "test-os",
    "os_release": "1.0",
    "arch": "test-arch",
    "python_version": "3.11.0",
    "bun_version": "1.3.14",
}
SOURCE = {
    "revision": OID_A,
    "tree": OID_B,
    "pr_base_revision": OID_C,
    "clean": True,
}


class ArtifactTestCase(unittest.TestCase):
    def make_binary(self, root, name="candidate", content=b"#!/bin/sh\nexit 0\n"):
        path = root / name
        path.write_bytes(content)
        path.chmod(0o755)
        return path

    def preserve(self, binary, output, name="candidate", capability="unavailable"):
        with mock.patch.object(tui_benchmark, "_git_source_identity", return_value=dict(SOURCE)):
            with mock.patch.object(tui_benchmark, "_tooling_hashes", return_value=dict(TOOLING)):
                with mock.patch.object(tui_benchmark, "_host_record", return_value=dict(HOST)):
                    return tui_benchmark.preserve_artifact(
                        name,
                        binary,
                        "bun run dev:build",
                        capability,
                        output,
                    )


class PreserveArtifactTest(ArtifactTestCase):
    def test_success_uses_exact_canonical_private_path_free_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = self.make_binary(root)
            output = root / "artifact"
            with mock.patch.dict(os.environ, {"PRIVATE_SECRET": "do-not-store", "USER": "private-user"}):
                artifact = self.preserve(binary, output)

            self.assertEqual({item.name for item in output.iterdir()}, {"artifact.json", "artifact.sha256", "bin"})
            self.assertEqual({item.name for item in (output / "bin").iterdir()}, {"oc2"})
            manifest_bytes = (output / "artifact.json").read_bytes()
            manifest = json.loads(manifest_bytes)
            self.assertEqual(manifest_bytes, tui_benchmark._canonical_json_bytes(manifest))
            self.assertEqual(manifest["source"], SOURCE)
            self.assertEqual(manifest["capabilities"], {"shell": "unavailable"})
            self.assertEqual(manifest["binary"]["path"], "bin/oc2")
            self.assertEqual(manifest["binary"]["mode"], 0o755)
            self.assertEqual(manifest["build_host"], HOST)
            self.assertEqual(manifest["tooling"], TOOLING)
            self.assertEqual(artifact.artifact_id, tui_benchmark._sha256_bytes(manifest_bytes))

            sidecar = (output / "artifact.sha256").read_text(encoding="ascii")
            self.assertEqual(sidecar, f"{artifact.artifact_id}  artifact.json\n")
            serialized = manifest_bytes.decode("utf-8") + sidecar
            self.assertNotIn(str(root), serialized)
            self.assertNotIn(str(binary), serialized)
            self.assertNotIn("private-user", serialized)
            self.assertNotIn("do-not-store", serialized)

    def test_refuses_existing_output_and_invalid_source_file_shapes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = self.make_binary(root)
            existing = root / "existing"
            existing.mkdir()
            with self.assertRaisesRegex(tui_benchmark.ArtifactFailure, "artifact_output_exists"):
                self.preserve(binary, existing)

            nonexec = self.make_binary(root, "nonexec")
            nonexec.chmod(0o644)
            symlink = root / "symlink"
            symlink.symlink_to(binary)
            directory_binary = root / "directory"
            directory_binary.mkdir()
            hardlink = root / "hardlink"
            os.link(binary, hardlink)
            for index, invalid in enumerate((nonexec, symlink, directory_binary, hardlink)):
                with self.subTest(invalid=invalid.name):
                    output = root / f"invalid-{index}"
                    with self.assertRaises(tui_benchmark.ArtifactFailure):
                        self.preserve(invalid, output)
                    self.assertFalse(output.exists())

    def test_dirty_and_identity_races_fail_and_remove_only_partial_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = self.make_binary(root)
            output = root / "artifact"
            sibling = root / "keep"
            sibling.write_text("keep", encoding="ascii")
            with mock.patch.object(
                tui_benchmark,
                "_git_source_identity",
                side_effect=tui_benchmark.ArtifactFailure("artifact_worktree_dirty"),
            ):
                with self.assertRaisesRegex(tui_benchmark.ArtifactFailure, "artifact_worktree_dirty"):
                    tui_benchmark.preserve_artifact(
                        "candidate", binary, "bun run dev:build", "required", output
                    )
            self.assertFalse(output.exists())
            self.assertEqual(sibling.read_text(encoding="ascii"), "keep")

            changed = dict(SOURCE, revision="d" * 40)
            with mock.patch.object(tui_benchmark, "_git_source_identity", side_effect=(SOURCE, changed)):
                with mock.patch.object(tui_benchmark, "_tooling_hashes", return_value=dict(TOOLING)):
                    with mock.patch.object(tui_benchmark, "_host_record", return_value=dict(HOST)):
                        with self.assertRaisesRegex(tui_benchmark.ArtifactFailure, "artifact_identity_changed"):
                            tui_benchmark.preserve_artifact(
                                "candidate", binary, "bun run dev:build", "required", output
                            )
            self.assertFalse(output.exists())
            self.assertTrue(sibling.exists())


class ArtifactLoaderTest(ArtifactTestCase):
    def make_artifact(self, root):
        binary = self.make_binary(root)
        output = root / "artifact"
        self.preserve(binary, output)
        return output

    def test_loader_rejects_extra_missing_symlink_and_binary_mutation(self):
        cases = ("extra", "missing", "symlink", "binary")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                output = self.make_artifact(root)
                if case == "extra":
                    (output / "extra").write_text("x", encoding="ascii")
                elif case == "missing":
                    (output / "artifact.sha256").unlink()
                elif case == "symlink":
                    manifest = output / "artifact.json"
                    original = root / "original-manifest"
                    manifest.rename(original)
                    manifest.symlink_to(original)
                else:
                    (output / "bin" / "oc2").write_bytes(b"changed")
                with self.assertRaises(tui_benchmark.ArtifactFailure):
                    tui_benchmark.load_artifact(output)

    def test_loader_rejects_noncanonical_duplicate_wrong_type_and_bad_sidecar(self):
        cases = ("noncanonical", "duplicate", "wrong-type", "sidecar")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                output = self.make_artifact(root)
                manifest_path = output / "artifact.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if case == "noncanonical":
                    content = (json.dumps(manifest, indent=2) + "\n").encode("utf-8")
                elif case == "duplicate":
                    canonical = tui_benchmark._canonical_json_bytes(manifest).decode("utf-8")
                    content = canonical.replace('{"binary":', '{"schema":"duplicate","binary":', 1).encode("utf-8")
                elif case == "wrong-type":
                    manifest["binary"]["size_bytes"] = True
                    content = tui_benchmark._canonical_json_bytes(manifest)
                else:
                    content = manifest_path.read_bytes()
                    (output / "artifact.sha256").write_text("0" * 64 + "  artifact.json\n", encoding="ascii")
                if case != "sidecar":
                    manifest_path.write_bytes(content)
                    digest = tui_benchmark._sha256_bytes(content)
                    (output / "artifact.sha256").write_text(f"{digest}  artifact.json\n", encoding="ascii")
                with self.assertRaises(tui_benchmark.ArtifactFailure):
                    tui_benchmark.load_artifact(output)

    def test_loader_rejects_path_traversal_capability_mode_size_and_version(self):
        mutations = (
            lambda value: value["binary"].__setitem__("path", "../oc2"),
            lambda value: value["capabilities"].__setitem__("shell", "optional"),
            lambda value: value["binary"].__setitem__("mode", 0o644),
            lambda value: value["binary"].__setitem__("size_bytes", value["binary"]["size_bytes"] + 1),
            lambda value: value.__setitem__("version", 2),
        )
        for mutate in mutations:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                output = self.make_artifact(root)
                manifest_path = output / "artifact.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                mutate(manifest)
                content = tui_benchmark._canonical_json_bytes(manifest)
                manifest_path.write_bytes(content)
                (output / "artifact.sha256").write_text(
                    f"{tui_benchmark._sha256_bytes(content)}  artifact.json\n",
                    encoding="ascii",
                )
                with self.assertRaises(tui_benchmark.ArtifactFailure):
                    tui_benchmark.load_artifact(output)


if __name__ == "__main__":
    unittest.main()
