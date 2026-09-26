import type {MessageKey} from "./i18n.ts";

export function shell(t:(key:MessageKey)=>string):string {
 return `<header class="topbar">
  <a class="brand" href="/" aria-label="${t("home")}"><img class="brand-icon" src="/icons/viaradar-mark.svg" alt="" width="36" height="36"><span>ViaRadar</span></a>
  <div class="header-actions">
   <button id="install" class="quiet" aria-label="${t("install")}">${t("installShort")}<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/></svg></button>
   <details id="settings" class="settings"><summary aria-label="${t("settings")}" title="${t("settings")}"><svg aria-hidden="true" viewBox="0 0 24 24"><path fill-rule="evenodd" d="M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.3 7.3 0 0 0-1.63-.95l-.36-2.54A.5.5 0 0 0 13.88 2h-3.76a.5.5 0 0 0-.49.42l-.36 2.54a7.3 7.3 0 0 0-1.63.95l-2.39-.96a.5.5 0 0 0-.61.22L2.72 8.49a.5.5 0 0 0 .12.64l2.03 1.58a7.7 7.7 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.5.38 1.04.7 1.63.95l.36 2.54a.5.5 0 0 0 .49.42h3.76a.5.5 0 0 0 .49-.42l.36-2.54a7.3 7.3 0 0 0 1.63-.95l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58a7.7 7.7 0 0 0 0-1.88z M12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg></summary><div class="settings-panel"><label class="language-control"><span>${t("appearance")}</span><select id="theme" aria-label="${t("appearance")}"><option value="auto">${t("automatic")}</option><option value="light">${t("light")}</option><option value="dark">${t("dark")}</option></select></label><label class="language-control"><span>${t("language")}</span><select id="language" aria-label="${t("language")}"><option value="auto">${t("automatic")}</option><option value="es">Español</option><option value="en">English</option></select></label></div></details>
  </div>
 </header>
 <main>
  <section class="station-identity" aria-labelledby="station-title"><h1 id="station-title">L’Hospitalet de Llobregat</h1><p>${t("tagline")}</p></section>
  <div class="service-strip"><div id="connection" class="connection" role="status">${t("connecting")}</div></div>
  <section class="board" aria-labelledby="board-title">
   <div class="board-heading"><h2 id="board-title">${t("departures")}</h2><div class="board-tools"><label class="visually-hidden" for="line">${t("line")}</label><select id="line"><option value="">${t("allLines")}</option></select><button id="refresh" class="refresh icon-button" aria-label="${t("refreshAria")}" title="${t("refresh")}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 7v5h-5M4 17v-5h5M6.1 7a7 7 0 0 1 11.6-1L20 9M4 15l2.3 3A7 7 0 0 0 17.9 17"/></svg></button></div></div>
   <div class="table-head" aria-hidden="true"><span>${t("departure")}</span><span>${t("destination")}</span><span>${t("platform")}</span></div>
   <div id="departures" aria-live="polite"><div class="empty"><h3>${t("loadingTitle")}</h3><p>${t("loadingBody")}</p></div></div>
   <div class="board-footer"><span id="updated">${t("waiting")}</span><span id="next-refresh">${t("autoRefresh")}</span></div>
  </section>
  <details id="how-it-works" class="guide"><summary>${t("howItWorks")}<span>${t("guideSummary")}</span></summary><div class="guide-items"><p><strong><i class="dot official"></i>${t("publishedRenfe")}</strong><span>${t("officialBody")}</span></p><p><strong><i class="dot prediction"></i>${t("historicalEstimate")}</strong><span>${t("predictionBody")}</span></p><p><strong><i class="dot unknown"></i>${t("notPublished")}</strong><span>${t("unknownBody")}</span></p></div><p class="guide-note">${t("guideNote")}</p></details>
  <details class="details"><summary>${t("sourcesTitle")}</summary><div id="sources">${t("waitingSources")}</div><p>${t("publicData")} <a href="https://data.renfe.com/" target="_blank" rel="noreferrer">Renfe Data</a> · <a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>. ${t("disclaimer")}</p></details>
  <footer>ViaRadar <span>${t("footer")}</span></footer>
 </main>
 <dialog id="install-dialog"><form method="dialog"><button class="close" aria-label="${t("closeInstall")}">×</button><p class="eyebrow">${t("takeBoard")}</p><h2>${t("installTitle")}</h2><p><strong>iPhone / iPad:</strong> ${t("ios")}</p><p><strong>Android:</strong> ${t("android")}</p><p>${t("installNote")}</p><button class="refresh">${t("gotIt")}</button></form></dialog>`;
}
