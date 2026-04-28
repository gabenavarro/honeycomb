"""Unit tests for _infer_workspace_from_container — M37.x truth source.

Priority order (post-fix):
  1. container.attrs["Config"]["WorkingDir"] — canonical container-side cwd
  2. devcontainer.local_folder label
  3. com.docker.compose.project.working_dir label
  4. bind mount whose target is /workspace*
"""

from __future__ import annotations

from types import SimpleNamespace

from hub.services.discovery import _infer_workspace_from_container


def _make(
    *,
    workdir: str | None = None,
    labels: dict | None = None,
    mounts: list | None = None,
) -> SimpleNamespace:
    attrs: dict = {"Mounts": mounts or []}
    if workdir is not None:
        attrs["Config"] = {"WorkingDir": workdir}
    return SimpleNamespace(labels=labels or {}, attrs=attrs)


def test_workingdir_is_preferred_over_devcontainer_label() -> None:
    """Regression: gnbio had no devcontainer labels and WorkingDir=/app.
    Container path must win because docker-exec uses it."""
    c = _make(
        workdir="/app",
        labels={"devcontainer.local_folder": "/home/user/proj"},
    )
    assert _infer_workspace_from_container(c) == "/app"


def test_workingdir_is_preferred_over_compose_label() -> None:
    c = _make(
        workdir="/srv/api",
        labels={"com.docker.compose.project.working_dir": "/host/proj"},
    )
    assert _infer_workspace_from_container(c) == "/srv/api"


def test_workingdir_is_preferred_over_bind_mount() -> None:
    c = _make(
        workdir="/code",
        mounts=[{"Type": "bind", "Destination": "/workspace/foo", "Source": "/host/foo"}],
    )
    assert _infer_workspace_from_container(c) == "/code"


def test_empty_workingdir_falls_through_to_label() -> None:
    c = _make(workdir="", labels={"devcontainer.local_folder": "/host/proj"})
    assert _infer_workspace_from_container(c) == "/host/proj"


def test_root_workingdir_falls_through_to_label() -> None:
    """A WorkingDir of "/" is the Docker default for images that don't
    declare WORKDIR — uninformative, fall through."""
    c = _make(workdir="/", labels={"devcontainer.local_folder": "/host/proj"})
    assert _infer_workspace_from_container(c) == "/host/proj"


def test_no_signals_returns_none() -> None:
    """Truly degenerate: no WorkingDir, no labels, no /workspace mount."""
    c = _make()
    assert _infer_workspace_from_container(c) is None


def test_missing_config_attr_falls_through() -> None:
    """Defensive: docker SDK should always populate Config but be safe."""
    c = SimpleNamespace(labels={"devcontainer.local_folder": "/host/x"}, attrs={})
    assert _infer_workspace_from_container(c) == "/host/x"
