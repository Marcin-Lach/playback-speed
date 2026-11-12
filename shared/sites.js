// The site list: which hosts the extension is meant to run on, how a host typed by a
// human becomes a match pattern, and where that list is stored.
//
// A site has two independent halves, and the UI has to be able to show either one
// without the other:
//
//   * it is on the list, which is this extension's own setting, in chrome.storage; and
//   * it is granted, which is a Chrome host permission the user approved.
//
// Neither implies the other. A freshly seeded default is listed but not granted until
// the user approves it, and a permission revoked from chrome://extensions leaves a
// listed site ungranted again. The content script only runs where both are true.
//
// Nothing here treats the default sites as special beyond being the initial contents of
// the list: DEFAULT_SITE_PATTERNS is data, seeded once, and removable afterwards like
// anything the user added.
//
// Like shared/rate.js, this is a classic script that assigns to globalThis, so that the
// popup, the options page, the service worker (via importScripts), and repeated
// injections can all load it without a redeclaration error.
(() => {
  // Only https is offered. Every streaming site that matters serves over TLS, and
  // keeping the scheme fixed means a pattern can never be widened by accident through
  // an http:// entry that also matches nothing useful.
  const SCHEME = 'https';
  const SUBDOMAIN_PREFIX = '*.';

  const SITES_KEY = 'sites';

  // Where the service worker mirrors the patterns that are currently both listed and
  // granted, so that a content script can tell whether it is still allowed to act.
  //
  // Revoking a host permission does not unload a content script Chrome has already
  // injected: it keeps its listeners, and its storage access, until the page navigates.
  // A content script cannot ask chrome.permissions anything either — that API is not
  // exposed to it. Reading this mirror is how an already-running frame finds out that
  // its site was removed, so it can stop instead of going on applying the rate to a
  // page the extension is no longer allowed to touch.
  const ACTIVE_KEY = 'activePatterns';

  // What the list starts out as. Seeded once, on the first run that finds no list at
  // all; removing one is permanent, because the seed never runs again afterwards.
  const DEFAULT_SITE_PATTERNS = [
    'https://*.primevideo.com/*',
    'https://*.disneyplus.com/*',
  ];

  // At least two dot-separated labels, so that a stray word or a single-label intranet
  // name cannot turn into a pattern that matches far more than the user meant.
  const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

  const PATTERN = /^https:\/\/(\*\.)?([^/*]+)\/\*$/;

  /**
   * Pulls a bare hostname out of whatever the user pasted.
   *
   * Accepts a full URL, a host with a port, a `*.` pattern, or just the host. Returns
   * null for anything that is not a plausible registrable hostname, so that a typo
   * becomes a visible error in the UI rather than a permission request Chrome rejects
   * with an opaque message.
   */
  function hostFromInput(input) {
    let value = String(input ?? '')
      .trim()
      .toLowerCase();
    if (!value) {
      return null;
    }

    value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    value = value.split(/[/?#]/)[0];
    // Strip any userinfo and port that survived the split.
    value = value.split('@').pop();
    value = value.split(':')[0];
    while (value.startsWith(SUBDOMAIN_PREFIX)) {
      value = value.slice(SUBDOMAIN_PREFIX.length);
    }
    value = value.replace(/\.+$/, '');

    if (!HOSTNAME.test(value)) {
      return null;
    }
    return value;
  }

  /** The pattern stored for a host: the host itself and everything under it. */
  function patternForHost(host) {
    return `${SCHEME}://${SUBDOMAIN_PREFIX}${host}/*`;
  }

  /**
   * The pattern to add for a page the user is looking at.
   *
   * A leading `www.` is dropped first, so enabling the extension from
   * https://www.example.com/watch covers player.example.com too. Sites routinely serve
   * the page from one subdomain and the player from another, and a user who had to come
   * back and add the second one would reasonably call that broken.
   */
  function patternForHostname(hostname) {
    const host = hostFromInput(String(hostname ?? '').replace(/^www\./, ''));
    return host ? patternForHost(host) : null;
  }

  function patternForUrl(url) {
    return patternForHostname(url?.hostname);
  }

  /** The narrowest pattern that covers exactly one hostname, for permission checks. */
  function exactPatternForHostname(hostname) {
    return `${SCHEME}://${hostname}/*`;
  }

  /**
   * The narrowest pattern that covers exactly one page's origin, for asking Chrome
   * whether this specific page is already covered by anything that has been granted.
   */
  function exactPatternForUrl(url) {
    return `${url.protocol}//${url.hostname}/*`;
  }

  /** "https://*.example.com/*" -> "example.com", for display. */
  function hostLabel(pattern) {
    const match = PATTERN.exec(pattern);
    return match ? match[2] : pattern;
  }

  /** Whether a pattern covers subdomains, which changes how it is described in the UI. */
  function coversSubdomains(pattern) {
    return PATTERN.exec(pattern)?.[1] !== undefined;
  }

  /** Whether a listed pattern would match a given hostname. */
  function patternCoversHost(pattern, hostname) {
    const match = PATTERN.exec(pattern);
    if (!match) {
      return false;
    }
    const host = String(hostname ?? '').toLowerCase();
    return match[1] ? host === match[2] || host.endsWith(`.${match[2]}`) : host === match[2];
  }

  /** The listed pattern that covers a hostname, or null. */
  function listedPatternForHost(patterns, hostname) {
    return patterns.find((pattern) => patternCoversHost(pattern, hostname)) ?? null;
  }

  /** Drops duplicates and anything unparseable, and orders by the host being shown. */
  function tidy(patterns) {
    const seen = new Set();
    for (const pattern of patterns ?? []) {
      if (typeof pattern === 'string' && PATTERN.test(pattern)) {
        seen.add(pattern);
      }
    }
    return [...seen].sort((a, b) => hostLabel(a).localeCompare(hostLabel(b)));
  }

  /**
   * The current list, seeding the defaults the first time there is none.
   *
   * The distinction that matters is between "no list has ever been written" and "the
   * list is empty". Only the first one seeds; a user who removed every site gets an
   * empty list back, not the defaults again.
   */
  async function readSites({ seed = true } = {}) {
    const stored = await chrome.storage.local.get({ [SITES_KEY]: null });
    const value = stored[SITES_KEY];

    if (value === null || value === undefined) {
      if (!seed) {
        return [];
      }
      const seeded = tidy(DEFAULT_SITE_PATTERNS);
      await chrome.storage.local.set({ [SITES_KEY]: seeded });
      return seeded;
    }

    return tidy(Array.isArray(value) ? value : []);
  }

  async function saveSites(patterns) {
    await chrome.storage.local.set({ [SITES_KEY]: tidy(patterns) });
  }

  /** Adds a pattern to the list. Returns the new list. */
  async function addSite(pattern) {
    const sites = await readSites();
    if (sites.includes(pattern)) {
      return sites;
    }
    const next = tidy([...sites, pattern]);
    await chrome.storage.local.set({ [SITES_KEY]: next });
    return next;
  }

  /** Removes a pattern from the list. Returns the new list. */
  async function removeSite(pattern) {
    const sites = await readSites();
    const next = sites.filter((entry) => entry !== pattern);
    await chrome.storage.local.set({ [SITES_KEY]: next });
    return next;
  }

  globalThis.PlaybackSpeedSites = {
    SCHEME,
    SITES_KEY,
    ACTIVE_KEY,
    DEFAULT_SITE_PATTERNS,
    hostFromInput,
    patternForHost,
    patternForHostname,
    patternForUrl,
    exactPatternForHostname,
    exactPatternForUrl,
    hostLabel,
    coversSubdomains,
    patternCoversHost,
    listedPatternForHost,
    tidy,
    readSites,
    saveSites,
    addSite,
    removeSite,
  };
})();
