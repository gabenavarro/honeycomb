---
name: project-bootstrap
description: Interactive workflow to bootstrap a new project — gather requirements, infer project type, generate full .claude/ directory and devcontainer config.
---

# Project Bootstrap

Interactively set up a new project with a complete Claude Hive devcontainer environment.

## When to Use This Skill

- Starting a completely new project from scratch
- Onboarding an existing codebase into Claude Hive for the first time
- When the user says "set up a new project" or "create a workspace"

## Interactive Workflow

### Phase 1: Gather Information
Ask the user these questions (one at a time, adapt based on answers):

1. **What is the project name?**
2. **Describe what this project does in 1-2 sentences.**
3. **What type of project is this?** Offer choices based on description:
   - ML/CUDA — machine learning, deep learning, model training
   - Web Dev — web apps, APIs, frontend/backend
   - CompBio — bioinformatics, genomics, computational biology
   - Base — general purpose, scripts, tools, libraries
4. **Does this project have an existing GitHub repo?** If yes, get the URL.
5. **Does this project need GPU access?** (Only ask if ML/CUDA or ambiguous)
6. **Any specific frameworks or libraries not covered by the template?**

### Phase 2: Infer and Confirm

Based on answers, present the plan:
```
I'll set up "Project Name" as a [project-type] workspace:

DevContainer:
  - Base image: [ml-cuda / web-dev / compbio / base]
  - GPU access: [yes/no]
  - Forwarded ports: [list]

CLAUDE.md: Tailored for [project type] with:
  - [Key conventions from template]
  - [Any custom additions from user input]

Skills to install: [list from registry]
MCP Servers: [list from registry]
```

Ask the user to confirm or modify.

### Phase 3: Provision

Run the bootstrapper:
```python
from bootstrapper.provision import provision
from pathlib import Path

result = provision(
    workspace=Path(workspace_path),
    project_type=inferred_type,
    project_name=project_name,
    project_description=project_description,
)
```

### Phase 4: Customize

After provisioning, offer to customize:
- **CLAUDE.md**: "Would you like to add any project-specific conventions?"
- **Skills**: "Would you like to add or remove any skills from the manifest?"
- **Hooks**: "Would you like to customize any lifecycle hooks?"

Apply any changes the user requests.

### Phase 5: Verify

1. If `auto_start` is enabled, run `devcontainer up`
2. Verify hive-agent is running: check `/health` endpoint
3. Register with the hub: `POST /api/containers`
4. Report success:
```
✓ DevContainer created and running
✓ CLAUDE.md generated (87 lines)
✓ 12 skills queued for installation
✓ MCP servers configured (Context7, DeepWiki)
✓ Registered with Claude Hive hub (container #5)
```

## Type Inference Heuristics

If the user doesn't explicitly state a project type, infer from:

| Signal | Inferred Type |
|--------|---------------|
| Mentions PyTorch, training, model, GPU, CUDA, fine-tuning | ml-cuda |
| Mentions React, API, frontend, backend, web, Next.js, FastAPI | web-dev |
| Mentions genomics, RNA-seq, protein, cell, sequencing, bio | compbio |
| Mentions Dockerfile with CUDA base image | ml-cuda |
| Has `requirements.txt` with scanpy/biopython | compbio |
| Has `package.json` | web-dev |
| None of the above | base |

## Best Practices

- Ask one question at a time — don't overwhelm with a form
- Show the plan before executing — let the user confirm
- Default to the inferred type but let the user override
- If an existing repo is provided, clone it first, then detect existing Dockerfile
- Always verify the setup works before declaring success
- Keep the CLAUDE.md focused — better to start minimal and add than to start bloated
