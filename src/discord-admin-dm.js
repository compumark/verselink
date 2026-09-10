const DISCORD_API = "https://discord.com/api/v10";

const configured = value => String(value || "").trim();

export function buildRegistrationDm({ displayName, userId, environment, registeredAt }) {
  return ["**New VerseLink Registration**", "", `User: ${String(displayName || "Unknown").trim() || "Unknown"}`, `User ID: ${String(userId || "unknown")}`, `Environment: ${String(environment || "unknown")}`, `Registered: ${String(registeredAt || new Date().toISOString())}`].join("\n");
}

export function createDiscordAdminNotifier({ botToken, adminUserId, environment, fetchImpl = fetch, logger = console }) {
  const token = configured(botToken);
  const recipientId = configured(adminUserId);
  if (!token || !recipientId) {
    if (token || recipientId) logger.log("[discord] registration DM skipped; configuration incomplete");
    return async () => false;
  }
  const request = async (path, body) => {
    const response = await fetchImpl(`${DISCORD_API}${path}`, { method: "POST", headers: { authorization: `Bot ${token}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Discord HTTP ${response.status}`);
    return response.json();
  };
  return async ({ displayName, userId, registeredAt }) => {
    try {
      const dm = await request("/users/@me/channels", { recipient_id: recipientId });
      if (!dm || typeof dm.id !== "string" || !dm.id) throw new Error("Discord returned an invalid DM channel");
      await request(`/channels/${dm.id}/messages`, { content: buildRegistrationDm({ displayName, userId, environment, registeredAt }), allowed_mentions: { parse: [] } });
      logger.log("[discord] registration DM sent");
      return true;
    } catch {
      // Transport error text can contain request details, so never log it here.
      logger.warn("[discord] registration DM failed");
      return false;
    }
  };
}
