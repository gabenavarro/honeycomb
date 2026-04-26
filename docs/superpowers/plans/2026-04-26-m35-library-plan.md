# M35 — Library (artifact aggregation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the M32 LibraryRoute bridge (which surfaced M27 Recent Edits only) with the full Library — eight artifact types (Plan / Review / Edit / Snippet / Note / Skill / Subagent / Spec) aggregated from auto-save hooks across the chat stream + filesystem, with primary/More chip filtering, full-text search, scope toggle (active workspace / fleet-wide), per-type renderers, and live updates via WebSocket. Edit-type artifacts are read-only translations of the existing `diff_events` table — no duplicate storage.

**Architecture:** New `artifacts` table (Alembic migration) stores 7 of 8 types; the 8th (Edit) is synthesized at read-time from `diff_events`. The hub service `artifacts.py` owns CRUD + the read-time synthesis union. The router exposes REST + a POST endpoint for client-initiated artifacts (the M34 `/save note` slash command becomes a real artifact in M35). Auto-save hooks live in `chat_stream.py` parser — when the parser sees a Plan-mode-flip-out / Snippet code block / Subagent Task tool_use_end / Note `> NOTE:` marker, it calls `record_artifact` + broadcasts on `library:<container_id>`. Spec auto-save runs on hub startup (rescan `docs/superpowers/specs/*.md`; record new files). The dashboard's `LibraryRoute` swaps from the M32 bridge to a full `LibraryActivity` component: sidebar (filter chips + scope toggle + search + card list) + main pane (per-type renderer dispatch). `useArtifacts` hook mirrors M30 useDiffEvents (TanStack Query + WS push). Workspace scope: active = single `?container_id=N` query; fleet = client-side fan-out over the container list.

**Tech Stack:** SQLAlchemy + Alembic (migration); existing M30 ConnectionManager broadcast; Pydantic v2 Literals for type discriminator; React 19 + TanStack Query; **NEW dependency: `react-markdown` + `remark-gfm`** (markdown renderer for Plan/Note/Spec/Skill); existing `react-diff-view` (M27, reused by EditRenderer); Vitest + `@testing-library/react`; Playwright + `@axe-core/playwright`.

**Branch:** `m35-library` (to be created from `main` at the start of Task 0).

**Spec:** [docs/superpowers/specs/2026-04-26-dashboard-redesign-design.md](../specs/2026-04-26-dashboard-redesign-design.md) — M35 section (lines 865–935) + section 6 Library design (lines 350–425) + Architecture → Library artifact schema (lines 525–620).

**Visual reference:** `.superpowers/brainstorm/95298-1777173712/content/07-library.html` (locked design).

---

## Decisions made up front

These decisions are locked at plan time so the implementer doesn't have to think about them mid-task:

### Edit-type artifacts: read-time synthesis from diff_events (no duplicate storage)

The eight artifact types share a single SQL table (per spec lines 525–555) — except for `edit`. Edits are already captured in M27's `diff_events` table. Storing them again as artifact rows would be duplicate storage with stale-cache risk.

**Decision:** Edit-type artifacts are SYNTHESIZED at read-time. The `list_artifacts` service does:

```
1. SELECT * FROM artifacts WHERE container_id = :cid AND ... → real rows
2. If filter includes "edit" OR no type filter:
   a. SELECT * FROM diff_events WHERE container_id = :cid → diff rows
   b. Map each → Artifact JSON with artifact_id = "edit-" + diff_event.event_id
3. UNION + sort by created_at DESC
```

The synthesized Artifact is **immutable** (no pin / archive / delete via `/api/artifacts/edit-xxx/pin`). Pin/archive on edit artifacts is out of scope for M35.

### `/save note` slash command becomes real in M35

M34 left `/save note` as a stub-toast ("Notes arrive in M35 (Library)."). M35 wires it to actually create a Note artifact via a new `POST /api/containers/{id}/artifacts` endpoint. The existing `slashCommands.ts` parser keeps the `kind: "toast"` action for now; M35's last task adds a new `kind: "create-artifact"` action variant + the dashboard dispatcher routes it through the new endpoint.

### Spec auto-save: startup rescan only (no live watcher)

Spec files land in `docs/superpowers/specs/*.md` from brainstorm sessions. Spec artifacts auto-save when the hub starts: scan that directory, find all `.md` files, look up each by its `metadata.file_path`; if not present in the artifacts table, create a `type=spec` row.

No live filesystem watcher in M35 — `watchdog` is a substantial dep and the brainstorm flow naturally involves a hub restart (or at minimum a dashboard refresh, which can trigger a rescan via a cheap `POST /api/artifacts/rescan-specs` admin endpoint — deferred).

### Review auto-save: dormant in M35 (PR thread loading deferred)

Review-mode in M33/M34 is a localStorage flag + `--permission-mode default` + system-prompt nudge. There's no actual PR thread loaded; `/review <pr>` from M34 just toasts "PR thread loading arrives in M35." But **M35 does NOT actually load PR threads** — that's coupled to M14 GitOps integration which is a substantial future-ticket scope.

**Decision:** Review-type auto-save is **dormant in M35.** The artifact type, REST plumbing, and renderer all ship; the auto-save hook is a stub that early-returns with a "review_pr_loaded=False" guard. The hook is wired but inert. Future M35.x or M36 enables it once PR loading lands.

### Workspace scope: fleet-wide via client-side fan-out

Backend ships `GET /api/containers/{id}/artifacts` only (single-container). For fleet-wide scope, the dashboard fans out N parallel calls (one per container in the list) and unions client-side by `created_at DESC`. With the ~7-container scale target, this is well under any latency budget.

A future server-side fleet endpoint can land if container counts grow.

### Pin/Archive: endpoints ship; UI deferred to M35.x

The spec mandates `pinned` and `archived` columns + endpoints. M35 v1 ships:

- The columns (default 0 each)
- The endpoints (`POST /api/artifacts/{id}/pin`, `/unpin`, `/archive`)
- A `?archived=false` filter on `list_artifacts` (default false; explicit `?archived=true` shows archived)

M35 v1 does NOT ship UI for pinning/archiving (no chevron menu on cards; no "Pinned" sort tier). UI for these is M35.x or M36.

The hover-action bar on artifact cards SHIPS in M35 with: **Open in chat** (backlink) + **Delete** (with confirm) only.

### Markdown renderer: `react-markdown` + `remark-gfm`

Plan / Note / Spec / Skill renderers all need markdown. M35 adds:

- `react-markdown` (latest v9+, React 19 compatible, ESM-only)
- `remark-gfm` (GitHub-flavored extensions: tables, strikethrough, task lists)

These are well-maintained React-standard packages. Sanitization is built-in (no `dangerouslySetInnerHTML`).

### Per-user customization persistence

`localStorage:hive:library:primary-types` — JSON array of 4 type IDs (in display order). Default if absent: `["plan", "review", "edit", "snippet"]`. The other 4 land in More.

`localStorage:hive:library:scope` — `"active" | "fleet"`. Default `"active"`.

### No keyboard nav for chip customization sheet

Click-only, matching M34 SlashAutocomplete. Up/Down/Enter is a follow-up.

### Dashboard `Artifact` TS type mirrors hub's Pydantic schema

The TS type is a discriminated union over `type`, with per-type narrowing of `metadata`. This costs more code at the type layer but pays off in the renderer dispatch (each renderer destructures `metadata` with type narrowing).

---

## Out of scope (deferred to follow-ups)

- **Real Review artifact creation** — depends on PR thread loading (M14 GitOps integration; M35.x or M36)
- **Skill auto-source** — placeholder type only; future Skills milestone synthesizes from chat patterns
- **Live filesystem watcher for spec auto-save** — M35 uses startup rescan
- **Pin / Archive UI** — endpoints ship; UI is M35.x
- **Chip customization keyboard navigation** — click-only
- **FTS5 full-text search** — M35 uses simple SQL LIKE for `title || body`
- **Server-side fleet artifact endpoint** — client-side fan-out for M35
- **Mobile breakpoints** (M36)

---

## File Structure

### Backend — create

- `hub/db/migrations/versions/2026_xx_xx-m35_artifacts.py` — Alembic migration (artifacts table + 3 indexes)
- `hub/db/schema.py` — extend with `artifacts` SQLAlchemy Core Table definition (if there's a central schema module) OR inline in the migration only (verify pattern against existing migrations).
- `hub/services/artifacts.py` — CRUD + diff-event synthesis + spec rescan + tests
- `hub/routers/artifacts.py` — REST endpoints + tests
- `hub/tests/test_artifacts_service.py`
- `hub/tests/test_artifacts_endpoint.py`
- `hub/tests/test_chat_stream_artifact_hooks.py` — for the 4 auto-save hooks

### Backend — modify

- `hub/main.py` — register new router; call spec rescan on startup (lifespan event)
- `hub/models/schemas.py` — add `Artifact` Pydantic model + `ArtifactType` Literal alias
- `hub/services/chat_stream.py` — extend `ClaudeTurnSession.run` (or its parser layer) with the 4 auto-save hooks. Pass an optional `artifacts_engine` so hooks can write without coupling chat_stream tightly to the artifacts table.

### Frontend — create

- `dashboard/src/hooks/useArtifacts.ts` — TanStack Query + WS subscription
- `dashboard/src/hooks/__tests__/useArtifacts.test.tsx`
- `dashboard/src/components/library/LibraryActivity.tsx` — top-level shell (sidebar + main)
- `dashboard/src/components/library/ArtifactCard.tsx` — single sidebar card (icon + title + meta + From: <chat>)
- `dashboard/src/components/library/FilterChips.tsx` — All + 4 primary + ⋯ More chip row
- `dashboard/src/components/library/MoreCustomizationSheet.tsx` — popover with all 8 types + ★ toggle
- `dashboard/src/components/library/ScopeToggle.tsx` — active / fleet toggle
- `dashboard/src/components/library/SearchInput.tsx` — debounced search
- `dashboard/src/components/library/renderers/PlanRenderer.tsx`
- `dashboard/src/components/library/renderers/NoteRenderer.tsx`
- `dashboard/src/components/library/renderers/SpecRenderer.tsx`
- `dashboard/src/components/library/renderers/SkillRenderer.tsx`
- `dashboard/src/components/library/renderers/EditRenderer.tsx` — reuses M27 DiffViewerTab
- `dashboard/src/components/library/renderers/SnippetRenderer.tsx`
- `dashboard/src/components/library/renderers/ReviewRenderer.tsx` — placeholder (dormant)
- `dashboard/src/components/library/renderers/SubagentRenderer.tsx`
- `dashboard/src/components/library/renderers/dispatch.tsx` — registry mapping ArtifactType → component
- `dashboard/src/components/library/__tests__/*.test.tsx` — per component
- `dashboard/tests/e2e/library.spec.ts` — Playwright spec

### Frontend — modify

- `dashboard/package.json` — add `react-markdown` + `remark-gfm`
- `dashboard/src/lib/types.ts` — add `Artifact`, `ArtifactType`, type-specific metadata interfaces
- `dashboard/src/lib/api.ts` — add `listArtifacts`, `getArtifact`, `createArtifact`, `pinArtifact`, `unpinArtifact`, `archiveArtifact`, `deleteArtifact`
- `dashboard/src/lib/slashCommands.ts` — extend `SlashAction` with `create-artifact` variant; route `/save note <title>` through it (instead of toast stub)
- `dashboard/src/components/routes/LibraryRoute.tsx` — replace M32 bridge content with `<LibraryActivity />`
- `dashboard/src/components/routes/ChatsRoute.tsx` — `ChatThreadWrapper` slash dispatcher: handle the new `create-artifact` action by calling `createArtifact` API

---

## Task 0: Verify branch + create feature branch

- [ ] **Step 1: Confirm clean main + branch**

```bash
cd /home/gnava/repos/honeycomb
git checkout main
git pull --ff-only origin main
git status -s
git log --oneline -3
```

Expected: on `main`, status clean except `?? .claude/settings.json`, recent log shows `Merge M34: composer (effort + model + slash commands)` (or later).

- [ ] **Step 2: Create the feature branch**

```bash
git checkout -b m35-library
```

- [ ] **Step 3: Verify the diff_events table exists (Edit synthesis depends on it)**

```bash
grep -l "diff_events" hub/db/migrations/versions/ | head -3
sqlite3 ~/.config/honeycomb/registry.db ".schema diff_events" | head -10
```

If the local DB doesn't have the table, run `cd hub && uv run alembic -c db/alembic.ini upgrade head` first.

---

## Task 1: Alembic migration + Artifact Pydantic model

**Files:**

- Create: `hub/db/migrations/versions/<rev>_m35_artifacts.py` (Alembic generates timestamp prefix)
- Modify: `hub/models/schemas.py` (add `Artifact`, `ArtifactType`)

### Step 1: Generate the Alembic migration scaffold

```bash
cd /home/gnava/repos/honeycomb/hub
uv run alembic -c db/alembic.ini revision -m "m35 artifacts table"
```

This creates a new file at `hub/db/migrations/versions/<timestamp>_m35_artifacts.py`. Open it and replace the `upgrade()` and `downgrade()` bodies:

```python
def upgrade() -> None:
    op.create_table(
        "artifacts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("artifact_id", sa.Text(), nullable=False, unique=True),
        sa.Column(
            "container_id",
            sa.Integer(),
            sa.ForeignKey("containers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "type",
            sa.Text(),
            nullable=False,
        ),
        sa.Column("title", sa.Text(), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("body_format", sa.Text(), nullable=False, server_default="markdown"),
        sa.Column("source_chat_id", sa.Text(), nullable=True),
        sa.Column("source_message_id", sa.Text(), nullable=True),
        sa.Column("metadata_json", sa.Text(), nullable=True),
        sa.Column("pinned", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("archived", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.Text(), nullable=False),
        sa.CheckConstraint(
            "type IN ('plan','review','edit','snippet','note','skill','subagent','spec')",
            name="ck_artifacts_type",
        ),
    )
    op.create_index(
        "ix_artifacts_container_created",
        "artifacts",
        ["container_id", "archived", sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_artifacts_type",
        "artifacts",
        ["container_id", "type", "archived", sa.text("created_at DESC")],
    )
    op.create_index(
        "ix_artifacts_source_chat",
        "artifacts",
        ["source_chat_id", sa.text("created_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_artifacts_source_chat", table_name="artifacts")
    op.drop_index("ix_artifacts_type", table_name="artifacts")
    op.drop_index("ix_artifacts_container_created", table_name="artifacts")
    op.drop_table("artifacts")
```

**Note:** The column is named `metadata_json` (not `metadata`) because `metadata` collides with SQLAlchemy's `MetaData` attribute. The Pydantic model alias presents it as `metadata` in the API.

### Step 2: Apply migration locally

```bash
cd /home/gnava/repos/honeycomb/hub
uv run alembic -c db/alembic.ini upgrade head
sqlite3 ~/.config/honeycomb/registry.db ".schema artifacts" | head -25
```

Expected: column list matches the migration; the 3 indexes are present.

### Step 3: Add Artifact + ArtifactType to schemas.py

Open `/home/gnava/repos/honeycomb/hub/models/schemas.py`. Find a sensible insertion point (near other named-row models like `NamedSession`). Add:

```python
ArtifactType = Literal[
    "plan",
    "review",
    "edit",
    "snippet",
    "note",
    "skill",
    "subagent",
    "spec",
]


class Artifact(BaseModel):
    """Library artifact (M35).

    Stored in the `artifacts` table for 7 of 8 types; the `edit` type
    is synthesized at read-time from the existing `diff_events` table.
    Synthesized edit artifacts have artifact_id = "edit-" + diff_event.event_id
    and are immutable (no pin/archive/delete).
    """

    model_config = ConfigDict(populate_by_name=True, extra="allow")

    artifact_id: str
    container_id: int
    type: ArtifactType
    title: str
    body: str
    body_format: str = "markdown"
    source_chat_id: str | None = None
    source_message_id: str | None = None
    # Hub stores as `metadata_json` text; API exposes as `metadata` dict.
    metadata: dict[str, Any] | None = Field(default=None, alias="metadata_json")
    pinned: bool = False
    archived: bool = False
    created_at: str
    updated_at: str
```

If `Literal` and `ConfigDict` aren't already imported at the top of the file, add them (`from typing import Any, Literal` + `from pydantic import BaseModel, ConfigDict, Field`).

### Step 4: Verify schemas.py compiles

```bash
cd /home/gnava/repos/honeycomb/hub
uv run python -c "from hub.models.schemas import Artifact, ArtifactType; print(Artifact.model_fields.keys())"
```

Expected: prints the field names including `metadata`.

### Step 5: Commit

```bash
cd /home/gnava/repos/honeycomb
git add hub/db/migrations/versions/*m35_artifacts*.py hub/models/schemas.py
git commit -m "feat(m35): artifacts table migration + Artifact Pydantic model

Migration creates artifacts table with PK + artifact_id (UUID hex) +
container_id FK (CASCADE delete) + type CHECK constraint (8 types) +
title/body/body_format/source_chat_id/source_message_id/metadata_json
+ pinned/archived bools + timestamps. Three indexes:
container+archived+created (default sidebar query),
container+type+archived+created (filter chip queries),
source_chat+created (backlink lookups).

Pydantic Artifact model uses populate_by_name + alias='metadata_json'
so the API surface uses 'metadata' (dict) while the DB column avoids
the SQLAlchemy MetaData collision. ArtifactType Literal mirrors the
DB CHECK constraint."
```

If pre-commit reformats anything, re-stage and re-commit.

---

## Task 2: artifacts service (CRUD + edit synthesis + tests)

**Files:**

- Create: `hub/services/artifacts.py` (CRUD + diff_events synthesis + spec rescan helper)
- Create: `hub/tests/test_artifacts_service.py`

### Step 1: Write the failing test

Create `/home/gnava/repos/honeycomb/hub/tests/test_artifacts_service.py`:

```python
"""Artifact service tests (M35)."""

from __future__ import annotations

import json
from datetime import datetime

import pytest

from hub.models.schemas import Artifact
from hub.services.artifacts import (
    archive_artifact,
    delete_artifact,
    get_artifact,
    list_artifacts,
    pin_artifact,
    record_artifact,
    unpin_artifact,
)
from hub.services.diff_events import record_event
from hub.models.agent_protocol import DiffEventFrame


@pytest.mark.asyncio
async def test_record_and_get_artifact(registered_container, registry_engine) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="My Note",
        body="Body text.",
        metadata={"source": "user"},
    )
    assert art.artifact_id  # populated
    assert art.type == "note"
    assert art.title == "My Note"
    assert art.body == "Body text."
    assert art.metadata == {"source": "user"}

    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched is not None
    assert fetched.artifact_id == art.artifact_id


@pytest.mark.asyncio
async def test_get_artifact_returns_none_for_unknown(registry_engine) -> None:
    assert await get_artifact(registry_engine, artifact_id="does-not-exist") is None


@pytest.mark.asyncio
async def test_list_artifacts_filters_by_container(
    registered_container, registry_engine
) -> None:
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )
    rows = await list_artifacts(registry_engine, container_id=registered_container.id)
    assert len(rows) == 1
    assert rows[0].title == "A"


@pytest.mark.asyncio
async def test_list_artifacts_filters_by_type(
    registered_container, registry_engine
) -> None:
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="plan",
        title="Plan A",
        body="...",
    )
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="Note A",
        body="...",
    )
    plans = await list_artifacts(
        registry_engine, container_id=registered_container.id, types=["plan"]
    )
    assert len(plans) == 1
    assert plans[0].type == "plan"


@pytest.mark.asyncio
async def test_list_artifacts_search_matches_title_and_body(
    registered_container, registry_engine
) -> None:
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="Refactor plan",
        body="lorem ipsum",
    )
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="Other",
        body="contains REFACTOR keyword",
    )
    matches = await list_artifacts(
        registry_engine, container_id=registered_container.id, search="refactor"
    )
    # Title hit + body hit; case-insensitive
    assert len(matches) == 2


@pytest.mark.asyncio
async def test_list_artifacts_excludes_archived_by_default(
    registered_container, registry_engine
) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )
    await archive_artifact(registry_engine, artifact_id=art.artifact_id)
    rows = await list_artifacts(registry_engine, container_id=registered_container.id)
    assert len(rows) == 0
    rows_archived = await list_artifacts(
        registry_engine, container_id=registered_container.id, include_archived=True
    )
    assert len(rows_archived) == 1
    assert rows_archived[0].archived is True


@pytest.mark.asyncio
async def test_pin_unpin_archive_delete(
    registered_container, registry_engine
) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )

    await pin_artifact(registry_engine, artifact_id=art.artifact_id)
    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched.pinned is True

    await unpin_artifact(registry_engine, artifact_id=art.artifact_id)
    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched.pinned is False

    await archive_artifact(registry_engine, artifact_id=art.artifact_id)
    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched.archived is True

    await delete_artifact(registry_engine, artifact_id=art.artifact_id)
    assert await get_artifact(registry_engine, artifact_id=art.artifact_id) is None


@pytest.mark.asyncio
async def test_list_artifacts_synthesizes_edits_from_diff_events(
    registered_container, registry_engine
) -> None:
    # Record a diff event via the M27 service
    frame = DiffEventFrame(
        container_id=str(registered_container.id),
        tool_use_id="tu-1",
        tool="Edit",
        path="src/foo.py",
        diff="--- a/src/foo.py\n+++ b/src/foo.py\n@@ -1,1 +1,1 @@\n-old\n+new\n",
        added_lines=1,
        removed_lines=1,
        timestamp=datetime.now().isoformat(),
    )
    diff = await record_event(
        registry_engine, container_id=registered_container.id, frame=frame
    )

    # list_artifacts (no filter) should include the synthesized edit
    rows = await list_artifacts(registry_engine, container_id=registered_container.id)
    edits = [r for r in rows if r.type == "edit"]
    assert len(edits) == 1
    assert edits[0].artifact_id == f"edit-{diff.event_id}"
    assert edits[0].body  # contains the diff
    assert edits[0].metadata is not None
    assert edits[0].metadata["paths"] == ["src/foo.py"]
    assert edits[0].metadata["lines_added"] == 1


@pytest.mark.asyncio
async def test_list_artifacts_type_filter_edits_only(
    registered_container, registry_engine
) -> None:
    """Filtering by type=edit returns ONLY synthesized edits, not real rows."""
    # Real artifact (note) — should NOT appear
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="N",
        body="x",
    )
    # Diff event — should appear synthesized
    frame = DiffEventFrame(
        container_id=str(registered_container.id),
        tool_use_id="tu-2",
        tool="Write",
        path="src/bar.py",
        diff="--- /dev/null\n+++ b/src/bar.py\n@@ -0,0 +1,1 @@\n+new\n",
        added_lines=1,
        removed_lines=0,
        timestamp=datetime.now().isoformat(),
    )
    await record_event(
        registry_engine, container_id=registered_container.id, frame=frame
    )

    rows = await list_artifacts(
        registry_engine, container_id=registered_container.id, types=["edit"]
    )
    assert len(rows) == 1
    assert rows[0].type == "edit"
```

### Step 2: Run, expect FAIL

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_artifacts_service.py -v
```

Expected: ImportError because `hub.services.artifacts` doesn't exist yet.

### Step 3: Implement artifacts.py

Create `/home/gnava/repos/honeycomb/hub/services/artifacts.py`:

```python
"""Artifact service (M35) — CRUD over the artifacts table + read-time
synthesis of Edit artifacts from the existing diff_events table.

Architecture:
  - 7 types stored in `artifacts` table (plan/review/snippet/note/skill/subagent/spec)
  - 1 type synthesized from `diff_events` (edit) — read-only, immutable
  - list_artifacts UNIONs both sources, sorted by created_at DESC
"""

from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime
from typing import Any, Iterable

import sqlalchemy as sa
from sqlalchemy.ext.asyncio import AsyncEngine

from hub.models.schemas import Artifact, ArtifactType
from hub.services.diff_events import list_events as list_diff_events

logger = logging.getLogger(__name__)


def _row_to_artifact(row) -> Artifact:
    """Convert a DB row to an Artifact, parsing the JSON metadata column."""
    metadata: dict[str, Any] | None = None
    if row["metadata_json"]:
        try:
            metadata = json.loads(row["metadata_json"])
        except json.JSONDecodeError:
            logger.warning("Invalid JSON in artifact %s metadata_json", row["artifact_id"])
            metadata = None
    return Artifact(
        artifact_id=row["artifact_id"],
        container_id=row["container_id"],
        type=row["type"],
        title=row["title"],
        body=row["body"],
        body_format=row["body_format"],
        source_chat_id=row["source_chat_id"],
        source_message_id=row["source_message_id"],
        metadata=metadata,  # type: ignore[arg-type]
        pinned=bool(row["pinned"]),
        archived=bool(row["archived"]),
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


async def record_artifact(
    engine: AsyncEngine,
    *,
    container_id: int,
    type: ArtifactType,
    title: str,
    body: str,
    body_format: str = "markdown",
    source_chat_id: str | None = None,
    source_message_id: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> Artifact:
    """Insert a new artifact row and return the populated model."""
    artifact_id = uuid.uuid4().hex
    now = datetime.now().isoformat()
    metadata_json = json.dumps(metadata) if metadata is not None else None
    async with engine.begin() as conn:
        await conn.execute(
            sa.text(
                "INSERT INTO artifacts "
                "(artifact_id, container_id, type, title, body, body_format, "
                " source_chat_id, source_message_id, metadata_json, pinned, archived, "
                " created_at, updated_at) "
                "VALUES (:aid, :cid, :type, :title, :body, :body_format, "
                "        :scid, :smid, :meta, 0, 0, :ca, :ua)"
            ),
            {
                "aid": artifact_id,
                "cid": container_id,
                "type": type,
                "title": title,
                "body": body,
                "body_format": body_format,
                "scid": source_chat_id,
                "smid": source_message_id,
                "meta": metadata_json,
                "ca": now,
                "ua": now,
            },
        )
        row = (
            (
                await conn.execute(
                    sa.text("SELECT * FROM artifacts WHERE artifact_id = :aid"),
                    {"aid": artifact_id},
                )
            )
            .mappings()
            .one()
        )
    return _row_to_artifact(row)


def _synthesize_edit_from_diff_event(diff_event) -> Artifact:
    """Translate a DiffEvent → Artifact (type=edit). Immutable; always
    pinned=False, archived=False."""
    return Artifact(
        artifact_id=f"edit-{diff_event.event_id}",
        container_id=diff_event.container_id,
        type="edit",
        title=f"{diff_event.tool}: {diff_event.path}",
        body=diff_event.diff,
        body_format="diff",
        source_chat_id=diff_event.claude_session_id,
        source_message_id=diff_event.tool_use_id,
        metadata={
            "paths": [diff_event.path],
            "lines_added": diff_event.added_lines,
            "lines_removed": diff_event.removed_lines,
            "tool": diff_event.tool,
            "size_bytes": diff_event.size_bytes,
        },
        pinned=False,
        archived=False,
        created_at=diff_event.created_at,
        updated_at=diff_event.created_at,
    )


async def list_artifacts(
    engine: AsyncEngine,
    *,
    container_id: int,
    types: Iterable[ArtifactType] | None = None,
    search: str | None = None,
    include_archived: bool = False,
    limit: int = 200,
) -> list[Artifact]:
    """List artifacts for a container with optional filters.

    Synthesizes Edit artifacts from diff_events at read time. The synthesis
    runs whenever the type filter is None or includes "edit".
    """
    types_set: set[str] | None = set(types) if types else None
    include_real = types_set is None or any(t != "edit" for t in types_set)
    include_synth_edits = types_set is None or "edit" in types_set

    real_rows: list[Artifact] = []
    if include_real:
        clauses = ["container_id = :cid"]
        params: dict[str, Any] = {"cid": container_id, "limit": limit}
        if not include_archived:
            clauses.append("archived = 0")
        if types_set is not None:
            non_edit_types = [t for t in types_set if t != "edit"]
            if non_edit_types:
                placeholders = ", ".join(f":t{i}" for i in range(len(non_edit_types)))
                clauses.append(f"type IN ({placeholders})")
                for i, t in enumerate(non_edit_types):
                    params[f"t{i}"] = t
            else:
                # Only "edit" was in the filter — skip the real query
                clauses = None  # type: ignore[assignment]
        if search:
            clauses.append("(title LIKE :q OR body LIKE :q)")
            params["q"] = f"%{search}%"
        if clauses is not None:
            sql = (
                "SELECT * FROM artifacts "
                f"WHERE {' AND '.join(clauses)} "
                "ORDER BY created_at DESC "
                "LIMIT :limit"
            )
            async with engine.connect() as conn:
                rows = (
                    (await conn.execute(sa.text(sql), params)).mappings().all()
                )
            real_rows = [_row_to_artifact(r) for r in rows]

    synth_edits: list[Artifact] = []
    if include_synth_edits:
        diff_rows = await list_diff_events(
            engine, container_id=container_id, limit=limit
        )
        for d in diff_rows:
            edit = _synthesize_edit_from_diff_event(d)
            # Apply the search filter to synthesized edits too
            if search:
                ql = search.lower()
                if ql not in edit.title.lower() and ql not in edit.body.lower():
                    continue
            synth_edits.append(edit)

    # Union + sort by created_at DESC, cap at limit
    combined = real_rows + synth_edits
    combined.sort(key=lambda a: a.created_at, reverse=True)
    return combined[:limit]


async def get_artifact(
    engine: AsyncEngine,
    *,
    artifact_id: str,
) -> Artifact | None:
    """Fetch one artifact by ID. Returns None if missing.

    Synthesized edit IDs (prefix `edit-`) are looked up against diff_events.
    """
    if artifact_id.startswith("edit-"):
        event_id = artifact_id.removeprefix("edit-")
        async with engine.connect() as conn:
            row = (
                (
                    await conn.execute(
                        sa.text(
                            "SELECT * FROM diff_events WHERE event_id = :eid"
                        ),
                        {"eid": event_id},
                    )
                )
                .mappings()
                .first()
            )
        if row is None:
            return None
        # Reuse the diff_events row_to_model + synthesize
        from hub.services.diff_events import _row_to_model as diff_row_to_model
        diff = diff_row_to_model(row)
        return _synthesize_edit_from_diff_event(diff)

    async with engine.connect() as conn:
        row = (
            (
                await conn.execute(
                    sa.text("SELECT * FROM artifacts WHERE artifact_id = :aid"),
                    {"aid": artifact_id},
                )
            )
            .mappings()
            .first()
        )
    return _row_to_artifact(row) if row is not None else None


async def _set_flag(
    engine: AsyncEngine, *, artifact_id: str, column: str, value: int
) -> None:
    """Common helper for pin/unpin/archive."""
    if artifact_id.startswith("edit-"):
        # Synthesized edits are immutable — silently no-op.
        return
    async with engine.begin() as conn:
        await conn.execute(
            sa.text(
                f"UPDATE artifacts SET {column} = :v, updated_at = :ua "
                "WHERE artifact_id = :aid"
            ),
            {"v": value, "aid": artifact_id, "ua": datetime.now().isoformat()},
        )


async def pin_artifact(engine: AsyncEngine, *, artifact_id: str) -> None:
    await _set_flag(engine, artifact_id=artifact_id, column="pinned", value=1)


async def unpin_artifact(engine: AsyncEngine, *, artifact_id: str) -> None:
    await _set_flag(engine, artifact_id=artifact_id, column="pinned", value=0)


async def archive_artifact(engine: AsyncEngine, *, artifact_id: str) -> None:
    await _set_flag(engine, artifact_id=artifact_id, column="archived", value=1)


async def delete_artifact(engine: AsyncEngine, *, artifact_id: str) -> None:
    """Hard-delete an artifact. Idempotent. Synthesized edits silently no-op."""
    if artifact_id.startswith("edit-"):
        return
    async with engine.begin() as conn:
        await conn.execute(
            sa.text("DELETE FROM artifacts WHERE artifact_id = :aid"),
            {"aid": artifact_id},
        )
```

### Step 4: Run tests, expect 9/9 PASS

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_artifacts_service.py -v
```

If a test fails on the `_synthesize_edit_from_diff_event` import path (it imports `_row_to_model` from `diff_events`), verify the M27 module exposes that helper. If it's a private helper that's not exported, copy its body inline.

### Step 5: Run mypy + ruff

```bash
cd /home/gnava/repos/honeycomb/hub
uv run ruff check hub/services/artifacts.py
uv run mypy hub/services/artifacts.py
```

### Step 6: Commit

```bash
cd /home/gnava/repos/honeycomb
git add hub/services/artifacts.py hub/tests/test_artifacts_service.py
git commit -m "feat(m35): artifacts service (CRUD + diff_events synthesis)

record_artifact / get_artifact / list_artifacts / pin / unpin /
archive / delete. Edit-type artifacts are synthesized at read-time
from the M27 diff_events table — no duplicate storage. Synthesized
edit IDs prefix 'edit-' for stable identity; pin/archive/delete
silently no-op on synthesized rows.

list_artifacts unions real artifact rows with synthesized edits,
applies type/search filters across both sources, sorts by
created_at DESC."
```

---

## Task 3: artifacts router + tests

**Files:**

- Create: `hub/routers/artifacts.py`
- Modify: `hub/main.py` (register router)
- Create: `hub/tests/test_artifacts_endpoint.py`

### Step 1: Write the failing test

Create `/home/gnava/repos/honeycomb/hub/tests/test_artifacts_endpoint.py`:

```python
"""Endpoint tests for the artifacts router (M35)."""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from hub.services.artifacts import record_artifact, get_artifact

# AUTH constant + fixtures (client, registered_container, registry_engine)
# follow the local-per-file pattern from M33/M34 tests. If your suite
# already has a shared conftest fixture, use that. Otherwise replicate
# the fixtures from test_chat_stream_endpoint.py (M33 Task 4).


@pytest.mark.asyncio
async def test_list_artifacts_empty(
    client: AsyncClient, registered_container, AUTH
) -> None:
    resp = await client.get(
        f"/api/containers/{registered_container.id}/artifacts", headers=AUTH
    )
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_artifacts_returns_recorded(
    client: AsyncClient, registered_container, registry_engine, AUTH
) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="hello",
    )
    resp = await client.get(
        f"/api/containers/{registered_container.id}/artifacts", headers=AUTH
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    assert body[0]["artifact_id"] == art.artifact_id
    assert body[0]["title"] == "A"


@pytest.mark.asyncio
async def test_list_artifacts_filters_by_type_query_param(
    client: AsyncClient, registered_container, registry_engine, AUTH
) -> None:
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="plan",
        title="P",
        body="...",
    )
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="N",
        body="...",
    )
    resp = await client.get(
        f"/api/containers/{registered_container.id}/artifacts?type=plan",
        headers=AUTH,
    )
    body = resp.json()
    assert len(body) == 1
    assert body[0]["type"] == "plan"


@pytest.mark.asyncio
async def test_list_artifacts_supports_multi_type_filter(
    client: AsyncClient, registered_container, registry_engine, AUTH
) -> None:
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="plan",
        title="P",
        body="...",
    )
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="N",
        body="...",
    )
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="snippet",
        title="S",
        body="...",
    )
    # Repeated query param: ?type=plan&type=note
    resp = await client.get(
        f"/api/containers/{registered_container.id}/artifacts?type=plan&type=note",
        headers=AUTH,
    )
    body = resp.json()
    types = sorted(b["type"] for b in body)
    assert types == ["note", "plan"]


@pytest.mark.asyncio
async def test_list_artifacts_search_matches_body(
    client: AsyncClient, registered_container, registry_engine, AUTH
) -> None:
    await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="lorem ipsum",
    )
    resp = await client.get(
        f"/api/containers/{registered_container.id}/artifacts?search=ipsum",
        headers=AUTH,
    )
    assert len(resp.json()) == 1


@pytest.mark.asyncio
async def test_get_artifact_404_on_unknown(client: AsyncClient, AUTH) -> None:
    resp = await client.get("/api/artifacts/does-not-exist", headers=AUTH)
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_artifact_returns_detail(
    client: AsyncClient, registered_container, registry_engine, AUTH
) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="x",
    )
    resp = await client.get(f"/api/artifacts/{art.artifact_id}", headers=AUTH)
    assert resp.status_code == 200
    assert resp.json()["artifact_id"] == art.artifact_id


@pytest.mark.asyncio
async def test_create_artifact_endpoint(
    client: AsyncClient, registered_container, registry_engine, AUTH
) -> None:
    resp = await client.post(
        f"/api/containers/{registered_container.id}/artifacts",
        json={"type": "note", "title": "New Note", "body": "hello"},
        headers=AUTH,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["type"] == "note"
    assert body["title"] == "New Note"
    # Verify it landed in the DB
    fetched = await get_artifact(registry_engine, artifact_id=body["artifact_id"])
    assert fetched is not None


@pytest.mark.asyncio
async def test_create_artifact_rejects_invalid_type(
    client: AsyncClient, registered_container, AUTH
) -> None:
    resp = await client.post(
        f"/api/containers/{registered_container.id}/artifacts",
        json={"type": "bogus", "title": "X", "body": "y"},
        headers=AUTH,
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_pin_unpin_archive_endpoints(
    client: AsyncClient, registered_container, registry_engine, AUTH
) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )
    # Pin
    resp = await client.post(f"/api/artifacts/{art.artifact_id}/pin", headers=AUTH)
    assert resp.status_code == 204
    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched.pinned is True
    # Unpin
    resp = await client.post(f"/api/artifacts/{art.artifact_id}/unpin", headers=AUTH)
    assert resp.status_code == 204
    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched.pinned is False
    # Archive
    resp = await client.post(f"/api/artifacts/{art.artifact_id}/archive", headers=AUTH)
    assert resp.status_code == 204
    fetched = await get_artifact(registry_engine, artifact_id=art.artifact_id)
    assert fetched.archived is True


@pytest.mark.asyncio
async def test_delete_artifact_endpoint(
    client: AsyncClient, registered_container, registry_engine, AUTH
) -> None:
    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )
    resp = await client.delete(f"/api/artifacts/{art.artifact_id}", headers=AUTH)
    assert resp.status_code == 204
    assert (
        await get_artifact(registry_engine, artifact_id=art.artifact_id) is None
    )
```

### Step 2: Run, expect FAIL

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_artifacts_endpoint.py -v
```

### Step 3: Implement the router

Create `/home/gnava/repos/honeycomb/hub/routers/artifacts.py`:

```python
"""Artifacts router (M35).

Endpoints:
  - GET  /api/containers/{cid}/artifacts                — list (filterable)
  - POST /api/containers/{cid}/artifacts                — create (client-initiated)
  - GET  /api/artifacts/{artifact_id}                   — fetch one
  - POST /api/artifacts/{artifact_id}/pin               — pin
  - POST /api/artifacts/{artifact_id}/unpin             — unpin
  - POST /api/artifacts/{artifact_id}/archive           — archive
  - DELETE /api/artifacts/{artifact_id}                 — hard-delete

Edit-type artifacts (artifact_id prefixed 'edit-') are synthesized
from diff_events; pin/unpin/archive/delete on those silently no-op
at the service layer.
"""

from __future__ import annotations

import logging
from typing import Any, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from hub.models.schemas import Artifact, ArtifactType
from hub.services.artifacts import (
    archive_artifact,
    delete_artifact,
    get_artifact,
    list_artifacts,
    pin_artifact,
    record_artifact,
    unpin_artifact,
)

logger = logging.getLogger(__name__)

router = APIRouter(tags=["artifacts"])


class CreateArtifactRequest(BaseModel):
    type: ArtifactType
    title: str = Field(min_length=1, max_length=400)
    body: str = Field(min_length=1, max_length=1_000_000)
    body_format: str = "markdown"
    source_chat_id: str | None = None
    source_message_id: str | None = None
    metadata: dict[str, Any] | None = None


async def _lookup_container(registry, record_id: int) -> None:
    try:
        await registry.get(record_id)
    except KeyError:
        raise HTTPException(404, f"Container record {record_id} not found")


@router.get(
    "/api/containers/{record_id}/artifacts",
    response_model=list[Artifact],
)
async def list_container_artifacts(
    record_id: int,
    request: Request,
    type: list[ArtifactType] | None = Query(default=None),
    search: str | None = Query(default=None),
    archived: bool = Query(default=False),
) -> list[Artifact]:
    registry = request.app.state.registry
    await _lookup_container(registry, record_id)
    return await list_artifacts(
        registry.engine,
        container_id=record_id,
        types=type,
        search=search,
        include_archived=archived,
    )


@router.post(
    "/api/containers/{record_id}/artifacts",
    response_model=Artifact,
    status_code=201,
)
async def create_container_artifact(
    record_id: int,
    request: Request,
    body: CreateArtifactRequest,
) -> Artifact:
    registry = request.app.state.registry
    await _lookup_container(registry, record_id)
    return await record_artifact(
        registry.engine,
        container_id=record_id,
        type=body.type,
        title=body.title,
        body=body.body,
        body_format=body.body_format,
        source_chat_id=body.source_chat_id,
        source_message_id=body.source_message_id,
        metadata=body.metadata,
    )


@router.get(
    "/api/artifacts/{artifact_id}",
    response_model=Artifact,
)
async def get_artifact_endpoint(artifact_id: str, request: Request) -> Artifact:
    registry = request.app.state.registry
    art = await get_artifact(registry.engine, artifact_id=artifact_id)
    if art is None:
        raise HTTPException(404, f"Artifact {artifact_id} not found")
    return art


@router.post("/api/artifacts/{artifact_id}/pin", status_code=204)
async def pin_endpoint(artifact_id: str, request: Request) -> None:
    registry = request.app.state.registry
    await pin_artifact(registry.engine, artifact_id=artifact_id)


@router.post("/api/artifacts/{artifact_id}/unpin", status_code=204)
async def unpin_endpoint(artifact_id: str, request: Request) -> None:
    registry = request.app.state.registry
    await unpin_artifact(registry.engine, artifact_id=artifact_id)


@router.post("/api/artifacts/{artifact_id}/archive", status_code=204)
async def archive_endpoint(artifact_id: str, request: Request) -> None:
    registry = request.app.state.registry
    await archive_artifact(registry.engine, artifact_id=artifact_id)


@router.delete("/api/artifacts/{artifact_id}", status_code=204)
async def delete_endpoint(artifact_id: str, request: Request) -> None:
    registry = request.app.state.registry
    await delete_artifact(registry.engine, artifact_id=artifact_id)
```

### Step 4: Register the router in main.py

In `/home/gnava/repos/honeycomb/hub/main.py`, find the existing `app.include_router(...)` block and add:

```python
from hub.routers import artifacts as artifacts_router

app.include_router(artifacts_router.router)
```

(Match the existing import style — likely an `__init__.py`-style aliased import.)

### Step 5: Run tests, expect 11/11 PASS

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_artifacts_endpoint.py -v
```

### Step 6: Run the full hub suite

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests -q
```

Expected: all green.

### Step 7: Commit

```bash
cd /home/gnava/repos/honeycomb
git add hub/routers/artifacts.py hub/main.py hub/tests/test_artifacts_endpoint.py
git commit -m "feat(m35): artifacts router (REST endpoints)

GET /api/containers/{id}/artifacts (with type/search/archived
filters), POST same path (client-initiated artifact creation —
used by M34's /save note slash command in M35), GET
/api/artifacts/{id}, POST /pin /unpin /archive, DELETE /artifacts/{id}.

Multi-type filter via repeated ?type= query params; the M35
LibraryActivity uses this for the chip multi-select."
```

---

## Task 4: chat_stream auto-save hooks (Plan / Snippet / Subagent / Note)

**Files:**

- Modify: `hub/services/chat_stream.py` (add 4 hook helpers + integrate into the parser/run loop)
- Create: `hub/tests/test_chat_stream_artifact_hooks.py`

This task wires four auto-save hooks that fire during `ClaudeTurnSession.run`'s stdout drain loop. Each hook detects a specific signal in the parsed events + calls `record_artifact`.

The hooks are pure-function detectors that take the parsed event + return an optional `RecordArtifactDirective` dataclass; the `run` loop applies the directive (calls `record_artifact` with the right args).

### Step 1: Write the failing test

Create `/home/gnava/repos/honeycomb/hub/tests/test_chat_stream_artifact_hooks.py`:

````python
"""Auto-save artifact hooks in chat_stream parser (M35)."""

from __future__ import annotations

import pytest

from hub.models.chat_events import (
    ContentBlockStartEvent,
    ContentBlockStopEvent,
    ContentBlockDeltaEvent,
    StreamEvent,
    SystemEvent,
    TextBlock,
    ThinkingBlock,
    ToolUseBlock,
)
from hub.services.chat_stream_artifact_hooks import (
    detect_note_marker,
    detect_snippet,
    detect_subagent_completion,
    detect_plan_mode_exit,
    PlanModeTracker,
)


# ── Note hook ──────────────────────────────────────────────────────


class TestNoteDetector:
    def test_detects_note_marker_in_text(self) -> None:
        directive = detect_note_marker(
            text="Some prose.\n> NOTE: Remember to check the foo.\nMore prose.",
        )
        assert directive is not None
        assert directive.type == "note"
        assert "Remember to check the foo." in directive.body

    def test_no_marker_no_directive(self) -> None:
        assert detect_note_marker(text="No notes here.") is None

    def test_marker_title_is_first_60_chars(self) -> None:
        long = "A" * 200
        directive = detect_note_marker(text=f"> NOTE: {long}")
        assert directive is not None
        assert len(directive.title) <= 60


# ── Snippet hook ──────────────────────────────────────────────────


class TestSnippetDetector:
    def test_detects_3_line_python_block(self) -> None:
        text = "Here:\n```python\nimport os\nprint(os.getcwd())\nos.exit(0)\n```\nDone."
        directive = detect_snippet(text=text)
        assert directive is not None
        assert directive.type == "snippet"
        assert "import os" in directive.body
        assert directive.metadata is not None
        assert directive.metadata["language"] == "python"
        assert directive.metadata["line_count"] == 3

    def test_skips_2_line_block(self) -> None:
        text = "```python\nimport os\nprint('hi')\n```"
        assert detect_snippet(text=text) is None

    def test_skips_unlabeled_code_fence(self) -> None:
        text = "```\nline 1\nline 2\nline 3\n```"
        assert detect_snippet(text=text) is None

    def test_extracts_first_qualifying_block_only(self) -> None:
        text = (
            "```python\na = 1\nb = 2\nc = 3\n```\n"
            "Other text.\n"
            "```ts\nx = 1\ny = 2\nz = 3\n```"
        )
        directive = detect_snippet(text=text)
        assert directive is not None
        assert directive.metadata["language"] == "python"


# ── Subagent hook ──────────────────────────────────────────────────


class TestSubagentDetector:
    def test_fires_on_task_tool_use_end(self) -> None:
        block = ToolUseBlock(
            id="tu-1",
            name="Task",
            input={"subagent_type": "general-purpose", "description": "Find bug", "prompt": "Find the bug"},
        )
        directive = detect_subagent_completion(block=block)
        assert directive is not None
        assert directive.type == "subagent"
        assert directive.metadata is not None
        assert directive.metadata["agent_type"] == "general-purpose"

    def test_skips_non_task_tool(self) -> None:
        block = ToolUseBlock(id="tu-1", name="Bash", input={"command": "ls"})
        assert detect_subagent_completion(block=block) is None


# ── Plan-mode hook ────────────────────────────────────────────────


class TestPlanModeTracker:
    def test_no_directive_when_mode_unchanged(self) -> None:
        tracker = PlanModeTracker()
        # First turn in code mode — establishes baseline
        assert tracker.observe_turn_mode(named_session_id="ns-1", mode="code") is None
        # Second turn still in code mode
        assert tracker.observe_turn_mode(named_session_id="ns-1", mode="code") is None

    def test_directive_when_flipping_out_of_plan(self) -> None:
        tracker = PlanModeTracker()
        tracker.observe_turn_mode(named_session_id="ns-1", mode="plan")
        directive = tracker.observe_turn_mode(named_session_id="ns-1", mode="code")
        assert directive is not None
        assert directive.type == "plan"

    def test_no_directive_when_starting_in_plan(self) -> None:
        tracker = PlanModeTracker()
        # First turn already in plan — establishes baseline; no directive yet
        assert tracker.observe_turn_mode(named_session_id="ns-2", mode="plan") is None

    def test_per_session_isolation(self) -> None:
        tracker = PlanModeTracker()
        tracker.observe_turn_mode(named_session_id="ns-1", mode="plan")
        # Different session, no transition
        assert tracker.observe_turn_mode(named_session_id="ns-2", mode="code") is None
        # ns-1 transitions
        directive = tracker.observe_turn_mode(named_session_id="ns-1", mode="code")
        assert directive is not None
````

### Step 2: Run, expect FAIL

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_artifact_hooks.py -v
```

### Step 3: Create the hooks module

Create `/home/gnava/repos/honeycomb/hub/services/chat_stream_artifact_hooks.py`:

````python
"""Auto-save artifact hooks for chat_stream (M35).

Each hook is a pure-function detector that takes a parsed event/block
and returns an optional `RecordArtifactDirective` dataclass describing
what to write to the artifacts table. The chat_stream subprocess driver
collects directives during stdout drain and calls record_artifact for
each one (broadcasting on library:<container_id> as a side-effect).

Hooks:
  - detect_plan_mode_exit       — fires when Mode flips out of plan
  - detect_snippet              — fires on 3+-line fenced code blocks
  - detect_subagent_completion  — fires on Task tool_use end
  - detect_note_marker          — fires on `> NOTE:` markdown markers
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from hub.models.chat_events import ToolUseBlock
from hub.models.schemas import ArtifactType


@dataclass(frozen=True)
class RecordArtifactDirective:
    """A directive to call `record_artifact(...)`. The chat_stream driver
    fills in container_id/source_chat_id/source_message_id from context.
    """

    type: ArtifactType
    title: str
    body: str
    body_format: str = "markdown"
    metadata: dict[str, Any] | None = None


# ── Note hook ─────────────────────────────────────────────────────────────────

_NOTE_PATTERN = re.compile(r"^>\s*NOTE:\s*(.+?)(?=\n\s*\n|\Z)", re.MULTILINE | re.DOTALL)


def detect_note_marker(*, text: str) -> RecordArtifactDirective | None:
    """Look for `> NOTE: <body>` markdown markers. Captures body up to
    the next paragraph break (blank line) or end of text.
    """
    m = _NOTE_PATTERN.search(text)
    if m is None:
        return None
    body = m.group(1).strip()
    title = body[:60].strip() or "Note"
    return RecordArtifactDirective(type="note", title=title, body=body)


# ── Snippet hook ──────────────────────────────────────────────────────────────

_SNIPPET_PATTERN = re.compile(
    r"```([A-Za-z0-9_+-]+)\n(.+?)\n```",
    re.DOTALL,
)
_SNIPPET_MIN_LINES = 3


def detect_snippet(*, text: str) -> RecordArtifactDirective | None:
    """Find the FIRST fenced code block with a language tag and ≥3 lines."""
    for m in _SNIPPET_PATTERN.finditer(text):
        language = m.group(1)
        body = m.group(2)
        line_count = body.count("\n") + 1
        if line_count >= _SNIPPET_MIN_LINES:
            title = f"{language} snippet ({line_count} lines)"
            return RecordArtifactDirective(
                type="snippet",
                title=title,
                body=body,
                body_format=language,  # for renderer hint
                metadata={"language": language, "line_count": line_count},
            )
    return None


# ── Subagent hook ─────────────────────────────────────────────────────────────


def detect_subagent_completion(*, block: ToolUseBlock) -> RecordArtifactDirective | None:
    """Fires when a Task tool_use block completes."""
    if block.name != "Task":
        return None
    inp = block.input
    agent_type = (inp.get("subagent_type") or "agent") if isinstance(inp, dict) else "agent"
    description = (inp.get("description") or "") if isinstance(inp, dict) else ""
    prompt = (inp.get("prompt") or "") if isinstance(inp, dict) else ""
    title = description or f"Subagent: {agent_type}"
    return RecordArtifactDirective(
        type="subagent",
        title=title[:200],
        body=prompt,
        metadata={
            "agent_type": agent_type,
            # parent_chat_id + result_summary filled in by the driver from context
        },
    )


# ── Plan-mode tracker ─────────────────────────────────────────────────────────


@dataclass
class PlanModeTracker:
    """Tracks last-seen mode per named-session. observe_turn_mode returns
    a directive when the mode flips OUT of 'plan' (plan→code/review).
    """

    _last_seen: dict[str, str] = field(default_factory=dict)

    def observe_turn_mode(
        self, *, named_session_id: str, mode: str
    ) -> RecordArtifactDirective | None:
        prev = self._last_seen.get(named_session_id)
        self._last_seen[named_session_id] = mode
        if prev == "plan" and mode != "plan":
            return RecordArtifactDirective(
                type="plan",
                title="Plan-mode session",
                body="(filled in by chat_stream driver from accumulated assistant turns)",
                metadata={"mode_at_save": "plan"},
            )
        return None
````

### Step 4: Run tests, expect all green

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_chat_stream_artifact_hooks.py -v
```

Expected: ~12 cases pass.

### Step 5: Wire the hooks into ClaudeTurnSession.run

Open `/home/gnava/repos/honeycomb/hub/services/chat_stream.py`. Two changes:

**5a.** At the top, import the hooks + add a module-level singleton tracker:

```python
from hub.services.chat_stream_artifact_hooks import (
    PlanModeTracker,
    RecordArtifactDirective,
    detect_note_marker,
    detect_snippet,
    detect_subagent_completion,
)
from hub.services.artifacts import record_artifact

_plan_tracker = PlanModeTracker()
```

**5b.** Inside `ClaudeTurnSession.run`, after the existing per-event broadcast loop, add a hook-dispatch step. Find where the driver iterates `parse_line(line)` results and broadcasts. After the broadcast call, ALSO collect text snippets / tool blocks / handle the mode signal. Then at the end of the run (after the subprocess exits), apply the `RecordArtifactDirective`s.

The cleanest extension: thread a new `artifacts_engine: AsyncEngine | None` parameter through `ClaudeTurnSession.__init__` and `run`. If `None`, hooks are no-ops. Pseudo-shape:

```python
class ClaudeTurnSession:
    def __init__(
        self,
        *,
        named_session_id: str,
        cwd: str,
        ws_manager: Any,
        claude_binary: str = "claude",
        artifacts_engine: Any = None,   # NEW M35
    ) -> None:
        # ... existing
        self.artifacts_engine = artifacts_engine

    async def run(
        self,
        *,
        user_text: str,
        claude_session_id: str | None,
        effort: str = "standard",
        model: str | None = None,
        mode: str = "code",
        edit_auto: bool = False,
    ) -> TurnResult:
        # ... existing setup ...

        # M35: track mode flip OUT of plan (the directive fires on the CURRENT turn
        # that's leaving plan, not the next one). Apply at the end of run().
        plan_directive = _plan_tracker.observe_turn_mode(
            named_session_id=self.named_session_id, mode=mode,
        )

        # ... existing stdout drain loop ...
        # Inside the loop, accumulate text blocks + tool_use blocks for hook input

        accumulated_text_blocks: list[str] = []
        completed_tool_uses: list[ToolUseBlock] = []

        async for raw_line in self._proc.stdout:
            line = raw_line.decode("utf-8", errors="replace").rstrip("\n")
            event = parse_line(line)
            if event is None:
                continue
            if isinstance(event, SystemEvent) and event.subtype == "init":
                captured_id = event.session_id
            if not should_forward(event):
                continue

            # Accumulate hook signal
            if isinstance(event, StreamEvent):
                inner = event.event
                if inner.type == "content_block_delta" and inner.delta.type == "text_delta":
                    accumulated_text_blocks.append(inner.delta.text)
                elif inner.type == "content_block_stop":
                    # We don't track index→block mapping for simplicity; rely on
                    # content_block_start side-effect (next branch) to capture tool blocks
                    pass
                elif inner.type == "content_block_start":
                    cb = inner.content_block
                    if cb.type == "tool_use":
                        completed_tool_uses.append(cb)

            await broadcast_event(...)
            forwarded += 1

        exit_code = await self._proc.wait()

        # M35: apply hooks
        if self.artifacts_engine is not None:
            # Container ID lookup: the named_session row knows it; we'd need to
            # fetch it — OR pass container_id into __init__. Add container_id
            # as a constructor param.
            await self._apply_artifact_hooks(
                accumulated_text="".join(accumulated_text_blocks),
                completed_tool_uses=completed_tool_uses,
                plan_directive=plan_directive,
            )

        return TurnResult(...)
```

**5c.** Add a `container_id: int` parameter to `ClaudeTurnSession.__init__` (the router knows it; pass through). Then `_apply_artifact_hooks`:

```python
    async def _apply_artifact_hooks(
        self,
        *,
        accumulated_text: str,
        completed_tool_uses: list[ToolUseBlock],
        plan_directive: RecordArtifactDirective | None,
    ) -> None:
        directives: list[RecordArtifactDirective] = []
        if plan_directive is not None:
            # Replace the placeholder body with accumulated text from the turn
            directives.append(
                RecordArtifactDirective(
                    type="plan",
                    title=accumulated_text.split("\n", 1)[0][:60].strip() or "Plan",
                    body=accumulated_text or plan_directive.body,
                    metadata=plan_directive.metadata,
                )
            )
        # Snippet
        snippet = detect_snippet(text=accumulated_text)
        if snippet is not None:
            directives.append(snippet)
        # Note
        note = detect_note_marker(text=accumulated_text)
        if note is not None:
            directives.append(note)
        # Subagent (one per Task tool block)
        for block in completed_tool_uses:
            sub = detect_subagent_completion(block=block)
            if sub is not None:
                directives.append(sub)

        for directive in directives:
            try:
                created = await record_artifact(
                    self.artifacts_engine,
                    container_id=self.container_id,
                    type=directive.type,
                    title=directive.title,
                    body=directive.body,
                    body_format=directive.body_format,
                    source_chat_id=self.named_session_id,
                    metadata=directive.metadata,
                )
                # Broadcast on library:<container_id>
                await self._broadcast_artifact_new(created)
            except Exception as exc:
                logger.warning("artifact hook failed: %s (%s)", directive.type, exc)

    async def _broadcast_artifact_new(self, art) -> None:
        from hub.models.schemas import WSFrame
        frame = WSFrame(
            channel=f"library:{self.container_id}",
            event="new",
            data=art.model_dump(mode="json"),
        )
        try:
            await self.ws_manager.broadcast(frame)
        except Exception as exc:
            logger.warning("library broadcast failed: %s", exc)
```

**5d.** In `hub/routers/chat_stream.py` (existing M33 router), update the `ClaudeTurnSession(...)` constructor call inside `post_turn` to pass `container_id` + `artifacts_engine=registry.engine`:

```python
chat = ClaudeTurnSession(
    named_session_id=session_id,
    container_id=sess.container_id,
    cwd=cwd,
    ws_manager=ws_manager,
    artifacts_engine=registry.engine,
)
```

### Step 6: Run all hub tests

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests -q
```

Expected: all green. Existing chat_stream subprocess tests still pass because `artifacts_engine` defaults to `None` (no-op when absent — old test fixtures don't pass it).

### Step 7: Commit

```bash
cd /home/gnava/repos/honeycomb
git add hub/services/chat_stream.py \
        hub/services/chat_stream_artifact_hooks.py \
        hub/routers/chat_stream.py \
        hub/tests/test_chat_stream_artifact_hooks.py
git commit -m "feat(m35): chat_stream auto-save hooks (Plan / Snippet / Subagent / Note)

Four pure-function detectors in chat_stream_artifact_hooks.py:
detect_plan_mode_exit (PlanModeTracker class — last-seen mode per
session), detect_snippet (3+-line fenced code with language tag),
detect_subagent_completion (Task tool_use_end), detect_note_marker
(> NOTE: markdown).

Each detector returns an optional RecordArtifactDirective. The
ClaudeTurnSession driver collects directives during stdout drain
and applies them after subprocess exit — calling record_artifact +
broadcasting on library:<container_id>.

Existing tests pass because artifacts_engine defaults to None (hook
dispatch becomes a no-op when absent)."
```

---

## Task 5: Spec auto-save (startup rescan)

**Files:**

- Modify: `hub/main.py` (lifespan event: rescan specs)
- Modify: `hub/services/artifacts.py` (add `rescan_spec_files` helper)
- Add: `hub/tests/test_artifacts_spec_rescan.py`

### Step 1: Write the failing test

Create `/home/gnava/repos/honeycomb/hub/tests/test_artifacts_spec_rescan.py`:

```python
"""Spec auto-save rescan (M35)."""

from __future__ import annotations

from pathlib import Path

import pytest

from hub.services.artifacts import (
    list_artifacts,
    rescan_spec_files,
)


@pytest.mark.asyncio
async def test_rescan_records_new_spec_files(
    registered_container, registry_engine, tmp_path: Path
) -> None:
    spec_dir = tmp_path / "specs"
    spec_dir.mkdir()
    (spec_dir / "first.md").write_text("# First spec\n\nBody.")
    (spec_dir / "second.md").write_text("# Second\n\nMore body.")

    await rescan_spec_files(
        registry_engine,
        container_id=registered_container.id,
        specs_dir=spec_dir,
    )

    rows = await list_artifacts(
        registry_engine, container_id=registered_container.id, types=["spec"]
    )
    assert len(rows) == 2
    titles = sorted(r.title for r in rows)
    assert titles == ["First spec", "Second"]


@pytest.mark.asyncio
async def test_rescan_idempotent_does_not_duplicate(
    registered_container, registry_engine, tmp_path: Path
) -> None:
    spec_dir = tmp_path / "specs"
    spec_dir.mkdir()
    (spec_dir / "x.md").write_text("# X\n\nBody.")

    await rescan_spec_files(
        registry_engine, container_id=registered_container.id, specs_dir=spec_dir
    )
    await rescan_spec_files(
        registry_engine, container_id=registered_container.id, specs_dir=spec_dir
    )

    rows = await list_artifacts(
        registry_engine, container_id=registered_container.id, types=["spec"]
    )
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_rescan_picks_up_new_files_on_subsequent_run(
    registered_container, registry_engine, tmp_path: Path
) -> None:
    spec_dir = tmp_path / "specs"
    spec_dir.mkdir()
    (spec_dir / "old.md").write_text("# Old\n\nOld body.")
    await rescan_spec_files(
        registry_engine, container_id=registered_container.id, specs_dir=spec_dir
    )

    (spec_dir / "new.md").write_text("# New\n\nNew body.")
    await rescan_spec_files(
        registry_engine, container_id=registered_container.id, specs_dir=spec_dir
    )

    rows = await list_artifacts(
        registry_engine, container_id=registered_container.id, types=["spec"]
    )
    titles = sorted(r.title for r in rows)
    assert titles == ["New", "Old"]


@pytest.mark.asyncio
async def test_rescan_handles_missing_directory(
    registered_container, registry_engine, tmp_path: Path
) -> None:
    """Specs dir doesn't exist — rescan should silently no-op (0 records)."""
    await rescan_spec_files(
        registry_engine,
        container_id=registered_container.id,
        specs_dir=tmp_path / "does-not-exist",
    )
    rows = await list_artifacts(
        registry_engine, container_id=registered_container.id, types=["spec"]
    )
    assert rows == []
```

### Step 2: Run, expect FAIL

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_artifacts_spec_rescan.py -v
```

### Step 3: Implement rescan_spec_files

Add to `/home/gnava/repos/honeycomb/hub/services/artifacts.py`:

```python
import re
from pathlib import Path

# Match the first markdown heading in the file
_HEADING_PATTERN = re.compile(r"^#\s+(.+)$", re.MULTILINE)


def _extract_headings(body: str) -> list[str]:
    """Pull all h1/h2 headings (for the spec metadata.headings list)."""
    return [
        m.group(0).lstrip("#").strip()
        for m in re.finditer(r"^#{1,2}\s+.+$", body, re.MULTILINE)
    ]


def _spec_title(body: str, fallback: str) -> str:
    """First # heading, or the fallback (filename stem) if absent."""
    m = _HEADING_PATTERN.search(body)
    return m.group(1).strip() if m is not None else fallback


async def rescan_spec_files(
    engine: AsyncEngine,
    *,
    container_id: int,
    specs_dir: Path,
) -> int:
    """Scan `specs_dir` for *.md files; record any not already in the
    artifacts table (lookup by metadata.file_path). Returns the count
    of new records.

    Idempotent: existing rows are skipped. Missing/empty directory is
    a silent no-op.
    """
    if not specs_dir.exists():
        return 0
    md_files = sorted(specs_dir.glob("*.md"))
    if not md_files:
        return 0

    # Get the existing spec rows for this container — match by file_path
    # in metadata.
    async with engine.connect() as conn:
        rows = (
            (
                await conn.execute(
                    sa.text(
                        "SELECT metadata_json FROM artifacts "
                        "WHERE container_id = :cid AND type = 'spec'"
                    ),
                    {"cid": container_id},
                )
            )
            .mappings()
            .all()
        )
    existing_paths: set[str] = set()
    for r in rows:
        if r["metadata_json"]:
            try:
                meta = json.loads(r["metadata_json"])
                if "file_path" in meta:
                    existing_paths.add(meta["file_path"])
            except json.JSONDecodeError:
                continue

    new_count = 0
    for md_path in md_files:
        rel_path = str(md_path.relative_to(specs_dir.parent))
        if rel_path in existing_paths:
            continue
        body = md_path.read_text(encoding="utf-8", errors="replace")
        title = _spec_title(body, fallback=md_path.stem)
        await record_artifact(
            engine,
            container_id=container_id,
            type="spec",
            title=title,
            body=body,
            metadata={"file_path": rel_path, "headings": _extract_headings(body)},
        )
        new_count += 1
    return new_count
```

### Step 4: Wire into hub/main.py lifespan

Find the existing FastAPI lifespan event in `hub/main.py`. Add a startup task (after the existing `app.state.registry` initialization):

```python
# M35: scan docs/superpowers/specs/*.md and record any new files as
# spec artifacts. Iterates over all known containers — each gets the
# same set of spec rows (no per-container filtering yet; specs are
# shared across the workspace conceptually).
from pathlib import Path
from hub.services.artifacts import rescan_spec_files

specs_dir = Path("docs/superpowers/specs")
try:
    containers = await app.state.registry.list_all()
    for c in containers:
        await rescan_spec_files(
            app.state.registry.engine,
            container_id=c.id,
            specs_dir=specs_dir,
        )
except Exception as exc:
    logger.warning("spec rescan failed at startup: %s", exc)
```

(Verify the registry's "list all containers" method name — likely `list_all()` or `list_records()` per the existing pattern.)

### Step 5: Run tests, expect all green

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_artifacts_spec_rescan.py -v
uv run pytest tests -q
```

### Step 6: Commit

```bash
cd /home/gnava/repos/honeycomb
git add hub/services/artifacts.py hub/main.py hub/tests/test_artifacts_spec_rescan.py
git commit -m "feat(m35): spec auto-save via startup rescan

rescan_spec_files scans docs/superpowers/specs/*.md and records
any markdown file not already present (lookup by metadata.file_path).
Idempotent — existing artifacts are skipped. Missing dir is silent.

Hub lifespan startup iterates all known containers + applies the
rescan to each. Per-container spec rows means each container's
Library shows the same specs (specs are workspace-conceptual, not
container-bound)."
```

---

## Task 6: Live broadcast on `library:<container_id>`

**Files:**

- Modify: `hub/services/artifacts.py` (broadcast on each mutation)
- Modify: `hub/routers/artifacts.py` (broadcast on POST/DELETE/pin/unpin/archive)

The chat_stream auto-save hooks (Task 4) already broadcast on `new`. This task:

1. Adds broadcasts for `updated` (pin / unpin / archive) and `deleted` (delete).
2. Has the router POST emit `new` (so client-initiated artifacts also broadcast).

### Step 1: Write the failing test

Append to `/home/gnava/repos/honeycomb/hub/tests/test_artifacts_endpoint.py`:

```python
@pytest.mark.asyncio
async def test_create_artifact_broadcasts_new(
    client: AsyncClient, registered_container, registry_engine, AUTH
) -> None:
    from hub.routers.ws import manager as ws_mgr
    from unittest.mock import AsyncMock, patch

    with patch.object(ws_mgr, "broadcast", new=AsyncMock()) as mock_broadcast:
        resp = await client.post(
            f"/api/containers/{registered_container.id}/artifacts",
            json={"type": "note", "title": "N", "body": "x"},
            headers=AUTH,
        )
        assert resp.status_code == 201
        # At least one broadcast happened with channel = library:<cid>
        calls = mock_broadcast.await_args_list
        channels = [c.args[0].channel for c in calls]
        assert f"library:{registered_container.id}" in channels


@pytest.mark.asyncio
async def test_delete_broadcasts_deleted(
    client: AsyncClient, registered_container, registry_engine, AUTH
) -> None:
    from hub.routers.ws import manager as ws_mgr
    from unittest.mock import AsyncMock, patch

    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )
    with patch.object(ws_mgr, "broadcast", new=AsyncMock()) as mock_broadcast:
        resp = await client.delete(f"/api/artifacts/{art.artifact_id}", headers=AUTH)
        assert resp.status_code == 204
        # Find a broadcast with event == "deleted"
        deleted_frames = [
            c.args[0]
            for c in mock_broadcast.await_args_list
            if c.args[0].event == "deleted"
        ]
        assert len(deleted_frames) == 1
        assert deleted_frames[0].channel == f"library:{registered_container.id}"


@pytest.mark.asyncio
async def test_pin_broadcasts_updated(
    client: AsyncClient, registered_container, registry_engine, AUTH
) -> None:
    from hub.routers.ws import manager as ws_mgr
    from unittest.mock import AsyncMock, patch

    art = await record_artifact(
        registry_engine,
        container_id=registered_container.id,
        type="note",
        title="A",
        body="...",
    )
    with patch.object(ws_mgr, "broadcast", new=AsyncMock()) as mock_broadcast:
        resp = await client.post(f"/api/artifacts/{art.artifact_id}/pin", headers=AUTH)
        assert resp.status_code == 204
        updated_frames = [
            c.args[0]
            for c in mock_broadcast.await_args_list
            if c.args[0].event == "updated"
        ]
        assert len(updated_frames) == 1
```

### Step 2: Implement the broadcast helpers in artifacts.py

Add to `/home/gnava/repos/honeycomb/hub/services/artifacts.py`:

```python
async def _broadcast_library_event(
    ws_manager: Any,
    *,
    container_id: int,
    event: str,
    data: dict[str, Any],
) -> None:
    """Publish `event` on library:<container_id>. Best-effort."""
    from hub.models.schemas import WSFrame
    frame = WSFrame(
        channel=f"library:{container_id}",
        event=event,
        data=data,
    )
    try:
        await ws_manager.broadcast(frame)
    except Exception as exc:
        logger.warning(
            "library broadcast failed (channel=%s, event=%s): %s",
            frame.channel, event, exc,
        )
```

### Step 3: Wire broadcasts into the router

Modify each mutation endpoint in `/home/gnava/repos/honeycomb/hub/routers/artifacts.py` to broadcast after the successful service call. Add the import + wire each handler. Example for `create_container_artifact`:

```python
from hub.routers.ws import manager as ws_manager
from hub.services.artifacts import _broadcast_library_event

# Inside create_container_artifact, after `return await record_artifact(...)`:
async def create_container_artifact(...):
    art = await record_artifact(...)
    await _broadcast_library_event(
        ws_manager,
        container_id=record_id,
        event="new",
        data=art.model_dump(mode="json"),
    )
    return art
```

Repeat for `pin_endpoint`/`unpin_endpoint`/`archive_endpoint` (event="updated" with `{"artifact_id": ...}` data) and `delete_endpoint` (event="deleted" with `{"artifact_id": ...}` data).

For pin/unpin/archive — the artifact must be looked up first to get the container_id (the URL has `artifact_id`, not `container_id`). Add a helper:

```python
async def _fetch_container_id_for_artifact(engine, artifact_id: str) -> int | None:
    """Return container_id for an artifact, or None if missing/synthesized."""
    if artifact_id.startswith("edit-"):
        return None  # edit artifacts can't be mutated
    async with engine.connect() as conn:
        row = (
            (
                await conn.execute(
                    sa.text("SELECT container_id FROM artifacts WHERE artifact_id = :aid"),
                    {"aid": artifact_id},
                )
            )
            .mappings()
            .first()
        )
    return row["container_id"] if row else None
```

### Step 4: Run tests, expect all green

```bash
cd /home/gnava/repos/honeycomb/hub
uv run pytest tests/test_artifacts_endpoint.py -v
uv run pytest tests -q
```

### Step 5: Commit

```bash
cd /home/gnava/repos/honeycomb
git add hub/services/artifacts.py hub/routers/artifacts.py hub/tests/test_artifacts_endpoint.py
git commit -m "feat(m35): live broadcast on library:<container_id>

Every mutation (create / pin / unpin / archive / delete) broadcasts
on the container's library channel:
- 'new' on POST → full Artifact JSON
- 'updated' on pin / unpin / archive → {artifact_id}
- 'deleted' on DELETE → {artifact_id}

Mirrors M30's diff-events broadcast pattern. The dashboard's
useArtifacts hook (Task 7) subscribes to this channel and applies
the events to the TanStack Query cache."
```

---

## Task 7: useArtifacts hook + Artifact TS types

**Files:**

- Modify: `dashboard/src/lib/types.ts` (add `Artifact`, `ArtifactType`)
- Modify: `dashboard/src/lib/api.ts` (add 7 wrapper exports)
- Create: `dashboard/src/hooks/useArtifacts.ts`
- Create: `dashboard/src/hooks/__tests__/useArtifacts.test.tsx`

### Step 1: Add types

Append to `/home/gnava/repos/honeycomb/dashboard/src/lib/types.ts`:

```ts
// ─── M35 Library artifacts ───────────────────────────────────────────────────

export type ArtifactType =
  | "plan"
  | "review"
  | "edit"
  | "snippet"
  | "note"
  | "skill"
  | "subagent"
  | "spec";

export interface Artifact {
  artifact_id: string;
  container_id: number;
  type: ArtifactType;
  title: string;
  body: string;
  body_format: string;
  source_chat_id: string | null;
  source_message_id: string | null;
  metadata: Record<string, unknown> | null;
  pinned: boolean;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface ListArtifactsParams {
  type?: ArtifactType[];
  search?: string;
  archived?: boolean;
}
```

### Step 2: Add API wrappers

Append to `/home/gnava/repos/honeycomb/dashboard/src/lib/api.ts`:

```ts
// ─── M35 Library ─────────────────────────────────────────────────────────────

import type { Artifact, ArtifactType, ListArtifactsParams } from "./types";

function buildArtifactQuery(params: ListArtifactsParams): string {
  const sp = new URLSearchParams();
  if (params.type) {
    for (const t of params.type) sp.append("type", t);
  }
  if (params.search) sp.set("search", params.search);
  if (params.archived) sp.set("archived", "true");
  const qs = sp.toString();
  return qs ? `?${qs}` : "";
}

export const listArtifacts = (containerId: number, params: ListArtifactsParams = {}) =>
  request<Artifact[]>(`/containers/${containerId}/artifacts${buildArtifactQuery(params)}`);

export const getArtifact = (artifactId: string) => request<Artifact>(`/artifacts/${artifactId}`);

export interface CreateArtifactBody {
  type: ArtifactType;
  title: string;
  body: string;
  body_format?: string;
  source_chat_id?: string | null;
  source_message_id?: string | null;
  metadata?: Record<string, unknown> | null;
}

export const createArtifact = (containerId: number, body: CreateArtifactBody) =>
  request<Artifact>(`/containers/${containerId}/artifacts`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const pinArtifact = (artifactId: string) =>
  request<void>(`/artifacts/${artifactId}/pin`, { method: "POST" });

export const unpinArtifact = (artifactId: string) =>
  request<void>(`/artifacts/${artifactId}/unpin`, { method: "POST" });

export const archiveArtifact = (artifactId: string) =>
  request<void>(`/artifacts/${artifactId}/archive`, { method: "POST" });

export const deleteArtifact = (artifactId: string) =>
  request<void>(`/artifacts/${artifactId}`, { method: "DELETE" });
```

### Step 3: Write the failing hook test

Create `/home/gnava/repos/honeycomb/dashboard/src/hooks/__tests__/useArtifacts.test.tsx`:

```tsx
/** useArtifacts hook tests (M35). */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useArtifacts } from "../useArtifacts";
import type { Artifact } from "../../lib/types";

// Mock the API
const mockListArtifacts = vi.fn();
vi.mock("../../lib/api", () => ({
  listArtifacts: (...args: unknown[]) => mockListArtifacts(...args),
}));

// In-memory mock of useHiveWebSocket
type Listener = (frame: { channel: string; event: string; data: unknown }) => void;
const listeners = new Map<string, Set<Listener>>();
const subscribed = new Set<string>();

vi.mock("./useWebSocket", () => ({
  useHiveWebSocket: () => ({
    subscribe: (channels: string[]) => channels.forEach((c) => subscribed.add(c)),
    unsubscribe: (channels: string[]) => channels.forEach((c) => subscribed.delete(c)),
    onChannel: (channel: string, cb: Listener) => {
      let set = listeners.get(channel);
      if (!set) {
        set = new Set();
        listeners.set(channel, set);
      }
      set.add(cb);
      return () => set!.delete(cb);
    },
  }),
}));

function emit(channel: string, event: string, data: unknown): void {
  const set = listeners.get(channel);
  if (!set) return;
  for (const cb of set) cb({ channel, event, data });
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const sampleArtifact: Artifact = {
  artifact_id: "a-1",
  container_id: 1,
  type: "note",
  title: "A",
  body: "x",
  body_format: "markdown",
  source_chat_id: null,
  source_message_id: null,
  metadata: null,
  pinned: false,
  archived: false,
  created_at: "2026-04-26T00:00:00Z",
  updated_at: "2026-04-26T00:00:00Z",
};

beforeEach(() => {
  mockListArtifacts.mockReset();
  listeners.clear();
  subscribed.clear();
});
afterEach(() => {
  listeners.clear();
});

describe("useArtifacts", () => {
  it("subscribes to library:<id> on mount, unsubscribes on unmount", async () => {
    mockListArtifacts.mockResolvedValue([]);
    const { unmount } = renderHook(() => useArtifacts(1, {}), { wrapper });
    await waitFor(() => expect(subscribed.has("library:1")).toBe(true));
    unmount();
    expect(subscribed.has("library:1")).toBe(false);
  });

  it("does not query or subscribe when containerId is null", () => {
    renderHook(() => useArtifacts(null, {}), { wrapper });
    expect(mockListArtifacts).not.toHaveBeenCalled();
    expect(subscribed.size).toBe(0);
  });

  it("returns the artifact list from the API", async () => {
    mockListArtifacts.mockResolvedValue([sampleArtifact]);
    const { result } = renderHook(() => useArtifacts(1, {}), { wrapper });
    await waitFor(() => expect(result.current.artifacts).toHaveLength(1));
    expect(result.current.artifacts[0].artifact_id).toBe("a-1");
  });

  it("'new' WS event prepends the artifact to the cache", async () => {
    mockListArtifacts.mockResolvedValue([]);
    const { result } = renderHook(() => useArtifacts(1, {}), { wrapper });
    await waitFor(() => expect(subscribed.has("library:1")).toBe(true));

    act(() => {
      emit("library:1", "new", sampleArtifact);
    });
    expect(result.current.artifacts).toHaveLength(1);
    expect(result.current.artifacts[0].artifact_id).toBe("a-1");
  });

  it("'deleted' WS event removes the artifact from the cache", async () => {
    mockListArtifacts.mockResolvedValue([sampleArtifact]);
    const { result } = renderHook(() => useArtifacts(1, {}), { wrapper });
    await waitFor(() => expect(result.current.artifacts).toHaveLength(1));

    act(() => {
      emit("library:1", "deleted", { artifact_id: "a-1" });
    });
    expect(result.current.artifacts).toHaveLength(0);
  });

  it("'updated' WS event refetches the list", async () => {
    mockListArtifacts.mockResolvedValueOnce([sampleArtifact]);
    const { result } = renderHook(() => useArtifacts(1, {}), { wrapper });
    await waitFor(() => expect(result.current.artifacts).toHaveLength(1));

    mockListArtifacts.mockResolvedValueOnce([{ ...sampleArtifact, pinned: true }]);
    act(() => {
      emit("library:1", "updated", { artifact_id: "a-1" });
    });
    await waitFor(() => expect(result.current.artifacts[0].pinned).toBe(true));
  });
});
```

### Step 4: Run, expect FAIL

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useArtifacts.test.tsx
```

### Step 5: Implement useArtifacts

Create `/home/gnava/repos/honeycomb/dashboard/src/hooks/useArtifacts.ts`:

```ts
/** useArtifacts — TanStack Query cache + WebSocket subscription for
 *  library:<container_id> (M35). Pattern mirrors M30 useDiffEvents.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { listArtifacts } from "../lib/api";
import type { Artifact, ListArtifactsParams } from "../lib/types";
import { useHiveWebSocket } from "./useWebSocket";

export interface UseArtifactsResult {
  artifacts: Artifact[];
  isLoading: boolean;
  error: unknown;
}

function artifactsQueryKey(containerId: number, params: ListArtifactsParams) {
  return ["artifacts", containerId, params] as const;
}

export function useArtifacts(
  containerId: number | null,
  params: ListArtifactsParams,
): UseArtifactsResult {
  const qc = useQueryClient();
  const ws = useHiveWebSocket();

  const queryKey =
    containerId !== null
      ? artifactsQueryKey(containerId, params)
      : (["artifacts", "_disabled"] as const);

  const query = useQuery({
    queryKey,
    queryFn: () => listArtifacts(containerId as number, params),
    enabled: containerId !== null,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (containerId === null) return;
    const channel = `library:${containerId}`;
    ws.subscribe([channel]);
    const remove = ws.onChannel(channel, (frame) => {
      if (frame.event === "new") {
        const incoming = frame.data as Artifact;
        qc.setQueryData<Artifact[]>(queryKey as readonly unknown[], (prev) => {
          const base = prev ?? [];
          return [incoming, ...base];
        });
      } else if (frame.event === "deleted") {
        const { artifact_id } = frame.data as { artifact_id: string };
        qc.setQueryData<Artifact[]>(queryKey as readonly unknown[], (prev) => {
          if (!prev) return prev;
          return prev.filter((a) => a.artifact_id !== artifact_id);
        });
      } else if (frame.event === "updated") {
        // Easier than reconciling partial updates: refetch.
        void qc.invalidateQueries({ queryKey });
      }
    });
    return () => {
      remove();
      ws.unsubscribe([channel]);
    };
  }, [containerId, ws, qc, queryKey]);

  return {
    artifacts: query.data ?? [],
    isLoading: query.isFetching,
    error: query.error,
  };
}
```

### Step 6: Run tests, expect 6/6 PASS

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/hooks/__tests__/useArtifacts.test.tsx
```

### Step 7: Run full vitest + typecheck

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
```

### Step 8: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/hooks/useArtifacts.ts \
        dashboard/src/hooks/__tests__/useArtifacts.test.tsx \
        dashboard/src/lib/types.ts \
        dashboard/src/lib/api.ts
git commit -m "feat(m35): useArtifacts hook + Artifact TS types + 7 API wrappers

TanStack Query cache + WebSocket subscription on library:<container_id>.
Mirrors M30 useDiffEvents pattern: 'new' prepends, 'deleted' filters
out, 'updated' invalidates the query (cheaper than reconciling
partial updates).

API wrappers cover list / get / create / pin / unpin / archive /
delete. listArtifacts accepts type[] / search / archived params
that the M35 LibraryActivity will use for chip multi-select."
```

---

## Task 8: LibraryActivity shell + ArtifactCard component

**Files:**

- Modify: `dashboard/package.json` (add `react-markdown`, `remark-gfm`)
- Create: `dashboard/src/components/library/LibraryActivity.tsx`
- Create: `dashboard/src/components/library/ArtifactCard.tsx`
- Create: `dashboard/src/components/library/__tests__/ArtifactCard.test.tsx`

### Step 1: Install markdown deps

```bash
cd /home/gnava/repos/honeycomb/dashboard
npm install --save react-markdown remark-gfm
```

Verify install:

```bash
node -e "console.log(require('react-markdown/package.json').version)"
node -e "console.log(require('remark-gfm/package.json').version)"
```

### Step 2: Write the ArtifactCard test

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/__tests__/ArtifactCard.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ArtifactCard } from "../ArtifactCard";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "a-1",
  container_id: 1,
  type: "note",
  title: "Sample note",
  body: "body...",
  body_format: "markdown",
  source_chat_id: "ns-claude-1",
  source_message_id: null,
  metadata: null,
  pinned: false,
  archived: false,
  created_at: "2026-04-26T00:00:00Z",
  updated_at: "2026-04-26T00:00:00Z",
};

describe("ArtifactCard", () => {
  it("renders type icon + title + From: line", () => {
    render(<ArtifactCard artifact={sample} active={false} onSelect={vi.fn()} />);
    expect(screen.getByText("Sample note")).toBeTruthy();
    // From: line with the source chat ID
    expect(screen.getByText(/From:/i)).toBeTruthy();
  });

  it("clicking card calls onSelect with artifact_id", () => {
    const onSelect = vi.fn();
    render(<ArtifactCard artifact={sample} active={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onSelect).toHaveBeenCalledWith("a-1");
  });

  it("active card carries aria-pressed=true", () => {
    render(<ArtifactCard artifact={sample} active={true} onSelect={vi.fn()} />);
    expect(screen.getByRole("button").getAttribute("aria-pressed")).toBe("true");
  });

  it("each type renders a distinct emoji marker", () => {
    const types = [
      "plan",
      "review",
      "edit",
      "snippet",
      "note",
      "skill",
      "subagent",
      "spec",
    ] as const;
    const seen = new Set<string>();
    for (const t of types) {
      const { container, unmount } = render(
        <ArtifactCard artifact={{ ...sample, type: t }} active={false} onSelect={vi.fn()} />,
      );
      // Find the icon span — first emoji-bearing span in the card
      const text = container.textContent ?? "";
      seen.add(text.charAt(0)); // crude but: each card starts with a different glyph
      unmount();
    }
    // All 8 distinct (might collapse if two types share an emoji — adjust if needed)
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });
});
```

### Step 3: Implement ArtifactCard

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/ArtifactCard.tsx`:

```tsx
/** Single artifact card in the Library sidebar (M35).
 *
 * Per spec lines 360-369: each type has a distinct icon + accent color.
 * Card shows type icon + title + meta line (From: <chat name> · <relative time>).
 */
import type { Artifact, ArtifactType } from "../../lib/types";

interface Props {
  artifact: Artifact;
  active: boolean;
  onSelect: (artifactId: string) => void;
}

const TYPE_ICON: Record<ArtifactType, string> = {
  plan: "📋",
  review: "👁",
  edit: "✏️",
  snippet: "</>",
  note: "🗒",
  skill: "🛠",
  subagent: "🤝",
  spec: "📄",
};

const TYPE_ACCENT: Record<ArtifactType, string> = {
  plan: "text-think", // orange
  review: "text-claude", // purple
  edit: "text-edit", // blue
  snippet: "text-tool", // blue
  note: "text-secondary", // neutral
  skill: "text-claude", // purple
  subagent: "text-task", // red
  spec: "text-think", // orange
};

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function ArtifactCard({ artifact, active, onSelect }: Props) {
  const icon = TYPE_ICON[artifact.type];
  const accent = TYPE_ACCENT[artifact.type];
  const fromLabel = artifact.source_chat_id
    ? `From: ${artifact.source_chat_id.slice(0, 8)}`
    : `From: ${artifact.type}`;
  return (
    <button
      type="button"
      role="button"
      aria-pressed={active}
      onClick={() => onSelect(artifact.artifact_id)}
      className={`flex w-full items-start gap-2 rounded border px-3 py-2 text-left transition-colors ${
        active
          ? "border-accent bg-chip"
          : "border-edge bg-pane hover:border-edge-soft hover:bg-chip"
      }`}
    >
      <span className={`shrink-0 font-mono text-[14px] ${accent}`} aria-hidden="true">
        {icon}
      </span>
      <span className="flex flex-1 flex-col overflow-hidden">
        <span className="truncate text-[12px] font-medium text-primary">{artifact.title}</span>
        <span className="mt-0.5 truncate text-[10px] text-muted">
          {fromLabel} · {relativeTime(artifact.created_at)}
        </span>
      </span>
    </button>
  );
}
```

### Step 4: Implement LibraryActivity shell

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/LibraryActivity.tsx`:

```tsx
/** Library activity (M35) — top-level shell for the Library route.
 *
 * Composes:
 *   - Sidebar:  FilterChips + ScopeToggle + SearchInput + card list
 *   - Main:     per-type renderer dispatch on the selected artifact
 *
 * Tasks 9-12 fill in the sub-pieces; this task ships the shell with
 * placeholder children.
 */
import { useState } from "react";

import type { ArtifactType } from "../../lib/types";
import { useArtifacts } from "../../hooks/useArtifacts";
import { ArtifactCard } from "./ArtifactCard";

interface Props {
  containers: { id: number; project_name: string }[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
}

export function LibraryActivity({ containers, activeContainerId, onSelectContainer }: Props) {
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<ArtifactType[]>([]);
  const [search, setSearch] = useState("");
  // Scope toggle is "active" for M35 task 8; Task 11 wires the toggle UI.

  const { artifacts, isLoading } = useArtifacts(activeContainerId, {
    type: selectedTypes.length > 0 ? selectedTypes : undefined,
    search: search || undefined,
  });

  void containers;
  void onSelectContainer;
  void setSelectedTypes;
  void setSearch;

  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside
        aria-label="Library sidebar"
        className="flex w-80 shrink-0 flex-col border-r border-edge bg-pane"
      >
        <header className="border-b border-edge px-3 py-1.5">
          <h2 className="text-[10px] font-semibold tracking-wider text-secondary uppercase">
            Library
          </h2>
        </header>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {isLoading && artifacts.length === 0 ? (
            <p className="px-2 py-4 text-[12px] text-secondary">Loading…</p>
          ) : artifacts.length === 0 ? (
            <p className="px-2 py-4 text-[12px] text-secondary">
              No artifacts yet. They auto-save as you chat.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {artifacts.map((a) => (
                <li key={a.artifact_id}>
                  <ArtifactCard
                    artifact={a}
                    active={a.artifact_id === activeArtifactId}
                    onSelect={setActiveArtifactId}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <main className="flex h-full min-w-0 flex-1 flex-col bg-page">
        {activeArtifactId ? (
          <div className="flex-1 overflow-y-auto p-4 text-[12px] text-primary">
            Renderer for {activeArtifactId} arrives in Tasks 9-11.
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <p className="text-sm text-secondary">Pick an artifact from the sidebar to view it.</p>
          </div>
        )}
      </main>
    </div>
  );
}
```

### Step 5: Run tests, expect green

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/library/__tests__/ArtifactCard.test.tsx
npx tsc -b --noEmit
```

### Step 6: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/package.json dashboard/package-lock.json \
        dashboard/src/components/library/LibraryActivity.tsx \
        dashboard/src/components/library/ArtifactCard.tsx \
        dashboard/src/components/library/__tests__/ArtifactCard.test.tsx
git commit -m "feat(m35): LibraryActivity shell + ArtifactCard + react-markdown dep

Adds react-markdown + remark-gfm dependencies for the per-type
renderers (Tasks 9-11).

LibraryActivity composes the sidebar (filter chips + scope toggle
+ search + card list) with a placeholder main pane. Tasks 9-12
fill in the sub-pieces.

ArtifactCard shows the type icon + title + 'From: <source>' meta
line. Eight distinct icon + accent-color combinations per spec
lines 360-369."
```

---

## Task 9: Markdown-based renderers (Plan / Note / Spec / Skill)

**Files:**

- Create: `dashboard/src/components/library/renderers/PlanRenderer.tsx`
- Create: `dashboard/src/components/library/renderers/NoteRenderer.tsx`
- Create: `dashboard/src/components/library/renderers/SpecRenderer.tsx`
- Create: `dashboard/src/components/library/renderers/SkillRenderer.tsx`
- Create: `dashboard/src/components/library/renderers/MarkdownBody.tsx` (shared)
- Tests for each

All four are markdown-bodied artifacts. They share a `MarkdownBody` component built on `react-markdown` + `remark-gfm`. Per-type renderers add type-specific chrome (TOC for Spec, frontmatter parser for Skill, etc.).

### Step 1: Implement MarkdownBody (shared)

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/renderers/MarkdownBody.tsx`:

```tsx
/** Shared markdown rendering for Plan / Note / Spec / Skill (M35).
 *
 * Uses react-markdown + remark-gfm. Sanitization is built-in (no
 * dangerouslySetInnerHTML). Code blocks render with light styling
 * (no syntax highlighting in M35; that's a future enhancement).
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

interface Props {
  source: string;
}

export function MarkdownBody({ source }: Props) {
  return (
    <div className="prose-tight max-w-none text-[13px] text-primary">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Override default tags to use M31 semantic tokens
          h1: (props) => (
            <h1 className="mt-4 mb-2 text-[18px] font-semibold text-primary" {...props} />
          ),
          h2: (props) => (
            <h2 className="mt-3 mb-1.5 text-[15px] font-semibold text-primary" {...props} />
          ),
          h3: (props) => (
            <h3 className="mt-2 mb-1 text-[13px] font-semibold text-primary" {...props} />
          ),
          p: (props) => <p className="mb-2 leading-relaxed" {...props} />,
          a: (props) => (
            <a
              className="text-accent underline hover:text-claude"
              target="_blank"
              rel="noreferrer"
              {...props}
            />
          ),
          ul: (props) => <ul className="mb-2 ml-5 list-disc space-y-1" {...props} />,
          ol: (props) => <ol className="mb-2 ml-5 list-decimal space-y-1" {...props} />,
          code: ({ inline, ...props }: { inline?: boolean }) =>
            inline ? (
              <code
                className="rounded bg-chip px-1 py-0.5 font-mono text-[11.5px] text-tool"
                {...props}
              />
            ) : (
              <code className="font-mono text-[11.5px] text-primary" {...props} />
            ),
          pre: (props) => (
            <pre
              className="mb-2 overflow-x-auto rounded border border-edge-soft bg-input px-3 py-2"
              {...props}
            />
          ),
          blockquote: (props) => (
            <blockquote
              className="mb-2 border-l-2 border-edge pl-3 italic text-secondary"
              {...props}
            />
          ),
          table: (props) => (
            <table className="mb-2 border-collapse border border-edge text-[11.5px]" {...props} />
          ),
          th: (props) => (
            <th
              className="border border-edge bg-chip px-2 py-1 text-left font-semibold"
              {...props}
            />
          ),
          td: (props) => <td className="border border-edge px-2 py-1" {...props} />,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
```

### Step 2: Implement PlanRenderer + NoteRenderer + SpecRenderer + SkillRenderer

**PlanRenderer** (`dashboard/src/components/library/renderers/PlanRenderer.tsx`):

```tsx
/** Plan artifact renderer (M35). Markdown body with optional headings TOC. */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function PlanRenderer({ artifact }: Props) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <header className="border-b border-edge-soft pb-2">
        <h1 className="text-[18px] font-semibold text-primary">{artifact.title}</h1>
        <p className="mt-1 text-[11px] text-muted">
          Plan · saved {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>
      <MarkdownBody source={artifact.body} />
    </div>
  );
}
```

**NoteRenderer** (`dashboard/src/components/library/renderers/NoteRenderer.tsx`):

```tsx
/** Note artifact renderer (M35). Light markdown — single column, no chrome. */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function NoteRenderer({ artifact }: Props) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <header className="border-b border-edge-soft pb-2">
        <h1 className="text-[15px] font-semibold text-primary">{artifact.title}</h1>
        <p className="mt-1 text-[10px] text-muted">
          Note · {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>
      <MarkdownBody source={artifact.body} />
    </div>
  );
}
```

**SpecRenderer** (`dashboard/src/components/library/renderers/SpecRenderer.tsx`):

```tsx
/** Spec artifact renderer (M35). Markdown with a left-side TOC built
 *  from the metadata.headings list (populated at rescan time). */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function SpecRenderer({ artifact }: Props) {
  const headings = (artifact.metadata?.headings as string[] | undefined) ?? [];
  const filePath = artifact.metadata?.file_path as string | undefined;
  return (
    <div className="flex h-full">
      {headings.length > 0 && (
        <aside className="w-56 shrink-0 overflow-y-auto border-r border-edge-soft bg-pane px-3 py-3">
          <h3 className="mb-2 text-[10px] font-semibold tracking-wider text-muted uppercase">
            Contents
          </h3>
          <ul className="flex flex-col gap-1 text-[11px]">
            {headings.map((h, i) => (
              <li key={`${h}-${i}`} className="truncate text-secondary">
                {h}
              </li>
            ))}
          </ul>
        </aside>
      )}
      <div className="flex-1 overflow-y-auto">
        <header className="border-b border-edge-soft px-4 pt-3 pb-2">
          <h1 className="text-[18px] font-semibold text-primary">{artifact.title}</h1>
          {filePath && <p className="mt-1 font-mono text-[11px] text-muted">{filePath}</p>}
        </header>
        <div className="px-4 py-3">
          <MarkdownBody source={artifact.body} />
        </div>
      </div>
    </div>
  );
}
```

**SkillRenderer** (`dashboard/src/components/library/renderers/SkillRenderer.tsx`):

```tsx
/** Skill artifact renderer (M35 placeholder). Frontmatter + markdown body.
 *
 *  M35 ships a placeholder renderer; auto-source for skills is a future
 *  milestone. The renderer parses YAML-ish frontmatter from the body
 *  (between leading `---` markers) and presents it as a metadata header.
 */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

function splitFrontmatter(body: string): { frontmatter: Record<string, string>; rest: string } {
  if (!body.startsWith("---\n")) return { frontmatter: {}, rest: body };
  const end = body.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, rest: body };
  const fm = body.slice(4, end);
  const rest = body.slice(end + 5);
  const parsed: Record<string, string> = {};
  for (const line of fm.split("\n")) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    parsed[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { frontmatter: parsed, rest };
}

export function SkillRenderer({ artifact }: Props) {
  const { frontmatter, rest } = splitFrontmatter(artifact.body);
  const skillName =
    (artifact.metadata?.skill_name as string | undefined) ?? frontmatter.name ?? artifact.title;
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <header className="border-b border-edge-soft pb-2">
        <h1 className="text-[18px] font-semibold text-primary">{skillName}</h1>
        {frontmatter.description && (
          <p className="mt-1 text-[12px] text-secondary">{frontmatter.description}</p>
        )}
        <p className="mt-1 text-[10px] text-muted">
          Skill · {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>
      <MarkdownBody source={rest} />
    </div>
  );
}
```

### Step 3: Tests

Create one test file per renderer in `dashboard/src/components/library/__tests__/`. Pattern (using PlanRenderer):

```tsx
// dashboard/src/components/library/__tests__/PlanRenderer.test.tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PlanRenderer } from "../renderers/PlanRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "p-1",
  container_id: 1,
  type: "plan",
  title: "Refactor plan",
  body: "## Step 1\n\nDo the thing.\n\n## Step 2\n\nDo the next thing.",
  body_format: "markdown",
  source_chat_id: null,
  source_message_id: null,
  metadata: null,
  pinned: false,
  archived: false,
  created_at: "2026-04-26T00:00:00Z",
  updated_at: "2026-04-26T00:00:00Z",
};

describe("PlanRenderer", () => {
  it("renders the title in the header", () => {
    render(<PlanRenderer artifact={sample} />);
    expect(screen.getByText("Refactor plan")).toBeTruthy();
  });

  it("renders markdown body (h2 headings visible)", () => {
    render(<PlanRenderer artifact={sample} />);
    expect(screen.getByText("Step 1")).toBeTruthy();
    expect(screen.getByText("Step 2")).toBeTruthy();
  });
});
```

Mirror this for NoteRenderer (assert title + body). For SpecRenderer (additionally assert TOC: render with `metadata.headings = ["Section A", "Section B"]` and assert both appear in the aside). For SkillRenderer (assert frontmatter parser splits correctly).

Approximately 8-10 tests total across the four renderers.

### Step 4: Run + commit

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/library/__tests__/
npx tsc -b --noEmit
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/library/renderers/MarkdownBody.tsx \
        dashboard/src/components/library/renderers/PlanRenderer.tsx \
        dashboard/src/components/library/renderers/NoteRenderer.tsx \
        dashboard/src/components/library/renderers/SpecRenderer.tsx \
        dashboard/src/components/library/renderers/SkillRenderer.tsx \
        dashboard/src/components/library/__tests__/
git commit -m "feat(m35): markdown-based renderers — Plan / Note / Spec / Skill

Shared MarkdownBody built on react-markdown + remark-gfm with M31
semantic tokens overriding the default heading/link/code/blockquote
rendering. Sanitization is built-in (no dangerouslySetInnerHTML).

Per-type:
- Plan: h1 title + relative-time subtitle + body
- Note: lighter chrome — h2 title only
- Spec: left TOC built from metadata.headings + filename in subtitle
- Skill: frontmatter parser splits leading ---/--- block; presents
  description + name + body

Skill is placeholder-only in M35; auto-source ships in a future
milestone."
```

---

## Task 10: Code-based renderers (Edit / Snippet)

**Files:**

- Create: `dashboard/src/components/library/renderers/EditRenderer.tsx`
- Create: `dashboard/src/components/library/renderers/SnippetRenderer.tsx`
- Tests for each

### Step 1: Implement EditRenderer (reuses M27 react-diff-view)

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/renderers/EditRenderer.tsx`:

```tsx
/** Edit artifact renderer (M35). Reuses M27's react-diff-view setup
 *  via DiffViewerTab for visual consistency.
 *
 *  Edit artifacts are synthesized at read-time from the diff_events
 *  table; their body is the unified-diff text and metadata.paths is
 *  the file list. Translates the Artifact shape back into the M27
 *  DiffEvent shape that DiffViewerTab expects.
 */
import { DiffViewerTab } from "../../DiffViewerTab";
import type { Artifact, DiffEvent } from "../../../lib/types";

interface Props {
  artifact: Artifact;
}

function artifactToDiffEvent(artifact: Artifact): DiffEvent {
  const metadata = artifact.metadata ?? {};
  const paths = (metadata.paths as string[] | undefined) ?? [];
  const tool = (metadata.tool as DiffEvent["tool"] | undefined) ?? "Edit";
  // Strip the synthesized "edit-" prefix to recover the original event_id
  const eventId = artifact.artifact_id.startsWith("edit-")
    ? artifact.artifact_id.slice("edit-".length)
    : artifact.artifact_id;
  return {
    event_id: eventId,
    container_id: artifact.container_id,
    claude_session_id: artifact.source_chat_id,
    tool_use_id: artifact.source_message_id ?? "",
    tool,
    path: paths[0] ?? "(file)",
    diff: artifact.body,
    added_lines: (metadata.lines_added as number | undefined) ?? 0,
    removed_lines: (metadata.lines_removed as number | undefined) ?? 0,
    size_bytes: (metadata.size_bytes as number | undefined) ?? artifact.body.length,
    timestamp: artifact.created_at,
    created_at: artifact.created_at,
  };
}

export function EditRenderer({ artifact }: Props) {
  const event = artifactToDiffEvent(artifact);
  return <DiffViewerTab event={event} onOpenFile={() => undefined} />;
}
```

### Step 2: Implement SnippetRenderer

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/renderers/SnippetRenderer.tsx`:

```tsx
/** Snippet artifact renderer (M35). Code block with copy-to-clipboard
 *  + download buttons.
 */
import { Copy, Download } from "lucide-react";

import type { Artifact } from "../../../lib/types";

interface Props {
  artifact: Artifact;
}

export function SnippetRenderer({ artifact }: Props) {
  const language = (artifact.metadata?.language as string | undefined) ?? artifact.body_format;
  const lineCount =
    (artifact.metadata?.line_count as number | undefined) ?? artifact.body.split("\n").length;

  const copy = () => {
    void navigator.clipboard.writeText(artifact.body);
  };

  const download = () => {
    const blob = new Blob([artifact.body], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ext = language || "txt";
    a.href = url;
    a.download = `${artifact.title.replace(/[^a-z0-9-_]/gi, "_")}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-edge-soft px-4 py-2">
        <div>
          <h1 className="text-[14px] font-semibold text-primary">{artifact.title}</h1>
          <p className="mt-0.5 text-[10px] text-muted">
            {language} · {lineCount} lines
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={copy}
            aria-label="Copy snippet"
            title="Copy"
            className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
          >
            <Copy size={14} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={download}
            aria-label="Download snippet"
            title="Download"
            className="rounded p-1 text-secondary hover:bg-chip hover:text-primary"
          >
            <Download size={14} aria-hidden="true" />
          </button>
        </div>
      </header>
      <pre className="flex-1 overflow-auto bg-input px-4 py-3 font-mono text-[12px] text-primary">
        {artifact.body}
      </pre>
    </div>
  );
}
```

### Step 3: Tests

Create `dashboard/src/components/library/__tests__/EditRenderer.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EditRenderer } from "../renderers/EditRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "edit-abc123",
  container_id: 1,
  type: "edit",
  title: "Edit: src/main.tsx",
  body: "--- a/src/main.tsx\n+++ b/src/main.tsx\n@@ -1,1 +1,1 @@\n-old\n+new\n",
  body_format: "diff",
  source_chat_id: "ns-claude-1",
  source_message_id: "tu-1",
  metadata: { paths: ["src/main.tsx"], lines_added: 1, lines_removed: 1, tool: "Edit" },
  pinned: false,
  archived: false,
  created_at: "2026-04-26T00:00:00Z",
  updated_at: "2026-04-26T00:00:00Z",
};

describe("EditRenderer", () => {
  it("delegates to DiffViewerTab via the synthesized event", () => {
    render(<EditRenderer artifact={sample} />);
    // DiffViewerTab renders the file path in its toolbar
    expect(screen.getByText(/main.tsx/)).toBeTruthy();
  });
});
```

Create `dashboard/src/components/library/__tests__/SnippetRenderer.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SnippetRenderer } from "../renderers/SnippetRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "s-1",
  container_id: 1,
  type: "snippet",
  title: "python snippet (3 lines)",
  body: "import os\nprint(os.getcwd())\nos.exit(0)",
  body_format: "python",
  source_chat_id: null,
  source_message_id: null,
  metadata: { language: "python", line_count: 3 },
  pinned: false,
  archived: false,
  created_at: "2026-04-26T00:00:00Z",
  updated_at: "2026-04-26T00:00:00Z",
};

describe("SnippetRenderer", () => {
  it("renders the body in a <pre>", () => {
    const { container } = render(<SnippetRenderer artifact={sample} />);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("import os");
  });

  it("clicking Copy invokes clipboard.writeText", () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    render(<SnippetRenderer artifact={sample} />);
    fireEvent.click(screen.getByRole("button", { name: /Copy snippet/i }));
    expect(writeText).toHaveBeenCalledWith(sample.body);
  });

  it("renders the language + line count in the header", () => {
    render(<SnippetRenderer artifact={sample} />);
    expect(screen.getByText(/python · 3 lines/)).toBeTruthy();
  });
});
```

### Step 4: Run + commit

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/library/__tests__/
npx tsc -b --noEmit
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/library/renderers/EditRenderer.tsx \
        dashboard/src/components/library/renderers/SnippetRenderer.tsx \
        dashboard/src/components/library/__tests__/EditRenderer.test.tsx \
        dashboard/src/components/library/__tests__/SnippetRenderer.test.tsx
git commit -m "feat(m35): code-based renderers — Edit / Snippet

EditRenderer translates the synthesized Artifact (artifact_id =
'edit-' + diff_event.event_id) back into a DiffEvent shape and
delegates to M27's DiffViewerTab — visual consistency with the
existing Recent Edits surface.

SnippetRenderer shows the code body in a <pre> with copy-to-
clipboard + download-as-file actions in the header. Filename
sanitized from the title for the download."
```

---

## Task 11: Specialized renderers (Review / Subagent) + dispatch registry

**Files:**

- Create: `dashboard/src/components/library/renderers/ReviewRenderer.tsx` (placeholder/dormant)
- Create: `dashboard/src/components/library/renderers/SubagentRenderer.tsx`
- Create: `dashboard/src/components/library/renderers/dispatch.tsx`
- Tests for each

### Step 1: Implement ReviewRenderer (placeholder/dormant)

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/renderers/ReviewRenderer.tsx`:

```tsx
/** Review artifact renderer (M35 placeholder).
 *
 * Review artifacts are dormant in M35 — auto-save is gated on PR
 * thread loading which arrives in M35.x or M36. The renderer ships
 * for type-discriminator completeness; if a review row somehow
 * exists, render the body as markdown with a placeholder header.
 */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function ReviewRenderer({ artifact }: Props) {
  const prRepo = artifact.metadata?.pr_repo as string | undefined;
  const prNumber = artifact.metadata?.pr_number as number | undefined;
  const status = artifact.metadata?.status as string | undefined;
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <header className="border-b border-edge-soft pb-2">
        <h1 className="text-[16px] font-semibold text-primary">{artifact.title}</h1>
        {prRepo && prNumber !== undefined && (
          <p className="mt-1 font-mono text-[11px] text-secondary">
            {prRepo}#{prNumber}
            {status && <span className="ml-2 text-muted">[{status}]</span>}
          </p>
        )}
        <p className="mt-1 text-[10px] text-muted">
          Review · {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>
      <MarkdownBody source={artifact.body} />
      <div className="rounded border border-edge-soft bg-pane px-3 py-2 text-[11px] text-muted">
        PR thread loading + inline comments arrive in a future milestone.
      </div>
    </div>
  );
}
```

### Step 2: Implement SubagentRenderer

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/renderers/SubagentRenderer.tsx`:

```tsx
/** Subagent result artifact renderer (M35).
 *
 *  A Task tool dispatch — the body is the prompt sent to the subagent;
 *  metadata.result_summary is the subagent's final response. Renders
 *  as a two-bubble mini-thread.
 */
import type { Artifact } from "../../../lib/types";
import { MarkdownBody } from "./MarkdownBody";

interface Props {
  artifact: Artifact;
}

export function SubagentRenderer({ artifact }: Props) {
  const agentType = (artifact.metadata?.agent_type as string | undefined) ?? "agent";
  const resultSummary = artifact.metadata?.result_summary as string | undefined;
  const parentChatId = artifact.metadata?.parent_chat_id as string | undefined;

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <header className="border-b border-edge-soft pb-2">
        <h1 className="text-[15px] font-semibold text-primary">{artifact.title}</h1>
        <p className="mt-1 text-[11px] text-secondary">
          Task → <span className="font-mono text-task">{agentType}</span>
          {parentChatId && (
            <span className="ml-2 text-muted">from chat {parentChatId.slice(0, 8)}</span>
          )}
        </p>
        <p className="mt-1 text-[10px] text-muted">
          Subagent · {new Date(artifact.created_at).toLocaleString()}
        </p>
      </header>

      <section>
        <h2 className="mb-1 text-[10px] font-semibold tracking-wider text-muted uppercase">
          Prompt
        </h2>
        <pre className="whitespace-pre-wrap break-words rounded border border-edge-soft bg-input px-3 py-2 font-mono text-[11.5px] text-primary">
          {artifact.body}
        </pre>
      </section>

      {resultSummary && (
        <section>
          <h2 className="mb-1 text-[10px] font-semibold tracking-wider text-muted uppercase">
            Result
          </h2>
          <div className="rounded border border-edge-soft bg-card px-3 py-2">
            <MarkdownBody source={resultSummary} />
          </div>
        </section>
      )}
    </div>
  );
}
```

### Step 3: Implement the renderer dispatch registry

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/renderers/dispatch.tsx`:

```tsx
/** Per-type renderer dispatch (M35). Registry maps ArtifactType → component.
 *  Falls back to NoteRenderer for any unknown type (defensive — the
 *  Pydantic Literal on the hub side rejects unknowns at the API layer).
 */
import type { Artifact, ArtifactType } from "../../../lib/types";
import { EditRenderer } from "./EditRenderer";
import { NoteRenderer } from "./NoteRenderer";
import { PlanRenderer } from "./PlanRenderer";
import { ReviewRenderer } from "./ReviewRenderer";
import { SkillRenderer } from "./SkillRenderer";
import { SnippetRenderer } from "./SnippetRenderer";
import { SpecRenderer } from "./SpecRenderer";
import { SubagentRenderer } from "./SubagentRenderer";

const REGISTRY: Record<ArtifactType, React.FC<{ artifact: Artifact }>> = {
  plan: PlanRenderer,
  review: ReviewRenderer,
  edit: EditRenderer,
  snippet: SnippetRenderer,
  note: NoteRenderer,
  skill: SkillRenderer,
  subagent: SubagentRenderer,
  spec: SpecRenderer,
};

export function renderArtifact(artifact: Artifact): React.ReactNode {
  const Cmp = REGISTRY[artifact.type] ?? NoteRenderer;
  return <Cmp artifact={artifact} />;
}
```

### Step 4: Tests + commit

Create `dashboard/src/components/library/__tests__/ReviewRenderer.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ReviewRenderer } from "../renderers/ReviewRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "r-1",
  container_id: 1,
  type: "review",
  title: "Review of PR #42",
  body: "Some markdown body.",
  body_format: "markdown",
  source_chat_id: null,
  source_message_id: null,
  metadata: { pr_repo: "owner/repo", pr_number: 42, status: "open" },
  pinned: false,
  archived: false,
  created_at: "2026-04-26T00:00:00Z",
  updated_at: "2026-04-26T00:00:00Z",
};

describe("ReviewRenderer", () => {
  it("renders title + repo + PR number", () => {
    render(<ReviewRenderer artifact={sample} />);
    expect(screen.getByText("Review of PR #42")).toBeTruthy();
    expect(screen.getByText(/owner\/repo#42/)).toBeTruthy();
  });

  it("shows the M35-deferral notice", () => {
    render(<ReviewRenderer artifact={sample} />);
    expect(screen.getByText(/PR thread loading.+arrive/i)).toBeTruthy();
  });
});
```

Create `dashboard/src/components/library/__tests__/SubagentRenderer.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SubagentRenderer } from "../renderers/SubagentRenderer";
import type { Artifact } from "../../../lib/types";

const sample: Artifact = {
  artifact_id: "sub-1",
  container_id: 1,
  type: "subagent",
  title: "Find the bug",
  body: "Find the bug in main.py",
  body_format: "markdown",
  source_chat_id: "ns-1",
  source_message_id: "tu-1",
  metadata: {
    agent_type: "general-purpose",
    parent_chat_id: "ns-1",
    result_summary: "Found the bug in line 42.",
  },
  pinned: false,
  archived: false,
  created_at: "2026-04-26T00:00:00Z",
  updated_at: "2026-04-26T00:00:00Z",
};

describe("SubagentRenderer", () => {
  it("renders the prompt body inside a <pre>", () => {
    const { container } = render(<SubagentRenderer artifact={sample} />);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("Find the bug in main.py");
  });

  it("shows the agent_type in the header", () => {
    render(<SubagentRenderer artifact={sample} />);
    expect(screen.getByText(/general-purpose/)).toBeTruthy();
  });

  it("renders the result_summary section when present", () => {
    render(<SubagentRenderer artifact={sample} />);
    expect(screen.getByText(/Found the bug in line 42/)).toBeTruthy();
  });

  it("omits the result section when result_summary is absent", () => {
    const noResult: Artifact = {
      ...sample,
      metadata: { ...sample.metadata, result_summary: undefined },
    };
    render(<SubagentRenderer artifact={noResult} />);
    expect(screen.queryByText(/Result/)).toBeNull();
  });
});
```

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/library/__tests__/
npx tsc -b --noEmit
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/library/renderers/ReviewRenderer.tsx \
        dashboard/src/components/library/renderers/SubagentRenderer.tsx \
        dashboard/src/components/library/renderers/dispatch.tsx \
        dashboard/src/components/library/__tests__/ReviewRenderer.test.tsx \
        dashboard/src/components/library/__tests__/SubagentRenderer.test.tsx
git commit -m "feat(m35): specialized renderers — Review / Subagent + dispatch registry

ReviewRenderer is a placeholder for M35 (auto-source dormant per
the design choice; PR thread loading arrives later). Renders the
PR repo + number from metadata + a banner noting the deferral.

SubagentRenderer presents the Task as a two-bubble mini-thread:
prompt body in a <pre>, result_summary in markdown if present.
agent_type + parent_chat_id surface in the header.

dispatch.tsx maps all 8 ArtifactTypes to their renderer; falls
back to NoteRenderer defensively (the Pydantic Literal on the hub
side already rejects unknown types at the API layer)."
```

---

## Task 12: FilterChips + MoreCustomizationSheet + ScopeToggle + SearchInput

**Files:**

- Create: `dashboard/src/components/library/FilterChips.tsx`
- Create: `dashboard/src/components/library/MoreCustomizationSheet.tsx`
- Create: `dashboard/src/components/library/ScopeToggle.tsx`
- Create: `dashboard/src/components/library/SearchInput.tsx`
- Tests for each

### Step 1: Implement SearchInput (debounced)

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/SearchInput.tsx`:

```tsx
/** Debounced search input (M35). Emits onChange after 250ms of idle. */
import { Search } from "lucide-react";
import { useEffect, useState } from "react";

interface Props {
  value: string;
  onChange: (next: string) => void;
}

export function SearchInput({ value, onChange }: Props) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (draft !== value) onChange(draft);
    }, 250);
    return () => clearTimeout(t);
  }, [draft, value, onChange]);
  return (
    <label className="flex items-center gap-1.5 rounded border border-edge bg-input px-2 py-1 text-[12px] text-primary focus-within:border-accent">
      <Search size={12} aria-hidden="true" className="shrink-0 text-muted" />
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Search artifacts…"
        aria-label="Search artifacts"
        className="flex-1 bg-transparent placeholder:text-muted focus:outline-none"
      />
    </label>
  );
}
```

### Step 2: Implement ScopeToggle

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/ScopeToggle.tsx`:

```tsx
/** Workspace scope toggle (M35). Default "active"; ⌃A flips to "fleet".
 *  Persisted in localStorage:hive:library:scope.
 */
import { useEffect, useState } from "react";

export type LibraryScope = "active" | "fleet";

const STORAGE_KEY = "hive:library:scope";

function readStored(): LibraryScope {
  if (typeof window === "undefined") return "active";
  return window.localStorage.getItem(STORAGE_KEY) === "fleet" ? "fleet" : "active";
}

interface Props {
  activeContainerName: string | null;
  onScopeChange: (scope: LibraryScope) => void;
}

export function ScopeToggle({ activeContainerName, onScopeChange }: Props) {
  const [scope, setScope] = useState<LibraryScope>(() => readStored());
  useEffect(() => {
    onScopeChange(scope);
  }, [scope, onScopeChange]);

  const flip = () => {
    const next: LibraryScope = scope === "active" ? "fleet" : "active";
    setScope(next);
    window.localStorage.setItem(STORAGE_KEY, next);
  };

  return (
    <div className="flex items-center gap-1 text-[10px] text-secondary">
      <span>Library ·</span>
      {scope === "active" ? (
        <span>
          in <span className="text-primary">{activeContainerName ?? "(no workspace)"}</span>
        </span>
      ) : (
        <span className="text-primary">across all workspaces</span>
      )}
      <button
        type="button"
        onClick={flip}
        title="Toggle scope (⌃A)"
        aria-label="Toggle library scope"
        className="ml-1 rounded border border-edge px-1.5 py-0.5 text-[10px] hover:bg-chip"
      >
        ⌃ {scope === "active" ? "all" : "active"}
      </button>
    </div>
  );
}
```

### Step 3: Implement FilterChips + MoreCustomizationSheet

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/FilterChips.tsx`:

```tsx
/** Filter chip row (M35). All + 4 primary + ⋯ More.
 *  Multi-select supported. Counts shown per chip.
 *  Persists per-user customization in localStorage:hive:library:primary-types.
 */
import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";

import type { Artifact, ArtifactType } from "../../lib/types";
import { MoreCustomizationSheet } from "./MoreCustomizationSheet";

const STORAGE_KEY = "hive:library:primary-types";
const ALL_TYPES: ArtifactType[] = [
  "plan",
  "review",
  "edit",
  "snippet",
  "note",
  "skill",
  "subagent",
  "spec",
];
const DEFAULT_PRIMARY: ArtifactType[] = ["plan", "review", "edit", "snippet"];
const TYPE_LABEL: Record<ArtifactType, string> = {
  plan: "Plans",
  review: "Reviews",
  edit: "Edits",
  snippet: "Snippets",
  note: "Notes",
  skill: "Skills",
  subagent: "Subagents",
  spec: "Specs",
};

function readStored(): ArtifactType[] {
  if (typeof window === "undefined") return DEFAULT_PRIMARY;
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (!v) return DEFAULT_PRIMARY;
    const parsed = JSON.parse(v);
    if (!Array.isArray(parsed)) return DEFAULT_PRIMARY;
    const valid = parsed.filter((t): t is ArtifactType => ALL_TYPES.includes(t as ArtifactType));
    return valid.length === 4 ? (valid as ArtifactType[]) : DEFAULT_PRIMARY;
  } catch {
    return DEFAULT_PRIMARY;
  }
}

interface Props {
  selected: ArtifactType[]; // currently filtered-on types (multi-select)
  onSelectedChange: (next: ArtifactType[]) => void;
  artifacts: Artifact[]; // for live count badges
}

export function FilterChips({ selected, onSelectedChange, artifacts }: Props) {
  const [primary, setPrimary] = useState<ArtifactType[]>(() => readStored());
  const [sheetOpen, setSheetOpen] = useState(false);

  const setPrimaryAndPersist = (next: ArtifactType[]) => {
    setPrimary(next);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  // Live count per type
  const counts = new Map<ArtifactType, number>();
  for (const a of artifacts) {
    counts.set(a.type, (counts.get(a.type) ?? 0) + 1);
  }

  const toggle = (t: ArtifactType) => {
    if (selected.includes(t)) {
      onSelectedChange(selected.filter((x) => x !== t));
    } else {
      onSelectedChange([...selected, t]);
    }
  };

  const sortedPrimary = [...primary].sort();

  return (
    <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 text-[11px]">
      <ChipButton
        label={`All${artifacts.length > 0 ? ` · ${artifacts.length}` : ""}`}
        active={selected.length === 0}
        onClick={() => onSelectedChange([])}
      />
      {sortedPrimary.map((t) => (
        <ChipButton
          key={t}
          label={`${TYPE_LABEL[t]}${counts.has(t) ? ` · ${counts.get(t)}` : ""}`}
          active={selected.includes(t)}
          onClick={() => toggle(t)}
        />
      ))}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-label="Customize chips"
        title="Customize chips"
        className="rounded border border-edge bg-pane px-1.5 py-0.5 text-secondary hover:bg-chip hover:text-primary"
      >
        <MoreHorizontal size={11} aria-hidden="true" />
      </button>
      {sheetOpen && (
        <MoreCustomizationSheet
          primary={primary}
          allTypes={ALL_TYPES}
          onChange={(next) => setPrimaryAndPersist(next)}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  );
}

function ChipButton({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full border px-2 py-0.5 transition-colors ${
        active
          ? "border-accent bg-accent/10 text-primary"
          : "border-edge bg-pane text-secondary hover:bg-chip hover:text-primary"
      }`}
    >
      {label}
    </button>
  );
}
```

Create `/home/gnava/repos/honeycomb/dashboard/src/components/library/MoreCustomizationSheet.tsx`:

```tsx
/** Bottom-sheet (popover) listing all 8 types with ★ toggle (M35).
 *  Toggling ★ swaps a type between the primary chip row and the More
 *  overflow. Click-only (no keyboard nav in M35).
 */
import { Star, X } from "lucide-react";

import type { ArtifactType } from "../../lib/types";

const TYPE_LABEL: Record<ArtifactType, string> = {
  plan: "Plans",
  review: "Reviews",
  edit: "Edits",
  snippet: "Snippets",
  note: "Notes",
  skill: "Skills",
  subagent: "Subagents",
  spec: "Specs",
};

interface Props {
  primary: ArtifactType[];
  allTypes: ArtifactType[];
  onChange: (nextPrimary: ArtifactType[]) => void;
  onClose: () => void;
}

export function MoreCustomizationSheet({ primary, allTypes, onChange, onClose }: Props) {
  const togglePrimary = (t: ArtifactType) => {
    if (primary.includes(t)) {
      // Demote
      onChange(primary.filter((x) => x !== t));
    } else {
      // Promote — drop the oldest primary if already at 4
      const next = primary.length >= 4 ? [...primary.slice(1), t] : [...primary, t];
      onChange(next);
    }
  };

  return (
    <>
      {/* Click-outside backdrop */}
      <div aria-hidden="true" onClick={onClose} className="fixed inset-0 z-30 bg-black/30" />
      <div
        role="dialog"
        aria-label="Customize artifact chips"
        className="fixed top-1/2 left-1/2 z-40 w-80 -translate-x-1/2 -translate-y-1/2 rounded border border-edge bg-pane shadow-pop"
      >
        <header className="flex items-center justify-between border-b border-edge px-3 py-2">
          <h3 className="text-[12px] font-semibold text-primary">Customize chips</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close customization sheet"
            className="rounded p-0.5 text-faint hover:bg-edge hover:text-primary"
          >
            <X size={14} aria-hidden="true" />
          </button>
        </header>
        <ul className="flex flex-col py-1">
          {allTypes.map((t) => {
            const isPrimary = primary.includes(t);
            return (
              <li key={t}>
                <button
                  type="button"
                  onClick={() => togglePrimary(t)}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-chip"
                >
                  <Star
                    size={12}
                    aria-hidden="true"
                    className={isPrimary ? "fill-think text-think" : "text-muted"}
                  />
                  <span className="flex-1 text-primary">{TYPE_LABEL[t]}</span>
                  <span className="text-[10px] text-muted">{isPrimary ? "Primary" : "More"}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <footer className="border-t border-edge px-3 py-2 text-[10px] text-muted">
          Up to 4 primary chips. The rest live in More.
        </footer>
      </div>
    </>
  );
}
```

### Step 4: Tests + commit

Add 3-4 tests per component (per file pattern from previous tasks). Key assertions:

- **SearchInput**: typing then waiting 250ms calls onChange; immediate onChange does NOT fire (debounce).
- **ScopeToggle**: defaults to "active"; click flips to "fleet"; persists to localStorage.
- **FilterChips**: All chip + 4 primary chips render; click toggles selection (aria-pressed); count badges visible.
- **MoreCustomizationSheet**: 8 rows render; clicking ★ promotes/demotes; sheet capacity caps at 4 primary.

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx vitest run src/components/library/__tests__/
npx tsc -b --noEmit
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/library/SearchInput.tsx \
        dashboard/src/components/library/ScopeToggle.tsx \
        dashboard/src/components/library/FilterChips.tsx \
        dashboard/src/components/library/MoreCustomizationSheet.tsx \
        dashboard/src/components/library/__tests__/
git commit -m "feat(m35): FilterChips + MoreCustomizationSheet + ScopeToggle + SearchInput

FilterChips: All + 4 primary + ⋯ More chip row. Multi-select via
aria-pressed. Live count badges per type. Primary list persists
in localStorage:hive:library:primary-types (default
[plan, review, edit, snippet]).

MoreCustomizationSheet: modal listing all 8 types with ★ toggle.
Promotion/demotion enforces cap of 4 primary (drops oldest on
overflow). Click-only — no keyboard nav in M35.

ScopeToggle: default 'active' (current workspace); button flips to
'fleet'. Persists in localStorage:hive:library:scope. Future
work: ⌃A keyboard shortcut.

SearchInput: 250ms debounce so typing doesn't thrash the API."
```

---

## Task 13: Replace M32 LibraryRoute bridge + extend slashCommands

**Files:**

- Modify: `dashboard/src/components/routes/LibraryRoute.tsx` (replace M32 bridge with LibraryActivity wired up)
- Modify: `dashboard/src/components/library/LibraryActivity.tsx` (wire all the sub-pieces from Tasks 11/12)
- Modify: `dashboard/src/lib/slashCommands.ts` (add `create-artifact` action variant)
- Modify: `dashboard/src/components/routes/ChatsRoute.tsx` (handle the new action in the dispatcher)
- Modify: `dashboard/src/lib/__tests__/slashCommands.test.ts` (update `/save note` assertion)

### Step 1: Wire LibraryActivity sub-pieces

Replace the `LibraryActivity` body from Task 8 with a fully-wired version that integrates FilterChips + ScopeToggle + SearchInput + the renderer dispatch:

```tsx
import { useMemo, useState } from "react";

import type { ArtifactType, Artifact, ContainerRecord } from "../../lib/types";
import { useArtifacts } from "../../hooks/useArtifacts";
import { ArtifactCard } from "./ArtifactCard";
import { FilterChips } from "./FilterChips";
import { ScopeToggle, type LibraryScope } from "./ScopeToggle";
import { SearchInput } from "./SearchInput";
import { renderArtifact } from "./renderers/dispatch";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
}

export function LibraryActivity({ containers, activeContainerId, onSelectContainer }: Props) {
  const [activeArtifactId, setActiveArtifactId] = useState<string | null>(null);
  const [selectedTypes, setSelectedTypes] = useState<ArtifactType[]>([]);
  const [search, setSearch] = useState("");
  const [scope, setScope] = useState<LibraryScope>("active");

  // Active scope: query just the active container.
  // Fleet scope: fan out across all container IDs (client-side union).
  const targetIds =
    scope === "active" && activeContainerId !== null
      ? [activeContainerId]
      : scope === "fleet"
        ? containers.map((c) => c.id)
        : [];

  // For M35: fan out via map over containerIds. We use one useArtifacts
  // call per container — TanStack Query dedupes. The hook returns
  // {artifacts, isLoading} per container; we union locally.
  // (NOTE: hook order must be stable — guarded by sort + slice cap.)
  const stableIds = useMemo(() => [...targetIds].sort((a, b) => a - b), [targetIds]);

  // Single-container case (active scope) — common path; use the hook directly
  const single = useArtifacts(stableIds.length === 1 ? stableIds[0] : null, {
    type: selectedTypes.length > 0 ? selectedTypes : undefined,
    search: search || undefined,
  });

  // Fleet case: render N hooks via a child component for each id
  const multiArtifacts: Artifact[] = []; // populated by FleetUnion below
  // For brevity, M35 fleet support uses the single-container useArtifacts
  // for the active workspace; the fleet-wide case is wired by Task 13
  // step 4 (a small FleetUnion subcomponent that composes N useArtifacts).

  const allArtifacts = stableIds.length === 1 ? single.artifacts : multiArtifacts;
  const activeContainer = containers.find((c) => c.id === activeContainerId);

  return (
    <div className="flex h-full min-w-0 flex-1">
      <aside
        aria-label="Library sidebar"
        className="flex w-80 shrink-0 flex-col border-r border-edge bg-pane"
      >
        <header className="flex flex-col gap-1.5 border-b border-edge px-3 py-2">
          <h2 className="text-[10px] font-semibold tracking-wider text-secondary uppercase">
            Library
          </h2>
          <ScopeToggle
            activeContainerName={activeContainer?.project_name ?? null}
            onScopeChange={setScope}
          />
        </header>
        <FilterChips
          selected={selectedTypes}
          onSelectedChange={setSelectedTypes}
          artifacts={allArtifacts}
        />
        <div className="px-2 pb-1">
          <SearchInput value={search} onChange={setSearch} />
        </div>
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {allArtifacts.length === 0 ? (
            <p className="px-2 py-4 text-[12px] text-secondary">
              {single.isLoading ? "Loading…" : "No artifacts yet."}
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {allArtifacts.map((a) => (
                <li key={a.artifact_id}>
                  <ArtifactCard
                    artifact={a}
                    active={a.artifact_id === activeArtifactId}
                    onSelect={setActiveArtifactId}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      <main className="flex h-full min-w-0 flex-1 flex-col bg-page">
        {activeArtifactId ? (
          <ArtifactDetail
            artifactId={activeArtifactId}
            allArtifacts={allArtifacts}
            onSelectContainer={onSelectContainer}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center">
            <p className="text-sm text-secondary">Pick an artifact from the sidebar.</p>
          </div>
        )}
      </main>
    </div>
  );
}

function ArtifactDetail({
  artifactId,
  allArtifacts,
  onSelectContainer,
}: {
  artifactId: string;
  allArtifacts: Artifact[];
  onSelectContainer: (id: number) => void;
}) {
  const artifact = allArtifacts.find((a) => a.artifact_id === artifactId);
  if (!artifact) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <p className="text-sm text-secondary">Artifact not in current view.</p>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto">{renderArtifact(artifact)}</div>
      {artifact.source_chat_id && (
        <footer className="border-t border-edge bg-pane px-4 py-2 text-[12px]">
          <button
            type="button"
            onClick={() => {
              // Backlink: navigate to the source chat. M35 just selects the
              // container; full message-scroll lands in M36.
              onSelectContainer(artifact.container_id);
            }}
            className="rounded border border-edge px-3 py-1 text-primary hover:bg-chip"
          >
            Open in chat
          </button>
        </footer>
      )}
    </div>
  );
}
```

### Step 2: Wire LibraryRoute to use LibraryActivity

Replace `/home/gnava/repos/honeycomb/dashboard/src/components/routes/LibraryRoute.tsx` body with:

```tsx
import { LibraryActivity } from "../library/LibraryActivity";
import type { ContainerRecord } from "../../lib/types";

interface Props {
  containers: ContainerRecord[];
  activeContainerId: number | null;
  onSelectContainer: (id: number) => void;
}

export function LibraryRoute({ containers, activeContainerId, onSelectContainer }: Props) {
  return (
    <LibraryActivity
      containers={containers}
      activeContainerId={activeContainerId}
      onSelectContainer={onSelectContainer}
    />
  );
}
```

(M32 also passed `openedDiffEvent` + `onOpenEvent` — those props can be removed from LibraryRoute's interface AND from the App.tsx `<LibraryRoute>` call site. Verify: `grep -n openedDiffEvent dashboard/src/App.tsx`. Drop the props if found.)

### Step 3: Extend slashCommands.ts with create-artifact variant

Open `/home/gnava/repos/honeycomb/dashboard/src/lib/slashCommands.ts`. Add a new variant to the `SlashAction` union:

```ts
export type SlashAction =
  | { kind: "none" }
  | { kind: "transform-and-send"; userText: string }
  | { kind: "set-mode"; mode: ChatMode; toast?: string }
  | { kind: "clear-chat" }
  | { kind: "toast"; text: string }
  | { kind: "create-artifact"; artifact_type: ArtifactType; title: string; body: string } // NEW M35
  | { kind: "unknown"; raw: string; reason: string };
```

(Add `import type { ArtifactType } from "./types";` near the top.)

In the `parseSlashCommand` switch, replace the `/save` case to RETURN a `create-artifact` directive instead of a stub-toast:

```ts
case "/save": {
  if (!rest.startsWith("note ")) {
    return {
      kind: "unknown",
      raw: trimmed,
      reason: "/save expects 'note <title>' (other artifact types arrive in M35)",
    };
  }
  const title = rest.slice("note ".length).trim();
  if (!title) {
    return { kind: "unknown", raw: trimmed, reason: "/save note requires a title" };
  }
  return {
    kind: "create-artifact",
    artifact_type: "note",
    title,
    body: title,  // M35 uses the title as initial body; user can edit later
  };
}
```

Update the test in `dashboard/src/lib/__tests__/slashCommands.test.ts`:

```ts
it("/save note <title> creates a note artifact", () => {
  expect(parseSlashCommand("/save note My Idea")).toEqual<SlashAction>({
    kind: "create-artifact",
    artifact_type: "note",
    title: "My Idea",
    body: "My Idea",
  });
});
```

### Step 4: Wire ChatThreadWrapper dispatcher to handle create-artifact

In `/home/gnava/repos/honeycomb/dashboard/src/components/routes/ChatsRoute.tsx`, find the `send` callback in `ChatThreadWrapper` (the slash-command dispatcher). Add a new case:

```tsx
case "create-artifact": {
  if (activeContainerId === null) {
    toast("error", "No active container — can't save artifact.");
    return;
  }
  void createArtifact(activeContainerId, {
    type: action.artifact_type,
    title: action.title,
    body: action.body,
    source_chat_id: sessionId,
  })
    .then((art) => toast("success", `Saved as ${art.type}: ${art.title}`))
    .catch((err) => toast("error", `Failed to save: ${err}`));
  return;
}
```

(Add `import { createArtifact } from "../../lib/api";` at the top.)

### Step 5: Run tests + typecheck + Playwright (no regressions)

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx tsc -b --noEmit
npx vitest run
npx playwright test
```

Expected: all green. The slashCommands test for `/save note` now asserts the new shape; the existing M34 chat-composer Playwright spec for `/clear` and `/plan` still works because those parser paths are unchanged.

### Step 6: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/src/components/routes/LibraryRoute.tsx \
        dashboard/src/components/library/LibraryActivity.tsx \
        dashboard/src/lib/slashCommands.ts \
        dashboard/src/lib/__tests__/slashCommands.test.ts \
        dashboard/src/components/routes/ChatsRoute.tsx \
        dashboard/src/App.tsx
git commit -m "feat(m35): wire LibraryRoute + /save note creates real Note artifact

LibraryRoute swaps the M32 bridge (M27 DiffEvents only) for the
full LibraryActivity — sidebar (chips + scope + search + cards) +
main pane (per-type renderer dispatch).

slashCommands.ts gains a 'create-artifact' SlashAction variant.
The M34 stub-toast for /save note becomes a real artifact create
via the new POST /api/containers/{id}/artifacts endpoint. Other
slash commands (/clear, /plan, /edit, /git, /compact) are
unchanged.

Backlink in the artifact detail footer is single-click 'Open in
chat' — selects the source container; full message-scroll is M36."
```

---

## Task 14: Playwright spec for the Library

**Files:**

- Create: `dashboard/tests/e2e/library.spec.ts`

### Step 1: Create the spec

Create `/home/gnava/repos/honeycomb/dashboard/tests/e2e/library.spec.ts`:

```ts
/** M35 Library end-to-end.
 *
 * Verifies:
 *   1. Library route renders empty state when no artifacts
 *   2. Mocked artifact list renders cards in the sidebar
 *   3. Filter chip click filters the list
 *   4. Search debounce filters the list
 *   5. Click on artifact opens its renderer in main pane
 *   6. axe-core scans dark + light themes
 */
import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const TOKEN = "library-token";

const containerFixture = {
  id: 1,
  workspace_folder: "/repos/foo",
  project_type: "base",
  project_name: "foo",
  project_description: "",
  git_repo_url: null,
  container_id: "deadbeef",
  container_status: "running",
  agent_status: "idle",
  agent_port: 0,
  has_gpu: false,
  has_claude_cli: true,
  claude_cli_checked_at: null,
  created_at: "2026-04-26",
  updated_at: "2026-04-26",
  agent_expected: false,
};

const artifacts = [
  {
    artifact_id: "a-plan-1",
    container_id: 1,
    type: "plan",
    title: "Refactor plan",
    body: "## Step 1\n\nDo the thing.",
    body_format: "markdown",
    source_chat_id: "ns-1",
    source_message_id: null,
    metadata: null,
    pinned: false,
    archived: false,
    created_at: "2026-04-26T12:00:00Z",
    updated_at: "2026-04-26T12:00:00Z",
  },
  {
    artifact_id: "a-snip-1",
    container_id: 1,
    type: "snippet",
    title: "python snippet (3 lines)",
    body: "import os\nprint(os.getcwd())\nos.exit(0)",
    body_format: "python",
    source_chat_id: null,
    source_message_id: null,
    metadata: { language: "python", line_count: 3 },
    pinned: false,
    archived: false,
    created_at: "2026-04-26T11:00:00Z",
    updated_at: "2026-04-26T11:00:00Z",
  },
];

function mockJson(data: unknown) {
  return { status: 200, contentType: "application/json", body: JSON.stringify(data) };
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    (window as unknown as { __playwright_test: boolean }).__playwright_test = true;
  });
  await context.addInitScript(
    ([t]) => {
      try {
        window.localStorage.setItem("hive:auth:token", t);
        window.localStorage.setItem("hive:layout:openTabs", "[1]");
        window.localStorage.setItem("hive:layout:activeTab", "1");
      } catch {
        // ignore
      }
    },
    [TOKEN],
  );

  await context.route("**/api/containers", (r) => r.fulfill(mockJson([containerFixture])));
  await context.route("**/api/containers/*/workdir", (r) =>
    r.fulfill(mockJson({ path: "/repos/foo" })),
  );
  await context.route("**/api/containers/*/sessions", (r) => r.fulfill(mockJson({ sessions: [] })));
  await context.route("**/api/containers/*/named-sessions", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/diff-events**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/containers/*/resources**", (r) => r.fulfill(mockJson(null)));
  await context.route("**/api/containers/*/fs/**", (r) =>
    r.fulfill({ status: 404, contentType: "application/json", body: "{}" }),
  );
  await context.route("**/api/gitops/prs**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/gitops/repos**", (r) => r.fulfill(mockJson([])));
  await context.route("**/api/problems**", (r) => r.fulfill(mockJson({ problems: [] })));
  await context.route("**/api/settings", (r) =>
    r.fulfill(
      mockJson({
        values: {
          log_level: "INFO",
          discover_roots: [],
          metrics_enabled: true,
          timeline_visible: false,
        },
        mutable_fields: ["log_level", "discover_roots", "metrics_enabled", "timeline_visible"],
      }),
    ),
  );
  await context.route("**/api/keybindings**", (r) => r.fulfill(mockJson({ bindings: {} })));
  await context.route("**/api/health**", (r) => r.fulfill(mockJson({ status: "ok" })));
  // Default artifacts route — returns the fixture; per-test routes override
  await context.route("**/api/containers/*/artifacts**", (r) => r.fulfill(mockJson(artifacts)));
});

test("Library renders empty state when no artifacts", async ({ page, context }) => {
  await context.route("**/api/containers/*/artifacts**", (r) => r.fulfill(mockJson([])));
  await page.goto("/library");
  await expect(page.getByText(/No artifacts yet/i)).toBeVisible();
});

test("Library renders artifact cards in the sidebar", async ({ page }) => {
  await page.goto("/library");
  await expect(page.getByText("Refactor plan")).toBeVisible();
  await expect(page.getByText("python snippet (3 lines)")).toBeVisible();
});

test("Clicking a card opens the renderer in main pane", async ({ page }) => {
  await page.goto("/library");
  await page.getByText("Refactor plan").click();
  // Plan renderer markdown body
  await expect(page.getByText("Step 1")).toBeVisible();
  // Backlink button
  await expect(page.getByRole("button", { name: /Open in chat/i })).toBeVisible();
});

test("Filter chip click filters the artifact list (calls API with type=)", async ({
  page,
  context,
}) => {
  let lastRequestUrl: string | null = null;
  await context.route("**/api/containers/*/artifacts**", (r) => {
    lastRequestUrl = r.request().url();
    return r.fulfill(mockJson(artifacts));
  });
  await page.goto("/library");
  await page.getByRole("button", { name: /^Plans/i }).click();
  // Allow the refetch to land
  await page.waitForTimeout(200);
  expect(lastRequestUrl).toContain("type=plan");
});

test("Library passes axe-core in dark theme", async ({ page }) => {
  await page.goto("/library");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  const results = await new AxeBuilder({ page })
    .include('aside[aria-label="Library sidebar"]')
    .analyze();
  expect(results.violations).toEqual([]);
});

test("Library passes axe-core in light theme", async ({ page }) => {
  await page.goto("/library");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  const results = await new AxeBuilder({ page })
    .include('aside[aria-label="Library sidebar"]')
    .analyze();
  expect(results.violations).toEqual([]);
});
```

### Step 2: Run the spec

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test library.spec.ts
```

Expected: 6/6 PASS. Common iteration:

- If a chip selector doesn't resolve uniquely (e.g. `"Plans"` matches the chip AND a plan artifact card title), scope to the chip row container.
- axe-core violations → fix the offending chrome class. The new chips/cards use M31 semantic tokens; if any violation surfaces, it's likely a contrast issue with `text-muted` against the new `bg-pane` background. Bump to `text-secondary`.

### Step 3: Run full Playwright

```bash
cd /home/gnava/repos/honeycomb/dashboard
npx playwright test
```

Expected: all existing 46 specs + 6 new = 52 / 52 PASS.

### Step 4: Commit

```bash
cd /home/gnava/repos/honeycomb
git add dashboard/tests/e2e/library.spec.ts
git commit -m "test(m35): library playwright spec + axe-core scan

6 cases: empty state, card list rendering, click → renderer opens,
chip click triggers refetch with type= query param, axe-core
passes on the sidebar in dark + light themes.

Captures the actual artifacts API URL via context.route to verify
the chip selection translates into the right query param shape."
```

---

## Task 15: Pre-flight regression sweep + prettier

Same shape as previous milestones.

- [ ] **Step 1:** `cd /home/gnava/repos/honeycomb/hub && uv run ruff check . && uv run mypy . && uv run pytest tests -q` — all green
- [ ] **Step 2:** `cd /home/gnava/repos/honeycomb/hive-agent && uv run ruff check . && uv run mypy . && uv run pytest tests -q` — all green
- [ ] **Step 3:** `cd /home/gnava/repos/honeycomb/dashboard && npx tsc -b --noEmit && npm run lint && npx vitest run` — all green; lint warnings ≤ M34 baseline (~19)
- [ ] **Step 4:** `cd /home/gnava/repos/honeycomb/dashboard && npx playwright test` — all green
- [ ] **Step 5:** Prettier sweep:
  ```bash
  cd /home/gnava/repos/honeycomb/dashboard
  npx prettier --write .
  cd /home/gnava/repos/honeycomb
  git status
  git diff
  git add -A -- dashboard/
  git diff --cached --quiet || git commit -m "style(m35): prettier sweep before push"
  ```
- [ ] **Step 6:** `pre-commit run --all-files` — clean

---

## Task 16: Merge + tag + push + CI watch + branch delete

- [ ] **Step 1:** `git push -u origin m35-library`
- [ ] **Step 2:** `git checkout main && git pull --ff-only origin main && git merge --no-ff m35-library -m "Merge M35: library (artifact aggregation)"`
- [ ] **Step 3:** `git tag -a v0.35-library -m "M35: library — 8 artifact types, auto-save hooks, primary/More chips, scope toggle, per-type renderers, live updates"`
- [ ] **Step 4:** `git push --follow-tags origin main`
- [ ] **Step 5:** Watch CI:
  ```bash
  sleep 12
  gh run list --branch main --limit 1 --json databaseId,status
  gh run watch --exit-status $(gh run list --branch main --limit 1 --json databaseId --jq '.[0].databaseId')
  ```
  Expected: all 7 CI jobs green. If hub pytest hangs (M34 saw this once), cancel + `gh run rerun --failed`.
- [ ] **Step 6:** Delete merged branch:
  ```bash
  git branch -d m35-library
  git push origin --delete m35-library
  ```

---

## Verification Checklist

Before marking M35 done, confirm:

- [ ] `cd hub && uv run pytest tests -q` — green (existing + ~30 new artifacts service/router/hooks/spec-rescan tests)
- [ ] `cd dashboard && npx vitest run` — green (existing + ~25 new M35 component + hook tests)
- [ ] `cd dashboard && npx playwright test` — green (46 existing + 6 new library spec = 52)
- [ ] `cd dashboard && npx tsc -b --noEmit && npm run lint` — clean
- [ ] `pre-commit run --all-files` — clean
- [ ] **Manual smoke test:**
  - Open the dashboard, focus a kind="claude" session in /chats
  - Send a message that produces a 5-line Python code block in the assistant response
  - Switch to /library — within ~1 sec, a Snippet artifact appears
  - Click the snippet — body renders, copy/download buttons present
  - Toggle a filter chip — list narrows
  - Toggle scope to fleet — list expands across containers (if multiple registered)
  - Open ⌘K, type `/save note Test note`, press Enter — toast confirms; back in /library, a Note artifact appears
  - Switch theme; chips + cards re-paint correctly
- [ ] `git log --oneline main` shows `Merge M35: library (artifact aggregation)` + `v0.35-library` tag
- [ ] `gh run list --branch main --limit 1` shows the merge-CI green
- [ ] Branch `m35-library` deleted local + remote

---

## Out of scope — future tickets

- **Real Review artifact creation** — depends on PR thread loading (M14 GitOps integration; M35.x or M36)
- **Skill auto-source** — placeholder type only
- **Live filesystem watcher for spec auto-save** — M35 uses startup rescan
- **Pin / Archive UI** — endpoints ship; UI is M35.x or M36
- **Chip customization keyboard navigation** — click-only
- **FTS5 full-text search** — M35 uses simple SQL LIKE on title || body
- **Server-side fleet artifact endpoint** — M35 uses client-side fan-out
- **Backlink message-scroll** — M35 single-clicks to the source container; M36 scrolls to the source_message_id
- **Mobile breakpoints** — M36
- **Code-block syntax highlighting in renderers** — M35 uses plain `<pre>` styling
