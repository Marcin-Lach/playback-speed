// Popup: writes the chosen rate to chrome.storage.local, and shows every origin this
// page draws video from so each one can be enabled.
//
// A page is not one thing to Chrome. An embedded player lives in its own document, on
// its own origin, and a host permission for the page says nothing about it: granting
// xyzasd.com does not let anything touch a <video> inside a player.vimeo.com iframe.
// activeTab does not bridge that either — it covers the top frame and same-origin
// children only. So each origin needs its own permission, and the popup's job is to
// make that visible instead of leaving the user to guess why the slider does nothing.
//
// Detection costs no permission: the probe runs in the frames the extension may already
// touch, and reads the `src` of the iframes it finds there. Reading a child frame's src
// attribute is a read of the parent's own DOM, so an embed is discoverable long before
// anything is allowed to run inside it.
const { MIN_RATE, MAX_RATE, RATE_STEP, DEFAULT_RATE, normalizeRate } = globalThis.PlaybackSpeedRate;
const { patternForHostname, hostLabel, listedPatternForHost, readSites } =
  globalThis.PlaybackSpeedSites;

const STORAGE_KEY = 'playbackRate';
const WRITE_DEBOUNCE_MS = 80;
// Injected together and in this order: content.js reads the shared range and the site
// matching from the first two files, so it cannot be injected on its own.
const CONTENT_SCRIPT_FILES = ['shared/rate.js', 'shared/sites.js', 'content.js'];

const slider = document.getElementById('rate-slider');
const readout = document.getElementById('rate-readout');
const status = document.getElementById('status');
const frameList = document.getElementById('frame-list');
const reloadButton = document.getElementById('reload-tab');
const optionsButton = document.getElementById('open-options');
const presetButtons = Array.from(document.querySelectorAll('.preset'));

let writeTimer = null;
// The rate waiting to be written, or null when nothing is pending. Held outside the
// timer so that flushWrite() can commit it from a teardown path.
let pendingRate = null;
// Rates this popup wrote itself, so the storage listener below can ignore the
// echo instead of yanking the slider back while it is being dragged.
const selfWrittenRates = new Set();

let activeTabId = null;

/** 1 -> "1.0", 1.25 -> "1.25" */
function formatRate(rate) {
  const hundredths = Math.round(rate * 100);
  return (hundredths / 100).toFixed(hundredths % 10 === 0 ? 1 : 2);
}

function setStatus(message, tone = 'info') {
  status.textContent = message;
  status.dataset.tone = tone;
}

/**
 * Turns the slider and presets on or off.
 *
 * They are live wherever changing the speed does something — including on a tab that is
 * not a video page at all, since the rate is one global setting other tabs follow. They
 * go dead only when nothing on this page can be reached: a working slider would then be
 * a lie, storing a value and visibly applying it to nothing.
 */
function setControlsEnabled(enabled) {
  slider.disabled = !enabled;
  for (const button of presetButtons) {
    button.disabled = !enabled;
  }
  document.body.classList.toggle('controls-off', !enabled);
}

function renderRate(rate) {
  const label = `${formatRate(rate)}×`;
  slider.value = String(rate);
  // Without this a screen reader announces the bare number from slider.value, which is
  // the step-snapped one and carries no unit.
  slider.setAttribute('aria-valuetext', label);
  readout.textContent = label;
  for (const button of presetButtons) {
    button.setAttribute('aria-pressed', String(normalizeRate(button.dataset.rate) === rate));
  }
}

/**
 * Commits the pending rate now.
 *
 * A popup document is destroyed the moment it loses focus, and a scheduled timer dies
 * with it, so every teardown path has to come through here or the user's last change is
 * silently dropped after the readout has already shown it. chrome.storage.local.set
 * dispatches synchronously, so the write still lands even when the callback never runs.
 */
function flushWrite() {
  if (pendingRate === null) {
    return;
  }

  clearTimeout(writeTimer);
  writeTimer = null;
  const rate = pendingRate;
  pendingRate = null;

  selfWrittenRates.add(rate);
  chrome.storage.local.set({ [STORAGE_KEY]: rate }, () => {
    if (chrome.runtime.lastError) {
      setStatus('Could not save the speed. Try again.', 'warn');
    }
  });
}

function storeRate(rate) {
  pendingRate = rate;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flushWrite, WRITE_DEBOUNCE_MS);
}

function setRate(value) {
  const rate = normalizeRate(value);
  renderRate(rate);
  storeRate(rate);
}

/**
 * Points the slider at the shared range, and checks that every preset can actually be
 * represented on it. A preset that is not a whole number of steps above the minimum gets
 * snapped by the browser, leaving the thumb somewhere other than the value in the
 * readout and the value that was stored.
 */
function configureSlider() {
  slider.min = String(MIN_RATE);
  slider.max = String(MAX_RATE);
  slider.step = String(RATE_STEP);

  for (const button of presetButtons) {
    const rate = normalizeRate(button.dataset.rate);
    const steps = (rate - MIN_RATE) / RATE_STEP;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      console.warn(
        `[Playback Speed Slider] preset ${rate}× is not a multiple of the ` +
          `${RATE_STEP} step above ${MIN_RATE}, so the slider will snap away from it.`
      );
    }
  }
}

/**
 * Runs in one frame: what is here, and what does this frame embed?
 *
 * Serialised and injected, so it may not close over anything. `window.top === window`
 * is an identity check rather than a property read, which is allowed across origins.
 */
function inspectFrame() {
  const videos = Array.from(document.querySelectorAll('video'));
  const embeds = [];
  for (const frame of document.querySelectorAll('iframe')) {
    const src = frame.getAttribute('src');
    if (!src) {
      continue;
    }
    try {
      const url = new URL(src, location.href);
      if (url.protocol === 'https:' && url.hostname !== location.hostname) {
        embeds.push(url.hostname);
      }
    } catch (error) {
      // A relative or malformed src is not an embed worth offering.
    }
  }

  return {
    host: location.hostname,
    isTop: window.top === window,
    videoCount: videos.length,
    rates: videos.map((video) => video.playbackRate),
    // readyState > 2 is HAVE_CURRENT_DATA: enough for "this is the one making noise"
    // rather than a player that merely exists on the page.
    playing: videos.some((video) => !video.paused && !video.ended && video.readyState > 2),
    embeds,
  };
}

/** Every frame the extension may currently look into, with what it found. */
async function probeFrames(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: inspectFrame,
  });
  return results
    .filter((result) => result && result.result)
    .map((result) => ({ frameId: result.frameId, ...result.result }));
}

/**
 * One entry per origin, merging what was seen directly with what was only glimpsed as
 * an iframe src.
 *
 * `reached` is the difference between the two: a reached origin reported its own video
 * count and playback state, while an unreached one is a host name and nothing else,
 * because the extension is not allowed inside it yet.
 */
function collectOrigins(frames) {
  const byHost = new Map();

  const entry = (host) => {
    // A frame showing about:blank or srcdoc, or a blob: document, reports an empty
    // hostname. It can never be enabled, so it has no row to show and no permission to
    // check — and a pattern built from it is malformed, which chrome.permissions
    // rejects rather than answering.
    if (!patternForHostname(host)) {
      return null;
    }
    let found = byHost.get(host);
    if (!found) {
      found = {
        host,
        isTop: false,
        reached: false,
        videoCount: 0,
        rates: [],
        playing: false,
        frameIds: [],
      };
      byHost.set(host, found);
    }
    return found;
  };

  for (const frame of frames) {
    const found = entry(frame.host);
    if (!found) {
      continue;
    }
    found.reached = true;
    found.isTop ||= frame.isTop;
    found.videoCount += frame.videoCount;
    found.rates.push(...frame.rates);
    found.playing ||= frame.playing;
    found.frameIds.push(frame.frameId);
  }

  // Added after the reached frames, so an origin that was both embedded and visited
  // keeps the richer record.
  for (const frame of frames) {
    for (const host of frame.embeds) {
      entry(host);
    }
  }

  return [...byHost.values()];
}

/** Asks Chrome, and the site list, about every origin found. */
async function describeOrigins(origins) {
  const sites = await readSites();
  await Promise.all(
    origins.map(async (origin) => {
      // collectOrigins has already thrown out anything that cannot be a pattern, so
      // this is safe to ask Chrome about.
      const exact = patternForHostname(origin.host);
      // True for a legacy `*.` grant covering this host as well, since Chrome answers
      // on containment rather than on an exact string match.
      origin.granted = await chrome.permissions.contains({ origins: [exact] });
      const listed = listedPatternForHost(sites, origin.host);
      origin.listedPattern = listed;
      // Asking again for a site already on the list means asking for the pattern it is
      // listed under, not adding a second entry for the same site.
      origin.requestPattern = listed ?? exact;
    })
  );

  return origins.sort((a, b) => {
    if (a.isTop !== b.isTop) return a.isTop ? -1 : 1;
    if (a.playing !== b.playing) return a.playing ? -1 : 1;
    if (a.videoCount > 0 !== b.videoCount > 0) return a.videoCount > 0 ? -1 : 1;
    return a.host.localeCompare(b.host);
  });
}

/**
 * Starts the content script in the frames that are allowed to have one.
 *
 * Only granted frames, by id, rather than allFrames: under activeTab an allFrames
 * injection would also reach the top frame of a page that is not enabled, and running
 * there at all — even briefly, even if the script then shuts itself down — is the thing
 * this extension is built not to do.
 *
 * Returns the number of frames that refused, which is what makes a reload worth
 * offering.
 */
async function injectInto(tabId, frameIds) {
  if (frameIds.length === 0) {
    return 0;
  }
  const attempts = await Promise.allSettled(
    frameIds.map((frameId) =>
      chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: CONTENT_SCRIPT_FILES,
      })
    )
  );
  return attempts.filter((attempt) => attempt.status === 'rejected').length;
}

/** The small glyph that says, at a glance, which origin is the one that matters. */
function stateGlyph(origin) {
  if (!origin.granted) {
    return { text: '?', label: 'Not enabled, so its videos cannot be seen' };
  }
  if (!origin.reached) {
    return { text: '!', label: 'Enabled, but not reachable until the page is reloaded' };
  }
  if (origin.playing) {
    return { text: '▶', label: 'Playing now' };
  }
  if (origin.videoCount > 0) {
    return { text: '⏸', label: `${origin.videoCount} video, not playing` };
  }
  return { text: '·', label: 'No video in this frame' };
}

function originRow(origin, onEnable) {
  const item = document.createElement('li');
  item.className = origin.playing ? 'origin playing' : 'origin';

  const glyph = stateGlyph(origin);
  const mark = document.createElement('span');
  mark.className = 'glyph';
  mark.textContent = glyph.text;
  mark.title = glyph.label;
  mark.setAttribute('aria-label', glyph.label);

  const host = document.createElement('span');
  host.className = 'origin-host';
  host.textContent = origin.host;
  host.title = origin.isTop ? `${origin.host} — this page` : `${origin.host} — embedded here`;

  item.append(mark, host);

  if (origin.isTop) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = 'page';
    item.append(badge);
  }

  if (!origin.granted) {
    const enable = document.createElement('button');
    enable.type = 'button';
    enable.className = 'button-enable';
    // A site already on the list is missing only the permission, which is a different
    // thing to say than offering to add it.
    enable.textContent = origin.listedPattern ? 'Grant' : 'Enable';
    enable.disabled = !origin.requestPattern;
    enable.addEventListener('click', () => onEnable(origin));
    item.append(enable);
  }

  return item;
}

/** What the status line says once the list below it has the details. */
function summarise(origins) {
  const controlled = origins.filter((origin) => origin.granted && origin.reached);
  const videoCount = controlled.reduce((total, origin) => total + origin.videoCount, 0);

  if (origins.length === 0) {
    return 'Nothing to control on this tab.';
  }
  if (!origins.some((origin) => origin.granted)) {
    return 'Not enabled on any source here. Enable one below.';
  }
  if (videoCount === 0) {
    return 'No video yet. Start playing — the speed applies automatically.';
  }

  const rates = controlled.flatMap((origin) => origin.rates);
  const applied = [...new Set(rates.map((rate) => `${formatRate(normalizeRate(rate))}×`))];
  const label = videoCount === 1 ? 'video' : 'videos';
  return `${videoCount} ${label} on this page, now playing at ${applied.join(', ')}.`;
}

/**
 * Renders the popup's view of the active tab, and never rejects.
 */
async function refreshSiteState() {
  try {
    await renderSiteState();
  } catch (error) {
    // Every path out of renderSiteState is supposed to leave the popup saying
    // something. One that throws instead used to leave it exactly as the HTML shipped
    // it — "Checking this tab…" above live controls that did nothing — which reads as a
    // frozen extension rather than as a failure. Whatever went wrong, say so.
    console.debug('[Playback Speed Slider] could not inspect this tab:', error);
    setStatus('Could not inspect this tab. Reload the page and try again.', 'warn');
    setControlsEnabled(false);
    reloadButton.hidden = false;
  }
}

/**
 * Works out what this popup should say about the active tab, and what it should offer.
 *
 * The slider follows whether *any* frame here is controlled, not whether the top one
 * is. On a page whose player is an embed, the page itself may never be enabled and
 * never need to be.
 */
async function renderSiteState() {
  activeTabId = null;
  frameList.replaceChildren();
  reloadButton.hidden = true;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;

  let url = null;
  try {
    url = new URL(tab?.url ?? '');
  } catch (error) {
    url = null;
  }

  // Only https can be enabled: it is the whole of what optional_host_permissions
  // declares, so asking for anything else would be refused by Chrome.
  if (!url || url.protocol !== 'https:' || activeTabId === null) {
    setStatus('This tab is not a video site. The speed applies to the sites you enabled.');
    setControlsEnabled(true);
    return;
  }

  let frames = [];
  try {
    frames = await probeFrames(activeTabId);
  } catch (error) {
    setStatus('Could not reach this tab. Reload the page and try again.', 'warn');
    setControlsEnabled(false);
    reloadButton.hidden = false;
    return;
  }

  const origins = await describeOrigins(collectOrigins(frames));

  const grantedFrameIds = origins
    .filter((origin) => origin.granted)
    .flatMap((origin) => origin.frameIds);
  const refused = await injectInto(activeTabId, grantedFrameIds);

  for (const origin of origins) {
    frameList.append(originRow(origin, enableOrigin));
  }

  setStatus(summarise(origins));
  setControlsEnabled(origins.some((origin) => origin.granted));

  // Offered only when it would actually change something: a frame that refused the
  // injection, or an origin that is allowed but was not reachable, which is what a
  // just-granted embed looks like when its document loaded before the permission did.
  const unreachable = origins.some((origin) => origin.granted && !origin.reached);
  reloadButton.hidden = refused === 0 && !unreachable;
  if (!reloadButton.hidden) {
    setStatus('Reload the page to finish enabling it here.', 'warn');
  }
}

/**
 * Asks Chrome for one origin from the list.
 *
 * chrome.permissions.request() is called first, with nothing awaited before it, so the
 * click still counts as the user gesture Chrome requires. Chrome closes this popup
 * while its own prompt is up, in which case the callback never runs — the permission is
 * still granted, and reopening the popup shows the new state, so nothing is lost. The
 * service worker adds anything granted but unlisted to the site list, so a grant made
 * from here always shows up in the options page.
 */
function enableOrigin(origin) {
  const pattern = origin.requestPattern;
  if (!pattern) {
    setStatus(`${origin.host} cannot be enabled.`, 'warn');
    return;
  }

  try {
    chrome.permissions.request({ origins: [pattern] }, (accepted) => {
      if (chrome.runtime.lastError) {
        setStatus(`Chrome refused the request: ${chrome.runtime.lastError.message}`, 'warn');
        return;
      }
      if (!accepted) {
        setStatus(`Chrome did not grant access to ${hostLabel(pattern)}.`, 'warn');
        return;
      }
      refreshSiteState();
    });
  } catch (error) {
    // A request Chrome will not even consider throws rather than reporting through
    // lastError. Say so instead of leaving the button looking dead.
    setStatus(`Chrome refused the request: ${error.message}`, 'warn');
  }
}

reloadButton.addEventListener('click', () => {
  if (activeTabId === null) {
    return;
  }
  chrome.tabs.reload(activeTabId);
  window.close();
});

optionsButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

configureSlider();

slider.addEventListener('input', () => setRate(slider.value));
// A committed drag or keyboard nudge does not need to wait out the debounce.
slider.addEventListener('change', flushWrite);

for (const button of presetButtons) {
  button.addEventListener('click', () => {
    setRate(button.dataset.rate);
    flushWrite();
  });
}

// Both paths a popup can disappear through, so a pending write is never lost.
window.addEventListener('pagehide', flushWrite);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushWrite();
  }
});

// Keep the popup in sync if another window's popup changed the rate.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[STORAGE_KEY]) {
    return;
  }
  const rate = normalizeRate(changes[STORAGE_KEY].newValue);
  if (selfWrittenRates.delete(rate)) {
    return;
  }
  renderRate(rate);
});

chrome.storage.local.get({ [STORAGE_KEY]: DEFAULT_RATE }, (stored) => {
  if (chrome.runtime.lastError) {
    renderRate(DEFAULT_RATE);
    setStatus('Could not read the saved speed.', 'warn');
    return;
  }
  renderRate(normalizeRate(stored[STORAGE_KEY]));
  refreshSiteState();
});
