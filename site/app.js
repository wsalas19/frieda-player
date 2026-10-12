/* Progressive enhancement only — the page is fully readable without JS. */
(() => {
  "use strict";

  const REPO = "wsalas19/frieda-player";
  const RELEASES = `https://github.com/${REPO}/releases`;

  /* Footer year */
  const year = document.getElementById("year");
  if (year) year.textContent = String(new Date().getFullYear());

  /* Sticky nav border after scrolling */
  const nav = document.getElementById("nav");
  if (nav) {
    const onScroll = () => nav.classList.toggle("scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  /* Mobile menu */
  const toggle = document.getElementById("nav-toggle");
  const links = document.getElementById("nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", () => {
      const open = links.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    links.addEventListener("click", (e) => {
      if (e.target instanceof HTMLAnchorElement) {
        links.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      }
    });
  }

  /* Point every download button at the latest release. The markup already
     falls back to /releases/latest, so this only sharpens it (and the version
     label) once the GitHub API answers. */
  const setDownload = (href) => {
    document.querySelectorAll("[data-download]").forEach((el) => {
      el.setAttribute("href", href);
    });
  };

  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json" },
  })
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((rel) => {
      const tag = rel.tag_name || "";
      if (tag) {
        document.querySelectorAll("[data-version]").forEach((el) => {
          el.textContent = `${tag} · free & open source`;
        });
      }
      // Prefer the Windows installer asset; otherwise the release page.
      const installer = (rel.assets || []).find(
        (a) => /setup\.exe$/i.test(a.name) || /\.msi$/i.test(a.name),
      );
      setDownload(installer ? installer.browser_download_url : rel.html_url || RELEASES);
    })
    .catch(() => {
      /* offline / rate-limited — keep the /releases/latest fallback */
    });
})();
