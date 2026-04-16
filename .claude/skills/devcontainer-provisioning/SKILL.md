---
name: devcontainer-provisioning
description: Generate devcontainer.json, CLAUDE.md, skills, hooks, and MCP configs for a new project given its type and description.
---

# DevContainer Provisioning

Automate the setup of a complete Claude Hive devcontainer environment for a new project.

## When to Use This Skill

- Setting up a new project workspace with Claude Code
- Converting an existing project to use Claude Hive devcontainers
- Regenerating or updating the .claude/ directory configuration
- Creating a project-specific CLAUDE.md from templates

## Project Types

| Type | Use Case | Key Dependencies |
|------|----------|-----------------|
| `base` | General-purpose development | Python 3.12, Node.js 22, gh CLI, uv |
| `ml-cuda` | Machine learning with GPU | PyTorch, HuggingFace, Lightning, CUDA 13.2 |
| `web-dev` | Full-stack web development | Node.js, FastAPI, Playwright, pnpm |
| `compbio` | Computational biology | scanpy, BioPython, RDKit, pysam, scvi-tools |

## Provisioning Workflow

### Step 1: Detect Existing Setup
Check if the workspace already has:
- A `Dockerfile` with `base → dev / prod` multi-stage pattern
- A `.devcontainer/devcontainer.json`
- A `CLAUDE.md`
- A `.claude/` directory

If a compatible Dockerfile exists, generate a `devcontainer.json` that references it rather than overwriting.

### Step 2: Run the Bootstrapper
```python
from bootstrapper.provision import provision

result = provision(
    workspace=Path("/path/to/project"),
    project_type="ml-cuda",
    project_name="My ML Project",
    project_description="Fine-tuning LLMs on domain-specific data",
)
```

This generates:
- `.devcontainer/devcontainer.json` — container config with proper mounts, ports, env vars
- `.devcontainer/Dockerfile` — if no compatible Dockerfile exists
- `CLAUDE.md` — project-specific instructions rendered from Jinja2 templates
- `.mcp.json` — MCP server configurations (Context7, DeepWiki, Playwright for web-dev)
- `.claude/hooks.json` — default lifecycle hooks
- `.claude/settings.json` — permissions and preferences
- `.claude/skills_manifest.json` — list of skills to install

### Step 3: Customize CLAUDE.md
The rendered CLAUDE.md is a starting point. Customize it with:
- Specific model architectures or frameworks used
- Team conventions not covered by templates
- CI/CD pipeline details
- Data access patterns and credentials

### Step 4: Install Skills
Skills listed in `skills_manifest.json` are installed by the hub or DevContainer Feature. For manual installation:
```bash
cp -r /path/to/claude-scientific-skills/scientific-skills/pytorch-lightning ~/.claude/skills/
```

### Step 5: Verify Setup
```bash
devcontainer up --workspace-folder /path/to/project
devcontainer exec --workspace-folder /path/to/project -- hive-agent status
```

## GPU Considerations

- Only `ml-cuda` containers get `--gpus=all` in `runArgs`
- The hub tracks GPU ownership — check before launching a second GPU container
- `--shm-size=16g` is set for DataLoader workers
- CUDA 13.2 / Blackwell architecture: set `TORCH_CUDA_ARCH_LIST=Blackwell`

## Best Practices

- Always provision before starting: provision creates the devcontainer config that `devcontainer up` needs
- Use selective provisioning flags if you only need to update specific components
- Keep CLAUDE.md under 200 lines — split into `.claude/rules/*.md` for large instruction sets
- Use `CLAUDE.local.md` (gitignored) for personal preferences
- Review generated `.claude/settings.json` permissions — tighten for sensitive projects
