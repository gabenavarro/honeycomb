# Honeycomb v0.36.0 — Release Notes

**Date:** 2026-04-26
**Headline tag:** `v0.36-mobile`
**Arc:** M31 → M36 (six milestones, the dashboard redesign)
**Predecessor release:** [v0.1.0](RELEASE_NOTES_v0.1.0.md) (2026-04-17)

The dashboard redesign arc is complete. v0.1.0 shipped the orchestrator
itself; v0.36.0 ships the daily-driver UX on top of it — semantic theme
tokens, URL routing, a chat surface that mirrors Claude Code's visual
grammar, a composer with effort + model + slash commands, the Library
of auto-saved artifacts, and mobile + tablet layouts.

> Local-only by default. The hub still binds to `127.0.0.1`, every
> endpoint still requires the bearer token, the [SECURITY.md](../SECURITY.md)
> threat model is unchanged. The redesign is purely UX — no auth model
> changes, no new external dependencies on the backend.

---

## Highlights

- **Theme system, both ways.** Warm Workshop light theme (cream + terracotta) joins the existing dark. ⌘K commands switch instantly; preference persists per-user; `prefers-color-scheme` honored as the default.
- **URL is the route.** BrowserRouter + four top-level routes (`/chats`, `/library`, `/files`, `/scm`). Activity bar rebuilt; the leftmost rail emits routes, not state. WorkspacePill in every header. Global keyboard shortcuts (⌘1–4) navigate.
- **Chat surface that looks like Claude Code.** 10 message-type renderers (user, assistant text, thinking, Edit, Write, Read, Task, Todo, Generic tool, custom), per-tool color identity, hover-revealed action bar (Retry / Fork / Copy / Edit), mode toggle (Code / Review / Plan), live streaming via `claude --output-format stream-json`.
- **Composer with depth.** Effort levels (Quick / Standard / Deep / Max), model picker, edit-auto toggle, 8 slash commands (`/clear`, `/plan`, `/review`, `/code`, `/edit-auto`, `/save`, `/effort`, `/model`), attachment chips, slash-command autocomplete dropdown.
- **Library of artifacts.** 8 artifact types (Plan / Review / Edit / Snippet / Note / Skill / Subagent / Spec) auto-saved from the chat stream; primary/More chip filter with per-user customization persisted to localStorage; scope toggle (active / fleet); per-type renderers; live updates over `library:<container_id>` WebSocket; `/save note` slash command creates real artifacts.
- **Mobile is a real product.** Phone bottom tab bar replaces the activity rail at < 768px; ChatComposer mode + effort collapse to chips that open bottom sheets; Library chip row becomes horizontal-scroll; full-screen sheet on phone; DiffViewer forces unified mode; PtyPane listens to `visualViewport` for the iOS keyboard. 44 × 44 minimum touch targets across the new surfaces. axe-core green at 3 viewports × 2 themes.

---

## What shipped, milestone by milestone

| Milestone | Theme                                                                                                                                                                                                                   | Tag                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| M31       | Design system foundation — `@theme` color tokens, ThemeProvider, Appearance UI, ⌘K theme commands                                                                                                                       | `v0.31-design-system-foundation` |
| M32       | Layout shell — BrowserRouter + four routes + ActivityBar rebuild + WorkspacePill + chrome token migration + global route shortcuts                                                                                      | `v0.32-layout-shell`             |
| M33       | Chat surface — `claude --output-format stream-json` + ChatThread / ChatHeader / ChatTabStrip / ChatStream / ChatComposer + 10 message renderers + hover actions + mode toggle + per-tool color identity                 | `v0.33-chat-surface`             |
| M34       | Composer — effort + model + mode + edit-auto wired through to subprocess args; 8 slash commands; attachment chips; axe-core green                                                                                       | `v0.34-composer`                 |
| M35       | Library — 8 artifact types, auto-save hooks, primary/More chips, scope toggle, per-type renderers, live updates                                                                                                         | `v0.35-library`                  |
| M36       | Mobile + responsive breakpoints — phone bottom-tab-bar, tablet drawer (component), sheets, long-press hook, 44 px tap targets, responsive Library / ChatComposer / PTY / Diff, axe-core green at 3 viewports × 2 themes | `v0.36-mobile`                   |

Each milestone shipped to `main` via `--no-ff` merge with a per-task TDD commit history; the merge commits are stable and bisectable.

---

## What changed since v0.1.0

### Frontend

- **Tailwind v4** with `@theme` directive in `dashboard/src/index.css` — a single source of truth for color tokens, breakpoint thresholds (`tablet: 768px`, `desktop: 1024px`), and custom variants (`@custom-variant hover (&:hover) (@media (hover: hover))`). No `tailwind.config.ts` file.
- **React Router v7** (`BrowserRouter` + `<Routes>` + `<Route path="…" />`). `App.tsx` is the shell; route components own their primary sidebars.
- **New top-level surfaces:** `/chats` (M33), `/library` (M35). The legacy `/files` and `/scm` routes were rebuilt under the M32 router.
- **New activity bar** (M32) with route-emitting buttons + container badges + PR/problem badges.
- **WorkspacePill** in every header (M32). Switches workspaces from anywhere.
- **`useArtifacts`, `useChatStream`, `useMediaQuery`, `useLongPress`, `useLocalStorage` hooks** — reactive subscriptions with proper cleanup, SSR-safe defaults, optimistic mutations where appropriate.
- **`Sheet` primitive** (M36) — hand-rolled bottom-sheet. Used by `ModeToggleSheet`, `EffortPickerSheet`, `MessageActionSheet`, and the phone variant of `MoreCustomizationSheet`.
- **`PhoneTabBar`** (M36) — bottom 5-tab nav at phone breakpoint.
- **`PhoneChatList`, `PhoneChatDetail`, `TabletSidebarDrawer`** — components shipped in M36; ChatsRoute integration deferred to M36.x (see deferrals below).
- **react-markdown + remark-gfm** added in M35 for the Library's per-type markdown renderers.

### Backend

- **`artifacts` table + service + router + chat-stream auto-save hooks** (M35). Edit-type artifacts are synthesized at read-time from the M27 `diff_events` table — no duplicate storage. WebSocket broadcast on `library:<container_id>` for create/update/delete.
- **`record_artifact / get_artifact / list_artifacts` service helpers** with `_synthesize_edit_from_diff_event` for the read-time union.
- **Spec auto-save** — startup rescan of `docs/superpowers/specs/*.md`, idempotent via `metadata.file_path` lookup.
- **Chat-stream parser hooks** — Plan (mode-flip-out-of-plan), Snippet (3-line fenced code blocks), Subagent (Task tool_use_end), Note (`> NOTE:` markers).
- **No backend changes in M36** — mobile is purely a frontend rendering concern.

### Tests

- **Vitest:** **390** (was 154 at v0.1.0 — +236 over the redesign arc).
- **Playwright:** **76** (51 baseline carried from v0.1.0 + 13 mobile/tablet/library E2E + 12 axe-core scans across 3 viewports × 2 themes × 2 routes).
- **pytest (hub):** **484** (was ~447 at v0.1.0 — +37 from the M35 artifacts service / router / hooks / spec rescan).
- **pytest (hive-agent):** **20** (unchanged).
- **axe-core:** the M36 sweep caught 5 real a11y violations and they were fixed at source (PhoneTabBar contrast, SessionSubTabs `aria-required-children`, TerminalPane purple/green contrast, PtyPane gray contrast, LibraryActivity phone landmark).

### Tooling

- `npx tsc -b --noEmit` (composite mode) is the canonical typecheck; CI uses it.
- `dashboard/src/test-setup.ts` ships a global `matchMedia` desktop-default stub so existing M0–M35 tests render the desktop branch (M36 follow-up). Per-test mocks via `Object.defineProperty(window, "matchMedia", ...)` still win.
- The pre-commit prettier hook is older than CI's; the documented workaround is `npx prettier --write .` in `dashboard/` before pushing any dashboard-touching milestone (per `prettier_hook_vs_ci` user memory).

---

## Upgrading from v0.1.0

The redesign is internal to `dashboard/` (M31–M34, M36) plus additive tables / routes on the hub (M35). Existing settings, container records, named sessions, diff events, scrollback files, gitops state — all preserved.

1. `git pull` to land the v0.36.0 tag.
2. `cd hub && uv sync` (no migrations to run; the M35 artifacts table migration applies on first boot).
3. `cd dashboard && npm ci`.
4. Restart the hub + dashboard.

If you had the dashboard open: hard-refresh (or close and reopen) so the new `index.html` viewport meta + `manifest.webmanifest` link load. Vite HMR doesn't catch HTML changes.

There's no breaking auth change, no schema rewrite, no config change. Existing `~/.config/honeycomb/token` keeps working. Existing `localStorage` keys (auth token, layout state, named sessions, scope, primary chip types) are forward-compatible — the M36 work added new keys but didn't rename any.

---

## Deferred to M36.x

The M36 plan acknowledged that some spec items required per-route refactoring or had genuinely complex consumer-site wiring; rather than balloon M36, those items shipped as standalone components / hooks with the integration deferred. Each is tracked here so a follow-up M36.x can pick them up cleanly.

### Chat — phone shell integration

- **What's shipped:** `PhoneChatList.tsx`, `PhoneChatDetail.tsx`, `MessageActionSheet.tsx`, `useLongPress.ts`. All have unit tests; all render correctly when used.
- **What's missing:** `ChatsRoute.tsx` does not branch on `useIsPhone()` to swap between PhoneChatList ↔ PhoneChatDetail. At phone today, ChatsRoute renders the desktop-shaped two-column layout (with `overflow-x-hidden` applied in M36 T15 to suppress horizontal scroll). The PhoneTabBar is visible at the bottom.
- **Why deferred:** ChatsRoute is 401 lines and wires ContainerList sidebar + `ChatThreadWrapper` (which owns the chat-stream hook + send handler) + the shell-session path with WorkspacePill + Breadcrumbs + SessionSubTabs + SessionSplitArea + FileViewer + DiffViewerTab. Cleanly extracting `ChatThreadWrapper` so PhoneChatDetail can host it is M36.x-scale work.
- **Suggested next-step:** lift `ChatThreadWrapper` to its own file, give it a stable prop interface (sessionId + onClose + …), and let both ChatsRoute and PhoneChatDetail consume it. Then add the `useIsPhone()` branch in ChatsRoute.

### Tablet — sidebar drawer wiring

- **What's shipped:** `TabletSidebarDrawer.tsx` with backdrop click + Escape close + `role="dialog"` + `aria-label`.
- **What's missing:** No route consumes it yet. Each route owns its own primary sidebar post-M32 (ContainerList in ChatsRoute, file tree in FilesRoute, etc.), so the wrap-with-drawer pattern is per-route.
- **Why deferred:** Touching ChatsRoute, LibraryRoute, FilesRoute, GitOpsRoute, ProblemsRoute, SettingsRoute is too much scope creep for a single milestone.
- **Suggested next-step:** add a `<TabletSidebarDrawer open={drawerOpen} onClose={…}>{sidebarContent}</TabletSidebarDrawer>` wrapper to each route's primary sidebar gated on `useIsTablet()`, plus a hamburger button in each route's header.

### Long-press → action sheet consumer wiring

- **What's shipped:** `MessageActionSheet.tsx` + `useLongPress.ts` (500 ms default; `touchMove` cancels). Both have unit tests.
- **What's missing:** `MessageActions.tsx` (the M33 hover bar) doesn't yet dispatch long-press. The MessageBubble equivalents (MessageUser.tsx, MessageAssistantText.tsx, …) don't yet host the sheet.
- **Suggested next-step:** add a `useLongPress(() => setActionSheetOpen(true))` to each Message\* component that hosts the hover bar, conditionally render `<MessageActionSheet>` at phone via `useIsPhone()`.

### Edit-auto toggle ⋯ overflow menu

- **What's shipped:** ChatComposer hides `EditAutoToggle` at phone (M36 T8).
- **What's missing:** Spec called for moving it into a `⋯` overflow menu in the chat detail header. The overflow-menu component itself wasn't built.
- **Suggested next-step:** when the PhoneChatDetail integration above lands, add a small `<MoreActionsMenu>` to its header that hosts edit-auto + future per-detail actions.

### Workspace pill — tap-to-reveal CPU/MEM on phone

- **What's shipped:** PhoneChatList renders the workspace pill (project name + accent dot).
- **What's missing:** Spec called for the resource readout (CPU/MEM/GPU) to move behind a tap-on-pill reveal at phone. The readout component currently only renders in the desktop sidebar.
- **Suggested next-step:** lift `<ResourceMonitor>` into a small `<ResourceSheet>` triggered by tapping the pill at phone.

### Swipe-left chat-list actions

- **What's shipped:** PhoneChatList renders the row list.
- **What's missing:** Spec called for swipe-left → archive / delete on each row. M36 didn't add gesture support (the broader "no mobile-specific gestures" deferral in the M36 plan).
- **Suggested next-step:** a `useSwipeLeft` hook (similar shape to `useLongPress`) consumed by each row.

### Voice-to-text mic input

- Explicitly cut on phone per the spec. No follow-up planned unless a user requests it.

---

## Out of scope (still)

The following items remain out of scope per the original M36 plan; they are listed here only to prevent them from being filed against M36.x:

- PWA install prompts / service worker (manifest is sane, but no install affordance, no offline cache).
- Visual regression snapshots (Percy / Chromatic).
- VoiceOver / TalkBack accessibility audit beyond axe-core.
- Bottom-sheet animations (current sheets use simple CSS transitions; no spring physics).
- Tablet-specific dual-column layouts beyond what stacking gives us.
- Android-specific Playwright cases (Chromium is the only Playwright browser the project runs).

---

## Acknowledgements

The redesign arc was specified in
[`docs/superpowers/specs/2026-04-26-dashboard-redesign-design.md`](superpowers/specs/2026-04-26-dashboard-redesign-design.md)
and executed via per-milestone implementation plans under
[`docs/superpowers/plans/`](superpowers/plans/). Each milestone followed
the same workflow: small TDD commits → per-task spec-compliance review →
per-task code-quality review → `--no-ff` merge to `main` → annotated
tag → CI watch → branch delete.

Total per-milestone counts (across M31–M36):

- ~110 task commits
- ~236 new vitest cases
- ~25 new Playwright tests
- ~37 new pytest cases
- 5 source-level a11y fixes caught by axe-core during the M36 sweep
- Zero regressions to the v0.1.0 backend baselines

The next ticket on the board is M36.x — the per-route deferrals above. After that, the redesign arc is genuinely closed.
