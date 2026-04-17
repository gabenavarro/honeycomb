"""Provisioner — generates a complete devcontainer setup for a new project.

Given a project type, name, and description, this module:
1. Detects if the workspace already has a Dockerfile with base→dev/prod pattern
2. Generates or copies devcontainer.json from templates
3. Renders a project-specific CLAUDE.md from Jinja2 templates
4. Copies curated skills from the skill registry
5. Writes default hooks config and settings.json
6. Writes .mcp.json with project-type-appropriate MCP servers
"""

from __future__ import annotations

import json
import logging
import re
import shutil
from pathlib import Path
from typing import Any

from jinja2 import FileSystemLoader
from jinja2.sandbox import SandboxedEnvironment
from pydantic import BaseModel, Field

logger = logging.getLogger("bootstrapper.provision")

BOOTSTRAPPER_DIR = Path(__file__).parent
TEMPLATES_DIR = BOOTSTRAPPER_DIR / "templates"
SKILL_REGISTRIES_DIR = BOOTSTRAPPER_DIR / "skill_registries"
HOOKS_DIR = BOOTSTRAPPER_DIR / "hooks"

VALID_PROJECT_TYPES = ("base", "ml-cuda", "web-dev", "compbio")


class TemplateError(RuntimeError):
    """Raised when a required template asset is missing.

    Prefer fail-loud: a silently missing ml-cuda template (→ base fallback)
    produces a container without GPU tooling that looks superficially correct
    to the user until training fails mysteriously.
    """


class TemplateContext(BaseModel):
    """Everything a template is allowed to see.

    Pre-M6 :mod:`jinja2.Environment` was used with no sandbox and no
    autoescape, and the render kwargs were loose ``str`` values built
    from whatever the caller passed. A user-supplied
    ``project_description`` containing ``{{ os.system('id') }}`` would
    have been executed at template time. Since M6 we pass a typed
    context through :class:`SandboxedEnvironment` so the same payload
    renders literally into the document.

    Fields are bounded at the schema level; :func:`slugify` is applied
    inside the renderer so callers don't need to remember the
    convention.
    """

    project_name: str = Field(..., min_length=1, max_length=200)
    project_description: str = Field(default="", max_length=10_000)
    # Computed after validation to match the CLAUDE.md templates'
    # existing ``{{ project_slug }}`` placeholder.
    project_slug: str = Field(default="")

    def dump_for_template(self) -> dict[str, str]:
        return {
            "project_name": self.project_name,
            "project_description": self.project_description,
            "project_slug": self.project_slug or slugify(self.project_name),
        }


def slugify(name: str) -> str:
    """Convert a project name to a slug suitable for directory/variable names."""
    slug = name.lower().strip()
    slug = re.sub(r"[^\w\s-]", "", slug)
    slug = re.sub(r"[\s-]+", "_", slug)
    return slug


def detect_existing_dockerfile(workspace: Path) -> bool:
    """Check if workspace has a Dockerfile with the base→dev/prod multi-stage pattern."""
    dockerfile = workspace / "Dockerfile"
    if not dockerfile.exists():
        return False
    content = dockerfile.read_text()
    has_base = bool(re.search(r"FROM\s+.+\s+AS\s+base", content, re.IGNORECASE))
    has_dev = bool(re.search(r"FROM\s+base\s+AS\s+dev", content, re.IGNORECASE))
    return has_base and has_dev


def load_skill_registry(project_type: str) -> dict[str, Any]:
    """Load the skill registry for a given project type.

    Raises TemplateError if the requested registry is missing. For project_type
    == "base", a missing registry is a hard install problem; for any other
    type, fallback would hide the real issue (wrong skills installed).
    """
    registry_file = SKILL_REGISTRIES_DIR / f"{project_type}.json"
    if not registry_file.exists():
        raise TemplateError(
            f"Missing skill registry for project type '{project_type}' at {registry_file}. "
            "Install is incomplete or the project_type is unsupported."
        )
    return json.loads(registry_file.read_text())


def render_claude_md(
    project_type: str,
    project_name: str,
    project_description: str,
) -> str:
    """Render a CLAUDE.md from the Jinja2 template for the given project type.

    Uses :class:`jinja2.sandbox.SandboxedEnvironment` with autoescape
    off (the output is Markdown, not HTML — escaping angle brackets
    would corrupt code blocks). The sandbox still blocks attribute
    access to dunder methods and reflective traversal, so an attacker
    controlling ``project_description`` cannot reach into Python from
    inside the template. See ``hub/tests/test_provision_security.py``
    for the regression matrix.

    Raises :class:`TemplateError` if the template for ``project_type``
    is missing. The base template is used only when
    ``project_type == "base"``.
    """
    template_dir = TEMPLATES_DIR / project_type
    template_path = template_dir / "claude.md.j2"
    if not template_path.exists():
        raise TemplateError(
            f"Missing claude.md.j2 for project type '{project_type}' at {template_path}."
        )

    context = TemplateContext(
        project_name=project_name,
        project_description=project_description,
    )
    env = SandboxedEnvironment(
        loader=FileSystemLoader(str(template_dir)),
        keep_trailing_newline=True,
        # ``autoescape=False`` is deliberate: the destination is a
        # plain-text Markdown document. HTML-escaping would turn
        # angle brackets in code samples into ``&lt;`` / ``&gt;`` and
        # break the rendered CLAUDE.md.
        autoescape=False,
    )
    template = env.get_template("claude.md.j2")
    return template.render(**context.dump_for_template())


def generate_devcontainer_json(
    project_type: str,
    project_name: str,
    workspace: Path,
) -> dict[str, Any]:
    """Generate a devcontainer.json for the workspace.

    If the workspace already has a compatible Dockerfile, generate a minimal
    devcontainer.json that references it. Otherwise, copy the full template.
    """
    template_file = TEMPLATES_DIR / project_type / "devcontainer.json"
    if not template_file.exists():
        raise TemplateError(
            f"Missing devcontainer.json for project type '{project_type}' at {template_file}."
        )

    template_content = template_file.read_text()

    # Simple Jinja-like replacement for devcontainer.json (not full Jinja since
    # devcontainer.json has its own ${} variable syntax we must preserve)
    rendered = (
        template_content.replace(
            "{{ project_name | default('Claude Hive Workspace') }}", project_name
        )
        .replace("{{ project_name | default('ML/CUDA Workspace') }}", project_name)
        .replace("{{ project_name | default('Web Dev Workspace') }}", project_name)
        .replace("{{ project_name | default('CompBio Workspace') }}", project_name)
    )

    config = json.loads(rendered)

    # If workspace already has a compatible Dockerfile, reference it from .devcontainer/
    if detect_existing_dockerfile(workspace):
        config["build"] = {
            "dockerfile": "../Dockerfile",
            "target": "dev",
            "context": "..",
        }
        logger.info("Detected existing Dockerfile with dev target, referencing it")

    return config


def generate_mcp_json(project_type: str) -> dict[str, Any]:
    """Generate .mcp.json from the skill registry's MCP server configs."""
    registry = load_skill_registry(project_type)
    mcp_servers = registry.get("mcp_servers", {})
    return {"mcpServers": mcp_servers}


def get_skill_list(project_type: str) -> list[str]:
    """Get the flat list of all skills to install for a project type."""
    registry = load_skill_registry(project_type)
    skills: list[str] = []
    for category in registry.get("skills", {}).values():
        skills.extend(category.get("items", []))
    return skills


def provision(
    workspace: Path,
    project_type: str,
    project_name: str,
    project_description: str,
    *,
    write_devcontainer: bool = True,
    write_claude_md: bool = True,
    write_mcp_json: bool = True,
    write_hooks: bool = True,
    write_settings: bool = True,
) -> dict[str, list[str]]:
    """Provision a workspace with a complete Claude Hive devcontainer setup.

    Args:
        workspace: Path to the project workspace directory.
        project_type: One of 'base', 'ml-cuda', 'web-dev', 'compbio'.
        project_name: Human-readable project name.
        project_description: One-paragraph description of what the project does.
        write_*: Flags to selectively enable/disable each provisioning step.

    Returns:
        Dict of created file paths grouped by category.
    """
    if project_type not in VALID_PROJECT_TYPES:
        raise ValueError(
            f"Invalid project type: {project_type}. Must be one of {VALID_PROJECT_TYPES}"
        )

    workspace = Path(workspace)
    workspace.mkdir(parents=True, exist_ok=True)

    created: dict[str, list[str]] = {
        "devcontainer": [],
        "claude_md": [],
        "mcp": [],
        "hooks": [],
        "settings": [],
        "skills": [],
    }

    # 1. DevContainer config
    if write_devcontainer:
        devcontainer_dir = workspace / ".devcontainer"
        devcontainer_dir.mkdir(exist_ok=True)

        config = generate_devcontainer_json(project_type, project_name, workspace)
        devcontainer_json_path = devcontainer_dir / "devcontainer.json"
        devcontainer_json_path.write_text(json.dumps(config, indent=4) + "\n")
        created["devcontainer"].append(str(devcontainer_json_path))

        using_template_dockerfile = not detect_existing_dockerfile(workspace)

        # Copy Dockerfile if workspace doesn't have one
        if using_template_dockerfile:
            template_dockerfile = TEMPLATES_DIR / project_type / "Dockerfile"
            if not template_dockerfile.exists():
                raise TemplateError(
                    f"Workspace has no Dockerfile and template is missing at "
                    f"{template_dockerfile}. Cannot provision '{project_type}'."
                )
            dest_dockerfile = devcontainer_dir / "Dockerfile"
            shutil.copy2(template_dockerfile, dest_dockerfile)
            created["devcontainer"].append(str(dest_dockerfile))
            logger.info("Copied Dockerfile template for %s", project_type)

            # entrypoint.sh is only required by our template Dockerfile
            # (which does `COPY entrypoint.sh /usr/local/bin/...`). With the
            # template's build context = .devcontainer/, the entrypoint must
            # live alongside the Dockerfile. Missing entrypoint is a hard
            # build-time failure (see troubleshoot.md).
            entrypoint_src = TEMPLATES_DIR / "base" / "entrypoint.sh"
            if not entrypoint_src.exists():
                raise TemplateError(
                    f"Required entrypoint.sh missing at {entrypoint_src}. "
                    "Reinstall bootstrapper templates."
                )
            entrypoint_dest = devcontainer_dir / "entrypoint.sh"
            shutil.copy2(entrypoint_src, entrypoint_dest)
            # Preserve executable bit explicitly — shutil.copy2 relies on
            # source mode, which may not survive packaging.
            entrypoint_dest.chmod(0o755)
            created["devcontainer"].append(str(entrypoint_dest))
        else:
            # User supplied their own Dockerfile with build context `..`
            # (workspace root). Don't inject our entrypoint — they own the
            # ENTRYPOINT. Note for them:
            logger.info(
                "Existing Dockerfile detected; skipping entrypoint.sh. "
                "Your Dockerfile is responsible for starting hive-agent in "
                "the dev stage (see docs)."
            )

        logger.info("Generated devcontainer.json at %s", devcontainer_json_path)

    # 2. CLAUDE.md
    if write_claude_md:
        claude_md_content = render_claude_md(project_type, project_name, project_description)
        claude_md_path = workspace / "CLAUDE.md"
        claude_md_path.write_text(claude_md_content)
        created["claude_md"].append(str(claude_md_path))
        logger.info("Generated CLAUDE.md at %s", claude_md_path)

    # 3. .mcp.json
    if write_mcp_json:
        mcp_config = generate_mcp_json(project_type)
        mcp_json_path = workspace / ".mcp.json"
        mcp_json_path.write_text(json.dumps(mcp_config, indent=4) + "\n")
        created["mcp"].append(str(mcp_json_path))
        logger.info("Generated .mcp.json at %s", mcp_json_path)

    # 4. Hooks — use project-type-specific hooks if available, else default
    if write_hooks:
        claude_dir = workspace / ".claude"
        claude_dir.mkdir(exist_ok=True)
        type_hooks = HOOKS_DIR / f"{project_type}_hooks.json"
        hooks_src = type_hooks if type_hooks.exists() else HOOKS_DIR / "default_hooks.json"
        if hooks_src.exists():
            hooks_dest = claude_dir / "hooks.json"
            shutil.copy2(hooks_src, hooks_dest)
            created["hooks"].append(str(hooks_dest))
            logger.info("Copied %s hooks to %s", hooks_src.stem, hooks_dest)

    # 5. Settings
    if write_settings:
        claude_dir = workspace / ".claude"
        claude_dir.mkdir(exist_ok=True)
        settings_path = claude_dir / "settings.json"
        if not settings_path.exists():
            settings = {
                "permissions": {
                    "allow": [
                        "Bash(git *)",
                        "Bash(python *)",
                        "Bash(pytest *)",
                        "Bash(pip *)",
                        "Bash(uv *)",
                        "Bash(gh *)",
                        "Bash(hive-agent *)",
                        "Read",
                        "Write",
                        "Edit",
                        "Glob",
                        "Grep",
                    ]
                }
            }
            settings_path.write_text(json.dumps(settings, indent=4) + "\n")
            created["settings"].append(str(settings_path))
            logger.info("Generated settings.json at %s", settings_path)

    # 6. Record skills to install (actual skill files are copied by the hub
    #    or DevContainer Feature from the skill repositories)
    skills = get_skill_list(project_type)
    if skills:
        claude_dir = workspace / ".claude"
        claude_dir.mkdir(exist_ok=True)
        skills_manifest = claude_dir / "skills_manifest.json"
        skills_manifest.write_text(
            json.dumps(
                {
                    "project_type": project_type,
                    "skills": skills,
                },
                indent=4,
            )
            + "\n"
        )
        created["skills"].append(str(skills_manifest))
        logger.info("Wrote skills manifest (%d skills) to %s", len(skills), skills_manifest)

    return created
