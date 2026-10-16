/**
 * dsh-workspace-focus-enhancer - Host Service
 *
 * Implements:
 * 1. Listening to session activity events to identify which workspace is busy.
 * 2. Multi-tier workspace reordering:
 *    - Tier 1: User-pinned workspaces (always at the very top, in fixed order).
 *    - Tier 2: Busy workspaces (workspaces currently running active sessions, newest busy first).
 *    - Tier 3: Idle workspaces (ordered naturally).
 * 3. HTTP endpoints for client-side pin toggling and status polling.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, rename, mkdir, open } from 'node:fs/promises';

export const name = 'workspace-order';
export const inject = ['workspaceRegistry', 'webServer', 'agents'];

const STATUS_PATH = '/api/workspace-order/status';
const TOGGLE_PIN_PATH = '/api/workspace-order/toggle-pin';
const CLEAR_ERROR_PATH = '/api/workspace-order/clear-error';
const SETTINGS_PATH = '/api/workspace-order/settings';
const TOGGLE_FAVORITE_PATH = '/api/workspace-order/toggle-favorite';

/**
 * Mirror the Host's own home resolution (`@deepseek-ai/dsh-home-paths`):
 * explicit `DSH_HOME` first, then `~/.dsh`. A hardcoded `homedir()` would
 * strand the plugin's files away from the rest of the harness the moment the
 * deployment relocates its home.
 */
const DSH_HOME = (process.env.DSH_HOME ?? '').trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh');
const STORAGE_DIR = join(DSH_HOME, 'storages');
const STORAGE_FILE = join(STORAGE_DIR, 'workspace-pins.json');
const SETTINGS_FILE = join(STORAGE_DIR, 'workspace-order-settings.json');
const FAVORITES_FILE = join(STORAGE_DIR, 'workspace-favorites.json');

/** Feature switches, with everything on by default. */
const DEFAULT_SETTINGS = Object.freeze({
  /** Busy workspaces move to the front of the list. */
  autoFront: true,
  /** Pinned workspaces stay on top and the pin control is offered. */
  pinTop: true,
  /** Orange question mark while a session waits for the user. */
  badgeWaiting: true,
  /** Red exclamation mark after a session fails. */
  badgeError: true,
  /** Spinning ring while working and green check when finished unread. */
  badgeRunningDone: true,
  /** Expanding one workspace collapses the others (browser-side behaviour). */
  autoCollapse: true,
  /** Outlines the workspace holding the session on screen (browser-side). */
  highlightCurrent: true
});

/**
 * Keep only known boolean switches, so a hand-edited file cannot invent state.
 */
function normalizeSettings(raw) {
  const next = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_SETTINGS)) {
      if (typeof raw[key] === 'boolean') next[key] = raw[key];
    }
  }
  return next;
}

/**
 * Write a JSON response with proper headers.
 */
function jsonResponse(res, status, data) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache, no-store'
  });
  res.end(body);
}

/**
 * Parse a `Host`-header authority the way the Host's own fence does (WHATWG
 * URL over `http://`, so default ports are stripped and IPv6 must be
 * bracketed).
 */
function parseAuthority(authority) {
  try {
    return new URL(`http://${authority}`);
  } catch {
    return void 0;
  }
}

/**
 * Official loopback-hostname semantics (mirrors
 * `isLoopbackHostname` in @deepseek-ai/dsh-client-connection): `localhost`,
 * `[::1]`, and the whole 127.0.0.0/8 written as four dotted octets.
 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/**
 * Socket-level loopback check, kept as a second layer: a request can carry a
 * spoofable `Host` header, but the peer address cannot be forged over TCP.
 */
function isLoopbackSocket(req) {
  const remote = (req.socket?.remoteAddress || '').toLowerCase();
  return remote === '::1' || remote === '127.0.0.1' || remote === '::ffff:127.0.0.1';
}

/**
 * Confused-deputy fence for every plugin route. The official `/api` bridge
 * never sees these paths (exact routes win over its prefix), so this plugin
 * owns its own admission and mirrors the official fence's three decisions
 * (`isTrustedApiRequest`): the Host header must name our own loopback server
 * (defeats DNS rebinding), `Sec-Fetch-Site` must not be `cross-site`, and any
 * `Origin` the browser does attach must be the same authority.
 * @returns true when the request may proceed.
 */
function isTrustedRequest(req) {
  if (!isLoopbackSocket(req)) return false;
  const host = req.headers?.host;
  if (typeof host !== 'string' || host.trim() === '') return false;
  const hostUrl = parseAuthority(host);
  if (hostUrl === void 0) return false;
  // Canonical-form guard, before anything else: WHATWG parsing rewrites
  // aliases like `0x7f.0.0.1` or `127.1` into `127.0.0.1`, so an attacker could
  // smuggle a rebound authority past a "loopback" test that only sees the
  // parsed form. Only a spelling whose hostname part survives round-tripping
  // unchanged is accepted (case aside, brackets preserved for IPv6).
  const spelledHostname = hostUrl.port === ''
    ? host.trim().toLowerCase()
    : host.slice(0, host.length - String(hostUrl.port).length - 1).trim().toLowerCase();
  if (hostUrl.hostname !== spelledHostname) return false;
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  const site = req.headers?.['sec-fetch-site'];
  if (typeof site === 'string' && site.toLowerCase() === 'cross-site') return false;
  const origin = req.headers?.origin;
  if (typeof origin === 'string' && origin.trim() !== '') {
    try {
      if (new URL(origin).host !== hostUrl.host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * Read request body as JSON. Only `application/json` is accepted: a
 * `text/plain` body would otherwise let a cross-site page smuggle a JSON
 * payload inside a preflight-free "simple request".
 */
function readJsonBody(req, pendingBodies) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers?.['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'application/json') {
      reject(Object.assign(new Error('Content type must be application/json'), { status: 415 }));
      req.resume();
      return;
    }
    let raw = '';
    let bytes = 0;
    const finish = (error, value) => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      pendingBodies.delete(cancel);
      if (error) reject(error);
      else resolve(value);
    };
    const cancel = () => finish(Object.assign(new Error('Service stopped'), { status: 503 }));
    const onError = error => finish(error);
    const onAborted = () => finish(Object.assign(new Error('Request aborted'), { status: 400 }));
    const onData = chunk => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 64 * 1024) {
        finish(Object.assign(new Error('Body too large'), { status: 413 }));
        req.resume();
      } else raw += chunk;
    };
    const onEnd = () => {
      try {
        const value = raw ? JSON.parse(raw) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
        finish(null, value);
      } catch {
        finish(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    };
    const timer = setTimeout(() => {
      finish(Object.assign(new Error('Request body timed out'), { status: 408 }));
      req.resume();
    }, 15000);
    timer.unref?.();
    pendingBodies.add(cancel);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}

export function apply(ctx) {
  let disposed = false;
  let reorderTimer = null;
  let applyingOrder = false;
  let lastReconciled = null;
  let mutationTask = Promise.resolve();
  const pendingBodies = new Set();
  const pendingResponses = new Set();

  function ensureActive() {
    if (disposed) throw Object.assign(new Error('Service stopped'), { status: 503 });
  }

  // All user mutations share one queue. Compute from committed state, write the
  // candidate, then publish it; a failed write has nothing in memory to undo.
  function mutate(operation) {
    const task = mutationTask.then(() => {
      ensureActive();
      return operation();
    });
    mutationTask = task.catch(() => {});
    return task;
  }

  function registerRoute(route) {
    return ctx.webServer.register({
      ...route,
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) return jsonResponse(res, 403, { error: 'Forbidden' });
        pendingResponses.add(res);
        try {
          await ready;
          ensureActive();
          await route.handler(req, res);
        } catch (error) {
          jsonResponse(res, error.status || 500, { error: String(error) });
        } finally {
          pendingResponses.delete(res);
        }
      }
    });
  }

  ctx.effect(() => () => {
    disposed = true;
    clearTimeout(reorderTimer);
    reorderTimer = null;
    for (const cancel of pendingBodies) cancel();
    for (const res of pendingResponses) jsonResponse(res, 503, { error: 'Service stopped' });
    pendingResponses.clear();
  }, 'workspace-order: pending work cleanup');

  /** Pinned workspace IDs in display order. */
  let pinnedIds = [];

  /** Favourite session ids, in the order they were starred. */
  let favoriteIds = [];

  /** Feature switches, mirrored to the browser through /api/workspace-order/settings. */
  let settings = { ...DEFAULT_SETTINGS };

  /** Currently running session IDs. */
  const activeSessions = new Set();

  /** Sessions whose last turn ended in an error, until the user opens that session. */
  const erroredSessions = new Set();

  /**
   * Open approval requests per session: sessionId -> Set of request ids. A set,
   * not a counter, so two asks answered out of order cannot cancel each other.
   */
  const openApprovals = new Map();

  /** Sessions whose last turn finished with a reply the user has not opened yet. */
  const unreadSessions = new Set();

  /**
   * The session the page last reported as being looked at. It exists for one
   * decision only: a turn that ends while its session is on screen has been read
   * as it arrived, so it does not become "a reply you have not seen". A turn that
   * ends after the user moved on is unread, because nobody was there to read it.
   */
  let mainSessionId = null;

  /**
   * Read the durable question fold, when the composition provides it: the very
   * fact the page turns into "waiting for an answer". Declared as an optional
   * dependency so a composition without it still loads, just blind to questions.
   * @returns the set of session ids holding an unanswered question.
   */
  let questionWaiters = null;
  ctx.inject(['sessions', 'sessionProjections'], (child) => {
    questionWaiters = () => {
      const waiting = new Set();
      try {
        for (const session of child.sessions.list()) {
          const state = child.sessionProjections.stateOf(session, 'userQuestions');
          const active = state && state.questions ? state.questions.active : void 0;
          if (!Array.isArray(active)) continue;
          // `continued` outlived its tool call but is still unanswered, so it counts.
          if (active.some(q => q && (q.state === 'open' || q.state === 'continued'))) {
            waiting.add(session.id);
          }
        }
      } catch {
        // A projection mid-teardown must not take the status route down with it.
      }
      return waiting;
    };
    child.effect(() => () => {
      questionWaiters = null;
    }, 'workspace-order: question fold reader');
  });

  /**
   * Sessions waiting for the user right now, from every source the Host owns.
   * This is the fact the polled fallback was missing: without it a session that
   * asked a question still looked merely "running" to the browser.
   * @returns a set of session ids.
   */
  function waitingSessions() {
    const waiting = questionWaiters ? questionWaiters() : new Set();
    for (const [sessionId, ids] of openApprovals) {
      if (ids.size) waiting.add(sessionId);
    }
    return waiting;
  }

  /**
   * The registered workspace whose directory most closely contains this one, by
   * the same longest-prefix rule the page uses to nest workspaces. The browser
   * needs this to lift a hidden child's badge onto a collapsed ancestor.
   * @returns a workspace id, or undefined at the top level.
   */
  function parentWorkspaceOf(workspace, all) {
    if (!workspace || typeof workspace.path !== 'string') return void 0;
    const child = trimPath(workspace.path);
    let best;
    let bestLength = -1;
    for (const other of all) {
      if (other === workspace || typeof other.path !== 'string') continue;
      const root = trimPath(other.path);
      if (root.length > bestLength && child !== root && child.startsWith(root + '/')) {
        best = other.id;
        bestLength = root.length;
      }
    }
    return best;
  }

  /** Normalize separators without reading POSIX backslashes as separators. */
  function trimPath(path) {
    const windows = /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\');
    const normalized = windows ? path.replaceAll('\\', '/') : path;
    return normalized.replace(/\/+$/, '');
  }

  /** Timestamps when workspaces entered busy state: workspaceId -> timestamp */
  const busyTimestamps = new Map();

  let reorderTask = Promise.resolve();

  /**
   * Load persisted pinned workspace IDs.
   */
  async function loadPins() {
    try {
      const content = await readFile(STORAGE_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.pinnedIds)) {
        pinnedIds = [...new Set(parsed.pinnedIds.filter(id => typeof id === 'string'))];
      }
    } catch {
      pinnedIds = [];
    }
  }

  /**
   * Persist one JSON document atomically and privately: write a temp sibling,
   * fsync it, then rename over the target. A crash mid-write therefore leaves
   * the previous document intact instead of a truncated file the loader would
   * silently reset to defaults. Mode 0600 matches every other file the storage
   * backend keeps in this directory.
   */
  async function saveJson(file, value) {
    await mkdir(STORAGE_DIR, { recursive: true });
    const body = `${JSON.stringify(value, null, 2)}\n`;
    const tmp = `${file}.${process.pid}.tmp`;
    const handle = await open(tmp, 'w', 0o600);
    try {
      await handle.writeFile(body, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
  }

  /**
   * Save pinned workspace IDs to disk.
   */
  async function savePins(next) {
    await saveJson(STORAGE_FILE, { pinnedIds: next });
  }

  /**
   * Load the starred session ids. Unknown shapes fall back to an empty list.
   */
  async function loadFavorites() {
    try {
      const content = await readFile(FAVORITES_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.favoriteIds)) {
        favoriteIds = [...new Set(parsed.favoriteIds.filter(id => typeof id === 'string'))];
      }
    } catch {
      favoriteIds = [];
    }
  }

  /**
   * Save the starred session ids to disk.
   */
  async function saveFavorites(next) {
    await saveJson(FAVORITES_FILE, { favoriteIds: next });
  }

  /**
   * Load the persisted feature switches.
   */
  async function loadSettings() {
    try {
      const content = await readFile(SETTINGS_FILE, 'utf8');
      settings = normalizeSettings(JSON.parse(content));
    } catch {
      settings = { ...DEFAULT_SETTINGS };
    }
  }

  /**
   * Save the feature switches to disk.
   */
  async function saveSettings(next) {
    await saveJson(SETTINGS_FILE, next);
  }

  /**
   * Check which workspaces are currently busy.
   */
  function getBusyWorkspaces(allWorkspaces) {
    const busyIds = new Set();
    // Host entities use `id`; the Remote projection alone uses `workspaceId`.
    const present = new Set(allWorkspaces.map(ws => ws.id));
    for (const id of busyTimestamps.keys()) if (!present.has(id)) busyTimestamps.delete(id);
    for (const ws of allWorkspaces) {
      if (Array.isArray(ws.sessionIds) && ws.sessionIds.some(id =>
        activeSessions.has(id) || ctx.agents.get(id)?.status === 'running')) {
        busyIds.add(ws.id);
        if (!busyTimestamps.has(ws.id)) {
          busyTimestamps.set(ws.id, Date.now());
        }
      } else {
        busyTimestamps.delete(ws.id);
      }
    }
    return busyIds;
  }

  /**
   * Workspaces holding a session whose last failure is still unseen.
   */
  function getErroredWorkspaces(allWorkspaces) {
    const erroredIds = [];
    for (const ws of allWorkspaces) {
      if (Array.isArray(ws.sessionIds) && ws.sessionIds.some(id => erroredSessions.has(id))) {
        erroredIds.push(ws.id);
      }
    }
    return erroredIds;
  }

  /** Every workspace holding at least one of these sessions. */
  function workspacesHolding(allWorkspaces, sessionIds) {
    if (!sessionIds.size) return [];
    const ids = [];
    for (const ws of allWorkspaces) {
      if (Array.isArray(ws.sessionIds) && ws.sessionIds.some(id => sessionIds.has(id))) {
        ids.push(ws.id);
      }
    }
    return ids;
  }

  /**
   * Workspace nesting as child -> the workspace whose folder contains it. The
   * page renders a collapsed group's rows nowhere, so a badge for a session
   * inside one has to be drawn on an ancestor that is still on screen; sending
   * the tree is what lets the browser find that ancestor on its own.
   */
  function workspaceParents(allWorkspaces) {
    const parents = {};
    for (const ws of allWorkspaces) {
      const parent = parentWorkspaceOf(ws, allWorkspaces);
      if (parent) parents[ws.id] = parent;
    }
    return parents;
  }

  /**
   * Which workspace owns each session, straight from the registry. The browser
   * needs this for the same reason it needs the tree: a starred session behind a
   * collapsed group still has to show up somewhere the user can see.
   */
  function sessionOwners(allWorkspaces) {
    const owners = {};
    for (const ws of allWorkspaces) {
      for (const id of ws.sessionIds || []) owners[id] = ws.id;
    }
    return owners;
  }

  /**
   * Status payload shared by both read-only routes. `waiting` is why this
   * payload exists at all for a badge: a session parked on a question is not
   * merely busy, and the browser cannot tell the two apart from `busy` alone.
   */
  function statusPayload() {
    const all = ctx.workspaceRegistry.list() || [];
    const busy = getBusyWorkspaces(all);
    reconcile(all);
    const waiting = waitingSessions();
    return {
      protocolVersion: 2,
      pinned: pinnedIds,
      busy: Array.from(busy),
      waiting: workspacesHolding(all, waiting),
      waitingSessions: Array.from(waiting),
      errored: getErroredWorkspaces(all),
      erroredSessions: Array.from(erroredSessions),
      unread: workspacesHolding(all, unreadSessions),
      unreadSessions: Array.from(unreadSessions),
      parents: workspaceParents(all),
      owners: sessionOwners(all),
      favorites: favoriteIds,
      settings
    };
  }

  /** A shared global order serves both flat and tree browser views. Only
   * ancestors inherit descendant urgency; idle children inherit nothing. */
  function performReorder() {
    const task = reorderTask.catch(() => {}).then(async () => {
      if (disposed) return;
      applyingOrder = true;
      let completed = false;
      try {
        const all = ctx.workspaceRegistry.list() || [];
        const busyIds = getBusyWorkspaces(all);
        if (all.length <= 1 || (!settings.autoFront && !settings.pinTop)) {
          completed = true;
          return;
        }
        const parentOf = workspaceParents(all);
        const busyAtIn = new Map(all.map(ws => [ws.id,
          settings.autoFront && busyIds.has(ws.id) ? busyTimestamps.get(ws.id) || 0 : 0]));
        const pinRankIn = new Map(all.map(ws => [ws.id, Infinity]));
        if (settings.pinTop) pinnedIds.forEach((id, rank) => {
          if (pinRankIn.has(id)) pinRankIn.set(id, rank);
        });
        // Propagate each workspace's own urgency up its ancestor chain.
        for (const ws of all) {
          const busyAt = busyAtIn.get(ws.id);
          const pinRank = pinRankIn.get(ws.id);
          const seen = new Set([ws.id]);
          for (let parent = parentOf[ws.id]; parent && !seen.has(parent); parent = parentOf[parent]) {
            seen.add(parent);
            busyAtIn.set(parent, Math.max(busyAtIn.get(parent) || 0, busyAt));
            pinRankIn.set(parent, Math.min(pinRankIn.get(parent) ?? Infinity, pinRank));
          }
        }
        const targetOrder = all.map((ws, index) => ({ id: ws.id, index })).sort((a, b) => {
          const pinA = pinRankIn.get(a.id);
          const pinB = pinRankIn.get(b.id);
          if (pinA !== pinB) return pinA - pinB;
          const busyA = busyAtIn.get(a.id);
          const busyB = busyAtIn.get(b.id);
          return busyB - busyA || a.index - b.index;
        }).map(entry => entry.id);
        for (let i = 0; i < targetOrder.length; i++) {
          if (disposed) return;
          const live = ctx.workspaceRegistry.list().map(ws => ws.id);
          // A concurrent removal/create invalidates this snapshot; a later
          // reconciliation computes against the complete live registry again.
          if (live.length !== targetOrder.length || targetOrder.some(id => !live.includes(id))) {
            lastReconciled = null;
            requestReorder();
            return;
          }
          if (live[i] !== targetOrder[i]) await ctx.workspaceRegistry.insertBefore(targetOrder[i], live[i]);
        }
        completed = true;
      } finally {
        applyingOrder = false;
        if (!disposed && completed) {
          const all = ctx.workspaceRegistry.list() || [];
          getBusyWorkspaces(all);
          // A concurrent registry edit during an awaited move still needs a
          // pass, while self-induced changes already satisfy the target order.
          reconcile(all);
        }
      }
    });
    reorderTask = task;
    return task;
  }

  function reconcile(all) {
    const signature = JSON.stringify([
      all.map(ws => [ws.id, ws.path, ws.sessionIds]),
      Array.from(busyTimestamps), pinnedIds, settings.autoFront, settings.pinTop
    ]);
    if (signature === lastReconciled) return;
    lastReconciled = signature;
    requestReorder();
  }

  async function reorderAfterCommit() {
    try {
      await performReorder();
    } catch (err) {
      lastReconciled = null;
      console.warn('[workspace-order] Reorder after committed mutation failed:', err);
    }
  }

  function requestReorder() {
    if (disposed || reorderTimer !== null) return;
    reorderTimer = setTimeout(() => {
      reorderTimer = null;
      ready.then(() => performReorder()).catch(err => {
        lastReconciled = null;
        console.warn('[workspace-order] Reorder cycle error:', err);
      });
    }, 20);
    reorderTimer.unref?.();
  }

  // Native registry changes are durable storage-domain notifications. The
  // singleton table is ''; workspace records use 'workspaces'. Events precede
  // completion of the registry operation, hence reconciliation is deferred.
  ctx.on('domain/changed', change => {
    if (disposed || change.domain !== 'workspace' || applyingOrder) return;
    if (change.table === '' || change.table === 'workspaces') requestReorder();
  });

  // A failed initial ordering write must not make all reads fail permanently.
  const ready = Promise.all([loadPins(), loadSettings(), loadFavorites()])
    .then(() => disposed ? undefined : performReorder())
    .catch(err => {
      lastReconciled = null;
      console.warn('[workspace-order] Startup reorder error:', err);
    });

  // Listen to session status changes
  ctx.on('api-session/status', (sessionId, running) => {
    if (disposed) return;
    // Snapshot the transition now, before an awaited reorder can blur the
    // relative times of two workspaces entering busy state.
    getBusyWorkspaces(ctx.workspaceRegistry.list() || []);
    if (running) {
      activeSessions.add(sessionId);
      getBusyWorkspaces(ctx.workspaceRegistry.list() || []);
      // A fresh run means the user is acting on it; the red mark has been seen.
      erroredSessions.delete(sessionId);
      unreadSessions.delete(sessionId);
    } else {
      // Only a run this process actually watched can "finish", so a session that
      // stops for any other reason cannot invent a finished-unread reminder.
      const finishedHere = activeSessions.delete(sessionId);
      // A session the user is looking at is not unread: the reply is on screen.
      // The page reports the session it is showing before this turn ends, so the
      // comparison is against what is on screen right now, not where the user was
      // when the turn began.
      if (finishedHere && sessionId !== mainSessionId) unreadSessions.add(sessionId);
    }
    getBusyWorkspaces(ctx.workspaceRegistry.list() || []);
    requestReorder();
  });

  // An approval ask opens a wait; its decision closes it. The event pair is the
  // only way to see pending approvals, which no service enumerates.
  ctx.on('session/event', (session, event) => {
    const sessionId = session && session.id;
    if (disposed || !sessionId || !event) return;
    // Only a well-formed id may enter the set: a malformed ask would otherwise
    // park a `undefined` member that only the matching malformed decision could
    // remove, pinning the workspace on "waiting" until restart.
    const requestId = event.data && typeof event.data.id === 'string' ? event.data.id : void 0;
    if (!requestId) return;
    if (event.type === 'approval/asked') {
      let ids = openApprovals.get(sessionId);
      if (!ids) openApprovals.set(sessionId, ids = new Set());
      ids.add(requestId);
    } else if (event.type === 'approval/decided') {
      const ids = openApprovals.get(sessionId);
      if (!ids) return;
      ids.delete(requestId);
      if (!ids.size) openApprovals.delete(sessionId);
    } else {
      return;
    }
    // The question a turn asked may already be answered; the wait is re-read
    // at report time, so only the approval change needs announcing here.
    requestReorder();
  });

  // A turn that stopped on an error needs the user's attention.
  ctx.on('api-session/error', (sessionId) => {
    if (disposed) return;
    erroredSessions.add(sessionId);
  });

  ctx.on('api-session/removed', sessionId => {
    if (disposed) return;
    const wasTracked = activeSessions.has(sessionId) || erroredSessions.has(sessionId)
      || unreadSessions.has(sessionId) || openApprovals.has(sessionId);
    activeSessions.delete(sessionId);
    openApprovals.delete(sessionId);
    erroredSessions.delete(sessionId);
    unreadSessions.delete(sessionId);
    if (mainSessionId === sessionId) mainSessionId = null;
    if (wasTracked) requestReorder();
  });

  // Register HTTP endpoint: GET status
  ctx.effect(() => registerRoute({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      try {
        await ready;
        jsonResponse(res, 200, statusPayload());
      } catch (err) {
        jsonResponse(res, err.status || 500, { error: String(err) });
      }
    }
  }), 'workspace-order: status route');

  // Register HTTP endpoint: feature switches — GET reads them, POST writes them.
  ctx.effect(() => registerRoute({
    kind: 'exact',
    path: SETTINGS_PATH,
    handler: async (req, res) => {
      try {
        await ready;
        if (req.method === 'GET') {
          return jsonResponse(res, 200, { settings });
        }
        if (req.method !== 'POST') {
          return jsonResponse(res, 405, { error: 'Method Not Allowed' });
        }
        const body = await readJsonBody(req, pendingBodies);
        const patch = body && body.settings;
        const keys = patch && typeof patch === 'object' && !Array.isArray(patch) ? Object.keys(patch) : [];
        if (!keys.length || keys.some(key => !Object.hasOwn(DEFAULT_SETTINGS, key) || typeof patch[key] !== 'boolean')) {
          return jsonResponse(res, 400, { error: 'Expected known boolean settings' });
        }
        const committed = await mutate(async () => {
          const next = { ...settings, ...patch };
          await saveSettings(next);
          settings = next;
          await reorderAfterCommit();
          return settings;
        });
        jsonResponse(res, 200, { success: true, settings: committed });
      } catch (err) {
        jsonResponse(res, err.status || 500, { error: String(err) });
      }
    }
  }), 'workspace-order: settings route');

  // Register HTTP endpoint: POST clear-error (a session was opened, so its red mark is seen)
  ctx.effect(() => registerRoute({
    kind: 'exact',
    path: CLEAR_ERROR_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        return jsonResponse(res, 405, { error: 'Method Not Allowed' });
      }
      try {
        const body = await readJsonBody(req, pendingBodies);
        await mutate(() => {
          const { sessionId, workspaceId } = body;
          // The page reports the session it is showing, including "none" when the
          // user has closed every session. Opening a session retires both of its
          // marks: the failure has been seen, and the reply has been read.
          if (sessionId === null || typeof sessionId === 'string') {
            const seen = sessionId || null;
            // Nothing is undone on the way out. A turn that ended while its session
            // was on screen was read as it arrived, so it was never marked unread;
            // re-raising it when the user looked elsewhere put a "new reply" check
            // on a conversation they had just read.
            if (seen) {
              erroredSessions.delete(seen);
              unreadSessions.delete(seen);
            }
            mainSessionId = seen;
            return jsonResponse(res, 200, { success: true });
          }
          if (typeof workspaceId === 'string' && workspaceId) {
            const ws = ctx.workspaceRegistry.get(workspaceId);
            if (!ws) {
              return jsonResponse(res, 404, { error: 'Workspace not found' });
            }
            for (const id of ws.sessionIds || []) {
              erroredSessions.delete(id);
              unreadSessions.delete(id);
            }
            return jsonResponse(res, 200, { success: true });
          }
          jsonResponse(res, 400, { error: 'Invalid sessionId' });
        });
      } catch (err) {
        jsonResponse(res, err.status || 500, { error: String(err) });
      }
    }
  }), 'workspace-order: clear-error route');

  // Register HTTP endpoint: POST toggle-pin
  ctx.effect(() => registerRoute({
    kind: 'exact',
    path: TOGGLE_PIN_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        return jsonResponse(res, 405, { error: 'Method Not Allowed' });
      }

      try {
        await ready;
        const body = await readJsonBody(req, pendingBodies);
        const { workspaceId } = body;
        if (!workspaceId || typeof workspaceId !== 'string') {
          return jsonResponse(res, 400, { error: 'Invalid workspaceId' });
        }
        if (!ctx.workspaceRegistry.get(workspaceId)) {
          return jsonResponse(res, 404, { error: 'Workspace not found' });
        }

        if (Object.hasOwn(body, 'pinned') && typeof body.pinned !== 'boolean') {
          return jsonResponse(res, 400, { error: 'Invalid pinned' });
        }
        const pinned = await mutate(async () => {
          if (!ctx.workspaceRegistry.get(workspaceId)) throw Object.assign(new Error('Workspace not found'), { status: 404 });
          const present = pinnedIds.includes(workspaceId);
          const desired = typeof body.pinned === 'boolean' ? body.pinned : !present;
          if (desired !== present) {
            const next = desired ? [workspaceId, ...pinnedIds] : pinnedIds.filter(id => id !== workspaceId);
            await savePins(next);
            pinnedIds = next;
            await reorderAfterCommit();
          }
          return desired;
        });

        const payload = statusPayload();

        jsonResponse(res, 200, {
          success: true,
          workspaceId,
          pinned,
          pinnedIds: payload.pinned,
          busyIds: payload.busy,
          waitingIds: payload.waiting,
          unreadIds: payload.unread,
          unreadSessionIds: payload.unreadSessions,
          erroredIds: payload.errored,
          erroredSessionIds: payload.erroredSessions,
          parents: payload.parents,
          owners: payload.owners
        });
      } catch (err) {
        jsonResponse(res, err.status || 500, { error: String(err) });
      }
    }
  }), 'workspace-order: toggle-pin route');

  // Register HTTP endpoint: POST toggle-favorite (star or unstar one session)
  ctx.effect(() => registerRoute({
    kind: 'exact',
    path: TOGGLE_FAVORITE_PATH,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        return jsonResponse(res, 405, { error: 'Method Not Allowed' });
      }
      try {
        const body = await readJsonBody(req, pendingBodies);
        const { sessionId } = body;
        if (!sessionId || typeof sessionId !== 'string') {
          return jsonResponse(res, 400, { error: 'Invalid sessionId' });
        }
        if (Object.hasOwn(body, 'favorite') && typeof body.favorite !== 'boolean') {
          return jsonResponse(res, 400, { error: 'Invalid favorite' });
        }
        const result = await mutate(async () => {
          const present = favoriteIds.includes(sessionId);
          const favorite = typeof body.favorite === 'boolean' ? body.favorite : !present;
          if (favorite !== present) {
            const next = favorite ? [sessionId, ...favoriteIds] : favoriteIds.filter(id => id !== sessionId);
            await saveFavorites(next);
            favoriteIds = next;
          }
          return { success: true, sessionId, favorite, favoriteIds };
        });
        jsonResponse(res, 200, result);
      } catch (err) {
        jsonResponse(res, err.status || 500, { error: String(err) });
      }
    }
  }), 'workspace-order: toggle-favorite route');
}
