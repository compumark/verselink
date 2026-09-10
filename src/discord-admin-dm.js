const DISCORD_API = "https://discord.com/api/v10";
const UTC_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const configured = value => String(value || "").trim();

export function formatRegistrationTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("invalid registration timestamp");
  const twoDigits = number => String(number).padStart(2, "0");
  return `${twoDigits(date.getUTCDate())}.${UTC_MONTHS[date.getUTCMonth()]}.${date.getUTCFullYear()}, ${twoDigits(date.getUTCHours())}:${twoDigits(date.getUTCMinutes())} UTC`;
}

export function buildRegistrationDm({ displayName, userId, environment, registeredAt }) {
  return ["**New VerseLink Registration**", "", `User: ${String(displayName || "Unknown").trim() || "Unknown"}`, `User ID: ${String(userId || "unknown")}`, `Environment: ${String(environment || "unknown")}`, `Registered: ${formatRegistrationTimestamp(registeredAt || new Date())}`].join("\n");
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
