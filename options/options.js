// Options page: the site list, and whether Chrome has granted access to each entry.
//
// Those are two separate things and the page shows both. Adding a site writes it to the
// list and asks for the permission in the same click; if the user declines, the site
// stays on the list as "not granted" with a button to ask again. Removing a site takes
// it off the list and revokes the permission.
//
// Granting is a chrome.permissions.request() — a Chrome permission prompt, not
// something this page can decide — and Chrome only honours a request that is still
// inside the click that started it. Every handler below therefore calls request()
// before it awaits anything, and reads what it needs from state captured by the last
// render instead.
const {
  hostFromInput,
  patternForHost,
  hostLabel,
  coversSubdomains,
  readSites,
  addSite,
  removeSite,
} = globalThis.PlaybackSpeedSites;

const form = document.getElementById('add-form');
const input = document.getElementById('site-input');
const message = document.getElementById('message');
const list = document.getElementById('site-list');
const grantAllButton = document.getElementById('grant-all');

// What the last render saw, for the handlers that cannot afford to await first.
let listedPatterns = [];
let ungrantedPatterns = [];

function setMessage(text, tone = 'info') {
  if (!text) {
    message.hidden = true;
    message.textContent = '';
    return;
  }
  message.hidden = false;
  message.textContent = text;
  message.dataset.tone = tone;
}

function describe(pattern, granted) {
  const scope = coversSubdomains(pattern) ? 'this site and its subdomains' : 'this site only';
  return granted
    ? `Granted — ${scope}`
    : `Not granted yet — ${scope} once you allow it`;
}

function siteRow(pattern, granted) {
  const item = document.createElement('li');
  item.className = granted ? 'site' : 'site pending';

  const text = document.createElement('div');
  text.className = 'site-text';

  const host = document.createElement('span');
  host.className = 'site-host';
  host.textContent = hostLabel(pattern);

  const detail = document.createElement('span');
  detail.className = 'site-detail';
  detail.textContent = describe(pattern, granted);

  text.append(host, detail);
  item.append(text);

  if (!granted) {
    const grant = document.createElement('button');
    grant.type = 'button';
    grant.className = 'button grant';
    grant.textContent = 'Grant';
    grant.addEventListener('click', () => requestAccess([pattern]));
    item.append(grant);
  }

  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'button remove';
  remove.textContent = 'Remove';
  remove.addEventListener('click', () => forgetSite(pattern));
  item.append(remove);

  return item;
}

async function render() {
  const [sites, granted] = await Promise.all([readSites(), chrome.permissions.getAll()]);
  const grantedSet = new Set(granted.origins ?? []);

  listedPatterns = sites;
  ungrantedPatterns = sites.filter((pattern) => !grantedSet.has(pattern));

  list.replaceChildren(...sites.map((pattern) => siteRow(pattern, grantedSet.has(pattern))));

  if (sites.length === 0) {
    const note = document.createElement('li');
    note.className = 'empty';
    note.textContent = 'No sites listed. Add one above.';
    list.append(note);
  }

  grantAllButton.hidden = ungrantedPatterns.length < 2;
}

/**
 * Offers to reopen this page in a tab.
 *
 * chrome://extensions embeds the options page in an iframe, and a permission prompt
 * raised from inside that frame can be refused by the browser. The page itself opened
 * in a tab has no such problem, so the fallback is worth one click rather than leaving
 * the user with a button that silently does nothing.
 */
function offerTabFallback() {
  const link = document.createElement('button');
  link.type = 'button';
  link.className = 'button';
  link.textContent = 'Open this page in a tab';
  link.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html') });
  });
  message.append(' ', link);
}

/**
 * Asks Chrome for one or more sites. Must be called straight out of a click.
 *
 * `onAccepted` runs only if the user approved; everything else is reported here, so
 * each caller is left with the one case it actually cares about.
 */
function requestAccess(patterns, onAccepted = null) {
  const label = patterns.length === 1 ? hostLabel(patterns[0]) : `${patterns.length} sites`;
  try {
    chrome.permissions.request({ origins: patterns }, (accepted) => {
      if (chrome.runtime.lastError) {
        setMessage(`Chrome refused the request: ${chrome.runtime.lastError.message}`, 'warn');
        offerTabFallback();
        return;
      }
      if (!accepted) {
        setMessage(`Chrome did not grant access to ${label}.`, 'warn');
        render();
        return;
      }
      setMessage(`${label} granted. Reload any open tab on it to start controlling speed.`);
      onAccepted?.();
      render();
    });
  } catch (error) {
    // A click Chrome did not accept as a gesture throws here rather than reporting
    // through lastError, and an uncaught throw would leave the page looking inert.
    setMessage(`Chrome refused the request: ${error.message}`, 'warn');
    offerTabFallback();
  }
}

// Not async, and request() comes before the list write: the click is spent the moment
// anything is awaited.
form.addEventListener('submit', (event) => {
  event.preventDefault();

  const host = hostFromInput(input.value);
  if (!host) {
    setMessage('That does not look like a site address. Try example.com.', 'warn');
    return;
  }

  const pattern = patternForHost(host);
  if (listedPatterns.includes(pattern)) {
    setMessage(`${host} is already on the list.`);
    input.value = '';
    return;
  }

  input.value = '';
  // The site joins the list whether or not Chrome grants it, so a declined prompt
  // leaves something to retry rather than losing what was typed.
  addSite(pattern).then(render);
  requestAccess([pattern]);
});

grantAllButton.addEventListener('click', () => {
  if (ungrantedPatterns.length === 0) {
    return;
  }
  requestAccess(ungrantedPatterns);
});

async function forgetSite(pattern) {
  const host = hostLabel(pattern);
  await removeSite(pattern);
  try {
    // Revoking is not a prompt and needs no gesture, so awaiting the list write first
    // is safe here. A permission that was never granted removes as a no-op.
    await chrome.permissions.remove({ origins: [pattern] });
    setMessage(`${host} removed. The slider stops working there once its tabs are reloaded.`);
  } catch (error) {
    setMessage(
      `${host} was removed from the list, but Chrome kept the permission: ${error.message}`,
      'warn'
    );
  }
  await render();
}

// The popup, another window's options page, or chrome://extensions itself can change
// either half of this while the page is open.
chrome.permissions.onAdded.addListener(render);
chrome.permissions.onRemoved.addListener(render);
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[globalThis.PlaybackSpeedSites.SITES_KEY]) {
    render();
  }
});

render();
