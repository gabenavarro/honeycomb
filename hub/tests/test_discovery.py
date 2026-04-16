"""Tests for the discovery scan helpers (hub/services/discovery.py).

These cover the read-only half of discovery: workspace scanning and
project-type inference. Container discovery is exercised by the
integration tests (test_integration.py) with a mocked docker SDK.
"""

from __future__ import annotations

import json
from pathlib import Path

from hub.services.discovery import (
    infer_project_type,
    scan_workspace_candidates,
)


class TestInferProjectType:
    def test_base_is_default(self) -> None:
        assert infer_project_type("") == "base"
        assert infer_project_type("lorem ipsum") == "base"

    def test_ml_cuda_from_cuda_keyword(self) -> None:
        assert infer_project_type("FROM nvcr.io/nvidia/pytorch:23.10-py3") == "ml-cuda"
        assert infer_project_type("import pytorch_lightning") == "ml-cuda"
        assert infer_project_type('"runArgs": ["--gpus=all"]') == "ml-cuda"

    def test_compbio_from_scientific_deps(self) -> None:
        assert infer_project_type("scanpy==1.10") == "compbio"
        assert infer_project_type("biopython>=1.80") == "compbio"
        assert infer_project_type("pysam") == "compbio"

    def test_web_dev_from_frameworks(self) -> None:
        assert infer_project_type('"next": "^14.0"') == "web-dev"
        assert infer_project_type("from fastapi import FastAPI") == "web-dev"

    def test_ml_cuda_beats_web_dev_when_both_match(self) -> None:
        # Order in _TYPE_SIGNALS is intentional: GPU signals win.
        assert infer_project_type("import torch\nimport fastapi") == "ml-cuda"


class TestScanWorkspaceCandidates:
    def _write_devcontainer(self, root: Path, name: str, content: str | None = None) -> Path:
        project = root / name
        (project / ".devcontainer").mkdir(parents=True)
        cfg = {"name": name, "build": {"dockerfile": "Dockerfile"}}
        body = content if content is not None else json.dumps(cfg)
        (project / ".devcontainer" / "devcontainer.json").write_text(body)
        return project

    def test_finds_devcontainer_at_expected_depth(self, tmp_path: Path) -> None:
        root = tmp_path / "repos"
        root.mkdir()
        self._write_devcontainer(root, "proj-a")

        cands = scan_workspace_candidates(set(), roots=[root])
        assert len(cands) == 1
        assert cands[0].workspace_folder == str((root / "proj-a").resolve())
        assert cands[0].project_name == "proj-a"

    def test_excludes_already_registered(self, tmp_path: Path) -> None:
        root = tmp_path / "repos"
        root.mkdir()
        proj_a = self._write_devcontainer(root, "proj-a")
        self._write_devcontainer(root, "proj-b")

        registered = {str(proj_a.resolve())}
        cands = scan_workspace_candidates(registered, roots=[root])
        names = [c.project_name for c in cands]
        assert names == ["proj-b"]

    def test_flags_dockerfile_and_claude_md(self, tmp_path: Path) -> None:
        root = tmp_path / "repos"
        root.mkdir()
        proj = self._write_devcontainer(root, "proj-c")
        (proj / "Dockerfile").write_text("FROM python:3.12\n")
        (proj / "CLAUDE.md").write_text("# Proj C\n")

        cands = scan_workspace_candidates(set(), roots=[root])
        assert cands[0].has_dockerfile is True
        assert cands[0].has_claude_md is True

    def test_infers_ml_cuda_from_dockerfile(self, tmp_path: Path) -> None:
        root = tmp_path / "repos"
        root.mkdir()
        proj = self._write_devcontainer(root, "ml-proj")
        (proj / "Dockerfile").write_text("FROM nvcr.io/nvidia/pytorch:23.10-py3\n")

        cands = scan_workspace_candidates(set(), roots=[root])
        assert cands[0].inferred_project_type == "ml-cuda"

    def test_prefers_devcontainer_name_over_folder_basename(self, tmp_path: Path) -> None:
        root = tmp_path / "repos"
        root.mkdir()
        self._write_devcontainer(
            root,
            "boring-folder-name",
            content=json.dumps({"name": "My Nice Project"}),
        )
        cands = scan_workspace_candidates(set(), roots=[root])
        assert cands[0].project_name == "My Nice Project"

    def test_tolerates_jsonc_comments(self, tmp_path: Path) -> None:
        root = tmp_path / "repos"
        root.mkdir()
        content = """// Leading comment
{
  /* block */
  "name": "Commented Project"
}"""
        self._write_devcontainer(root, "commented", content=content)
        cands = scan_workspace_candidates(set(), roots=[root])
        assert cands[0].project_name == "Commented Project"

    def test_ignores_noise_directories(self, tmp_path: Path) -> None:
        root = tmp_path / "repos"
        root.mkdir()
        # A .devcontainer inside node_modules should be skipped entirely.
        junk = root / "real-project" / "node_modules" / "fake-pkg"
        junk.mkdir(parents=True)
        (junk / ".devcontainer").mkdir()
        (junk / ".devcontainer" / "devcontainer.json").write_text("{}")
        # But the real-project's own devcontainer is picked up.
        self._write_devcontainer(root, "real-project")

        cands = scan_workspace_candidates(set(), roots=[root])
        assert len(cands) == 1
        assert cands[0].project_name == "real-project"

    def test_output_is_sorted_for_determinism(self, tmp_path: Path) -> None:
        root = tmp_path / "repos"
        root.mkdir()
        for name in ("zeta", "alpha", "mike"):
            self._write_devcontainer(root, name)

        cands = scan_workspace_candidates(set(), roots=[root])
        folders = [c.workspace_folder for c in cands]
        assert folders == sorted(folders)
