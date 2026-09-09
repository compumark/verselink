(() => {
  const content = document.querySelector("#content");
  const repository = "compumark/verselink";
  let loading = false;

  const escapeHtml = (value) => {
    const node = document.createElement("span");
    node.textContent = String(value || "");
    return node.innerHTML;
  };

  const releaseBody = (body) => String(body || "").trim().split(/\n{2,}/).filter(Boolean).map((block) => {
    const lines = block.split("\n").filter(Boolean);
    if (lines.every((line) => /^[-*+]\s+/.test(line))) {
      return `<ul class="github-release-notes">${lines.map((line) => `<li>${escapeHtml(line.replace(/^[-*+]\s+/, ""))}</li>`).join("")}</ul>`;
    }
    return `<p>${lines.map(escapeHtml).join("<br>")}</p>`;
  }).join("");

  const releaseChanges = (body) => String(body || "").split(/\r?\n/)
    .filter((line) => /^[-*+]\s+/.test(line))
    .map((line) => line.replace(/^[-*+]\s+/, "").trim());

  const hasEmbeddedReleaseNotes = (entry, release) => {
    const notes = releaseChanges(release?.body);
    return notes.length > 0 && notes.every((note) => entry.changes.includes(note));
  };

  const loadGithubRelease = async (version) => {
    try {
      const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/v${encodeURIComponent(version)}`, {
        headers: { Accept: "application/vnd.github+json" }
      });
      return response.ok ? response.json() : null;
    } catch {
      return null;
    }
  };

  const render = async (mode = "releases") => {
    if (location.hash !== "#changelog") return;
    loading = true;
    try {
      const response = await fetch("/api/changelog");
      if (!response.ok) throw new Error("changelog unavailable");
      const documentSource = new DOMParser().parseFromString(await response.text(), "text/html");
      const entries = [...documentSource.querySelectorAll(".entry")].map((entry) => ({
        kind: entry.dataset.releaseKind || "pre-release",
        version: entry.dataset.version || "",
        date: entry.querySelector("time")?.textContent.trim() || entry.querySelector(".version")?.textContent.trim() || "",
        changes: [...entry.querySelectorAll("li")].map((item) => item.textContent.trim()).filter(Boolean)
      })).filter((entry) => entry.date && entry.changes.length);
      const stable = entries.filter((entry) => entry.kind === "stable");
      const selected = mode === "pre-release" ? entries.filter((entry) => entry.kind === "pre-release") : stable;
      if (!selected.length) throw new Error("no changelog entries");

      const githubReleases = new Map(mode === "pre-release" ? [] : await Promise.all(
        selected.map(async (entry) => [entry.version, await loadGithubRelease(entry.version)])
      ));
      if (location.hash !== "#changelog") return;

      const preRelease = mode === "pre-release";
      content.innerHTML = `<section class="frame changelog-panel" data-changelog-controlled="true">
        <div class="eyebrow">MOBIGLASS SYSTEM</div>
        <h1>${preRelease ? "PRE-RELEASE HISTORY" : "CHANGELOG"}</h1>
        <p class="changelog-intro">${preRelease ? "Development history before the first public release." : "Official releases and their deployed changes."}</p>
        ${selected.map((entry, index) => {
          const release = githubReleases.get(entry.version);
          const githubNotes = release?.body && !hasEmbeddedReleaseNotes(entry, release) ? `<section class="github-release"><strong>GITHUB RELEASE NOTES</strong>${releaseBody(release.body)}<a href="${escapeHtml(release.html_url)}" target="_blank" rel="noopener noreferrer">VIEW GITHUB RELEASE ↗</a></section>` : "";
          return `<article class="changelog-entry"><div class="changelog-release"><strong>${entry.version ? `VERSION ${escapeHtml(entry.version)}` : "PRE-RELEASE"}</strong><small>${escapeHtml(entry.date)}</small>${!preRelease && index === 0 ? '<span class="changelog-current">CURRENT RELEASE</span>' : ""}</div><ul>${entry.changes.map((change) => `<li>${escapeHtml(change)}</li>`).join("")}</ul>${githubNotes}</article>`;
        }).join("")}
        <div class="changelog-actions"><button type="button" id="changelog-toggle">${preRelease ? "BACK TO RELEASES" : "VIEW PRE-RELEASE HISTORY"}</button></div>
      </section>`;
      document.querySelector("#changelog-toggle").onclick = () => render(preRelease ? "releases" : "pre-release");
    } catch {
      if (location.hash === "#changelog") content.innerHTML = '<section class="frame changelog-panel" data-changelog-controlled="true"><div class="eyebrow">MOBIGLASS SYSTEM</div><h1>CHANGELOG</h1><p class="changelog-intro">Changelog data is currently unavailable.</p></section>';
    } finally {
      loading = false;
    }
  };

  const schedule = () => {
    if (location.hash === "#changelog" && !loading && !content.querySelector('[data-changelog-controlled="true"]')) queueMicrotask(() => render());
  };

  new MutationObserver(schedule).observe(content, { childList: true, subtree: true });
  window.addEventListener("hashchange", () => setTimeout(schedule, 0));
  schedule();
})();
