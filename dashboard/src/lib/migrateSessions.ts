/** One-shot migration of localStorage session state to the hub (M26).
 *
 * The pre-M26 dashboard stored session names under
 * ``hive:layout:sessions`` (Record<containerId, SessionInfo[]>). This
 * function POSTs every entry to ``/api/containers/{id}/named-sessions``,
 * captures the oldId→newId map, rewrites dependent keys, wipes PTY
 * sessionStorage labels (users get fresh terminals — accepted
 * trade-off), and sets a guard key so re-runs no-op.
 *
 * Idempotency: the guard key (``hive:layout:sessionsMigratedAt``) is
 * set ONLY after a full pass. A mid-run auth failure leaves
 * localStorage untouched; the next run retries from scratch.
 * Partial failure (e.g., half the POSTs succeed before a 401) could
 * produce duplicate rows on retry — acceptable given the rarity
 * of mid-migration auth failure in a single-user local tool.
 */

import { createNamedSession } from "./api";
import type { NamedSessionCreate, SessionKind } from "./types";

const LS_SOURCE = "hive:layout:sessions";
const LS_ACTIVE = "hive:layout:activeSession";
const LS_GUARD = "hive:layout:sessionsMigratedAt";
const LS_KIND_PREFIX = "hive:terminal-last-kind:";
const SS_PTY_PREFIX = "hive:pty:label:";

export interface MigrationSkip {
  containerId: string;
  oldId: string;
  reason: string;
}

export interface MigrationResult {
  migrated: number;
  skipped: MigrationSkip[];
}

interface LegacySession {
  id: string;
  name: string;
}

function readJson<T>(key: string): T | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function readKind(containerId: string, oldId: string): SessionKind {
  const raw = localStorage.getItem(`${LS_KIND_PREFIX}${containerId}:${oldId}`);
  return raw === "claude" ? "claude" : "shell";
}

function moveKind(containerId: string, oldId: string, newId: string): void {
  const key = `${LS_KIND_PREFIX}${containerId}:${oldId}`;
  const value = localStorage.getItem(key);
  if (value !== null) {
    localStorage.setItem(`${LS_KIND_PREFIX}${containerId}:${newId}`, value);
    localStorage.removeItem(key);
  }
}

function wipePtyLabel(containerId: string, oldId: string): void {
  sessionStorage.removeItem(`${SS_PTY_PREFIX}${containerId}:${oldId}`);
}

export async function runSessionMigration(): Promise<MigrationResult> {
  // Idempotency guard — set once per successful migration.
  if (localStorage.getItem(LS_GUARD) !== null) {
    return { migrated: 0, skipped: [] };
  }

  const legacy = readJson<Record<string, LegacySession[]>>(LS_SOURCE);
  if (!legacy || Object.keys(legacy).length === 0) {
    localStorage.setItem(LS_GUARD, new Date().toISOString());
    return { migrated: 0, skipped: [] };
  }

  const active = readJson<Record<string, string>>(LS_ACTIVE) ?? {};
  const idMap: Record<string, Record<string, string>> = {}; // containerId → {oldId: newId}
  const skipped: MigrationSkip[] = [];
  let migrated = 0;

  for (const [containerIdStr, sessions] of Object.entries(legacy)) {
    const containerId = Number(containerIdStr);
    if (!Number.isFinite(containerId)) continue;
    idMap[containerIdStr] = {};
    for (const entry of sessions) {
      const kind = readKind(containerIdStr, entry.id);
      const body: NamedSessionCreate = { name: entry.name, kind };
      try {
        const row = await createNamedSession(containerId, body);
        idMap[containerIdStr][entry.id] = row.session_id;
        migrated += 1;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err ?? "unknown");
        skipped.push({
          containerId: containerIdStr,
          oldId: entry.id,
          reason,
        });
      }
    }
  }

  // Rewrite hive:layout:activeSession: map old → new; drop unmapped.
  const nextActive: Record<string, string> = {};
  for (const [containerIdStr, oldId] of Object.entries(active)) {
    const newId = idMap[containerIdStr]?.[oldId];
    if (newId) nextActive[containerIdStr] = newId;
  }
  localStorage.setItem(LS_ACTIVE, JSON.stringify(nextActive));

  // Move terminal-last-kind keys to the new ids; wipe pty-label SS.
  for (const [containerIdStr, map] of Object.entries(idMap)) {
    for (const [oldId, newId] of Object.entries(map)) {
      moveKind(containerIdStr, oldId, newId);
      wipePtyLabel(containerIdStr, oldId);
    }
  }

  localStorage.removeItem(LS_SOURCE);
  localStorage.setItem(LS_GUARD, new Date().toISOString());

  return { migrated, skipped };
}
