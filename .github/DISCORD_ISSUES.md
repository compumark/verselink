# GitHub Issues → Discord forum

## Purpose and architecture

This optional GitHub Actions integration uses the **VerseLink Courier** Discord bot to mirror each VerseLink GitHub Issue into one post in the `verselink-feedback` Discord forum. GitHub remains the source of truth. The workflow runs on issue open, edit, label changes, close, and reopen; it never copies Discord discussion back to GitHub.

The action stores the Discord thread ID in one bot-created Issue comment. Later deliveries use that marker to update only the post title, its bot starter message, and its forum tags. Community messages are never edited or deleted. If the marker is absent, the normal path creates a forum post directly; it does not enumerate forum threads first. Workflow concurrency queues deliveries for the same repository Issue, preventing `opened` and `labeled` from racing before the mapping comment exists.

Discord REST calls are limited to `GET /channels/{forum-id}` (validate the type and read `available_tags`), `POST /channels/{forum-id}/threads` (create the post and starter message), `GET /channels/{thread-id}`, `PATCH /channels/{thread-id}`, and `PATCH /channels/{thread-id}/messages/{thread-id}`. Forum thread creation returns a nested starter message, and Discord assigns that starter message the same ID as the thread; therefore the mapping's thread ID safely identifies the bot starter message. The invalid `GET /channels/{forum-id}/threads/active` route is not used.

## Setup

Create a Discord application bot, invite it to the server containing `verselink-feedback`, and add these repository Actions secrets:

| Secret | Value |
| --- | --- |
| `DISCORD_BOT_TOKEN` | The bot token; never commit it. |
| `DISCORD_FORUM_CHANNEL_ID` | The ID of the `verselink-feedback` forum channel. |

The bot normally appears **offline**: it is not a continuously running service. GitHub Actions calls Discord's REST API only when an Issue event occurs, which is expected.

Grant the bot these forum-channel permissions: **View Channel**, **Create Posts** / **Send Messages** (Discord uses Send Messages to create forum posts), **Send Messages in Posts** / **Send Messages in Threads**, **Embed Links**, **Manage Posts** / **Manage Threads**, and **Read Message History**. **Create Public Threads** is ignored by Discord for forum-post creation. Manage Posts is needed because the workflow updates post names/tags after recovery and must work with moderated tags. The integration does not require **Manage Messages**, **Manage Channels**, or Administrator. Discord may display these labels differently by client/version; grant them at the forum-channel level.

Create these existing forum tags exactly once; the workflow resolves their IDs by name and never creates or modifies them: `bug`, `issue`, `idea`, `in progress`, `completed`, `not implemented`. Emoji are preserved because the bot only applies the existing tag IDs.

## Tag and lifecycle mapping

| GitHub state | Discord tags/status |
| --- | --- |
| `bug` label | `bug` (takes priority) |
| `idea`, `enhancement`, or `feature` | `idea` |
| no type label | `issue` |
| open + `in progress`, `status: in progress`, or `status/in progress` | primary tag + `in progress`; status In Progress |
| closed, completed/default reason | primary tag + `completed` |
| closed, `not_planned` | primary tag + `not implemented` |
| reopened | removes closure tag; restores primary and optional `in progress` |

Missing tags generate a workflow warning; configuration is not changed automatically. Managed tags are recalculated while unrelated existing tags are retained where Discord's five-tag limit allows. Discord 429 responses are retried once using `retry_after`. Missing secrets, permission failures, non-forum channels, malformed/duplicate mappings, deleted mapped threads, and missing starter messages produce actionable workflow logs without credentials.

## Issue-form summary policy

Discord is intentionally a summary view. From GitHub Issue Forms, the starter message shows `Description` (up to roughly 600 characters) and never includes `Steps to reproduce`, `Expected behavior`, `Actual behavior`, or `Additional context`. `Logs / error messages` is omitted for `No response`, `N/A`, `None`, or dash-only answers; otherwise it is shown as an **Error** preview of at most 200 characters, followed by `… Full logs on GitHub.` when shortened. The GitHub Issue link always remains the source for complete detail.

## Security and disabling

Issue title, body, and author are untrusted. The script neutralizes Discord mention syntax and sends `allowed_mentions: { parse: [] }`; it does not execute issue content or log tokens. To disable safely, disable `.github/workflows/discord-issues.yml` in GitHub Actions (or remove the two secrets). Existing forum posts remain readable.

## Manual acceptance checklist

1. Open a `bug` Issue titled `Test Discord Integration`: one `[#X] Test Discord Integration` post with `bug` and Open status appears.
2. Add `in progress`: `bug` and `in progress` are applied.
3. Edit the title: the post title changes.
4. Close as completed: `in progress` is removed and `completed` is applied.
5. Reopen: `completed` is removed; Open/In Progress follows labels.
6. Close as not planned: `not implemented` is applied.
7. Redeliver an event: no duplicate post or mapping comment is created.
8. Add ordinary Discord replies, edit the GitHub Issue, and confirm those replies remain unchanged.
