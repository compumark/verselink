import { parseVersekitConfig } from "./config.js";
import { createVersekitRouter } from "./router.js";

// No OAuth or data handlers exist in VK-02. Environment variables cannot enable scopes.
const operationalScopes = Object.freeze([]);

export const createVersekitAdapter = async ({ env, db }) => {
  const config = parseVersekitConfig(env);
  if (!config) return null;
  let result;
  try { result = await db.query("SELECT id, name FROM blueprint_groups WHERE id = $1", [config.groupId]); }
  catch { throw new Error("VERSEKIT_GROUP_ID lookup failed"); }
  const group = result.rows[0];
  if (!group) throw new Error("VERSEKIT_GROUP_ID does not identify an existing group");
  if (typeof group.name !== "string" || !group.name.trim() || group.name.length > 80) {
    throw new Error("VERSEKIT_GROUP_ID group name must contain 1–80 characters");
  }
  // The context is immutable and never derived from a request.
  const context = Object.freeze({ ...config, groupName: group.name.trim() });
  if (operationalScopes.length !== 0) throw new Error("VK-02 cannot advertise operational scopes");
  return createVersekitRouter({ context });
};
