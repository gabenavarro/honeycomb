# Golden Project

A canonical project description used exclusively by golden-file tests. Keep it plain prose — Jinja-looking input belongs in test_provision_security.py, not here.

## Project Structure

- Follow existing directory structure conventions.
- Keep files focused and single-purpose.
- Separate concerns: data, logic, configuration, tests.

## Coding Conventions

- Python 3.12+. Type hints on all function signatures.
- Use `uv` for dependency management when available, otherwise `pip`.
- Format with `ruff`. Lint with `ruff check`.
- Docstrings on public functions and classes (Google style).

## Testing

- Use `pytest` for all tests.
- Tests live in `tests/` mirroring the source structure.
- Run tests before committing: `pytest -v`.

## Git Workflow

- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`.
- Feature branches off `main`. PRs require passing tests.
- Keep commits atomic — one logical change per commit.

## Environment

- This project runs in a Claude Hive devcontainer.
- `hive-agent` is available for hub communication.
- `gh` CLI is available for GitHub operations.
