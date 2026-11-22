import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// Deliberately dependency-free: no browser, DSH, filesystem home, or network.
// Real client code runs in a VM, against a small DOM with bubbling/capture,
// service injection lifetimes, snapshots, async fetches, and a controlled clock.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
function splitOutside(value, separator) {
  const parts = []; let start = 0, depth = 0, quote = '';
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quote) { if (c === quote && value[i - 1] !== '\\') quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[' || c === '(') depth++;
    if (c === ']' || c === ')') depth--;
    if (!depth && c === separator) { parts.push(value.slice(start, i)); start = i + 1; }
  }
  parts.push(value.slice(start)); return parts.map(s => s.trim()).filter(Boolean);
}
function matches(node, selector, scope = node) {
  return splitOutside(selector, ',').some(part => {
    const tokens = []; let buf = '', depth = 0, quote = '';
    for (const c of part) {
      if (quote) { buf += c; if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { buf += c; quote = c; continue; }
      if (c === '[' || c === '(') depth++;
      if (c === ']' || c === ')') depth--;
      if (!depth && (c === ' ' || c === '>')) {
        if (buf.trim()) { tokens.push(buf.trim()); buf = ''; }
        if (c === '>') tokens.push('>');
      } else buf += c;
    }
    if (buf.trim()) tokens.push(buf.trim());
    const check = (current, index) => {
      if (!current || !simple(current, tokens[index], scope)) return false;
      if (index === 0) return true;
      if (tokens[index - 1] === '>') return check(current.parentElement, index - 2);
      for (let p = current.parentElement; p; p = p.parentElement) if (check(p, index - 1)) return true;
      return false;
    };
    return tokens.length && check(node, tokens.length - 1);
  });
}
function simple(node, value, scope) {
  if (!value) return false;
  for (const pseudo of ['has', 'not']) {
    let at;
    while ((at = value.indexOf(`:${pseudo}(`)) >= 0) {
      let end = at + pseudo.length + 2, depth = 1;
      for (; depth && end < value.length; end++) {
        if (value[end] === '(') depth++;
        else if (value[end] === ')') depth--;
      }
      const arg = value.slice(at + pseudo.length + 2, end - 1);
      const found = pseudo === 'not' ? matches(node, arg, scope)
        : arg.startsWith('>') ? node.children.some(child => matches(child, arg.slice(1).trim(), node))
          : node.querySelector(arg) !== null;
      if (pseudo === 'not' ? found : !found) return false;
      value = value.slice(0, at) + value.slice(end);
    }
  }
  if (value.includes(':scope')) { if (node !== scope) return false; value = value.replace(':scope', ''); }
  let valid = true;
  value = value.replace(/\[([^\]=*^\s]+)\s*(?:(\^=|\*=|=)\s*["']?([^"'\]]*)["']?)?\]/g, (_, name, op, expected) => {
    const actual = node.getAttribute(name);
    if (actual === null || op === '=' && actual !== expected || op === '^=' && !actual.startsWith(expected) || op === '*=' && !actual.includes(expected)) valid = false;
    return '';
  });
  if (!valid) return false;
  const tag = value.match(/^[\w-]+/);
  if (tag && node.tagName !== tag[0].toUpperCase()) return false;
  for (const [, cls] of value.matchAll(/\.([\w-]+)/g)) if (!node.classList.contains(cls)) return false;
  for (const [, id] of value.matchAll(/#([\w-]+)/g)) if (node.id !== id) return false;
  return true;
}
class MockElement {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document; this.parentElement = null;
    this.children = []; this.attrs = new Map(); this.listeners = new Map(); this.style = {};
    this._text = ''; this.disabled = false; this.scrollTop = 0; this.clientHeight = 500;
    this.clientTop = 0; this.scrollHeight = 1200;
    this.classList = {
      contains: cls => this.className.split(/\s+/).includes(cls),
      add: (...classes) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...classes])].join(' '); },
      remove: (...classes) => { this.className = this.className.split(/\s+/).filter(cls => !classes.includes(cls)).join(' '); },
      toggle: (cls, force) => { const wanted = force ?? !this.classList.contains(cls); this.classList[wanted ? 'add' : 'remove'](cls); return wanted; }
    };
  }
  get className() { return this.getAttribute('class') || ''; } set className(value) { this.setAttribute('class', value); }
  get id() { return this.getAttribute('id') || ''; } set id(value) { this.setAttribute('id', value); }
  get title() { return this.getAttribute('title') || ''; } set title(value) { this.setAttribute('title', value); }
  get tabIndex() { return this.attrs.has('tabindex') ? Number(this.getAttribute('tabindex')) : ['BUTTON','INPUT','A'].includes(this.tagName) ? 0 : -1; }
  set tabIndex(value) { this.setAttribute('tabindex', value); }
  get firstElementChild() { return this.children[0] || null; } get firstChild() { return this.firstElementChild; }
  get nextElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] || null; }
  get isConnected() { return this === this.ownerDocument.documentElement || !!this.parentElement?.isConnected; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set textContent(value) { this.children.forEach(child => { child.parentElement = null; }); this.children = []; this._text = String(value); }
  set innerHTML(value) { this.textContent = ''; this.html = value; } get innerHTML() { return this.html || ''; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); } getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  appendChild(node) { return this.insertBefore(node, null); }
  insertBefore(node, anchor) {
    node.remove(); const index = anchor ? this.children.indexOf(anchor) : this.children.length;
    assert(index >= 0, 'insertBefore uses an actual child'); this.children.splice(index, 0, node); node.parentElement = this; return node;
  }
  remove() { if (this.parentElement) { const p = this.parentElement; p.children.splice(p.children.indexOf(this), 1); this.parentElement = null; } }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  matches(selector) { return matches(this, selector); }
  closest(selector) { for (let n = this; n; n = n.parentElement) if (n.matches(selector)) return n; return null; }
  querySelectorAll(selector) {
    const out = []; const walk = n => { for (const child of n.children) { if (matches(child, selector, this)) out.push(child); walk(child); } }; walk(this); return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, fn, opts) { const list = this.listeners.get(name) || []; list.push({ fn, capture:opts === true || opts?.capture }); this.listeners.set(name, list); }
  removeEventListener(name, fn, opts) { const cap = opts === true || opts?.capture; this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item.fn !== fn || !!item.capture !== !!cap)); }
  focus() {
    if (this.disabled || this.closest('[inert], [hidden]')) return;
    for (let p=this; p; p=p.parentElement) if (p.style.visibility === 'hidden' || p.style.visibility === 'collapse') return;
    this.ownerDocument.activeElement = this;
  }
  click() { this.ownerDocument.dispatch(this, 'click'); }
  // Real inert/aria-hidden/visibility:hidden nodes still have layout boxes.
  getClientRects() { return this.isConnected && !this.closest('[hidden], .dsh-order-native-svg-hidden') ? [this.getBoundingClientRect()] : []; }
  getBoundingClientRect() { return { top:10, bottom:38, left:20, right:280, width:260, height:28 }; }
  getAnimations() { return []; } scrollTo({ top }) { this.scrollTop = top; }
}
class MockDocument extends MockElement {
  constructor() {
    super('document', null); this.ownerDocument = this; this.documentElement = new MockElement('html', this);
    this.head = new MockElement('head', this); this.body = new MockElement('body', this);
    this.documentElement.parentElement = this; this.children = [this.documentElement];
    this.documentElement.appendChild(this.head); this.documentElement.appendChild(this.body); this.activeElement = this.body;
    this.hidden = false; this.documentElement.lang = 'en';
  }
  createElement(tag) { return new MockElement(tag, this); } createElementNS(ns, tag) { return this.createElement(tag); }
  getElementById(id) { return this.querySelector('#' + id); }
  dispatch(target, name, extra = {}) {
    const event = { target, key:'', button:0, defaultPrevented:false, stopped:false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; this.immediateStopped = true; }, ...extra };
    const path = []; for (let n = target; n; n = n.parentElement) path.push(n);
    if (!path.includes(this)) path.push(this);
    if (this.defaultView && !path.includes(this.defaultView)) path.push(this.defaultView);
    for (const capture of [true, false]) for (const n of capture ? [...path].reverse() : path) {
      for (const item of [...(n.listeners.get(name) || [])]) if (!!item.capture === capture) { event.currentTarget = n; item.fn(event); if (event.immediateStopped) return event; }
      if (event.stopped) return event;
    }
    return event;
  }
}
function snapshot(initial) {
  let value = initial; const listeners = new Set();
  return { getSnapshot: () => value, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(next) { value = next; for (const fn of [...listeners]) fn(); }, count: () => listeners.size };
}
async function harness(t, options = {}) {
  const document = new MockDocument(), window = new MockElement('window', document);
  document.defaultView = window;
  const storage = new Map(Object.entries(options.storage || {}));
  Object.assign(window, { document, innerWidth:900, innerHeight:700, crypto:{ randomUUID:() => options.viewId || 'test-view' }, CSS:{ escape:String },
    localStorage:{ getItem:key => storage.get(key) ?? null, setItem:(key,value) => storage.set(key,value) } });
  let now = 100000, nextTimer = 1; const timers = new Map(), calls = [], warnings = [];
  const setTimer = (fn, ms, repeat) => { const id = nextTimer++; timers.set(id, { fn, due:now + ms, ms, repeat }); return id; };
  let payload = { protocolVersion:2, pinned:[], busy:[], errored:[], waiting:[], unread:[], favorites:[], owners:{}, parents:{},
    erroredSessions:[], waitingSessions:[], runningSessions:[], unreadSessions:[], archivedSessions:[], sessionTitles:{}, stateRead:{ status:'ok' } };
  let responder = (url, opts) => {
    if (url.endsWith('/status')) return { status:200, data:payload };
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (url.endsWith('/settings')) { payload.settings = { ...payload.settings, ...body.settings }; return {status:200,data:{success:true,settings:payload.settings}}; }
    if (url.endsWith('/toggle-favorite')) {
      payload.favorites = payload.favorites.filter(id => id !== body.sessionId);
      if (body.favorite) payload.favorites.unshift(body.sessionId);
      return {status:200,data:{success:true,favoriteIds:payload.favorites}};
    }
    return {status:200,data:{success:true}};
  };
  const services = { uiSession:{ sessionStatus:snapshot(new Map()) }, sessions:{ list:snapshot({ phase:'ready', state:'ready', byId:{}, projectionsBySession:{} }) },
    workspaces:{ list:snapshot({ items:[], archivedSessionIds:[] }) }, uiWorkspace:{ openSession:async id => { opened.push(id); } },
    remote:{ $on(name, fn) { const list = remoteEvents.get(name) || new Set(); list.add(fn); remoteEvents.set(name,list); return () => list.delete(fn); } },
    locale:{ state:snapshot({}), bind:ns => (key, vars) => ns === 'workspace' ? ({ 'session.new':'Localized New', 'session.untitled':'Localized Untitled', 'toast.archivedNotOpenable':'Unarchive before opening (native)' })[key] || key : key }
  };
  const opened = [], remoteEvents = new Map(), injections = [], disposers = [];
  const view = snapshot({ groupBy:'workspace-tree', groupExpansion:{} });
  view.store = { update(fn) { const next = structuredClone(view.getSnapshot()); fn(next); view.set(next); } };
  services.slots = { entries:() => [{ store:{ spec:{ persist:'dsh.workspace.view.v5' }, create:() => view } }], subscribe:() => () => {},
    inject:() => () => {}, register:() => () => {} };
  function childFor(names, fn) {
    const offs = [], child = { ...services, effect(effect) { const off = effect(); if (typeof off === 'function') offs.push(off); }, slots:services.slots };
    fn(child); return () => { for (const off of [...offs].reverse()) off(); };
  }
  const ctx = { inject(names, fn) { const injection = { names, fn, off:childFor(names,fn) }; injections.push(injection); }, effect(fn) { const off = fn(); if (typeof off === 'function') disposers.push(off); } };
  const sandbox = { window, document, navigator:{ language:'en' }, Element:MockElement, Map, Set, AbortController, Date:class extends Date { static now() { return now; } },
    console:{ warn:(...args) => warnings.push(args), error:(...args) => warnings.push(args) }, queueMicrotask,
    setTimeout:(fn,ms=0) => setTimer(fn,ms,false), setInterval:(fn,ms) => setTimer(fn,ms,true), clearTimeout:id => timers.delete(id), clearInterval:id => timers.delete(id),
    requestAnimationFrame:fn => setTimer(fn,16,false), cancelAnimationFrame:id => timers.delete(id),
    MutationObserver:class { observe() {} disconnect() {} },
    getComputedStyle:node => ({ overflowY:node.style.overflowY || 'visible', width:node.style.width, height:node.style.height,
      visibility:(() => { for (let p=node; p; p=p.parentElement) if (p.style.visibility) return p.style.visibility; return 'visible'; })(),
      getPropertyValue(key) {
      if (key === '--dsh-workspace-indent' && document.body.classList.contains('dsh-order-tree-trays') && node.getAttribute('data-dsh-order-tray-row') !== null) return '0px';
      for (let n = node; n; n = n.parentElement) if (n.style[key] !== undefined) return n.style[key]; return '';
    } }),
    fetch:async (url, opts = {}) => { calls.push({ url, opts, body:opts.body && JSON.parse(opts.body) }); const result = await responder(url,opts); return { ok:result.status >= 200 && result.status < 300, status:result.status, json:async () => result.data }; }
  };
  let plugin;
  window.__ModuleLoader__ = { load({ factory }) { plugin = factory(() => { throw Error('optional UI primitives absent'); }); } };
  const instrumented = source.replace('module.exports.apply = apply;', `module.exports.apply = apply; module.exports.test = {
    refresh, updateStatus, rowDepth, saveSetting, toggleFavorite, togglePin, sessionTitleOf, sessionState,
    computeLiveStates, computeFallbackStates, localDoneCounts, onTreeKeydown, syncTreeOrderMode,
    toggleStarMenu, closeStarMenu, openSessionById, paintSessionMark,
    state:() => ({ settings, hostError, hostProtocol, favoriteIds, sessionMarksKnown, lastStatusAt, pendingSettings, favoriteChanges, live, retiredLocalUnread, viewId, seenRequests })
  };`);
  vm.runInNewContext(instrumented, sandbox, { filename:'client.js' });
  const h = { document, window, plugin, services, view, storage, calls, opened, warnings, timers, remoteEvents,
    el(tag, attrs={}, parent=document.body) { const el = document.createElement(tag); for (const [key,value] of Object.entries(attrs)) el.setAttribute(key,value); parent?.appendChild(el); return el; },
    setPayload(patch) { payload = { ...payload, ...patch }; }, respond(fn) { responder = fn; },
    async flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); },
    async advance(ms) { const end = now + ms; for (;;) { const entry = [...timers].filter(([,timer]) => timer.due <= end).sort((a,b) => a[1].due-b[1].due)[0]; if (!entry) break; const [id,timer] = entry; now = timer.due; if (timer.repeat) timer.due += timer.ms; else timers.delete(id); timer.fn(); await this.flush(); } now = end; await this.flush(); },
    replace(name, value) { for (const item of injections.filter(item => item.names.includes(name))) item.off(); services[name] = value; for (const item of injections.filter(item => item.names.includes(name))) item.off = childFor(item.names,item.fn); },
    dispose() { for (const off of disposers.splice(0).reverse()) off(); for (const injection of injections.splice(0).reverse()) injection.off(); },
    async reloadClient() {
      this.dispose(); vm.runInNewContext(instrumented, sandbox, { filename:'client.js' });
      this.plugin = plugin; plugin.apply(ctx); await this.flush();
    }
  };
  t.after(() => h.dispose());
  if (options.setup) await options.setup(h);
  plugin.apply(ctx); await h.flush(); return h;
}
function addTree(h) {
  const tree = h.el('div', { role:'tree', class:'native_list' }); tree.style.overflowY = 'auto';
  function section(parent, id, depth, wrappers=1) {
    const group = h.el('div', { class:'native_groupSection' }, parent); group.style['--dsh-workspace-indent'] = `${depth * 12}px`;
    let anchor = group; for (let i=0; i<wrappers; i++) anchor = h.el('span', {}, anchor);
    const row = h.el('div', { 'data-row-key':`workspace:${id}`, role:'treeitem', tabindex:'0', 'aria-expanded':'true' }, anchor);
    h.el('span', { class:'native_folder' }, row); h.el('span', { class:'native_projectText' }, row); h.el('span', { class:'native_rowActions' }, row);
    return { group, row };
  }
  const parent = section(tree,'parent',0);
  const nested = h.el('div', { role:'group' }, parent.group);
  const child = section(nested,'child',1,3);
  const grandContainer = h.el('div', { role:'group' }, child.group);
  const grand = section(grandContainer,'grand',2,2);
  const session = (group,id,dotState) => {
    const anchor = h.el('span', {}, h.el('span', {}, group));
    const row = h.el('div', { 'data-row-key':`session:${id}`, role:'treeitem', tabindex:'0' }, anchor);
    const cell = h.el('span', { class:'native_slot' }, row);
    const slot = h.el('div', { 'data-slot':'sidebar.session.row.leading' }, cell);
    const dot = dotState ? h.el('span', { 'data-state':dotState, 'aria-hidden':'true', 'aria-label':'native', title:'native title' }, cell) : null;
    if (dot) h.el('span', { class:'native_visuallyHidden' }, cell).textContent = 'Native status';
    return { row, cell, slot, dot };
  };
  const sp = session(parent.group,'sp','ongoing'), sc = session(child.group,'sc'), sg = session(grand.group,'sg');
  const overflow = h.el('button', { 'data-row-key':'overflow:parent' }, parent.group);
  h.services.workspaces.list.set({ items:[{workspaceId:'parent',path:'/fixture/p',sessionIds:['sp']}, {workspaceId:'child',path:'/fixture/p/c',sessionIds:['sc']}, {workspaceId:'grand',path:'/fixture/p/c/g',sessionIds:['sg']}], archivedSessionIds:[] });
  h.services.sessions.list.set({ phase:'ready', state:'ready', byId:{ sp:{id:'sp',title:'Parent Session'},sc:{id:'sc',title:'Child Session'},sg:{id:'sg',title:'Grand Session'} }, projectionsBySession:{} });
  return { tree,parent,child,grand,nested,sp,sc,sg,overflow };
}

test('nearest group tray ownership, native depth and visual accessibility order survive arbitrary wrappers', async t => {
  let f; const h = await harness(t, { setup(h) { f=addTree(h); } });
  h.plugin.test.refresh();
  for (const row of [f.parent.row,f.child.row,f.grand.row,f.sp.row,f.sc.row,f.sg.row,f.overflow]) assert(row.getAttribute('data-dsh-order-tray-row') !== null);
  assert.equal(h.plugin.test.rowDepth(f.child.row),1); assert.equal(h.plugin.test.rowDepth(f.grand.row),2);
  assert.equal(f.parent.group.children[1],f.nested,'React-managed DOM did not move');
  const owns = f.parent.group.getAttribute('aria-owns').split(' ');
  assert.equal(owns.at(-1),f.nested.id); assert(owns.indexOf(f.overflow.id) < owns.indexOf(f.nested.id));
  assert.equal(f.child.group.getAttribute('role'),'group');
  await h.plugin.test.saveSetting('treeSessionsFirst',false);
  assert.equal(f.parent.group.getAttribute('aria-owns'),null); assert.equal(f.parent.group.getAttribute('role'),null);
  h.view.set({groupBy:'workspace',groupExpansion:{}});
  assert.equal(f.grand.row.getAttribute('data-dsh-order-tray-row'),null);
});

test('tree Arrow/Home/End and boundary Tab follow visible sessions-first order, not React DOM', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);}}); h.plugin.test.refresh();
  const key=(target,value,extra={})=>h.document.dispatch(target,'keydown',{key:value,...extra});
  f.parent.row.focus(); assert(key(f.parent.row,'ArrowDown').defaultPrevented); assert.equal(h.document.activeElement,f.sp.row);
  key(f.sp.row,'ArrowDown'); assert.equal(h.document.activeElement,f.overflow);
  key(f.overflow,'ArrowDown'); assert.equal(h.document.activeElement,f.child.row);
  key(f.child.row,'End'); assert.equal(h.document.activeElement,f.sg.row);
  key(f.sg.row,'Home'); assert.equal(h.document.activeElement,f.parent.row);
  const star=f.sp.row.querySelector('.dsh-order-star'); key(star,'Tab'); assert.equal(h.document.activeElement,f.overflow);
  key(f.child.row,'Tab',{shiftKey:true}); assert.equal(h.document.activeElement,f.overflow);
  const after=h.el('button',{id:'after-tree'});
  const lastStar=f.sg.row.querySelector('.dsh-order-star'); key(lastStar,'Tab'); assert.equal(h.document.activeElement,after,'last visual row exits the entire tree');
  let clicked=0; f.child.row.addEventListener('click',()=>clicked++);
  key(f.child.row,'ArrowLeft'); assert.equal(clicked,1,'Left on an expanded workspace invokes native collapse');
  f.child.row.setAttribute('aria-expanded','false'); key(f.child.row,'ArrowRight'); assert.equal(h.view.getSnapshot().groupExpansion.child,true,'Right expands via the native shared view');
  assert.equal(key(star,'ArrowDown').defaultPrevented,false);
  const input=h.el('input',{},f.sp.row); assert.equal(key(input,'Home').defaultPrevented,false);
  assert.equal(key(f.sp.row,'Home',{ctrlKey:true}).defaultPrevented,false);
  const other=h.el('div',{role:'tree'}), unrelated=h.el('div',{'data-row-key':'other:x'},other);
  assert.equal(key(unrelated,'End').defaultPrevented,false);
});

test('host waiting overrides a native running dot shape and color with one mark; filters are independent', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);h.setPayload({waiting:['parent'],waitingSessions:['sp'],erroredSessions:['sp'],runningSessions:['sp'],unreadSessions:['sp'],owners:{sp:'parent'}});}});
  h.plugin.test.refresh();
  assert.equal(f.sp.dot.getAttribute('data-state'),'ongoing','native React state untouched');
  assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'),'waiting'); assert.equal(f.sp.dot.getAttribute('aria-hidden'),'false');
  assert.equal(f.sp.row.querySelectorAll('.dsh-order-session-mark').length,0);
  assert.match(f.sp.dot.getAttribute('aria-label'),/Waiting/);
  await h.plugin.test.saveSetting('badgeWaiting',false); assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'),'error');
  await h.plugin.test.saveSetting('badgeError',false); assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'),'running');
  f.sp.dot.remove(); h.plugin.test.refresh(); assert.equal(f.sp.row.querySelectorAll('.dsh-order-session-mark').length,1);
  await h.plugin.test.saveSetting('badgeRunningDone',false); assert.equal(f.sp.row.querySelectorAll('.dsh-order-session-mark').length,0);
});

test('degraded HTTP503 and HTTP200 preserve last-good ledger and surface partial read feedback', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);h.setPayload({waiting:['parent'],waitingSessions:['sp']});}});
  const good=h.plugin.test.state().lastStatusAt;
  for (const status of [503,200]) {
    h.respond(()=>({status,data:{protocolVersion:2,waiting:[],waitingSessions:[],unreadSessions:[],stateRead:{status:'degraded',catalog:'unavailable',failedSessionIds:['sp'],unavailableProjectionSessionIds:[]}}}));
    await h.plugin.test.updateStatus();
    assert.equal(h.plugin.test.state().hostError,'noteHostDegraded'); assert.equal(h.plugin.test.state().lastStatusAt,good);
    assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'),'waiting');
  }
  h.respond(()=>({status:200,data:{error:'state source unavailable'}})); await h.plugin.test.updateStatus();
  assert.equal(h.plugin.test.state().hostError,'noteHostUnavailable');
  assert.equal(h.plugin.test.state().lastStatusAt,good); assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'),'waiting');
});

test('seen lease uses per-view id, 5s heartbeat, hidden null, immediate recovery poll and unload release', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);f.sp.row.setAttribute('aria-selected','true');}});
  const reports=()=>h.calls.filter(call=>call.url.endsWith('/clear-error'));
  assert(reports().some(call=>call.body.sessionId==='sp' && call.body.viewId==='test-view'));
  const first=reports().length; await h.advance(5000); assert(reports().length>first);
  h.document.hidden=true; h.document.dispatch(h.document,'visibilitychange'); await h.flush(); assert.equal(reports().at(-1).body.sessionId,null);
  const polls=h.calls.filter(call=>call.url.endsWith('/status')).length; await h.advance(10000);
  assert.equal(h.calls.filter(call=>call.url.endsWith('/status')).length,polls);
  h.document.hidden=false; h.document.dispatch(h.document,'visibilitychange'); await h.flush();
  assert(h.calls.filter(call=>call.url.endsWith('/status')).length>polls); assert.equal(reports().at(-1).body.sessionId,'sp');
  h.window.listeners.get('pagehide')[0].fn(); await h.flush(); assert.equal(reports().at(-1).body.sessionId,null);
});

test('favorites keep archived entries and native blank/untitled labels; guard never opens or unarchives archived', async t => {
  const h=await harness(t,{setup(h){
    h.services.sessions.list.set({phase:'ready',byId:{arch:{id:'arch',title:'Archived'},blank:{id:'blank',blank:true,title:'ignored'},untitled:{id:'untitled',title:'   '}},projectionsBySession:{}});
    h.setPayload({favorites:['arch','blank','untitled','missing'],archivedSessions:['arch'],sessionTitles:{arch:'Archived',blank:'',untitled:''}});
  }});
  assert.equal(h.plugin.test.sessionTitleOf('blank'),'Localized New'); assert.equal(h.plugin.test.sessionTitleOf('untitled'),'Localized Untitled');
  const anchor=h.el('button',{'class':'dsh-order-star-filter'}); h.plugin.test.toggleStarMenu(anchor); await h.advance(0);
  const menu=h.document.querySelector('.dsh-order-star-menu'), items=menu.querySelectorAll('[data-session-id]');
  assert.equal(items.length,4); assert.equal(h.document.activeElement,items[1]); assert.equal(anchor.getAttribute('aria-expanded'),'true');
  assert.equal(items[0].disabled,true); assert.equal(h.opened.length,0);
  assert.match(menu.querySelector('.dsh-order-star-menu-archive-note').textContent,/Unarchive before opening/);
  assert(menu.querySelector('.dsh-order-star-menu-archive-action'),'disabled item has a separate enabled archive entry');
  assert.equal(h.plugin.test.state().favoriteIds.includes('arch'),true); assert(!h.calls.some(call=>call.url.includes('unarchive')));
  h.document.dispatch(items[3],'click'); await h.flush(); assert.match(menu.querySelector('.dsh-order-star-menu-feedback').textContent,/no longer exists/);
  assert(menu.querySelector('.dsh-order-star-menu-action')); assert(!items[3].textContent.includes('missing'));
  h.document.dispatch(h.document.activeElement,'keydown',{key:'End'}); assert.equal(h.document.activeElement,menu.querySelector('.dsh-order-star-menu-action'));
  h.document.dispatch(h.document.activeElement,'keydown',{key:'Escape'}); assert.equal(h.document.querySelector('.dsh-order-star-menu'),null); assert.equal(h.document.activeElement,anchor);
});

test('async native open rejection retains menu with readable feedback; success closes it', async t => {
  const h=await harness(t,{setup(h){h.setPayload({favorites:['s'],sessionTitles:{s:'Host title'}});}});
  const anchor=h.el('button',{class:'dsh-order-star-filter'}); h.plugin.test.toggleStarMenu(anchor); await h.advance(0);
  h.services.uiWorkspace.openSession=async()=>{throw Error('not available');};
  let item=h.document.querySelector('[data-session-id="s"]'); h.document.dispatch(item,'click'); await h.flush();
  assert.match(h.document.querySelector('.dsh-order-star-menu-feedback').textContent,/Cannot open/); assert.equal(item.getAttribute('aria-busy'),null);
  h.services.uiWorkspace.openSession=async id=>h.opened.push(id); h.document.dispatch(item,'click'); await h.flush();
  assert.deepEqual(h.opened,['s']); assert.equal(h.document.querySelector('.dsh-order-star-menu'),null);
});

test('independent service HMR unbinds old stores and remote errors, then disposal clears DOM and timers', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);}}); h.plugin.test.refresh();
  const old=h.services.uiSession.sessionStatus; assert.equal(old.count(),1);
  const replacement={sessionStatus:snapshot(new Map([['sp',{pendingInteraction:{kind:'question'}}]]))}; h.replace('uiSession',replacement);
  assert.equal(old.count(),0); assert.equal(replacement.sessionStatus.count(),1); assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'),'waiting');
  old.set(new Map([['sp',{running:true}]])); assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'),'waiting');
  const oldSessions=h.services.sessions.list; h.replace('sessions',{list:snapshot(oldSessions.getSnapshot())}); assert.equal(oldSessions.count(),0);
  const oldWorkspaces=h.services.workspaces.list; h.replace('workspaces',{list:snapshot(oldWorkspaces.getSnapshot())}); assert.equal(oldWorkspaces.count(),0);
  assert.equal(h.remoteEvents.get('api-session/error').size,1);
  h.dispose(); assert.equal(replacement.sessionStatus.count(),0); assert.equal(h.remoteEvents.get('api-session/error').size,0);
  assert.equal(h.timers.size,0); assert.equal(h.document.querySelector('.dsh-order-star'),null); assert.equal(h.document.querySelector('[data-dsh-order-clip]'),null);
  assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'),null); assert.equal(f.sp.dot.getAttribute('aria-label'),'native'); assert.equal(f.sp.dot.getAttribute('aria-hidden'),'true');
  assert.equal(f.parent.group.getAttribute('aria-owns'),null); assert.equal(f.child.row.getAttribute('data-dsh-order-tray-row'),null);
});

test('pending settings retain eight-key cache format and failed favorite choice survives disposal', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);}});
  h.respond((url)=> url.endsWith('/status') ? {status:503,data:{}} : {status:500,data:{success:false,error:'write rejected'}});
  await h.plugin.test.saveSetting('pinTop',false);
  assert.equal(Object.keys(JSON.parse(h.storage.get('dsh-workspace-focus-enhancer:settings'))).length,8);
  assert.deepEqual(JSON.parse(h.storage.get('dsh-workspace-focus-enhancer:settings:pending')),[['pinTop',false]]);
  h.document.dispatch(f.sp.row.querySelector('.dsh-order-star'),'click'); await h.flush();
  assert.deepEqual(JSON.parse(h.storage.get('dsh-workspace-focus-enhancer:favorites:pending')),[['sp',true]]);
  assert.match(f.sp.row.querySelector('.dsh-order-action-feedback').textContent,/not saved/);
  h.dispose(); assert.deepEqual(JSON.parse(h.storage.get('dsh-workspace-focus-enhancer:favorites:pending')),[['sp',true]]);
});

test('unread retirement survives host outage and service replacement until a new Host affirmation', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);f.sp.dot.setAttribute('data-state','done');h.services.uiSession.sessionStatus.set(new Map([['sp',{completionUnread:true}]]));}});
  assert.equal(h.plugin.test.localDoneCounts('sp'),false);
  h.respond(()=>({status:503,data:{stateRead:{status:'degraded'}}})); await h.advance(12000);
  h.replace('uiSession',{sessionStatus:snapshot(new Map([['sp',{completionUnread:true}]]))});
  assert.equal(h.plugin.test.localDoneCounts('sp'),false);
  h.services.uiSession.sessionStatus.set(new Map([['sp',{running:true}]]));
  h.services.uiSession.sessionStatus.set(new Map([['sp',{running:false,completionUnread:true}]]));
  assert.equal(h.plugin.test.localDoneCounts('sp'),false,'a new stop alone never re-arms done');
  h.respond(()=>({status:200,data:{protocolVersion:2,pinned:[],unreadSessions:['sp'],owners:{sp:'parent'}}}));
  await h.plugin.test.updateStatus(); assert.equal(h.plugin.test.localDoneCounts('sp'),true);
});

test('pin degraded metadata preserves precise waiting while pin failure rolls back with nearby feedback', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);h.setPayload({waiting:['parent'],waitingSessions:['sp']});}});
  const pin=f.parent.row.querySelector('.dsh-order-pin-btn');
  h.respond(()=>({status:200,data:{success:true,pinnedIds:['parent'],waitingIds:[],waitingSessionIds:[],archivedSessionIds:[],sessionTitles:{},stateRead:{status:'degraded'}}}));
  await h.plugin.test.togglePin('parent',pin);
  assert.equal(pin.getAttribute('data-pinned'),'true'); assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'),'waiting');
  h.respond(()=>({status:500,data:{success:false,error:'disk write failed'}}));
  await h.plugin.test.togglePin('parent',pin); assert.equal(pin.getAttribute('data-pinned'),'true');
  assert.match(f.parent.row.querySelector('.dsh-order-action-feedback').textContent,/previous state was restored/);
  assert.equal(pin.disabled,false);
});

test('an in-flight favorite response cannot discard a newer opposite desired membership', async t => {
  const h=await harness(t); let resolveFirst, writes=0;
  h.respond(async(url,opts)=> {
    const body=opts.body && JSON.parse(opts.body);
    if (url.endsWith('/toggle-favorite')) {
      writes++;
      if (writes===1) return await new Promise(resolve=>{resolveFirst=resolve;});
      assert.equal(body.favorite,false);
      return {status:200,data:{success:true,favoriteIds:[]}};
    }
    return {status:200,data:{success:true}};
  });
  const first=h.plugin.test.toggleFavorite('s'); await h.flush();
  const second=h.plugin.test.toggleFavorite('s'); await h.flush();
  assert.equal(JSON.parse(h.storage.get('dsh-workspace-focus-enhancer:favorites:pending'))[0][1],false);
  resolveFirst({status:200,data:{success:true,favoriteIds:['s']}});
  await Promise.all([first,second]); await h.flush();
  assert.equal(writes,2); assert.equal(h.plugin.test.state().favoriteIds.length,0);
  assert.deepEqual(JSON.parse(h.storage.get('dsh-workspace-focus-enhancer:favorites:pending')),[]);
});

test('all live subagent signals lift to the root and then to the nearest collapsed visible workspace', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);
    h.services.sessions.list.set({phase:'ready',byId:{sc:{id:'sc'}, sub:{id:'sub',origin:'subagent',parentId:'sc',running:true}},projectionsBySession:{}});
    h.services.uiSession.sessionStatus.set(new Map([['sub',{pendingInteraction:{kind:'approval'},running:true,completionUnread:true}]]));
  }});
  h.plugin.test.refresh(); assert.equal(f.sc.row.querySelector('.dsh-order-session-mark').getAttribute('data-dsh-order-state'),'waiting');
  f.child.group.remove(); f.parent.row.setAttribute('aria-expanded','false'); h.plugin.test.refresh();
  assert.equal(f.parent.row.querySelector('.dsh-order-state').getAttribute('data-state'),'waiting');
  await h.plugin.test.saveSetting('badgeWaiting',false);
  assert.equal(f.parent.row.querySelector('.dsh-order-state').getAttribute('data-state'),'running');
});

test('toolbar arrows open menu with first/last focus, Tab exits, and async favorites refresh retains focused session', async t => {
  const h=await harness(t,{setup(h){
    const header=h.el('div',{class:'native_sectionHeader'}); h.el('div',{class:'native_headerActions'},header);
    h.setPayload({favorites:['a','b'],sessionTitles:{a:'A',b:'B'}});
  }});
  const anchor=h.document.querySelector('.dsh-order-star-filter'); assert(anchor);
  h.document.dispatch(anchor,'keydown',{key:'ArrowUp'}); await h.advance(0);
  assert.equal(h.document.activeElement.getAttribute('data-session-id'),'b');
  h.setPayload({favorites:['c','a','b'],sessionTitles:{a:'A',b:'B',c:'C'}}); await h.plugin.test.updateStatus();
  assert.equal(h.document.activeElement.getAttribute('data-session-id'),'b'); await h.advance(0);
  h.document.dispatch(h.document.activeElement,'keydown',{key:'Tab'});
  assert.equal(h.document.querySelector('.dsh-order-star-menu'),null); assert.equal(h.document.activeElement,anchor);
  h.document.dispatch(anchor,'keydown',{key:'ArrowDown'}); await h.advance(0);
  assert.equal(h.document.activeElement.getAttribute('data-session-id'),'c');
});

test('real SVG native spinner is replaced by one owned HTML glyph, preserving dimensions, paths, ARIA and cleanup', async t => {
  let f, svg, path; const h=await harness(t,{setup(h){
    f=addTree(h); f.sp.dot.remove();
    svg=h.document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.setAttribute('data-state','ongoing'); svg.setAttribute('aria-hidden','true'); svg.setAttribute('title','Native spinning SVG');
    svg.style.width='12px'; svg.style.height='12px'; svg.style.animation='native-spin 1s infinite';
    // Real SVG rotations can inflate bounding-box dimensions. CSS size wins.
    svg.getBoundingClientRect=()=>({top:0,left:0,width:17,height:17});
    path=h.document.createElementNS('http://www.w3.org/2000/svg','path'); path.setAttribute('d','native-ring-path'); svg.appendChild(path);
    f.sp.cell.appendChild(svg); f.sp.dot=svg;
    h.setPayload({waiting:['parent'],waitingSessions:['sp'],erroredSessions:['sp'],runningSessions:['sp']});
  }});
  assert.equal(svg.tagName,'SVG'); h.plugin.test.refresh();
  let mark=f.sp.row.querySelector('.dsh-order-session-mark');
  assert.equal(mark.tagName,'SPAN'); assert.equal(mark.getAttribute('data-dsh-order-state'),'waiting');
  assert.equal(mark.parentElement,f.sp.cell); assert.equal(mark.nextElementSibling,svg);
  assert.equal(mark.style.width,'12px'); assert.equal(mark.style.height,'12px');
  assert.equal(svg.getAttribute('data-dsh-order-state'),null,'never masks SVG with ::after');
  assert(svg.classList.contains('dsh-order-native-svg-hidden')); assert.equal(svg.getAttribute('aria-hidden'),'true');
  assert.equal(svg.firstElementChild,path); assert.equal(path.getAttribute('d'),'native-ring-path');
  assert.equal(svg.getAttribute('data-state'),'ongoing'); assert.equal(svg.style.animation,'native-spin 1s infinite','native inline styles stay untouched');
  assert.equal(svg.getClientRects().length,0); assert.equal(mark.getClientRects().length,1);
  assert.match(mark.getAttribute('aria-label'),/Waiting/);
  await h.plugin.test.saveSetting('badgeWaiting',false); assert.equal(mark.getAttribute('data-dsh-order-state'),'error');
  await h.plugin.test.saveSetting('badgeError',false); assert.equal(mark.getAttribute('data-dsh-order-state'),'running');
  await h.plugin.test.saveSetting('badgeRunningDone',false);
  assert.equal(f.sp.row.querySelector('.dsh-order-session-mark'),null); assert(!svg.classList.contains('dsh-order-native-svg-hidden'));
  assert.equal(svg.getAttribute('title'),'Native spinning SVG'); assert.equal(f.sp.cell.querySelector('[class*="visuallyHidden"]').getAttribute('aria-hidden'),null);
  await h.plugin.test.saveSetting('badgeWaiting',true); mark=f.sp.row.querySelector('.dsh-order-session-mark'); assert(mark);
  // Native React can swap an SVG for a span. Stand down and return to the span
  // path without leaving two glyphs or leaked ownership on the detached SVG.
  const span=h.el('span',{'data-state':'warning','aria-hidden':'true'},null); f.sp.cell.insertBefore(span,svg); svg.remove(); h.plugin.test.refresh();
  assert.equal(f.sp.row.querySelector('.dsh-order-session-mark'),null); assert.equal(span.getAttribute('data-dsh-order-state'),'waiting');
  assert(!svg.classList.contains('dsh-order-native-svg-hidden')); assert.equal(svg.getAttribute('aria-hidden'),'true');
  span.remove(); f.sp.cell.appendChild(svg); h.plugin.test.refresh(); assert.equal(f.sp.row.querySelectorAll('.dsh-order-session-mark').length,1);
  h.dispose(); assert.equal(f.sp.row.querySelector('.dsh-order-session-mark'),null);
  assert(!svg.classList.contains('dsh-order-native-svg-hidden')); assert.equal(svg.getAttribute('title'),'Native spinning SVG'); assert.equal(svg.firstElementChild,path);
});

test('tree Tab skips real boxed inert/aria-hidden/visibility-hidden targets and never consumes failed focus', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);}}); h.plugin.test.refresh();
  const inert=h.el('div',{inert:''}), blocked=h.el('button',{},inert);
  const ariaHidden=h.el('div',{'aria-hidden':'true'}), ariaButton=h.el('button',{},ariaHidden);
  const hidden=h.el('div'); hidden.style.visibility='hidden'; const hiddenButton=h.el('button',{},hidden);
  const destination=h.el('button',{id:'valid-destination'});
  for (const node of [blocked,ariaButton,hiddenButton]) assert.equal(node.getClientRects().length,1,'boxed hidden/inert nodes retain real layout');
  const last=f.sg.row.querySelector('.dsh-order-star'); last.focus();
  let event=h.document.dispatch(last,'keydown',{key:'Tab'}); assert.equal(event.defaultPrevented,true); assert.equal(h.document.activeElement,destination);
  destination.focus=()=>{}; last.focus(); event=h.document.dispatch(last,'keydown',{key:'Tab'});
  assert.equal(event.defaultPrevented,false,'browser retains Tab when focus did not actually move'); assert.equal(h.document.activeElement,last);
});

test('archive knowledge is independent of ready sessions during workspace HMR and degraded first poll', async t => {
  const h=await harness(t,{setup(h){
    h.services.sessions.list.set({phase:'ready',state:'ready',byId:{arch:{id:'arch',title:'Session summary only'}},projectionsBySession:{}});
    h.services.workspaces=null;
    h.respond(()=>({status:503,data:{stateRead:{status:'degraded'},sessionTitles:{},archivedSessions:[]}}));
  }});
  const anchor=h.el('button',{class:'dsh-order-star-filter'});
  await h.plugin.test.toggleFavorite('arch'); h.plugin.test.toggleStarMenu(anchor); await h.advance(0);
  const item=h.document.querySelector('[data-session-id="arch"]'); assert(item);
  h.document.dispatch(item,'click'); await h.flush(); assert.equal(h.opened.length,0);
  assert.match(h.document.querySelector('.dsh-order-star-menu-feedback').textContent,/confirm whether.*archived/);
  h.replace('workspaces',{list:snapshot({phase:'ready',state:'loading',items:[],archivedSessionIds:[]})});
  h.document.dispatch(item,'click'); await h.flush(); assert.equal(h.opened.length,0,'loading archives are not confirmed');
  h.services.workspaces.list.set({phase:'ready',state:'ready',items:[],archivedSessionIds:['arch']});
  h.document.dispatch(item,'click'); await h.flush(); assert.equal(h.opened.length,0);
  assert.match(h.document.querySelector('.dsh-order-star-menu-archive-note').textContent,/Unarchive before opening/);
});

test('archived favorites proactively show native guidance and a keyboard-operable native archive filter entry', async t => {
  const h=await harness(t,{setup(h){h.setPayload({favorites:['arch'],archivedSessions:['arch'],sessionTitles:{arch:'Archived favorite'}});}});
  const anchor=h.el('button',{class:'dsh-order-star-filter'}); h.plugin.test.toggleStarMenu(anchor);
  const menu=h.document.querySelector('.dsh-order-star-menu');
  const archived=menu.querySelector('[data-session-id="arch"]'), action=menu.querySelector('.dsh-order-star-menu-archive-action');
  assert.equal(archived.disabled,true); assert.equal(archived.getAttribute('aria-disabled'),'true');
  assert.match(menu.querySelector('.dsh-order-star-menu-archive-note').textContent,/Unarchive before opening/);
  assert.equal(action.textContent,'View Archived Sessions'); assert.equal(action.getAttribute('role'),'menuitem'); assert.equal(action.disabled,false);
  assert.equal(h.document.activeElement,action,'all-disabled favorites focus their enabled archive footer');
  h.document.dispatch(action,'keydown',{key:'Home'}); assert.equal(h.document.activeElement,action);
  const prior=structuredClone(h.view.getSnapshot()); h.document.dispatch(action,'click'); await h.flush();
  assert.equal(h.view.getSnapshot().archivedFilter,'only');
  assert.equal(h.view.getSnapshot().groupBy,prior.groupBy); assert.deepEqual(h.view.getSnapshot().groupExpansion,prior.groupExpansion);
  assert.equal(h.opened.length,0); assert(!h.calls.some(call=>call.url.includes('unarchive')));
  assert.equal(h.document.querySelector('.dsh-order-star-menu'),null); assert.equal(h.document.activeElement,anchor);
});

test('archive footer unavailable state is readable, and metadata changes preserve an enabled focused menu item', async t => {
  const h=await harness(t,{setup(h){h.setPayload({favorites:['arch','s'],archivedSessions:['arch'],sessionTitles:{arch:'Archived',s:'Session'}});}});
  const anchor=h.el('button',{class:'dsh-order-star-filter'}); h.plugin.test.toggleStarMenu(anchor);
  const selected=h.document.querySelector('[data-session-id="s"]'); selected.focus();
  h.replace('slots',{entries:()=>[],subscribe:()=>()=>{},inject:()=>()=>{},register:()=>()=>{}}); h.plugin.test.refresh();
  assert.equal(h.document.querySelector('.dsh-order-star-menu-archive-action').disabled,true);
  assert.match(h.document.querySelector('.dsh-order-star-menu-archive-note').textContent,/entry is unavailable/);
  assert.equal(h.document.activeElement,selected);
  h.setPayload({archivedSessions:[]}); await h.plugin.test.updateStatus();
  assert.equal(h.document.querySelector('.dsh-order-star-menu-archive'),null); assert.equal(h.document.activeElement,selected);
});

test('Escape immediately closes its focused menu before timers and document shortcuts; outside editors/modals keep Escape', async t => {
  let nativeKeys=0; const h=await harness(t,{setup(h){
    h.setPayload({favorites:['s'],sessionTitles:{s:'Session'}});
    h.document.addEventListener('keydown',event=>{if(event.key==='Escape'){nativeKeys++;event.stopPropagation();}},true);
  }});
  const anchor=h.el('button',{class:'dsh-order-star-filter'});
  h.plugin.test.toggleStarMenu(anchor); // deliberately do NOT advance fake timers
  let event=h.document.dispatch(h.document.activeElement,'keydown',{key:'Escape'});
  assert.equal(event.defaultPrevented,true); assert.equal(h.document.querySelector('.dsh-order-star-menu'),null); assert.equal(nativeKeys,0);
  assert.equal(h.document.activeElement,anchor); await h.advance(0);
  assert.equal((h.window.listeners.get('keydown')||[]).length,0,'late outside-click timer cannot reinstall key handler');
  for (const mode of ['outside-input','inert','hidden','native-dialog']) {
    h.plugin.test.toggleStarMenu(anchor); const menu=h.document.querySelector('.dsh-order-star-menu');
    let target=h.document.activeElement, other;
    if (mode==='outside-input') {other=h.el('input');other.focus();target=other;}
    if (mode==='inert') menu.setAttribute('inert','');
    if (mode==='hidden') menu.style.visibility='hidden';
    if (mode==='native-dialog') other=h.el('div',{role:'dialog','aria-modal':'true'});
    event=h.document.dispatch(target,'keydown',{key:'Escape'});
    assert.equal(event.defaultPrevented,false,`${mode} Escape reaches native handlers`);
    assert.equal(h.document.querySelector('.dsh-order-star-menu'),null);
    if(mode==='outside-input')assert.equal(h.document.activeElement,other,'do not steal editor focus');
    other?.remove();
  }
  assert.equal(nativeKeys,4);
});

test('same-window stopPropagation cannot leak the immediate menu Escape handler', async t => {
  const h=await harness(t,{setup(h){h.setPayload({favorites:['s'],sessionTitles:{s:'Session'}});
    h.window.addEventListener('keydown',event=>{if(event.key==='Escape')event.stopPropagation();},true);
  }});
  const anchor=h.el('button',{class:'dsh-order-star-filter'}); h.plugin.test.toggleStarMenu(anchor);
  const event=h.document.dispatch(h.document.activeElement,'keydown',{key:'Escape'});
  assert.equal(event.defaultPrevented,true); assert.equal(h.document.querySelector('.dsh-order-star-menu'),null);
});

test('context disposal sends no late reading POST, aborts reading only, and retains in-flight unsaved choices', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);f.sp.row.setAttribute('aria-selected','true');}});
  let resolveSettings, resolveFavorite, readingSignal;
  h.respond(async(url,opts)=> {
    if(url.endsWith('/clear-error')) {
      readingSignal=opts.signal;
      return await new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(new Error('reading request aborted')),{once:true}));
    }
    if(url.endsWith('/settings')) return await new Promise(resolve=>{resolveSettings=resolve;});
    if(url.endsWith('/toggle-favorite')) return await new Promise(resolve=>{resolveFavorite=resolve;});
    return {status:200,data:{success:true,pinned:[]}};
  });
  h.document.hidden=true; h.document.dispatch(h.document,'visibilitychange');
  const setting=h.plugin.test.saveSetting('pinTop',false), favorite=h.plugin.test.toggleFavorite('sp'); await h.flush();
  assert(readingSignal); assert.equal(readingSignal.aborted,false);
  const choices=h.calls.filter(call=>call.url.endsWith('/settings')||call.url.endsWith('/toggle-favorite'));
  assert(choices.every(call=>call.opts.signal===undefined),'reading abort does not own user choice requests');
  const before=h.calls.length; h.dispose(); await h.flush();
  assert.equal(h.calls.length,before,'route may be gone: disposal never initiates another keepalive request');
  assert.equal(readingSignal.aborted,true); assert.equal(h.plugin.test.state().seenRequests.size,0);
  h.document.dispatch(h.document,'visibilitychange'); h.document.dispatch(h.window,'pagehide'); await h.flush();
  assert.equal(h.calls.length,before,'disposed visibility/pagehide handlers cannot initiate late requests');
  resolveSettings({status:200,data:{success:true,settings:{pinTop:false}}}); resolveFavorite({status:200,data:{success:true,favoriteIds:['sp']}});
  await Promise.all([setting,favorite]);
  assert.deepEqual(JSON.parse(h.storage.get('dsh-workspace-focus-enhancer:settings:pending')),[['pinTop',false]]);
  assert.deepEqual(JSON.parse(h.storage.get('dsh-workspace-focus-enhancer:favorites:pending')),[['sp',true]]);
});

test('client-only HMR reuses a document-owned view id and replaces its lease; new documents get independent ids', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);f.sp.row.setAttribute('aria-selected','true');}});
  const oldView=h.plugin.test.state().viewId, leases=new Map([[oldView,'sp']]);
  h.respond((url,opts)=> {
    if(url.endsWith('/clear-error')) {const body=JSON.parse(opts.body);if(body.sessionId)leases.set(body.viewId,body.sessionId);else leases.delete(body.viewId);return {status:200,data:{success:true}};}
    return {status:200,data:{protocolVersion:2,pinned:[],archivedSessions:[],sessionTitles:{}}};
  });
  h.window.crypto.randomUUID=()=>{throw new Error('HMR must not mint a new reading view');};
  f.sp.row.setAttribute('aria-selected','false'); f.sc.row.setAttribute('aria-selected','true');
  const before=h.calls.length; await h.reloadClient();
  assert.equal(h.plugin.test.state().viewId,oldView); assert.equal(leases.size,1); assert.equal(leases.get(oldView),'sc');
  const reports=h.calls.slice(before).filter(call=>call.url.endsWith('/clear-error'));
  assert(reports.length>0); assert(reports.every(call=>call.body.viewId===oldView && call.body.sessionId==='sc'),'new client replaces, rather than abandons, old 18s view lease');
  const separate=await harness(t,{viewId:'separate-document-view'});
  assert.notEqual(separate.document,h.document); assert.notEqual(separate.plugin.test.state().viewId,oldView);
  assert(![...h.storage.keys()].some(key=>key.includes('reading-view')),'view id is not copied through storage');
});

for (const tag of ['span','svg']) test(`native ${tag} running-to-stopped/cancelled without reply stays neutral until exact Host confirmation`, async t => {
  let f; const h=await harness(t,{setup(h){
    f=addTree(h); f.sp.dot.remove(); f.sp.dot=h.el(tag,{'data-state':'ongoing','aria-hidden':'true'},f.sp.cell);
    if(tag==='svg')h.el('path',{d:'native-spinner'},f.sp.dot);
    h.services.uiSession.sessionStatus.set(new Map([['sp',{running:true,completionUnread:false}]]));
    h.setPayload({unread:[],unreadSessions:[],owners:{sp:'parent'}});
  }});
  h.services.uiSession.sessionStatus.set(new Map([['sp',{running:false,completionUnread:true}]]));
  f.sp.dot.setAttribute('data-state','done'); h.plugin.test.refresh();
  const resolved=()=>tag==='svg'?f.sp.row.querySelector('.dsh-order-session-mark')?.getAttribute('data-dsh-order-state'):f.sp.dot.getAttribute('data-dsh-order-state');
  assert.equal(resolved(),'idle','no transient false green before the next poll');
  assert.equal(f.parent.row.querySelector('.dsh-order-state'),null,'workspace uses the same confirmed predicate');
  assert.equal(h.plugin.test.localDoneCounts('sp'),false);
  h.setPayload({unread:['parent'],unreadSessions:['sp']}); await h.plugin.test.updateStatus();
  assert.equal(resolved(),'done'); assert.equal(f.parent.row.querySelector('.dsh-order-state').getAttribute('data-state'),'done');
  h.respond(()=>({status:503,data:{stateRead:{status:'degraded'}}})); await h.advance(12000);
  assert.equal(resolved(),'done','outage retains an already confirmed reply');
  h.respond(()=>({status:200,data:{protocolVersion:2,pinned:[],unread:[],unreadSessions:[],owners:{sp:'parent'}}})); await h.plugin.test.updateStatus();
  assert.equal(resolved(),'idle'); h.respond(()=>({status:503,data:{stateRead:{status:'degraded'}}})); await h.advance(12000);
  assert.equal(resolved(),'idle','outage does not revive retired native completion');
  await h.plugin.test.saveSetting('badgeRunningDone',false);
  assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'),null); assert.equal(f.sp.row.querySelector('.dsh-order-session-mark'),null,'disabled enhancement restores native glyph');
});

test('fast new run and cancel invalidate prior confirmation and an older in-flight poll without clearing other sessions', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);f.sp.dot.setAttribute('data-state','done');h.setPayload({unread:['parent','child'],unreadSessions:['sp','sc'],owners:{sp:'parent',sc:'child'}});}});
  assert.equal(h.plugin.test.localDoneCounts('sp'),true); assert.equal(h.plugin.test.localDoneCounts('sc'),true);
  let resolvePoll; h.respond((url)=>url.endsWith('/status')?new Promise(resolve=>{resolvePoll=resolve;}):{status:200,data:{success:true}});
  const oldPoll=h.plugin.test.updateStatus(); await h.flush();
  h.services.uiSession.sessionStatus.set(new Map([['sp',{running:true,completionUnread:false}]]));
  assert.equal(h.plugin.test.localDoneCounts('sp'),false,'old unread invalidated immediately on new source run');
  h.services.uiSession.sessionStatus.set(new Map([['sp',{running:false,completionUnread:true}]]));
  f.sp.dot.setAttribute('data-state','done'); h.plugin.test.refresh();
  assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'),'idle');
  resolvePoll({status:200,data:{protocolVersion:2,pinned:[],unread:['parent','child'],unreadSessions:['sp','sc'],owners:{sp:'parent',sc:'child'}}});
  await oldPoll; assert.equal(h.plugin.test.localDoneCounts('sp'),false,'pre-run response cannot reaffirm its old completion');
  assert.equal(h.plugin.test.localDoneCounts('sc'),true,'unrelated confirmed session survives');
  assert.equal(f.parent.row.querySelector('.dsh-order-state'),null);
  h.respond(()=>({status:503,data:{stateRead:{status:'degraded'}}})); await h.plugin.test.updateStatus();
  assert.equal(h.plugin.test.localDoneCounts('sp'),false); assert.equal(h.plugin.test.localDoneCounts('sc'),true);
});

test('poll cut taken while a root/subagent runs cannot confirm its previous unread after a quick cancel', async t => {
  let f; const h=await harness(t,{setup(h){f=addTree(h);f.sp.dot.setAttribute('data-state','done');h.setPayload({unreadSessions:['sp'],owners:{sp:'parent'}});}});
  h.services.sessions.list.set({phase:'ready',byId:{sp:{id:'sp'},sub:{id:'sub',origin:'subagent',parentId:'sp'}},projectionsBySession:{}});
  h.services.uiSession.sessionStatus.set(new Map([['sub',{running:true}]]));
  let resolvePoll; h.respond(url=>url.endsWith('/status')?new Promise(resolve=>{resolvePoll=resolve;}):{status:200,data:{success:true}});
  const activeCut=h.plugin.test.updateStatus(); await h.flush();
  h.services.uiSession.sessionStatus.set(new Map([['sub',{running:false,completionUnread:true}],['sp',{running:false,completionUnread:true}]]));
  resolvePoll({status:200,data:{protocolVersion:2,pinned:[],unreadSessions:['sp'],owners:{sp:'parent'}}}); await activeCut;
  assert.equal(h.plugin.test.localDoneCounts('sp'),false); assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'),'idle');
  h.respond(()=>({status:200,data:{protocolVersion:2,pinned:[],unreadSessions:['sp'],owners:{sp:'parent'}}})); await h.plugin.test.updateStatus();
  assert.equal(h.plugin.test.localDoneCounts('sp'),true,'a new idle-cut Host affirmation may confirm a real reply');
});

test('favorite navigation invokes native service owner and leaves the sole main holder releasable by native New', async t => {
  const holders=new Map(), consumerReferences=new Set(), nativeScope={name:'native'}, pluginScope={name:'consumer'};
  function retain(id,scope){const ref={id,scope,released:false,release(){if(this.released)return;this.released=true;holders.set(id,(holders.get(id)||0)-1);consumerReferences.delete(this);}};holders.set(id,(holders.get(id)||0)+1);if(scope===pluginScope)consumerReferences.add(ref);return ref;}
  const owner={ctx:nativeScope,mainReference:null,openSession(id){const next=retain(id,this.ctx),previous=this.mainReference;this.mainReference=next;previous?.release();},startSession(){this.openSession('native-blank');}};
  // A consumer proxy supplies a ctx-shadowed receiver (Cordis use-site behavior).
  // The original symbol exposes the service whose mainReference/native lifetime
  // must own global navigation; no independent plugin holder is permitted.
  const consumer=Object.create(owner); consumer.ctx=pluginScope;
  const proxy=new Proxy(consumer,{get(target,key){if(key===Symbol.for('cordis.original'))return owner;return Reflect.get(target,key);}});
  const h=await harness(t,{setup(h){h.services.uiWorkspace=proxy;h.setPayload({favorites:['qa'],sessionTitles:{qa:'QA'}});}});
  const anchor=h.el('button',{class:'dsh-order-star-filter'}); h.plugin.test.toggleStarMenu(anchor);
  h.document.dispatch(h.document.activeElement,'click'); await h.flush();
  assert.equal(owner.mainReference?.id,'qa'); assert.equal(owner.mainReference?.scope,nativeScope); assert.equal(consumerReferences.size,0);
  owner.startSession(); assert.equal(owner.mainReference.id,'native-blank'); assert.equal(holders.get('qa'),0); assert.equal(holders.get('native-blank'),1);
  h.dispose(); assert.equal(owner.mainReference.id,'native-blank'); assert.equal(holders.get('native-blank'),1,'plugin disposal does not own or release global main view');
});

test('a Host-affirmed completion reaches both the session row and the workspace folder', async t => {
  // The page's own store only learns completion from a running -> stopped edge
  // it personally watched. A reply that finished in another window, or before
  // this page loaded, has no such edge here, so the Host ledger is the only
  // source — and it must still reach the green mark.
  let f; const h = await harness(t, { setup(h) {
    f = addTree(h);
    // After a turn completes the native dot is 'done', not 'ongoing'.
    f.sp.dot.setAttribute('data-state', 'done');
    h.setPayload({ unread:['parent'], unreadSessions:['sp'], owners:{sp:'parent'} });
  } });
  await h.plugin.test.updateStatus();
  assert.equal(h.plugin.test.localDoneCounts('sp'), true, 'a Host-affirmed unread reply is a completion');
  h.plugin.test.refresh();
  assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'), 'done', 'the session row wears the done mark');
  const glyph = f.parent.row.querySelector('.dsh-order-state');
  assert.equal(glyph?.getAttribute('data-state'), 'done', 'the workspace folder shows the done state');
});

test('a live completion on an open page reaches the green mark', async t => {
  let f; const h = await harness(t, { setup(h) { f = addTree(h); } });
  h.services.sessions.list.set({ phase:'ready', state:'ready', byId:{ sp:{id:'sp',title:'Parent Session'} }, projectionsBySession:{} });
  // The turn runs, then stops with a real reply; the Host then affirms it.
  h.services.uiSession.sessionStatus.set(new Map([['sp',{running:true}]]));
  h.plugin.test.refresh(); await h.flush();
  h.services.uiSession.sessionStatus.set(new Map([['sp',{running:false,completionUnread:true}]]));
  f.sp.dot.setAttribute('data-state','done');
  h.setPayload({ unread:['parent'], unreadSessions:['sp'], owners:{sp:'parent'} });
  await h.plugin.test.updateStatus();
  h.plugin.test.refresh();
  assert.equal(h.plugin.test.localDoneCounts('sp'), true, 'the watched completion is confirmed');
  assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'), 'done');
  assert.equal(f.parent.row.querySelector('.dsh-order-state')?.getAttribute('data-state'), 'done');
});

test('a completion this client watched being read retires its green', async t => {
  // The shared ledger is what makes "read on the phone" clear the desktop's
  // green. The retirement needs positive evidence: this client first held the
  // reply as unread, then saw the Host withdraw it. An empty ledger alone is not
  // that evidence (see the reload test below).
  let f; const h = await harness(t, { setup(h) { f = addTree(h); f.sp.dot.setAttribute('data-state','done'); } });
  h.services.sessions.list.set({ phase:'ready', state:'ready', byId:{ sp:{id:'sp'} }, projectionsBySession:{} });
  h.services.uiSession.sessionStatus.set(new Map([['sp',{running:false,completionUnread:true}]]));
  // 1. The Host affirms the reply: this client now holds it as unread.
  h.setPayload({ unread:['parent'], unreadSessions:['sp'], owners:{sp:'parent'} });
  await h.plugin.test.updateStatus();
  assert.equal(h.plugin.test.localDoneCounts('sp'), true, 'the reply is held as unread');
  // 2. Another client reads it; the Host withdraws the mark and this page follows.
  h.setPayload({ unread:[], unreadSessions:[], owners:{sp:'parent'} });
  await h.plugin.test.updateStatus();
  h.plugin.test.refresh();
  assert.equal(h.plugin.test.localDoneCounts('sp'), false, 'the shared ledger retired it');
  assert.equal(f.parent.row.querySelector('.dsh-order-state'), null, 'no green folder once read');
});

test('a native green survives a page reload the Host never saw as a live completion', async t => {
  // The native page paints its own green check for a completed turn. After a
  // reload (or a Harness restart) this page saw no running -> stopped edge, and
  // the Host has no live event either, so it reports an empty unread ledger.
  // The native green is still the user's only completion fact and must stay.
  let f; const h = await harness(t, { setup(h) {
    f = addTree(h);
    f.sp.dot.setAttribute('data-state', 'done');
    h.setPayload({ unread: [], unreadSessions: [], owners: { sp: 'parent' } });
  } });
  await h.plugin.test.updateStatus();
  h.plugin.test.refresh();
  assert.equal(f.sp.dot.getAttribute('data-dsh-order-state'), 'done',
    'the page\'s own completion must not be replaced with idle');
  assert.equal(f.parent.row.querySelector('.dsh-order-state')?.getAttribute('data-state'), 'done',
    'the workspace folder keeps the completion too');
});

