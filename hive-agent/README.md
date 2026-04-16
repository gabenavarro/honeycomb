# hive-agent

Lightweight worker-side client for Claude Hive. Runs inside devcontainers to communicate with the hub.

## Usage

```bash
# Start the agent
hive-agent start

# Start with custom options
hive-agent start --port 9100 --hub-url http://host.docker.internal:8420

# Check status
hive-agent status
```
