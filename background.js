// Service worker: keeps the registered content scripts in step with the sites that are
// both listed and granted.
//
// Nothing is declared statically in manifest.json any more. Every site, including the
// seeded defaults, is an optional host permission that Chrome will not inject into on
// its own, so each one has to be registered at runtime with
// chrome.scripting.registerContentScripts.
//
// The registration is derived from the list and from chrome.permissions.getAll() every
// time rather than tracked incrementally. Both can change while this worker is not
// running — the user can revoke a site from chrome://extensions, and Chrome restores
// registrations from a previous session at startup — so anything this file remembered
// between runs would eventually be wrong.
importScripts('shared/sites.js');

const DYNAMIC_SCRIPT_ID = 'user-sites';
const CONTENT_SCRIPT_FILES = ['shared/rate.js', 'content.js'];

// Serialises the syncs. A permission change can land while a storage change is still
// being handled, and two concurrent passes would both see the pre-change registration
// and race to register the same id — one of them failing with "Duplicate script ID".
let syncQueue = Promise.resolve();

async function registeredDynamicScript() {
  try {
    const scripts = await chrome.scripting.getRegisteredContentScripts();
    return scripts.find((script) => script.id === DYNAMIC_SCRIPT_ID) ?? null;
  } catch (error) {
    console.debug('[Playback Speed Slider] could not read registered scripts:', error);
    return null;
  }
}

/**
 * Adds to the list anything that has been granted but is not on it.
 *
 * Chrome lets the user grant a site from the Site access section of
 * chrome://extensions without this extension being asked, and a permission the user
 * granted but the options page refused to show would look like a bug. The write is
 * skipped when there is nothing to add, so this cannot loop against its own
 * storage.onChanged.
 */
async function reconcileListWithGrants(sites, grantedOrigins) {
  const missing = grantedOrigins.filter((origin) => !sites.includes(origin));
  if (missing.length === 0) {
    return sites;
  }
  const next = PlaybackSpeedSites.tidy([...sites, ...missing]);
  await PlaybackSpeedSites.saveSites(next);
  return next;
}

async function syncDynamicContentScripts() {
  const granted = await chrome.permissions.getAll();
  const grantedOrigins = granted.origins ?? [];
  const sites = await reconcileListWithGrants(
    // Seeding here is what puts the defaults in front of the user on a fresh install.
    await PlaybackSpeedSites.readSites(),
    grantedOrigins
  );

  // Only sites that are both listed and granted get a content script. A listed site
  // without the permission cannot be injected into at all; a granted site that was
  // removed from the list is on its way out and should stop working now rather than
  // when the permission removal happens to land.
  const grantedSet = new Set(grantedOrigins);
  const matches = sites.filter((pattern) => grantedSet.has(pattern));
  const existing = await registeredDynamicScript();

  if (matches.length === 0) {
    if (existing) {
      await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
    }
    return;
  }

  const definition = {
    id: DYNAMIC_SCRIPT_ID,
    matches,
    js: CONTENT_SCRIPT_FILES,
    allFrames: true,
    runAt: 'document_idle',
    // Survives a browser restart on its own; the startup sync below only reconciles it
    // with anything that changed while the browser was closed.
    persistAcrossSessions: true,
  };

  try {
    if (existing) {
      await chrome.scripting.updateContentScripts([definition]);
    } else {
      await chrome.scripting.registerContentScripts([definition]);
    }
  } catch (error) {
    // An update can fail on a registration Chrome considers stale or malformed — for
    // instance one restored from a previous version of this file with different files
    // listed. Dropping it and registering from scratch is the only way back, and
    // leaving the old one in place would keep the user's newly added site inert.
    console.debug('[Playback Speed Slider] re-registering from scratch after:', error);
    try {
      await chrome.scripting.unregisterContentScripts({ ids: [DYNAMIC_SCRIPT_ID] });
    } catch (unregisterError) {
      console.debug('[Playback Speed Slider] nothing to unregister:', unregisterError);
    }
    await chrome.scripting.registerContentScripts([definition]);
  }
}

function queueSync(reason) {
  syncQueue = syncQueue
    .catch(() => {})
    .then(() => syncDynamicContentScripts())
    .catch((error) => {
      console.debug(`[Playback Speed Slider] sync after ${reason} failed:`, error);
    });
  return syncQueue;
}

// Registered at the top level so Chrome can start this worker for any of them.
chrome.runtime.onInstalled.addListener(async (details) => {
  await queueSync('install');
  // Nothing works until the user approves at least one site, and on a fresh install
  // there is no other sign of that. The options page shows the seeded defaults with the
  // button that grants them.
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});
chrome.runtime.onStartup.addListener(() => queueSync('startup'));
chrome.permissions.onAdded.addListener(() => queueSync('permission granted'));
chrome.permissions.onRemoved.addListener(() => queueSync('permission revoked'));
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[PlaybackSpeedSites.SITES_KEY]) {
    queueSync('site list changed');
  }
});

// Also runs on every cold start of the worker. The events above cover the cases that
// matter, but a worker woken for any other reason is a free opportunity to reconcile,
// and it costs one permissions read.
queueSync('worker start');
