(() => {
  const modules = [
    { name: "Blueprints", description: "Search synced crew blueprints, owners, categories and required materials.", icon: "/assets/icons/blueprint-schematic.svg?v=2", view: "inventory" },
    { name: "Orders", description: "Coordinate crafting requests and track order progress across the crew.", icon: "/assets/icons/orders.svg", view: "orders" },
    { name: "Groups", description: "Manage crew membership, invitations, ownership and public blueprint links.", icon: "/assets/icons/group-management.svg", view: "groups" },
    { name: "TradeMax", description: "Compare cargo routes and optimize trading opportunities with UEX data.", icon: "/assets/icons/connection.svg", view: "trademax" },
    { name: "Material Inventory", description: "Track shared crew material stock, quality bands and storage locations.", icon: "/assets/icons/material-crate.svg", view: "material" },
    { name: "SCMDB Connection", description: "Receive authenticated profile and blueprint snapshots through the SCMDB sink.", icon: "/assets/icons/sink-token.svg" }
  ];

  const styles = `
    .content.about-active{min-height:0;overflow:auto}
    .about-view{width:100%;max-width:1440px;margin:0 auto;padding:clamp(16px,2.4vw,34px);color:var(--text)}
    .about-hero{display:block;position:relative;box-sizing:border-box;padding:clamp(24px,4vw,52px);overflow:hidden;border:1px solid var(--border);background:linear-gradient(120deg,rgba(5,27,43,.94),rgba(4,17,29,.78));box-shadow:inset 0 0 45px rgba(0,179,255,.07),0 0 26px var(--glow)}
    .about-hero:after{content:"";position:absolute;right:-80px;top:-130px;width:420px;height:420px;border:1px solid color-mix(in srgb,var(--accent) 35%,transparent);border-radius:50%;box-shadow:0 0 45px var(--glow),inset 0 0 45px var(--glow);opacity:.55}
    .about-hero-layout{display:grid;grid-template-columns:minmax(140px,210px) minmax(0,1fr);align-items:center;gap:clamp(24px,4vw,58px)}.about-logo{display:block;width:100%;height:auto;filter:drop-shadow(0 0 18px var(--glow))}.about-hero-copy{min-width:0}
    .about-hero>*{position:relative;z-index:1}.about-hero h1{margin:8px 0 12px;font-size:clamp(34px,6vw,76px);line-height:.92;letter-spacing:.08em;color:var(--bright);text-shadow:0 0 18px var(--glow)}
    .about-hero .about-subtitle{margin:0 0 16px;color:var(--accent);font-size:clamp(15px,2vw,22px);font-weight:700;letter-spacing:.18em;text-transform:uppercase}
    .about-hero p{max-width:840px;margin:0;color:var(--muted);font-size:15px;line-height:1.65}
    .about-section{margin-top:30px}.about-heading{display:flex;align-items:center;gap:14px;margin:0 0 14px;color:var(--bright);font-size:14px;letter-spacing:.17em;text-transform:uppercase}.about-heading:after{content:"";height:1px;flex:1;background:linear-gradient(90deg,var(--border),transparent)}
    .about-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px}.about-card{display:flex;min-width:0;min-height:220px;padding:20px;flex-direction:column;border:1px solid var(--border);background:linear-gradient(145deg,rgba(8,31,47,.92),rgba(4,17,28,.78));box-shadow:inset 0 0 24px rgba(0,179,255,.04)}
    .about-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:14px}.about-module-icon{width:48px;height:48px;flex:none;background:var(--bright);-webkit-mask:var(--icon) center/contain no-repeat;mask:var(--icon) center/contain no-repeat;filter:drop-shadow(0 0 8px var(--glow))}.about-module-image{width:52px;height:52px;object-fit:contain;filter:drop-shadow(0 0 8px var(--glow))}
    .about-status{padding:5px 8px;border:1px solid var(--accent);color:var(--accent);font-size:10px;font-weight:700;letter-spacing:.14em}.about-status--inactive{border-color:var(--muted);color:var(--muted)}.about-card.is-inactive{border-style:dashed;filter:grayscale(.72) saturate(.35);opacity:.58}.about-card h3{margin:16px 0 8px;color:var(--bright);font-size:19px;letter-spacing:.06em;text-transform:uppercase}.about-card p{margin:0 0 18px;color:var(--muted);font-size:13px;line-height:1.55}.about-open{align-self:flex-start;margin-top:auto;padding:9px 12px;border:1px solid var(--accent);background:rgba(7,66,92,.65);color:var(--bright);font:700 11px inherit;letter-spacing:.08em;cursor:pointer}.about-open:hover,.about-open:focus-visible{background:var(--accent);color:#021019;outline:none}
    .about-info-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.about-info{padding:20px;border:1px solid var(--border);background:rgba(5,23,36,.78)}.about-info h3{margin:0 0 12px;color:var(--bright);font-size:14px;letter-spacing:.12em}.about-data{display:grid;grid-template-columns:auto 1fr;gap:9px 18px;margin:0}.about-data dt{color:var(--muted);font-size:11px;letter-spacing:.12em;text-transform:uppercase}.about-data dd{margin:0;color:var(--bright);font-size:13px}.about-service-list{display:flex;flex-wrap:wrap;gap:8px;margin:0;padding:0;list-style:none}.about-service-list li{padding:7px 10px;border:1px solid var(--border);color:var(--bright);font-size:12px}.about-service-list small{display:block;margin-top:3px;color:var(--muted)}
    .about-disclaimer{margin:18px 0 0;padding:15px 18px;border-left:2px solid var(--accent);background:rgba(3,17,28,.72);color:var(--muted);font-size:11px;line-height:1.55;letter-spacing:.03em}.about-changelog{margin-top:16px}.about-user-id{word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
    @media(max-width:1050px){.about-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:680px){.about-view{padding:12px}.about-hero-layout{grid-template-columns:1fr;text-align:center}.about-logo{width:132px;margin:0 auto}.about-hero p{margin-inline:auto}.about-grid,.about-info-grid{grid-template-columns:1fr}.about-card{min-height:0}.about-hero:after{right:-230px}.about-data{grid-template-columns:1fr;gap:4px}.about-data dd{margin-bottom:9px}}
  `;

  const moduleCard = (module) => `<article class="about-card${module.inactive ? " is-inactive" : ""}"><div class="about-card-top">${module.image ? `<img class="about-module-image" src="${module.image}" alt="">` : `<i class="about-module-icon" style="--icon:url('${module.icon}')" aria-hidden="true"></i>`}<span class="about-status${module.inactive ? " about-status--inactive" : ""}">${module.status || "ACTIVE"}</span></div><h3>${module.name}</h3><p>${module.description}</p>${module.view ? `<button class="about-open" type="button" data-about-view="${module.view}">OPEN MODULE</button>` : ""}</article>`;
  const deployedCommit = "{{APP_COMMIT}}";
  const displayedCommit = deployedCommit !== "unknown" && deployedCommit ? deployedCommit.slice(0, 7) : "unknown";
  const deployedCommitMarkup = /^[0-9a-f]{7,}$/i.test(deployedCommit)
    ? `<a href="https://github.com/compumark/verselink/commit/${deployedCommit}" target="_blank" rel="noopener noreferrer">${displayedCommit}</a>`
    : displayedCommit;

  window.renderVerseLinkAbout = (content, user) => {
    if (!document.querySelector("#verselink-about-styles")) {
      const style = document.createElement("style");
      style.id = "verselink-about-styles";
      style.textContent = styles;
      document.head.append(style);
    }
    content.classList.add("about-active");
      const userIdMarkup = user?.id ? `<dt>USER ID</dt><dd class="about-user-id">${user.id}</dd>` : "";
      content.innerHTML = `<section class="about-view" aria-labelledby="about-title"><header class="about-hero"><div class="about-hero-layout"><img class="about-logo" src="/assets/verselink.png" alt="VerseLink logo"><div class="about-hero-copy"><div class="eyebrow">MOBIGLASS SYSTEM PROFILE</div><h1 id="about-title">VERSELINK</h1><div class="about-subtitle">Star Citizen Companion</div><p>VerseLink combines blueprint intelligence, material planning, group coordination and trading tools in one consistent Mobiglass workspace for Star Citizen crews.</p></div></div></header><section class="about-section"><h2 class="about-heading">Available modules</h2><div class="about-grid">${modules.map(moduleCard).join("")}</div></section><section class="about-section"><h2 class="about-heading">System information</h2><div class="about-info-grid"><article class="about-info"><h3>PRODUCT</h3><dl class="about-data"><dt>Name</dt><dd>VerseLink</dd><dt>Interface</dt><dd>Mobiglass</dd><dt>Environment</dt><dd>{{APP_ENVIRONMENT}}</dd><dt>Version</dt><dd>{{APP_VERSION}}</dd><dt>Deployed commit</dt><dd>${deployedCommitMarkup}</dd>${userIdMarkup}</dl><button class="about-open about-changelog" type="button" data-about-view="changelog">VIEW CHANGELOG</button></article><article class="about-info"><h3>CONNECTED SERVICES</h3><ul class="about-service-list"><li>SCMDB<small>Blueprint synchronization</small></li><li>UEX<small>Trading reference data</small></li><li>Discord<small>Optional notifications</small></li></ul></article></div><p class="about-disclaimer">VerseLink is an independent community project and is not affiliated with or endorsed by Cloud Imperium Games. Star Citizen and related marks are the property of their respective owners.</p></section></section>`;
    content.querySelectorAll("[data-about-view]").forEach((button) => {
      button.addEventListener("click", () => { location.hash = `#${button.dataset.aboutView}`; });
    });
  };
})();
