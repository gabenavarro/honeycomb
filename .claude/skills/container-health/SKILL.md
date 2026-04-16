---
name: container-health
description: Monitor devcontainer health, detect stuck or unhealthy containers, interpret resource metrics, and perform diagnostics and recovery.
---

# Container Health

Monitor and diagnose health issues across Claude Hive devcontainers.

## When to Use This Skill

- A container is reported as unresponsive or errored in the dashboard
- Resource usage (CPU, memory, GPU) appears abnormal
- A Claude Code session is hanging or producing no output
- Need to verify all containers are healthy after a restart

## Health Check Workflow

### Step 1: Check Agent Status
```bash
# From the host or another container:
curl http://<container-host>:9100/health
# Expected: {"status": "ok", "container_id": "...", "agent_status": "idle"}
```

Via hub API:
```
GET /api/containers/{id}
# Check: agent_status should be "idle" or "busy", not "unreachable" or "error"
```

### Step 2: Check Resource Usage
```
GET /api/containers/{id}/resources
```

| Metric | Healthy | Warning | Critical |
|--------|---------|---------|----------|
| CPU % | < 80% | 80-95% | > 95% sustained |
| Memory % | < 70% | 70-90% | > 90% |
| GPU Util | < 95% | 95-99% | 100% sustained + OOM |
| GPU Memory | < 90% | 90-95% | > 95% |

### Step 3: Check Container Logs
```bash
docker logs <container-id> --tail 100
```

Look for:
- OOM kills: `Killed process` or `Out of memory`
- CUDA errors: `CUDA out of memory`, `CUDA error: device-side assert`
- hive-agent errors: `Hub unreachable after N consecutive failures`
- Process crashes: segfaults, Python tracebacks

### Step 4: Check Running Processes
```bash
# Via hive-agent
curl http://<container-host>:9100/status
# Shows running_commands list

# Or via devcontainer exec
devcontainer exec --workspace-folder /path -- ps aux
```

## Common Issues and Fixes

### Container Unreachable (agent_status: unreachable)
1. Check if container is running: `docker ps | grep <container-id>`
2. If stopped: restart via hub `POST /api/containers/{id}/start`
3. If running but agent unreachable: hive-agent may have crashed
   - Restart agent: `devcontainer exec -- hive-agent start`
   - Check if port 9100 is blocked: `devcontainer exec -- ss -tlnp | grep 9100`

### High Memory Usage
1. Check what's consuming memory: `devcontainer exec -- ps aux --sort=-%mem | head`
2. For Python processes: likely large datasets in memory
3. For ML: reduce batch size, enable gradient checkpointing
4. Clear Python garbage: `import gc; gc.collect()`
5. Clear CUDA cache: `torch.cuda.empty_cache()`

### GPU OOM
1. Check GPU memory: `nvidia-smi`
2. Identify which container owns the GPU via hub
3. Reduce model/batch size, enable mixed precision
4. Kill the offending process if stuck: `curl http://<host>:9100/kill/<cmd_id>`

### Stuck Claude Code Session
1. Check if there's a running command: `curl http://<host>:9100/status`
2. If a command is running for too long, kill it: `curl -X POST http://<host>:9100/kill/<cmd_id>`
3. If hive-agent itself is stuck: `devcontainer exec -- pkill -f hive-agent && hive-agent start`

## Heartbeat Protocol

The hive-agent sends heartbeats to the hub every 5 seconds. The hub marks a container as:
- **unreachable**: 3 consecutive missed heartbeats (15 seconds)
- **error**: container explicitly reports error status

Recovery: once heartbeats resume, the hub automatically updates status back to idle/busy.

## Best Practices

- Check container health before dispatching work
- Monitor resource usage trends, not just point-in-time snapshots
- Set up alerts in the dashboard for containers exceeding resource thresholds
- After a container restart, verify hive-agent is running before sending commands
- For GPU containers: only one should be running GPU workloads at a time
- Periodically restart long-lived containers to clear accumulated state
