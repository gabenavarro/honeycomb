"""Unit tests for ResourceMonitor ring-buffer history (M25)."""

from __future__ import annotations

from datetime import datetime

from hub.models.schemas import ResourceStats
from hub.services.resource_monitor import HISTORY_CAP, ResourceMonitor


def _sample(cid: str, cpu: float = 1.0) -> ResourceStats:
    return ResourceStats(
        container_id=cid,
        cpu_percent=cpu,
        memory_mb=1.0,
        memory_limit_mb=100.0,
        memory_percent=1.0,
        timestamp=datetime.now(),
    )


class TestResourceHistory:
    def test_record_and_read_empty(self) -> None:
        rm = ResourceMonitor()
        assert rm.get_history("nope") == []

    def test_record_sample_appends(self) -> None:
        rm = ResourceMonitor()
        a = _sample("c1", 1.0)
        b = _sample("c1", 2.0)
        rm._record_sample("c1", a)
        rm._record_sample("c1", b)
        history = rm.get_history("c1")
        assert len(history) == 2
        assert [s.cpu_percent for s in history] == [1.0, 2.0]

    def test_caps_at_history_cap(self) -> None:
        rm = ResourceMonitor()
        for i in range(HISTORY_CAP + 5):
            rm._record_sample("c1", _sample("c1", float(i)))
        history = rm.get_history("c1")
        assert len(history) == HISTORY_CAP
        # Oldest 5 dropped; first surviving cpu is 5.0.
        assert history[0].cpu_percent == 5.0
        assert history[-1].cpu_percent == float(HISTORY_CAP + 4)

    def test_get_history_returns_snapshot(self) -> None:
        # Mutating the returned list must not affect the internal buffer.
        rm = ResourceMonitor()
        rm._record_sample("c1", _sample("c1", 1.0))
        snap = rm.get_history("c1")
        snap.clear()
        assert len(rm.get_history("c1")) == 1

    def test_clear_history(self) -> None:
        rm = ResourceMonitor()
        rm._record_sample("c1", _sample("c1"))
        rm._record_sample("c2", _sample("c2"))
        rm.clear_history("c1")
        assert rm.get_history("c1") == []
        assert len(rm.get_history("c2")) == 1

    def test_clear_history_unknown_is_noop(self) -> None:
        rm = ResourceMonitor()
        rm.clear_history("nope")  # no raise

    def test_isolation_per_container(self) -> None:
        rm = ResourceMonitor()
        rm._record_sample("c1", _sample("c1", 1.0))
        rm._record_sample("c2", _sample("c2", 2.0))
        assert rm.get_history("c1")[0].cpu_percent == 1.0
        assert rm.get_history("c2")[0].cpu_percent == 2.0
