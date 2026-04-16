"""Tests for the bootstrapper provisioner."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bootstrapper.provision import (
    TemplateError,
    detect_existing_dockerfile,
    generate_devcontainer_json,
    generate_mcp_json,
    get_skill_list,
    load_skill_registry,
    provision,
    render_claude_md,
    slugify,
)


class TestSlugify:
    def test_simple(self) -> None:
        assert slugify("My Project") == "my_project"

    def test_special_chars(self) -> None:
        assert slugify("My Project! (v2)") == "my_project_v2"

    def test_hyphens(self) -> None:
        assert slugify("my-cool-project") == "my_cool_project"

    def test_already_slug(self) -> None:
        assert slugify("my_project") == "my_project"


class TestDetectExistingDockerfile:
    def test_no_dockerfile(self, tmp_path: Path) -> None:
        assert detect_existing_dockerfile(tmp_path) is False

    def test_simple_dockerfile(self, tmp_path: Path) -> None:
        (tmp_path / "Dockerfile").write_text("FROM python:3.12\nRUN echo hello")
        assert detect_existing_dockerfile(tmp_path) is False

    def test_multistage_dockerfile(self, tmp_path: Path) -> None:
        (tmp_path / "Dockerfile").write_text(
            "FROM python:3.12 AS base\nRUN echo hello\n"
            "FROM base AS dev\nRUN echo dev\n"
            "FROM base AS prod\nCOPY . .\n"
        )
        assert detect_existing_dockerfile(tmp_path) is True


class TestLoadSkillRegistry:
    def test_base(self) -> None:
        registry = load_skill_registry("base")
        assert registry["project_type"] == "base"
        assert "skills" in registry

    def test_ml_cuda(self) -> None:
        registry = load_skill_registry("ml-cuda")
        assert registry["project_type"] == "ml-cuda"
        assert "scientific" in registry["skills"]

    def test_compbio(self) -> None:
        registry = load_skill_registry("compbio")
        assert "biopython" in registry["skills"]["scientific"]["items"]

    def test_unknown_raises_template_error(self) -> None:
        # Fail-loud: a silent fallback to base would hide the real problem
        # (wrong skills, no GPU tooling, etc.)
        with pytest.raises(TemplateError, match="unknown-type"):
            load_skill_registry("unknown-type")


class TestRenderClaudeMd:
    def test_base_template(self) -> None:
        result = render_claude_md("base", "Test Project", "A test project for testing.")
        assert "# Test Project" in result
        assert "A test project for testing." in result

    def test_ml_cuda_template(self) -> None:
        result = render_claude_md("ml-cuda", "ML Experiment", "Training a transformer model.")
        assert "# ML Experiment" in result
        assert "PyTorch" in result
        assert "Blackwell" in result

    def test_web_dev_template(self) -> None:
        result = render_claude_md("web-dev", "My App", "A full-stack web application.")
        assert "# My App" in result
        assert "FastAPI" in result

    def test_compbio_template(self) -> None:
        result = render_claude_md("compbio", "Gene Analysis", "Single-cell RNA-seq pipeline.")
        assert "# Gene Analysis" in result
        assert "scanpy" in result


class TestGenerateDevcontainerJson:
    def test_base(self, tmp_path: Path) -> None:
        config = generate_devcontainer_json("base", "Test", tmp_path)
        assert config["name"] == "Test"
        assert config["build"]["target"] == "dev"

    def test_ml_cuda_has_gpu(self, tmp_path: Path) -> None:
        config = generate_devcontainer_json("ml-cuda", "ML Test", tmp_path)
        assert "--gpus=all" in config.get("runArgs", [])

    def test_existing_dockerfile_overrides_build(self, tmp_path: Path) -> None:
        (tmp_path / "Dockerfile").write_text(
            "FROM python:3.12 AS base\nRUN echo hi\nFROM base AS dev\nRUN echo dev\n"
        )
        config = generate_devcontainer_json("base", "Test", tmp_path)
        assert config["build"]["dockerfile"] == "../Dockerfile"
        assert config["build"]["context"] == ".."


class TestGenerateMcpJson:
    def test_base_has_mcp_servers(self) -> None:
        mcp = generate_mcp_json("base")
        assert "mcpServers" in mcp
        assert "context7" in mcp["mcpServers"]

    def test_web_dev_has_playwright(self) -> None:
        mcp = generate_mcp_json("web-dev")
        assert "playwright" in mcp["mcpServers"]


class TestGetSkillList:
    def test_base_skills(self) -> None:
        skills = get_skill_list("base")
        assert "hive-orchestration" in skills
        assert "project-bootstrap" in skills

    def test_ml_cuda_skills(self) -> None:
        skills = get_skill_list("ml-cuda")
        assert "pytorch-lightning" in skills
        assert "transformers" in skills
        assert "ml-cuda-workflow" in skills

    def test_compbio_skills(self) -> None:
        skills = get_skill_list("compbio")
        assert "scanpy" in skills
        assert "biopython" in skills
        assert "compbio-workflow" in skills


class TestProvision:
    def test_provision_base(self, tmp_path: Path) -> None:
        result = provision(
            workspace=tmp_path,
            project_type="base",
            project_name="Test Project",
            project_description="A test.",
        )
        assert (tmp_path / ".devcontainer" / "devcontainer.json").exists()
        assert (tmp_path / "CLAUDE.md").exists()
        assert (tmp_path / ".mcp.json").exists()
        assert (tmp_path / ".claude" / "hooks.json").exists()
        assert (tmp_path / ".claude" / "settings.json").exists()
        assert (tmp_path / ".claude" / "skills_manifest.json").exists()

        # Verify CLAUDE.md content
        claude_md = (tmp_path / "CLAUDE.md").read_text()
        assert "# Test Project" in claude_md

        # Verify devcontainer.json
        dc = json.loads((tmp_path / ".devcontainer" / "devcontainer.json").read_text())
        assert dc["name"] == "Test Project"

        # Verify skills manifest
        manifest = json.loads((tmp_path / ".claude" / "skills_manifest.json").read_text())
        assert manifest["project_type"] == "base"
        assert len(manifest["skills"]) > 0

    def test_provision_invalid_type(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="Invalid project type"):
            provision(
                workspace=tmp_path,
                project_type="invalid",
                project_name="Test",
                project_description="A test.",
            )

    def test_provision_with_existing_dockerfile(self, tmp_path: Path) -> None:
        (tmp_path / "Dockerfile").write_text(
            "FROM python:3.12 AS base\nRUN echo hi\nFROM base AS dev\nRUN echo dev\n"
        )
        result = provision(
            workspace=tmp_path,
            project_type="ml-cuda",
            project_name="Existing Project",
            project_description="Has its own Dockerfile.",
        )
        dc = json.loads((tmp_path / ".devcontainer" / "devcontainer.json").read_text())
        # Should reference existing Dockerfile from .devcontainer/ directory
        assert dc["build"]["dockerfile"] == "../Dockerfile"
        assert dc["build"]["context"] == ".."
        # Should NOT have copied a Dockerfile into .devcontainer
        assert not (tmp_path / ".devcontainer" / "Dockerfile").exists()
        # Should NOT inject our entrypoint.sh — the user owns their Dockerfile's
        # ENTRYPOINT and build context (`..` = workspace root) wouldn't pick up
        # a .devcontainer/entrypoint.sh anyway.
        assert not (tmp_path / ".devcontainer" / "entrypoint.sh").exists()

    def test_provision_selective(self, tmp_path: Path) -> None:
        result = provision(
            workspace=tmp_path,
            project_type="base",
            project_name="Minimal",
            project_description="Just CLAUDE.md.",
            write_devcontainer=False,
            write_mcp_json=False,
            write_hooks=False,
            write_settings=False,
        )
        assert (tmp_path / "CLAUDE.md").exists()
        assert not (tmp_path / ".devcontainer").exists()
        assert not (tmp_path / ".mcp.json").exists()

    def test_provision_all_project_types(self, tmp_path: Path) -> None:
        for ptype in ("base", "ml-cuda", "web-dev", "compbio"):
            workspace = tmp_path / ptype
            provision(
                workspace=workspace,
                project_type=ptype,
                project_name=f"Test {ptype}",
                project_description=f"Testing {ptype} provisioning.",
            )
            assert (workspace / "CLAUDE.md").exists()
            assert (workspace / ".devcontainer" / "devcontainer.json").exists()
