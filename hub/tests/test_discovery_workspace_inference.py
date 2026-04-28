"""Unit tests for _infer_workspace_from_container — M37.x truth source.

Priority order (post-fix):
  1. devcontainer.local_folder label — host path, used by gitops + the
     devcontainer up/rebuild + provision flows.
  2. com.docker.compose.project.working_dir label — also host path.
  3. bind mount whose target is /workspace* — its source is the host path.
  4. container.attrs["Config"]["WorkingDir"] — last resort, container-side
     cwd. Used for ad-hoc ``docker run`` containers (e.g., gnbio) that
     have no host-side signal. The chat_stream docker-exec relay
     consumes this via ``-w <cwd>``.

The host-path signals come first because workspace_folder is consumed
by gitops (git/gh on the hub host), the devcontainer CLI relay
(--workspace-folder is a host path), and provision (writes templates
to the host filesystem). Switching to a container path for those
breaks them. WorkingDir is only the right answer for containers that
have NO host-side signal at all.
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


def test_devcontainer_label_wins_over_workingdir() -> None:
    """Regression guard: a devcontainer-CLI-launched container has both
    a container WORKDIR and a host-side local_folder label. The host
    path must win because devcontainer up/git/gitops all expect it."""
    c = _make(
        workdir="/workspace/myproj",
        labels={"devcontainer.local_folder": "/home/user/repos/myproj"},
    )
    assert _infer_workspace_from_container(c) == "/home/user/repos/myproj"


def test_compose_label_wins_over_workingdir() -> None:
    """Compose's project working_dir is a host path; same precedence
    as the devcontainer label."""
    c = _make(
        workdir="/srv/api",
        labels={"com.docker.compose.project.working_dir": "/host/proj"},
    )
    assert _infer_workspace_from_container(c) == "/host/proj"


def test_workspace_bind_mount_wins_over_workingdir() -> None:
    """A /workspace* bind mount source is the host path the user mounted
    from. Wins over the container's own cwd."""
    c = _make(
        workdir="/code",
        mounts=[{"Type": "bind", "Destination": "/workspace/foo", "Source": "/host/foo"}],
    )
    assert _infer_workspace_from_container(c) == "/host/foo"


def test_workingdir_wins_when_no_host_signal() -> None:
    """gnbio case: ad-hoc docker run with WorkingDir=/app, no devcontainer
    label, no /workspace bind mount. WorkingDir is the only credible
    signal — return it so chat_stream's docker-exec ``-w`` finds a
    real directory."""
    c = _make(workdir="/app")
    assert _infer_workspace_from_container(c) == "/app"


def test_empty_workingdir_with_no_host_signal_returns_none() -> None:
    """No host signal AND no meaningful WorkingDir → caller falls back
    to the synthetic /workspace/<name> placeholder in routers/discover."""
    c = _make(workdir="")
    assert _infer_workspace_from_container(c) is None


def test_root_workingdir_with_no_host_signal_returns_none() -> None:
    """A WorkingDir of "/" is the Docker default for images that don't
    declare WORKDIR — uninformative, fall through to None."""
    c = _make(workdir="/")
    assert _infer_workspace_from_container(c) is None


def test_no_signals_returns_none() -> None:
    """Truly degenerate: no WorkingDir, no labels, no /workspace mount."""
    c = _make()
    assert _infer_workspace_from_container(c) is None


def test_missing_config_attr_falls_through() -> None:
    """Defensive: docker SDK should always populate Config but be safe."""
    c = SimpleNamespace(labels={"devcontainer.local_folder": "/host/x"}, attrs={})
    assert _infer_workspace_from_container(c) == "/host/x"
