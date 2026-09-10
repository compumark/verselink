import fs from "node:fs/promises";

const DISCORD_API = "https://discord.com/api/v10";
const MARKER = /<!--\s*verselink-discord-thread:(\d+)\s*-->/;
const MAX_THREAD_NAME = 100;
const MAX_MESSAGE = 2000;

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
export function parseThreadMarker(body) { return MARKER.exec(String(body || ""))?.[1] || null; }
export function buildMessage(issue, type = chooseType(issue.labels || [])) {
  const status = issueStatus(issue);
  const heading = `**GitHub ${type[0].toUpperCase()}${type.slice(1)} #${issue.number}**\n\n### ${sanitizeDiscordText(issue.title)}`;
  const footer = `\n\n🔗 **GitHub Issue**\n${issue.html_url}\n\n_GitHub is the source of truth for status and issue tracking._`;
  const author = `\n\n**Author:** ${sanitizeDiscordText(issue.user?.login || "unknown")}\n**Status:** ${status}\n\n`;
  const rawBody = sanitizeDiscordText(issue.body || "_No description provided._").trim();
  const budget = MAX_MESSAGE - heading.length - author.length - footer.length;
  const body = rawBody.length > budget ? `${rawBody.slice(0, Math.max(0, budget - 39)).trimEnd()}\n\nFull description available on GitHub.` : rawBody;
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
async function github(path, options = {}) {
  const token = required("GITHUB_TOKEN");
  const response = await fetch(`https://api.github.com${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...(options.headers || {}) } });
  const body = await responseJson(response);
  if (!response.ok) throw new Error(`GitHub ${options.method || "GET"} ${path} failed (${response.status}): ${body?.message || "unknown error"}`);
  return body;
}
async function findMapping(ownerRepo, issueNumber, githubRequest) {
  const comments = await githubRequest(`/repos/${ownerRepo}/issues/${issueNumber}/comments?per_page=100`);
  if (comments.some(comment => String(comment.body || "").includes("verselink-discord-thread:") && !parseThreadMarker(comment.body))) {
    throw new Error("Malformed Discord mapping comment found; refusing to create a duplicate post.");
  }
  const matches = comments.map(comment => ({ comment, id: parseThreadMarker(comment.body) })).filter(item => item.id);
  if (matches.length > 1) throw new Error("Multiple Discord mapping comments found; refusing to choose a thread.");
  return matches[0] || null;
}
async function tagsForForum(channelId, issue, discordRequest) {
  const forum = await discordRequest(`/channels/${channelId}`);
  if (forum.type !== 15) throw new Error("DISCORD_FORUM_CHANNEL_ID does not refer to a Discord forum channel.");
  const available = new Map((forum.available_tags || []).map(tag => [normalizeLabel(tag.name), tag.id]));
  const ids = [];
  for (const name of desiredTagNames(issue)) { const id = available.get(name); if (id) ids.push(id); else log(`Warning: Discord forum tag '${name}' was not found.`); }
  return { forum, availableTags: forum.available_tags || [], tagIds: [...new Set(ids)].slice(0, 5) };
}
async function addMapping(ownerRepo, issue, thread, githubRequest) {
  const guildId = thread.guild_id;
  const url = guildId ? `https://discord.com/channels/${guildId}/${thread.id}` : `https://discord.com/channels/@me/${thread.id}`;
  await githubRequest(`/repos/${ownerRepo}/issues/${issue.number}/comments`, { method: "POST", body: JSON.stringify({ body: `Discord discussion:\n${url}\n\n<!-- verselink-discord-thread:${thread.id} -->` }) });
}
export async function synchronizeIssue({ issue, ownerRepo, forumChannelId, discordRequest = discord, githubRequest = github }) {
  const { forum, availableTags, tagIds } = await tagsForForum(forumChannelId, issue, discordRequest);
  const mapping = await findMapping(ownerRepo, issue.number, githubRequest);
  let thread;
  if (mapping) {
    try { thread = await discordRequest(`/channels/${mapping.id}`); } catch (error) { if (!String(error.message).includes("(404)")) throw error; throw new Error(`Mapped Discord thread ${mapping.id} no longer exists; leaving the mapping intact to avoid duplicates.`); }
  } else {
    const created = await discordRequest(`/channels/${forum.id}/threads`, { method: "POST", body: JSON.stringify({ name: truncateTitle(issue.number, issue.title), applied_tags: tagIds, message: { content: buildMessage(issue), allowed_mentions: { parse: [] } } }) });
    await addMapping(ownerRepo, issue, created, githubRequest);
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
  await synchronizeIssue({ issue: payload.issue, ownerRepo: required("GITHUB_REPOSITORY"), forumChannelId });
}

if (process.argv[1] && new URL(`file:${process.argv[1]}`).href === import.meta.url) run().catch(error => { console.error(`[discord-issues] ${error.message}`); process.exitCode = 1; });
