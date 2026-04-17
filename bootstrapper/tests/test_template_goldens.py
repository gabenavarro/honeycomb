"""Golden-file tests for the CLAUDE.md renderer.

Each project-type template is rendered with a canonical context; the
output is compared to a stored golden. Any accidental change to a
template triggers the test, and the diff on failure shows exactly what
shifted. Regenerate goldens intentionally with:

    HONEYCOMB_UPDATE_GOLDENS=1 pytest bootstrapper/tests/test_template_goldens.py

which rewrites the files on disk. Keep the canonical context small and
stable so goldens stay readable.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from bootstrapper.provision import VALID_PROJECT_TYPES, render_claude_md

GOLDENS_DIR = Path(__file__).parent / "goldens"

# Canonical rendering inputs. Keeping the name and description simple
# avoids noise in the goldens when we rev the templates themselves.
CANONICAL_NAME = "Golden Project"
CANONICAL_DESCRIPTION = (
    "A canonical project description used exclusively by golden-file "
    "tests. Keep it plain prose — Jinja-looking input belongs in "
    "test_provision_security.py, not here."
)


@pytest.mark.parametrize("project_type", VALID_PROJECT_TYPES)
def test_claude_md_matches_golden(project_type: str) -> None:
    rendered = render_claude_md(project_type, CANONICAL_NAME, CANONICAL_DESCRIPTION)
    golden_path = GOLDENS_DIR / f"{project_type}.claude.md"

    if os.environ.get("HONEYCOMB_UPDATE_GOLDENS") == "1":
        GOLDENS_DIR.mkdir(parents=True, exist_ok=True)
        golden_path.write_text(rendered, encoding="utf-8")
        pytest.skip(f"Golden regenerated at {golden_path}")

    assert golden_path.exists(), (
        f"Missing golden for {project_type} at {golden_path}. "
        "Generate with HONEYCOMB_UPDATE_GOLDENS=1 pytest ..."
    )
    expected = golden_path.read_text(encoding="utf-8")
    assert rendered == expected, (
        f"CLAUDE.md for {project_type} drifted from its golden. "
        "If the change is intentional, regenerate with "
        "HONEYCOMB_UPDATE_GOLDENS=1 pytest ..."
    )
