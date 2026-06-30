/* ---------- Config ---------- */
const CONFIG_KEY = 'recipeAppConfig';
// Public repo the app reads recipes from by default. Browsing is anonymous
// (the repo is public), so no token is needed just to view recipes. A token
// is only required to add/edit/delete, and is supplied via Settings.
const DEFAULT_REPO = { owner: 'sjoerdkoelewijn', repo: 'recipes', branch: 'main' };
function getConfig(){ try{ return JSON.parse(localStorage.getItem(CONFIG_KEY)) || null; }catch(e){ return null; } }
function setConfig(cfg){ localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); }
// Effective repo settings: any stored overrides layered on the public defaults.
function repoCfg(){
  const c = getConfig() || {};
  return {
    owner: c.owner || DEFAULT_REPO.owner,
    repo: c.repo || DEFAULT_REPO.repo,
    branch: c.branch || DEFAULT_REPO.branch,
    token: c.token || ''
  };
}
// Adding or editing recipes (write access) requires a personal access token.
function canEdit(){ return !!repoCfg().token; }

/* ---------- base64 helpers (UTF-8 safe) ---------- */
function b64EncodeUnicode(str){
  return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode('0x' + p1)));
}
function b64DecodeUnicode(str){
  return decodeURIComponent(atob(str).split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
}

/* ---------- GitHub API ---------- */
const gh = {
  apiBase(){ const c = repoCfg(); return `https://api.github.com/repos/${c.owner}/${c.repo}`; },
  headers(json=true){
    const c = repoCfg();
    const h = { 'Accept': 'application/vnd.github+json' };
    if(c && c.token) h['Authorization'] = `Bearer ${c.token}`;
    if(json) h['Content-Type'] = 'application/json';
    return h;
  },
  async getFile(path){
    const c = repoCfg();
    // Cache-bust (unique query + no-store) so a freshly added or edited recipe
    // shows up immediately instead of a stale browser/CDN copy of index.json.
    const url = `${this.apiBase()}/contents/${path}?ref=${c.branch||'main'}&t=${Date.now()}`;
    const res = await fetch(url, { headers: this.headers(false), cache: 'no-store' });
    if(res.status === 404) return null;
    if(!res.ok) throw new Error(`GitHub read failed (${res.status})`);
    const data = await res.json();
    return { sha: data.sha, text: b64DecodeUnicode(data.content.replace(/\n/g,'')) };
  },
  async putFile(path, text, message, sha){
    const c = repoCfg();
    const body = { message, content: b64EncodeUnicode(text), branch: c.branch||'main' };
    if(sha) body.sha = sha;
    const res = await fetch(`${this.apiBase()}/contents/${path}`, {
      method: 'PUT', headers: this.headers(true), body: JSON.stringify(body)
    });
    if(!res.ok){ const t = await res.text(); throw new Error(`GitHub write failed (${res.status}): ${t}`); }
    return res.json();
  },
  async putImage(path, base64Data, message, sha){
    const c = repoCfg();
    const body = { message, content: base64Data, branch: c.branch||'main' };
    if(sha) body.sha = sha;
    const res = await fetch(`${this.apiBase()}/contents/${path}`, {
      method: 'PUT', headers: this.headers(true), body: JSON.stringify(body)
    });
    if(!res.ok){ const t = await res.text(); throw new Error(`Image upload failed (${res.status}): ${t}`); }
    return res.json();
  },
  async deleteFile(path, message, sha){
    const c = repoCfg();
    const res = await fetch(`${this.apiBase()}/contents/${path}`, {
      method: 'DELETE', headers: this.headers(true), body: JSON.stringify({ message, sha, branch: c.branch||'main' })
    });
    if(!res.ok) throw new Error(`Delete failed (${res.status})`);
  }
};

/* ---------- Index (recipes/index.json) for fast list rendering ---------- */
async function getIndex(){
  const file = await gh.getFile('recipes/index.json');
  if(!file) return { sha: null, entries: [] };
  try{ return { sha: file.sha, entries: JSON.parse(file.text) }; }
  catch(e){ return { sha: file.sha, entries: [] }; }
}
async function saveIndex(entries, sha){
  const text = JSON.stringify(entries, null, 2);
  return gh.putFile('recipes/index.json', text, 'Update recipe index', sha);
}

/* ---------- Recipe markdown format ----------
---
{ "title": "...", "image": "images/x.jpg", "ingredients": [{"id","name","amount","unit"}] }
---
1. Step text with {ingredientId} placeholders
2. ...
------------------------------------------------- */
function parseRecipe(raw){
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if(!match) throw new Error('Kon receptbestand niet lezen (frontmatter ontbreekt).');
  const meta = JSON.parse(match[1]);
  const body = match[2];
  const steps = [];
  body.split('\n').forEach(line => {
    const m = line.match(/^\s*\d+\.\s+(.*)$/);
    if(m) steps.push(m[1].trim());
  });
  meta.steps = steps;
  return meta;
}
function serializeRecipe(r){
  const meta = { title: r.title, image: r.image || '', tags: r.tags || [], ingredients: r.ingredients };
  const stepsText = r.steps.map((s,i) => `${i+1}. ${s}`).join('\n');
  return `---\n${JSON.stringify(meta, null, 2)}\n---\n\n${stepsText}\n`;
}

/* Public site root (GitHub Pages). Used to build absolute share/OG URLs. */
const SITE_BASE = 'https://sjoerdkoelewijn.github.io/recipes';
function escAttr(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
/* A tiny per-recipe HTML page that carries the recipe's Open Graph tags (so
   link previews show its title + photo) and then redirects into the app.
   Scrapers don't run JS, so per-recipe previews need a real HTML file. */
function buildSharePage(slug, title, imagePath){
  const t = escAttr(title);
  const img = escAttr(imagePath ? `${SITE_BASE}/recipes/${imagePath}` : `${SITE_BASE}/og-image.jpg`);
  const target = `../#/r/${encodeURIComponent(slug)}`;
  const url = `${SITE_BASE}/r/${encodeURIComponent(slug)}.html`;
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="UTF-8">
<title>${t} — KoeleKook</title>
<meta property="og:type" content="article">
<meta property="og:site_name" content="KoeleKook">
<meta property="og:title" content="${t}">
<meta property="og:description" content="Bekijk dit recept op KoeleKook.">
<meta property="og:url" content="${escAttr(url)}">
<meta property="og:image" content="${img}">
<meta property="og:image:alt" content="${t}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="Bekijk dit recept op KoeleKook.">
<meta name="twitter:image" content="${img}">
<meta http-equiv="refresh" content="0;url=${target}">
<link rel="icon" href="../favicon.svg" type="image/svg+xml">
</head>
<body>
<p>Bezig met laden… <a href="${target}">Open ${t}</a></p>
<script>location.replace(${JSON.stringify(target)});</script>
</body>
</html>
`;
}

/* Recipe tags, grouped by category. Stored values are the slugs; labels are
   for display. Filtering is OR within a group and AND across groups. */
const TAG_GROUPS = [
  { label: 'Type', tags: [
    { value: 'hartig', label: 'Hartig' },
    { value: 'zoet', label: 'Zoet' }
  ]},
  { label: 'Dieet', tags: [
    { value: 'fodmap', label: 'Fodmap' },
    { value: 'vega', label: 'Vega' }
  ]}
];
const ALL_TAGS = TAG_GROUPS.flatMap(g => g.tags.map(t => t.value));
const TAG_LABELS = {};
TAG_GROUPS.forEach(g => g.tags.forEach(t => { TAG_LABELS[t.value] = t.label; }));
function tagLabel(t){ return TAG_LABELS[t] || (t.charAt(0).toUpperCase() + t.slice(1)); }

/* Render the grouped tag chips into a container. Toggling a chip updates the
   given Set; onToggle (optional) fires after each change. Reused by the
   recipe form and the overview filter panel. */
function buildTagGroups(container, selectedSet, onToggle){
  container.innerHTML = '';
  TAG_GROUPS.forEach(group => {
    const wrap = document.createElement('div');
    wrap.className = 'tag-group';
    const label = document.createElement('span');
    label.className = 'tag-group-label';
    label.textContent = group.label;
    const row = document.createElement('div');
    row.className = 'tag-select';
    group.tags.forEach(t => {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (selectedSet.has(t.value) ? ' selected' : '');
      chip.dataset.tag = t.value;
      chip.textContent = t.label;
      chip.setAttribute('aria-pressed', selectedSet.has(t.value) ? 'true' : 'false');
      chip.addEventListener('click', () => {
        if(selectedSet.has(t.value)) selectedSet.delete(t.value); else selectedSet.add(t.value);
        const on = selectedSet.has(t.value);
        chip.classList.toggle('selected', on);
        chip.setAttribute('aria-pressed', on ? 'true' : 'false');
        if(onToggle) onToggle();
      });
      row.appendChild(chip);
    });
    wrap.append(label, row);
    container.appendChild(wrap);
  });
}

/* A sample recipe used for the downloadable .md template. Serialized with the
   same serializeRecipe() the app writes with, so the example always matches
   the current schema. Supported units: g, kg, ml, l, tsp, tbsp, cup, pcs. */
const EXAMPLE_RECIPE = {
  title: 'Voorbeeldrecept',
  image: 'images/voorbeeldrecept.jpg',
  tags: ['zoet'],
  ingredients: [
    { id: 'bloem', name: 'Bloem', amount: 250, unit: 'g' },
    { id: 'melk', name: 'Melk', amount: 400, unit: 'ml' },
    { id: 'eieren', name: 'Eieren', amount: 2, unit: 'pcs' },
    { id: 'zout', name: 'Zout', amount: 0.25, unit: 'tsp' }
  ],
  steps: [
    'Klop {bloem} en {zout} samen in een kom.',
    'Voeg geleidelijk {melk} toe tot een glad beslag.',
    'Klop de {eieren} erdoor.',
    'Bak in een hete, ingevette pan tot beide kanten goudbruin zijn.'
  ]
};
function downloadText(filename, text){
  const blob = new Blob([text], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* ---------- Scaling ---------- */
const WEIGHT_UNITS = { g: 1, kg: 1000 };
function computeBaseWeight(ingredients){
  let total = 0, hasWeight = false;
  ingredients.forEach(i => { if(WEIGHT_UNITS[i.unit]){ total += i.amount * WEIGHT_UNITS[i.unit]; hasWeight = true; } });
  if(hasWeight) return Math.round(total);
  const fallback = ingredients.reduce((s,i) => s + Number(i.amount||0), 0);
  return fallback || 1;
}
function formatAmount(amount, unit){
  if(unit === 'g' || unit === 'ml') return amount >= 10 ? Math.round(amount) : Math.round(amount*10)/10;
  if(unit === 'kg' || unit === 'l') return Math.round(amount*100)/100;
  if(unit === 'pcs') return Math.max(1, Math.round(amount)); // whole pieces (e.g. eggs), never 0
  return Math.round(amount*4)/4; // tsp, tbsp, cup -> quarter precision
}
function amountText(amount, unit){
  const v = formatAmount(amount, unit);
  return unit === 'pcs' ? `${v}` : `${v} ${unit}`;
}
function scaleIngredients(ingredients, factor){
  return ingredients.map(i => ({ ...i, amount: i.amount * factor }));
}
// Drop parenthetical notes like "(bestellen bij de bakker)" — useful in the
// ingredient list, but redundant when the name is woven into a step.
function stripParenthetical(name){
  return name.replace(/\s*\([^)]*\)/g, '').trim();
}
function substitutePlaceholders(text, scaledById){
  return text.replace(/\{([a-zA-Z0-9_-]+)\}/g, (whole, id) => {
    const ing = scaledById[id];
    if(!ing) return whole;
    const shortName = stripParenthetical(ing.name) || ing.name;
    const lowerName = shortName.charAt(0).toLowerCase() + shortName.slice(1);
    // Keep the number+unit on one line; let the name wrap if space is tight.
    return `<span class="step-amt"><span class="step-amt-num">${amountText(ing.amount, ing.unit)}</span> ${escapeHtml(lowerName)}</span>`;
  });
}

/* ---------- Utility ---------- */
function slugify(text){
  return text.toString().toLowerCase().trim()
    .replace(/[^\w\s-]/g, '').replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'recipe';
}
async function uniqueSlug(base, existingSlugs){
  let slug = base, n = 2;
  while(existingSlugs.includes(slug)){ slug = `${base}-${n}`; n++; }
  return slug;
}
function compressImage(file, maxWidth=1200, quality=0.82){
  return new Promise((resolve, reject) => {
    const img = new Image();
    const reader = new FileReader();
    reader.onload = e => { img.src = e.target.result; };
    reader.onerror = reject;
    img.onload = () => {
      const scale = Math.min(1, maxWidth / img.width);
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve({ base64: dataUrl.split(',')[1], dataUrl });
    };
    img.onerror = reject;
    reader.readAsDataURL(file);
  });
}
function escapeHtml(s){ const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

/* Placeholder shown when a recipe has no photo (or its photo fails to load):
   a neutral plate with a steaming bowl, drawn inline so no asset is needed. */
const FALLBACK_IMG = 'data:image/svg+xml,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">` +
  `<rect width="400" height="400" fill="#f2f2f2"/>` +
  `<g fill="none" stroke="#c4c4c4" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M112 214h176"/>` +
  `<path d="M126 214a74 74 0 0 0 148 0"/>` +
  `<path d="M176 150c0-16 12-22 12-40m24 40c0-16 12-22 12-40"/>` +
  `</g></svg>`
);
// Point an <img> at the fallback and keep it there even if a later src 404s.
function useFallback(img){ img.onerror = () => { img.onerror = null; img.src = FALLBACK_IMG; }; }

/* ---------- Router ---------- */
const appEl = document.getElementById('app');
const topLogo = document.getElementById('topLogo');
const topTitleText = document.getElementById('topTitleText');
const backBtn = document.getElementById('backBtn');
const addBtn = document.getElementById('addBtn');
const navSearchBtn = document.getElementById('navSearchBtn');
const navSearch = document.getElementById('navSearch');
const navSearchClose = document.getElementById('navSearchClose');
const searchInput = document.getElementById('searchInput');

const settingsBtn = document.getElementById('settingsBtn');
const gotoSettingsBtn = document.getElementById('gotoSettingsBtn');
const shareBtn = document.getElementById('shareBtn');
const filterPanel = document.getElementById('filterPanel');
const filterGroups = document.getElementById('filterGroups');
const topbarEl = document.querySelector('.topbar');
const activeTags = new Set();      // tags currently filtered on
let redrawList = null;             // set by renderList so the filter can re-apply

window.addEventListener('hashchange', render);
backBtn.addEventListener('click', () => { location.hash = '#/'; });
addBtn.addEventListener('click', () => { location.hash = '#/new'; });
gotoSettingsBtn.addEventListener('click', () => { location.hash = '#/settings'; });

/* ---- Brief toast message (e.g. "Link gekopieerd") ---- */
let toastTimer = null;
function showToast(message){
  let el = document.getElementById('toast');
  if(!el){ el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

/* ---- Share: copy the recipe's share-page link (carries its OG preview) ---- */
shareBtn.addEventListener('click', async () => {
  const m = location.hash.match(/^#\/r\/(.+)$/);
  const url = m ? `${SITE_BASE}/r/${m[1]}.html` : location.href;
  try{
    await navigator.clipboard.writeText(url);
    showToast('Link gekopieerd');
  }catch(e){
    // Fallback for browsers without clipboard API / permission.
    const ta = document.createElement('textarea');
    ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try{ document.execCommand('copy'); showToast('Link gekopieerd'); }
    catch(_){ showToast('Kopiëren mislukt'); }
    ta.remove();
  }
});

/* ---- "Voeg toe als app" banner: only in a browser, not the installed app ---- */
const installBanner = document.getElementById('installBanner');
let deferredInstallPrompt = null;
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
if(!isStandalone){ installBanner.hidden = false; }
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; });
installBanner.addEventListener('click', async () => {
  if(deferredInstallPrompt){
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if(outcome === 'accepted') installBanner.hidden = true;
  }else{
    // iOS / unsupported: no programmatic install, so guide the user.
    showToast('Tik op Delen → Zet op beginscherm');
  }
});
window.addEventListener('appinstalled', () => { installBanner.hidden = true; });

/* ---- Top-bar search: icon expands the input across the bar ---- */
function openSearch(){
  closeFilter();
  navSearch.dataset.open = 'true';
  navSearchBtn.setAttribute('aria-expanded', 'true');
  searchInput.focus();
}
function closeSearch(){
  navSearch.dataset.open = 'false';
  navSearchBtn.setAttribute('aria-expanded', 'false');
  if(searchInput.value){ searchInput.value = ''; searchInput.dispatchEvent(new Event('input')); }
}
navSearchBtn.addEventListener('click', openSearch);
navSearchClose.addEventListener('click', closeSearch);
searchInput.addEventListener('keydown', (e) => { if(e.key === 'Escape') closeSearch(); });

/* ---- Tag filter: the gear icon opens a panel of tag toggles ---- */
function positionFilterPanel(){
  // Anchor just below the sticky, variable-height top bar.
  filterPanel.style.top = topbarEl.getBoundingClientRect().bottom + 'px';
}
function openFilter(){ closeSearch(); positionFilterPanel(); filterPanel.dataset.open = 'true'; settingsBtn.setAttribute('aria-expanded', 'true'); }
function closeFilter(){ filterPanel.dataset.open = 'false'; settingsBtn.setAttribute('aria-expanded', 'false'); }
settingsBtn.addEventListener('click', () => { filterPanel.dataset.open === 'true' ? closeFilter() : openFilter(); });
document.addEventListener('click', (e) => {
  if(filterPanel.dataset.open === 'true' && !filterPanel.contains(e.target) && !settingsBtn.contains(e.target)) closeFilter();
});
buildTagGroups(filterGroups, activeTags, () => { if(redrawList) redrawList(); });

function setChrome({ title, showBack, showAdd, showSearch, showFilter, showSettings, showShare, logo }){
  // The home view shows the wordmark logo; other views show a text title.
  topLogo.hidden = !logo;
  topTitleText.textContent = logo ? '' : title;
  backBtn.hidden = !showBack;
  addBtn.hidden = !showAdd;
  navSearchBtn.hidden = !showSearch;
  settingsBtn.hidden = !showFilter;
  gotoSettingsBtn.hidden = !showSettings;
  shareBtn.hidden = !showShare;
  // Collapse search / filter whenever we leave a view that uses them.
  if(!showSearch){ navSearch.dataset.open = 'false'; navSearchBtn.setAttribute('aria-expanded', 'false'); searchInput.value = ''; }
  if(!showFilter){ closeFilter(); }
}

async function render(){
  const hash = location.hash || '#/';
  // Viewing is open to everyone. Only the write routes need a token; bounce
  // those to Settings so the user can paste one before adding/editing.
  const needsToken = hash === '#/new' || /^#\/edit\//.test(hash);
  if(needsToken && !canEdit()){ location.hash = '#/settings'; return; }

  if(hash === '#/' ) return renderList();
  if(hash === '#/settings') return renderSettings();
  if(hash === '#/new') return renderForm(null);
  let m = hash.match(/^#\/r\/(.+)$/); if(m) return renderDetail(decodeURIComponent(m[1]));
  m = hash.match(/^#\/edit\/(.+)$/); if(m) return renderForm(decodeURIComponent(m[1]));
  return renderList();
}

/* ---------- List view ---------- */
async function renderList(){
  // The + is shown to everyone; the router sends visitors without a valid
  // token to Settings, and token holders to the new-recipe form.
  setChrome({ title: 'KoeleKook', showBack: false, showAdd: true, showSearch: true, showFilter: true, logo: true });
  appEl.innerHTML = document.getElementById('tpl-list').innerHTML;
  const grid = document.getElementById('cardGrid');
  const empty = document.getElementById('emptyState');
  const loading = document.getElementById('loadingState');

  let entries = [];
  try{
    const idx = await getIndex();
    entries = idx.entries;
  }catch(e){
    loading.textContent = 'Kon recepten niet laden: ' + e.message;
    return;
  }
  loading.hidden = true;

  function draw(list){
    grid.innerHTML = '';
    list.forEach(entry => {
      const node = document.getElementById('tpl-card').content.cloneNode(true);
      const a = node.querySelector('a');
      a.href = `#/r/${encodeURIComponent(entry.slug)}`;
      const img = node.querySelector('img');
      useFallback(img);
      if(entry.image){ const c = repoCfg(); img.src = `https://raw.githubusercontent.com/${c.owner}/${c.repo}/${c.branch}/recipes/${entry.image}`; }
      else { img.src = FALLBACK_IMG; }
      node.querySelector('h3').textContent = entry.title;
      // Show up to the 3 most important tags (list order = priority).
      const tagsEl = node.querySelector('.card-tags');
      (entry.tags || []).slice(0, 3).forEach(t => {
        const pill = document.createElement('span');
        pill.className = 'card-tag';
        pill.textContent = tagLabel(t);
        tagsEl.appendChild(pill);
      });
      grid.appendChild(node);
    });
  }
  // Apply the search text and the active tag filter together.
  function apply(){
    const q = searchInput.value.trim().toLowerCase();
    const list = entries.filter(e => {
      const matchesText = !q || e.title.toLowerCase().includes(q);
      const rt = e.tags || [];
      // OR within a group, AND across groups: each group that has a selection
      // must be satisfied by at least one of the recipe's tags.
      const matchesTags = TAG_GROUPS.every(group => {
        const sel = group.tags.map(t => t.value).filter(v => activeTags.has(v));
        return sel.length === 0 || sel.some(v => rt.includes(v));
      });
      return matchesText && matchesTags;
    });
    draw(list);
    empty.hidden = list.length !== 0;
    empty.textContent = entries.length === 0
      ? 'Nog geen recepten. Tik op + om je eerste toe te voegen.'
      : 'Geen recepten gevonden.';
  }
  apply();
  // The search input lives in the persistent top bar; property assignment
  // (re)binds without stacking duplicate handlers across re-renders.
  searchInput.oninput = apply;
  // Let the tag-filter chips trigger a redraw with the current entries.
  redrawList = apply;
}

/* ---------- Detail view ---------- */
async function renderDetail(slug){
  setChrome({ title: 'Recept', showBack: true, showAdd: false, showShare: true });
  appEl.innerHTML = '<p class="empty">Laden…</p>';
  let file;
  try{ file = await gh.getFile(`recipes/${slug}.md`); }
  catch(e){ appEl.innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`; return; }
  if(!file){ appEl.innerHTML = '<p class="empty">Recept niet gevonden.</p>'; return; }

  const recipe = parseRecipe(file.text);
  const baseWeight = computeBaseWeight(recipe.ingredients);

  appEl.innerHTML = document.getElementById('tpl-detail').innerHTML;
  topTitleText.textContent = recipe.title;
  document.getElementById('detailTitle').textContent = recipe.title;
  const img = appEl.querySelector('.detail-photo img');
  useFallback(img);
  if(recipe.image){
    const c = repoCfg();
    img.src = `https://raw.githubusercontent.com/${c.owner}/${c.repo}/${c.branch}/recipes/${recipe.image}`;
  } else {
    img.src = FALLBACK_IMG;
  }

  const weightInput = document.getElementById('weightInput');
  weightInput.value = baseWeight;

  function draw(){
    const target = Number(weightInput.value) || baseWeight;
    const factor = target / baseWeight;
    const scaled = scaleIngredients(recipe.ingredients, factor);
    const byId = {}; scaled.forEach(i => byId[i.id] = i);

    const ul = document.getElementById('ingredientList');
    ul.innerHTML = '';
    scaled.forEach(i => {
      const li = document.createElement('li');
      li.innerHTML = `<span>${escapeHtml(i.name)}</span><span class="ingredient-amount">${amountText(i.amount, i.unit)}</span>`;
      ul.appendChild(li);
    });

    const ol = document.getElementById('stepList');
    ol.innerHTML = '';
    recipe.steps.forEach(s => {
      const li = document.createElement('li');
      // Wrap the text in a single element so the <li> flex layout has just
      // two items (number + text); otherwise each amount span becomes its
      // own flex item and the words stack into columns on narrow screens.
      li.innerHTML = `<span class="step-text">${substitutePlaceholders(escapeHtml(s), byId)}</span>`;
      ol.appendChild(li);
    });
  }
  draw();
  weightInput.addEventListener('input', draw);
  appEl.querySelectorAll('.scale-step').forEach(btn => {
    btn.addEventListener('click', () => {
      const dir = Number(btn.dataset.dir);
      weightInput.value = Math.max(1, (Number(weightInput.value)||baseWeight) + dir*50);
      draw();
    });
  });
  document.getElementById('resetScaleBtn').addEventListener('click', () => { weightInput.value = baseWeight; draw(); });
  const editBtn = document.getElementById('editBtn');
  editBtn.hidden = !canEdit();
  editBtn.addEventListener('click', () => { location.hash = `#/edit/${encodeURIComponent(slug)}`; });

  // Fixed bottom bar: smooth-scroll to the ingredients or steps section.
  appEl.querySelectorAll('.jumpbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const el = document.getElementById(btn.dataset.target);
      if(el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

/* ---------- Form view (new / edit) ---------- */
async function renderForm(editSlug){
  setChrome({ title: editSlug ? 'Recept bewerken' : 'Nieuw recept', showBack: true, showAdd: false, showSettings: true });
  appEl.innerHTML = document.getElementById('tpl-form').innerHTML;

  let existing = null, existingSha = null, existingImageSha = null;
  if(editSlug){
    const file = await gh.getFile(`recipes/${editSlug}.md`);
    if(file){ existing = parseRecipe(file.text); existingSha = file.sha; }
    document.getElementById('deleteBtn').hidden = false;
  }

  document.getElementById('f-title').value = existing ? existing.title : '';
  let imageBase64 = null, imageChanged = false;
  if(existing && existing.image){
    const prev = document.getElementById('f-imagePreview');
    const c = repoCfg();
    prev.src = `https://raw.githubusercontent.com/${c.owner}/${c.repo}/${c.branch}/recipes/${existing.image}`;
    prev.hidden = false;
  }
  document.getElementById('f-image').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const { base64, dataUrl } = await compressImage(file);
    imageBase64 = base64; imageChanged = true;
    const prev = document.getElementById('f-imagePreview');
    prev.src = dataUrl; prev.hidden = false;
  });

  // Tag selection: grouped toggle chips (Type, Dieet).
  const selectedTags = new Set(existing && existing.tags ? existing.tags : []);
  const tagGroupsEl = document.getElementById('tagGroups');
  buildTagGroups(tagGroupsEl, selectedTags);

  const rowsEl = document.getElementById('ingredientRows');
  const chipsEl = document.getElementById('ingredientChips');
  const stepsEl = document.getElementById('stepRows');
  let lastFocusedStep = null;

  function addIngredientRow(data){
    const row = document.createElement('div');
    row.className = 'ingredient-row';
    // Remember an existing ingredient's id so it stays stable across renames.
    if(data && data.id) row.dataset.ingId = data.id;
    row.innerHTML = `
      <input type="text" class="ing-name" placeholder="Naam" value="${data ? escapeHtml(data.name) : ''}">
      <input type="number" step="any" class="ing-amount" placeholder="Hvh" value="${data ? data.amount : ''}">
      <select class="ing-unit">
        ${['g','kg','ml','l','tsp','tbsp','cup','pcs'].map(u => `<option value="${u}" ${data && data.unit===u?'selected':''}>${u}</option>`).join('')}
      </select>
      <button type="button" class="rowremove">&times;</button>`;
    row.querySelector('.rowremove').addEventListener('click', () => { row.remove(); refreshChips(); });
    row.querySelector('.ing-name').addEventListener('input', refreshChips);
    rowsEl.appendChild(row);
    refreshChips();
  }

  function currentIngredients(){
    const rows = [...rowsEl.querySelectorAll('.ingredient-row')]
      .filter(r => r.querySelector('.ing-name').value.trim());
    // Reserve the stable ids of existing ingredients first, then derive a
    // fresh, collision-free id for any brand-new ingredient from its name.
    const used = new Set();
    rows.forEach(r => { if(r.dataset.ingId) used.add(r.dataset.ingId); });
    return rows.map(row => {
      const name = row.querySelector('.ing-name').value.trim();
      let id = row.dataset.ingId;
      if(!id){
        let base = slugify(name) || 'ingredient', candidate = base, n = 2;
        while(used.has(candidate)) candidate = `${base}-${n++}`;
        id = candidate; used.add(id);
      }
      return {
        name,
        id,
        amount: Number(row.querySelector('.ing-amount').value) || 0,
        unit: row.querySelector('.ing-unit').value
      };
    });
  }

  function refreshChips(){
    const ings = currentIngredients();
    chipsEl.innerHTML = '';
    ings.forEach(i => {
      const chip = document.createElement('button');
      // Show the ingredient name, but insert the stable {id} into the step.
      chip.type = 'button'; chip.className = 'chip'; chip.textContent = i.name;
      chip.title = `Voegt {${i.id}} in`;
      chip.addEventListener('click', () => {
        const ta = lastFocusedStep || stepsEl.querySelector('textarea');
        if(!ta) return;
        const start = ta.selectionStart ?? ta.value.length;
        const end = ta.selectionEnd ?? ta.value.length;
        ta.value = ta.value.slice(0, start) + `{${i.id}}` + ta.value.slice(end);
        ta.focus();
      });
      chipsEl.appendChild(chip);
    });
  }

  function addStepRow(text){
    const row = document.createElement('div');
    row.className = 'step-row';
    const num = document.createElement('span');
    num.className = 'step-num';
    const ta = document.createElement('textarea');
    ta.value = text || '';
    ta.placeholder = 'Beschrijf deze stap…';
    ta.addEventListener('focus', () => { lastFocusedStep = ta; });
    const rm = document.createElement('button');
    rm.type = 'button'; rm.className = 'rowremove'; rm.innerHTML = '&times;';
    rm.addEventListener('click', () => { row.remove(); renumberSteps(); });
    row.append(num, ta, rm);
    stepsEl.appendChild(row);
    renumberSteps();
  }
  function renumberSteps(){
    [...stepsEl.querySelectorAll('.step-row')].forEach((row, idx) => { row.querySelector('.step-num').textContent = idx+1; });
  }

  if(existing){
    existing.ingredients.forEach(addIngredientRow);
    existing.steps.forEach(addStepRow);
  } else {
    addIngredientRow(); addStepRow();
  }

  document.getElementById('addIngredientBtn').addEventListener('click', () => addIngredientRow());
  document.getElementById('addStepBtn').addEventListener('click', () => addStepRow());

  // Fill every form field from a parsed recipe (used by the .md import).
  function populateFromRecipe(r){
    document.getElementById('f-title').value = r.title || '';
    selectedTags.clear();
    (r.tags || []).forEach(t => selectedTags.add(t));
    buildTagGroups(tagGroupsEl, selectedTags);
    rowsEl.innerHTML = '';
    (r.ingredients && r.ingredients.length ? r.ingredients : [undefined]).forEach(addIngredientRow);
    stepsEl.innerHTML = '';
    (r.steps && r.steps.length ? r.steps : ['']).forEach(addStepRow);
    refreshChips();
  }

  // Import .md / download example — only offered when creating a new recipe.
  const importBlock = document.getElementById('importBlock');
  if(editSlug){
    importBlock.hidden = true;
  } else {
    document.getElementById('downloadExampleBtn').addEventListener('click', () => {
      downloadText('voorbeeld-recept.md', serializeRecipe(EXAMPLE_RECIPE));
    });
    document.getElementById('f-import').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if(!file) return;
      const status = document.getElementById('formStatus');
      status.hidden = false;
      try{
        const recipe = parseRecipe(await file.text());
        populateFromRecipe(recipe);
        status.className = 'form-status success';
        status.textContent = 'Recept ingeladen — controleer de velden en sla op.';
      }catch(err){
        status.className = 'form-status error';
        status.textContent = 'Kon dit .md-bestand niet lezen: ' + err.message;
      }
      e.target.value = '';  // allow re-importing the same file
    });
  }

  document.getElementById('recipeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const status = document.getElementById('formStatus');
    status.hidden = false; status.className = 'form-status'; status.textContent = 'Opslaan…';
    try{
      const title = document.getElementById('f-title').value.trim();
      const ingredients = currentIngredients();
      const steps = [...stepsEl.querySelectorAll('textarea')].map(t => t.value.trim()).filter(Boolean);
      if(!title) throw new Error('Titel is verplicht.');
      if(ingredients.length === 0) throw new Error('Voeg minstens één ingrediënt toe.');
      if(steps.length === 0) throw new Error('Voeg minstens één stap toe.');

      const idx = await getIndex();
      let slug = editSlug;
      if(!slug){
        slug = await uniqueSlug(slugify(title), idx.entries.map(e => e.slug));
      }

      let imagePath = existing ? existing.image : '';
      if(imageChanged && imageBase64){
        imagePath = `images/${slug}.jpg`;
        const existingImgFile = await gh.getFile(`recipes/${imagePath}`).catch(() => null);
        await gh.putImage(`recipes/${imagePath}`, imageBase64, `Add photo for ${title}`, existingImgFile ? existingImgFile.sha : undefined);
      }

      const tags = ALL_TAGS.filter(t => selectedTags.has(t));
      const recipeObj = { title, image: imagePath, tags, ingredients, steps };
      const raw = serializeRecipe(recipeObj);
      await gh.putFile(`recipes/${slug}.md`, raw, editSlug ? `Update ${title}` : `Add ${title}`, existingSha || undefined);

      const baseWeightGrams = computeBaseWeight(ingredients);
      const newEntry = { slug, title, image: imagePath, tags, baseWeightGrams };
      let entries = idx.entries.filter(e => e.slug !== slug);
      entries.push(newEntry);
      entries.sort((a,b) => a.title.localeCompare(b.title));
      await saveIndex(entries, idx.sha);

      // Write the per-recipe share page (OG title + photo for link previews).
      const sharePath = `r/${slug}.html`;
      const existingShare = await gh.getFile(sharePath).catch(() => null);
      await gh.putFile(sharePath, buildSharePage(slug, title, imagePath),
        editSlug ? `Update share page for ${title}` : `Add share page for ${title}`,
        existingShare ? existingShare.sha : undefined);

      status.className = 'form-status success'; status.textContent = 'Opgeslagen!';
      location.hash = `#/r/${encodeURIComponent(slug)}`;
    }catch(err){
      status.className = 'form-status error'; status.textContent = err.message;
    }
  });

  document.getElementById('deleteBtn').addEventListener('click', async () => {
    if(!confirm('Dit recept verwijderen? Dit kan niet ongedaan worden gemaakt.')) return;
    try{
      const file = await gh.getFile(`recipes/${editSlug}.md`);
      if(file) await gh.deleteFile(`recipes/${editSlug}.md`, `Delete ${existing.title}`, file.sha);
      const share = await gh.getFile(`r/${editSlug}.html`).catch(() => null);
      if(share) await gh.deleteFile(`r/${editSlug}.html`, `Delete share page for ${existing.title}`, share.sha);
      const idx = await getIndex();
      const entries = idx.entries.filter(e => e.slug !== editSlug);
      await saveIndex(entries, idx.sha);
      location.hash = '#/';
    }catch(err){ alert(err.message); }
  });
}

/* ---------- Settings view ---------- */
function renderSettings(){
  setChrome({ title: 'Instellingen', showBack: true, showAdd: false });
  appEl.innerHTML = document.getElementById('tpl-settings').innerHTML;
  const cfg = getConfig() || {};
  // Pre-fill repo fields with the public defaults so a contributor normally
  // only needs to paste a token to unlock editing.
  document.getElementById('s-owner').value = cfg.owner || DEFAULT_REPO.owner;
  document.getElementById('s-repo').value = cfg.repo || DEFAULT_REPO.repo;
  document.getElementById('s-branch').value = cfg.branch || DEFAULT_REPO.branch;
  document.getElementById('s-token').value = cfg.token || '';

  document.getElementById('settingsForm').addEventListener('submit', (e) => {
    e.preventDefault();
    setConfig({
      owner: document.getElementById('s-owner').value.trim(),
      repo: document.getElementById('s-repo').value.trim(),
      branch: document.getElementById('s-branch').value.trim() || 'main',
      token: document.getElementById('s-token').value.trim()
    });
    const status = document.getElementById('settingsStatus');
    status.hidden = false; status.className = 'form-status success'; status.textContent = 'Opgeslagen.';
    setTimeout(() => { location.hash = '#/'; }, 500);
  });
}

render();

/* ---------- PWA install (optional, no-op if unsupported) ---------- */
if('serviceWorker' in navigator){
  // Intentionally no service worker registered: keeps this app simple and
  // always fetches the latest recipe data instead of caching it.
}
