import fs from "node:fs/promises";

const DISCORD_API = "https://discord.com/api/v10";
const MAX_THREAD_NAME = 100;
const MAX_MESSAGE = 2000;
const EXCLUDED_FORM_SECTIONS = new Set(["steps to reproduce", "expected behavior", "actual behavior", "additional context"]);

export function normalizeLabel(value) { return String(value || "").trim().toLowerCase(); }
export function chooseType(labels) {
  const names = new Set(labels.map(label => normalizeLabel(typeof label === "string" ? label : label.name)));
  if (names.has("bug")) return "bug";
  if (["idea", "enhancement", "feature"].some(name => names.has(name))) return "idea";
  return "issue";
}
export function issueStatus(issue) {
  if (issue.state === "closed") return issue.state_reason === "not_planned" ? "Not Implemented" : "Completed";
  return issue.labels && issue.labels.some(label => ["in progress", "status: in progress", "status/in progress"].includes(normalizeLabel(label.name || label))) ? "In Progress" : "Open";
}
export function truncateTitle(number, title) {
  const prefix = `[#${number}] `;
  return `${prefix}${String(title || "Untitled").trim()}`.slice(0, MAX_THREAD_NAME).trim();
}
export function sanitizeDiscordText(value) {
  return String(value || "").replace(/@(everyone|here)\b/gi, "@\u200b$1").replace(/<@&?(\d+)>/g, "@$1").replace(/<@!(\d+)>/g, "@$1");
}
export function parseIssueFormSections(body) {
  const source = String(body || "");
  const headings = [...source.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)];
  return headings.map((match, index) => ({
    name: normalizeLabel(match[1]),
    content: source.slice(match.index + match[0].length, headings[index + 1]?.index ?? source.length).trim()
  }));
}
export function isEmptyLogResponse(value) {
  const lines = String(value || "").split(/\r?\n/).map(line => line.trim().toLowerCase()).filter(Boolean);
  return !lines.length || lines.every(line => ["no response", "n/a", "none", "-"].includes(line));
}
export function buildIssueSummary(body) {
  const source = String(body || "").trim();
  const sections = parseIssueFormSections(source);
  const description = sections.find(section => section.name === "description")?.content;
  const fallback = sections.length ? sections.find(section => !EXCLUDED_FORM_SECTIONS.has(section.name) && section.name !== "logs / error messages")?.content : source;
  const summary = String(description || fallback || "_No description provided._").trim();
  const logs = sections.find(section => section.name === "logs / error messages")?.content;
  const compactLogs = isEmptyLogResponse(logs) ? "" : String(logs).replace(/\s+/g, " ").trim();
  return {
    summary: summary.length > 600 ? `${summary.slice(0, 599).trimEnd()}…` : summary,
    error: compactLogs ? (compactLogs.length > 200 ? `${compactLogs.slice(0, 200).trimEnd()}… Full logs on GitHub.` : compactLogs) : ""
  };
}
export function buildMessage(issue, type = chooseType(issue.labels || [])) {
  const status = issueStatus(issue);
  const title = String(issue.title || "Untitled").trim().slice(0, 500);
  const heading = `**GitHub ${type[0].toUpperCase()}${type.slice(1)} #${issue.number}**\n\n### ${sanitizeDiscordText(title)}`;
  const footer = `\n\n🔗 **GitHub Issue**\n${issue.html_url}\n\n_GitHub is the source of truth for status and issue tracking._`;
  const author = `\n\n**Author:** ${sanitizeDiscordText(issue.user?.login || "unknown")}\n**Status:** ${status}\n\n`;
  const { summary, error } = buildIssueSummary(issue.body);
  const body = `${sanitizeDiscordText(summary)}${error ? `\n\n**Error**\n${sanitizeDiscordText(error)}` : ""}`;
  return `${heading}${author}${body}${footer}`.slice(0, MAX_MESSAGE);
}
export function desiredTagNames(issue) {
  const result = [chooseType(issue.labels || [])];
  if (issue.state === "closed") result.push(issue.state_reason === "not_planned" ? "not implemented" : "completed");
  else if (issueStatus(issue) === "In Progress") result.push("in progress");
  return result;
}
export function mergeAppliedTags(existingIds, availableTags, desiredNames) {
  const managedNames = new Set(["bug", "issue", "idea", "in progress", "completed", "not implemented"]);
  const namesById = new Map(availableTags.map(tag => [tag.id, normalizeLabel(tag.name)]));
  const idsByName = new Map(availableTags.map(tag => [normalizeLabel(tag.name), tag.id]));
  const preserved = existingIds.filter(id => !managedNames.has(namesById.get(id)));
  const desired = desiredNames.map(name => idsByName.get(name)).filter(Boolean);
  return [...new Set([...preserved, ...desired])].slice(0, 5);
}

function log(message) { console.log(`[discord-issues] ${message}`); }
function required(name) { if (!process.env[name]) throw new Error(`${name} is not configured.`); return process.env[name]; }
async function responseJson(response) { const text = await response.text(); let json; try { json = text ? JSON.parse(text) : null; } catch { json = text; } return json; }
async function discord(path, options = {}, retried = false) {
  const token = required("DISCORD_BOT_TOKEN");
  const response = await fetch(`${DISCORD_API}${path}`, { ...options, headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json", ...(options.headers || {}) } });
  if (response.status === 429 && !retried) { const body = await responseJson(response); const wait = Math.ceil(Number(body?.retry_after || 1) * 1000); log(`Rate limited; retrying in ${wait}ms.`); await new Promise(resolve => setTimeout(resolve, wait)); return discord(path, options, true); }
  const body = await responseJson(response);
  if (!response.ok) throw new Error(`Discord ${options.method || "GET"} ${path} failed (${response.status}): ${typeof body === "string" ? body.slice(0, 200) : body?.message || "unknown error"}`);
  return body;
}
async function tagsForForum(channelId, issue, discordRequest) {
  const forum = await discordRequest(`/channels/${channelId}`);
  if (forum.type !== 15) throw new Error("DISCORD_FORUM_CHANNEL_ID does not refer to a Discord forum channel.");
  const available = new Map((forum.available_tags || []).map(tag => [normalizeLabel(tag.name), tag.id]));
  const ids = [];
  for (const name of desiredTagNames(issue)) { const id = available.get(name); if (id) ids.push(id); else log(`Warning: Discord forum tag '${name}' was not found.`); }
  return { forum, availableTags: forum.available_tags || [], tagIds: [...new Set(ids)].slice(0, 5) };
}
async function findForumThread(forumChannelId, issueNumber, discordRequest) {
  const prefix = `[#${issueNumber}] `;
  const find = threads => {
    const matches = (threads || []).filter(thread => String(thread.name || "").startsWith(prefix));
    if (matches.length > 1) throw new Error(`Multiple Discord forum posts found for issue #${issueNumber}; refusing to choose one.`);
    return matches[0] || null;
  };
  const active = await discordRequest(`/channels/${forumChannelId}/threads/active`);
  const activeMatch = find(active.threads);
  if (activeMatch) return activeMatch;
  let before = "";
  do {
    const query = new URLSearchParams({ limit: "100" });
    if (before) query.set("before", before);
    const archived = await discordRequest(`/channels/${forumChannelId}/threads/archived/public?${query}`);
    const archivedMatch = find(archived.threads);
    if (archivedMatch) return archivedMatch;
    before = archived.has_more ? (archived.threads || []).at(-1)?.thread_metadata?.archive_timestamp || "" : "";
  } while (before);
  return null;
}
export async function synchronizeIssue({ issue, forumChannelId, discordRequest = discord }) {
  const { forum, availableTags, tagIds } = await tagsForForum(forumChannelId, issue, discordRequest);
  const thread = await findForumThread(forum.id, issue.number, discordRequest);
  if (!thread) {
    const created = await discordRequest(`/channels/${forum.id}/threads`, { method: "POST", body: JSON.stringify({ name: truncateTitle(issue.number, issue.title), applied_tags: tagIds, message: { content: buildMessage(issue), allowed_mentions: { parse: [] } } }) });
    log(`Created forum post ${created.id} for issue #${issue.number}.`);
    return { action: "created", threadId: created.id };
  }
  const appliedTags = mergeAppliedTags(thread.applied_tags || [], availableTags, desiredTagNames(issue));
  await discordRequest(`/channels/${thread.id}`, { method: "PATCH", body: JSON.stringify({ name: truncateTitle(issue.number, issue.title), applied_tags: appliedTags }) });
  // A forum post's initial message shares the thread ID (Discord thread API).
  try { await discordRequest(`/channels/${thread.id}/messages/${thread.id}`, { method: "PATCH", body: JSON.stringify({ content: buildMessage(issue), allowed_mentions: { parse: [] } }) }); }
  catch (error) { log(`Warning: could not update starter message for thread ${thread.id}: ${error.message}`); }
  log(`Updated forum post ${thread.id} for issue #${issue.number}.`);
  return { action: "updated", threadId: thread.id };
}
async function run() {
  const forumChannelId = required("DISCORD_FORUM_CHANNEL_ID");
  const payload = JSON.parse(await fs.readFile(required("GITHUB_EVENT_PATH"), "utf8"));
  if (!payload.issue) throw new Error("Workflow payload does not contain an issue.");
  await synchronizeIssue({ issue: payload.issue, forumChannelId });
}

if (process.argv[1] && new URL(`file:${process.argv[1]}`).href === import.meta.url) run().catch(error => { console.error(`[discord-issues] ${error.message}`); process.exitCode = 1; });
