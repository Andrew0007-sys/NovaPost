const CONFIG = {
  base: 'https://andrew0007-sys.github.io/NovaPost/data',

  area:     '[data-np-region]',
  city:     '[data-np-city]',
  branch:   '[data-np-branch]',
  postomat: '[data-np-postomat]',

  radioName: 'Shipment-type',

  /** Radio value -> internal mode. Any other value is none of our business. */
  modes: {
    'Nova post branch': 'b',
    'Nova Post locker': 'p',
    'Nova Post address': 'address',
  },

  empty: 'Немає доступних точок',
  failed: 'Не вдалось завантажити список — зв\'яжіться з менеджером',
};

const uk = new Intl.Collator('uk');
const $ = sel => document.querySelector(sel);

const el = {
  area: $(CONFIG.area),
  city: $(CONFIG.city),
  branch: $(CONFIG.branch),
  postomat: $(CONFIG.postomat),
};

/** Placeholders are already set in Webflow as the first <option> - reuse them. */
const ph = {};
for (const [key, node] of Object.entries(el)) {
  ph[key] = node?.options?.[0]?.text ?? '';
}

const state = {
  idx: null,
  areaRef: null,
  cityRef: null,
  settlements: [],
  points: {},
  type: null,
};

/* ---------- loading ---------- */

const mem = new Map();

/**
 * Some browser extensions register their own default Trusted Types policy.
 * If their context dies, assigning script.src throws. Use our own policy
 * so we never depend on theirs.
 */
let ttPolicy = null;
try {
  ttPolicy = window.trustedTypes?.createPolicy?.('np-data', { createScriptURL: u => u }) ?? null;
} catch {}

function loadScript(name) {
  return new Promise((resolve, reject) => {
    window.__np = window.__np || {};
    if (window.__np[name]) return resolve(window.__np[name]);

    const url = `${CONFIG.base}/${name}.js`;
    const s = document.createElement('script');
    s.async = true;
    // A script tag gives no HTTP status: 404 and a dropped connection look alike.
    s.onload = () => window.__np[name]
      ? resolve(window.__np[name])
      : reject(new Error(`${name}: empty`));
    s.onerror = () => reject(new Error(`${name}: failed to load`));

    try {
      s.src = ttPolicy ? ttPolicy.createScriptURL(url) : url;
    } catch {
      return reject(new Error(`${name}: blocked by browser policy`));
    }

    document.head.append(s);
  });
}

async function load(name) {
  if (mem.has(name)) return mem.get(name);

  const stamp = state.idx?.updated ?? '';
  const key = `np:${stamp}:${name}`;

  try {
    const hit = localStorage.getItem(key);
    if (hit) {
      const data = JSON.parse(hit);
      mem.set(name, data);
      return data;
    }
  } catch {}

  const data = await loadScript(name);
  mem.set(name, data);

  // Quota may overflow - never a reason to break checkout.
  try {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('np:') && !k.startsWith(`np:${stamp}:`)) localStorage.removeItem(k);
    }
    localStorage.setItem(key, JSON.stringify(data));
  } catch {}

  return data;
}

/* ---------- populating ---------- */

/**
 * Replaces options, keeping the current value if it is still available.
 * `disabled` and `required` are left alone - the field visibility
 * mechanism owns them.
 */
function fill(select, items, placeholder) {
  if (!select) return;

  const prev = select.value;
  select.innerHTML = '';

  const first = new Option(placeholder, '');
  first.disabled = true;
  first.selected = true;
  select.append(first);

  for (const [value, label] of items) select.append(new Option(label, value));

  if (prev && items.some(([v]) => v === prev)) select.value = prev;
}

const cityLabel = s => (s.raion ? `${s.name} (${s.raion} р-н)` : s.name);
const pointLabel = p => `№${p[1]} — ${p[2]}`;

/** Which point select is active depends on the current mode. */
const pointEl = () => (state.type === 'p' ? el.postomat : el.branch);
const pointPh = () => (state.type === 'p' ? ph.postomat : ph.branch);

/* ---------- levels ---------- */

async function initAreas() {
  state.idx = await load('areas');
  fill(el.area, state.idx.areas.map(a => [a.ref, a.name]), ph.area);
}

async function onAreaChange(areaRef) {
  state.areaRef = areaRef;
  state.cityRef = null;
  if (!areaRef) return;

  const s = await load(`area-${areaRef}-s`);
  state.settlements = s.settlements;

  if (state.type === 'b' || state.type === 'p') {
    const f = await load(`area-${areaRef}-${state.type}`);
    state.points[state.type] = f.s;
  }

  renderCities();
  clearPoints();
}

function renderCities() {
  if (!state.settlements.length) return;

  // Only settlements that actually have points of the requested type.
  const list = state.settlements
    .filter(s => state.type === 'address' || (state.type === 'p' ? s.np : s.nb) > 0)
    .sort((a, b) => uk.compare(a.name, b.name));

  fill(el.city, list.map(s => [s.ref, cityLabel(s)]), ph.city);

  // The chosen city survives a radio switch if it exists in the new mode.
  if (state.cityRef && list.some(s => s.ref === state.cityRef)) {
    el.city.value = state.cityRef;
  } else {
    state.cityRef = null;
  }
}

async function onCityChange(cityRef) {
  state.cityRef = cityRef;
  if (!cityRef || (state.type !== 'b' && state.type !== 'p')) return;

  const city = state.settlements.find(s => s.ref === cityRef);
  if (!city) return;

  const count = state.type === 'p' ? city.np : city.nb;

  // Large settlements live in their own file; the rest are already in memory.
  const list = count > state.idx.big
    ? (await load(`city-${cityRef}-${state.type}`)).w
    : (state.points[state.type]?.[cityRef] ?? []);

  fill(pointEl(), list.map(p => [p[0], pointLabel(p)]),
       list.length ? pointPh() : CONFIG.empty);
}

function clearPoints() {
  fill(el.branch, [], ph.branch);
  fill(el.postomat, [], ph.postomat);
}

/* ---------- radio ---------- */

async function onTypeChange(value) {
  const mode = CONFIG.modes[value] ?? null;

  // Ukrposhta and pickup are not ours - touch nothing, clear nothing.
  if (!mode) { state.type = null; return; }

  state.type = mode;

  if (state.areaRef && (mode === 'b' || mode === 'p') && !state.points[mode]) {
    const f = await load(`area-${state.areaRef}-${mode}`);
    state.points[mode] = f.s;
  }

  // Region and city are NOT reset - they do not depend on the delivery type.
  if (state.areaRef) renderCities();

  clearPoints();
  if (state.cityRef) await onCityChange(state.cityRef);
}

/* ---------- start ---------- */

el.area?.addEventListener('change', e => onAreaChange(e.target.value));
el.city?.addEventListener('change', e => onCityChange(e.target.value));

const radios = document.querySelectorAll(`input[name="${CONFIG.radioName}"]`);
radios.forEach(r => r.addEventListener('change', e => onTypeChange(e.target.value)));

// One radio is already checked on load - pick up the initial mode from it.
state.type = CONFIG.modes[[...radios].find(r => r.checked)?.value] ?? null;

initAreas().catch(e => {
  console.error('[np]', e);
  // A dead select with no explanation on a payment page is the worst outcome.
  fill(el.area, [], CONFIG.failed);
});