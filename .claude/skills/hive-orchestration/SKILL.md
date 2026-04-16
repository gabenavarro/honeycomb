---
name: hive-orchestration
description: Dispatch commands to multiple devcontainers via the Claude Hive hub, aggregate results, and handle partial failures across a fleet of containers.
---

# Hive Orchestration

Coordinate work across multiple Claude Code devcontainers managed by the Claude Hive hub.

## When to Use This Skill

- Dispatching the same or different commands to multiple devcontainers simultaneously
- Running tests, lints, or builds across several project containers in parallel
- Aggregating results from multiple containers into a unified report
- Performing fleet-wide operations (update skills, sync configs, check health)

## Architecture

The hub exposes REST + WebSocket APIs at `http://127.0.0.1:8420`:
- `GET /api/containers` — list all registered devcontainers
- `POST /api/containers/{id}/commands` — dispatch a command
- `GET /api/containers/{id}/commands/{cmd_id}` — get output
- `GET /api/containers/{id}/commands/{cmd_id}/stream` — stream output
- `POST /api/containers/{id}/commands/{cmd_id}/kill` — kill a command
- `GET /api/containers/{id}/resources` — get CPU/memory/GPU stats

Each container runs `hive-agent` which accepts commands on port 9100.

## Dispatch Patterns

### Fan-Out / Fan-In
1. Query hub for all running containers: `GET /api/containers`
2. Filter to relevant containers (by project type, status, etc.)
3. Dispatch commands in parallel to each container
4. Collect results as they complete
5. Aggregate into a unified report

### Sequential Pipeline
1. Run step 1 in container A (e.g., data preprocessing)
2. Pass output to container B (e.g., model training)
3. Pass output to container C (e.g., evaluation)
4. Merge final results

### Selective Dispatch
1. Determine which container is best suited for a task (GPU for ML, etc.)
2. Check resource availability via `/api/containers/{id}/resources`
3. Dispatch to the container with capacity

## Handling Failures

- **Partial failure**: If 5 of 7 containers succeed, report successes and failures separately. Do not treat partial failure as total failure.
- **Timeout**: Commands default to 120s timeout. Long-running tasks (training, builds) should use streaming via WebSocket.
- **Container unreachable**: If hive-agent is unreachable, fall back to `devcontainer exec`. If both fail, mark container as errored and skip.
- **Retry strategy**: Retry failed commands once. If the retry also fails, report the failure and move on.

## Best Practices

- Always check container status before dispatching (`agent_status: idle` means ready)
- Use command IDs to track commands across containers: `{"command": "pytest", "command_id": "test-run-001"}`
- Subscribe to WebSocket channels for real-time updates instead of polling
- For GPU-bound tasks, check GPU ownership first — only one container can use the GPU at a time
- Group independent tasks and dispatch in parallel; chain dependent tasks sequentially
- Include container name/ID in aggregated reports so failures are traceable
