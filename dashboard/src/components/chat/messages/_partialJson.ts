/** Defensive JSON.parse for tool_use partial inputs. Returns the
 *  parsed object on success, or null while the JSON is still
 *  incomplete. Don't throw — partial JSON is the streaming norm. */
export function tryParse(s: string): Record<string, unknown> | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
