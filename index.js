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
export const inject = ['workspaceRegistry', 'webServer', 'agents', 'connection'];

const STATUS_PATH = '/api/workspace-order/status';
const TOGGLE_PIN_PATH = '/api/workspace-order/toggle-pin';
const CLEAR_ERROR_PATH = '/api/workspace-order/clear-error';
const SETTINGS_PATH = '/api/workspace-order/settings';
const TOGGLE_FAVORITE_PATH = '/api/workspace-order/toggle-favorite';

/** The model-facing tool that parks a turn until the user answers. */
const ASK_USER_TOOL = 'ask_user_question';

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
  highlightCurrent: true,
  /** Show own sessions above sub-workspaces in tree view (browser-side). */
  treeSessionsFirst: true
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
        pendingResponses.add(res);
        try {
          // The native service owns login, trusted authorities and Origin checks.
          // Success is undefined: never run a second, loopback-only fence after it.
          // Keep the original request, including socket facts used by the Host.
          const rejection = ctx.connection.requestRejection(req);
          if (rejection !== undefined) {
            req.resume();
            return jsonResponse(res, rejection, { error: rejection === 401 ? 'Unauthorized' : 'Forbidden' });
          }
          await ready;
          ensureActive();
          await route.handler(req, res);
        } catch (error) {
          req.resume();
          jsonResponse(res, error.status || 500, { error: 'Workspace service unavailable' });
        } finally {
          pendingResponses.delete(res);
        }
      }
    });
  }

  ctx.effect(() => async () => {
    disposed = true;
    queryAbort.abort();
    clearTimeout(reorderTimer);
    reorderTimer = null;
    for (const cancel of pendingBodies) cancel();
    for (const res of pendingResponses) jsonResponse(res, 503, { error: 'Service stopped' });
    pendingResponses.clear();
    await queryFiber?.dispose?.();
    // Cordis awaits async effects. A replacement may load the same JSON files
    // only after every old writer/move/read has settled, including a mutation
    // which enqueues a reorder after its awaited atomic rename.
    await ready.catch(() => {});
    await Promise.allSettled([mutationTask, reorderTask, queryTask]);
    await reorderTask.catch(() => {});
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

  // Each browser instance owns a renewable, independent reading lease. A
  // vanished/hidden tab stops counting without overwriting any other reader.
  const VIEW_LEASE_MS = 18000;
  const readingViews = new Map();
  let legacyReadingLease = null;
  function isBeingRead(sessionId) {
    const now = Date.now();
    for (const [id, view] of readingViews) {
      if (view.expiresAt <= now) readingViews.delete(id);
      else if (view.sessionId === sessionId) return true;
    }
    if (legacyReadingLease?.expiresAt <= now) legacyReadingLease = null;
    return legacyReadingLease?.sessionId === sessionId;
  }

  const headers = new Map();
  const catalogParents = new Map();
  const observedState = new Map();
  const eventVersions = new Map();
  const turnFacts = new Map();
  const subagentRuns = new Map();
  const queryAbort = new AbortController();
  let queryTask = Promise.resolve();
  let querying = false;
  let stateRead = { status: 'ok', catalog: 'ok', failedSessionIds: [], unavailableProjectionSessionIds: [] };
  let queryBinding = null;
  // Some custom compositions omit the query service. The plugin still exposes
  // authenticated routes, explicitly degraded rather than silently blind.
  const queryFiber = ctx.inject(['sessionQuery'], child => {
    const abort = new AbortController();
    const binding = { service: child.sessionQuery, signal: abort.signal };
    queryBinding = binding;
    child.effect(() => async () => {
      abort.abort();
      if (queryBinding === binding) queryBinding = null;
      await queryTask.catch(() => {});
    }, 'workspace-order: logical session query binding');
  });

  /**
   * Sessions holding a question the user has not answered: callId -> true.
   *
   * This is the one wait that is not logged as an approval. The timed
   * `ask_user_question` variant folds into the durable `userQuestions`
   * projection, but the blocking variant — the one the standard preset ships
   * in this build — is not tracked by that fold at all, so a session parked on
   * a multiple-choice question looked merely "running" to every poll. The
   * Session event stream names both variants the same way, so the pair
   * `tool/call` / `tool/result` for that tool is what the Host watches.
   */
  const openQuestions = new Map();

  /** Summarize a borrowed logical log. Never retain the observation or events. */
  function summarizeObservation(observation) {
    const events = observation.events;
    if (!Array.isArray(events)) throw new Error('Session observation has no logical log');
    const approvals = new Set(), calls = new Set();
    let title;
    for (let i = observation.inheritedEventCount || 0; i < events.length; i += 1) {
      const event = events[i], data = event?.data;
      if (event?.type === 'turn/start' || event?.type === 'turn/end') calls.clear();
      if (!data) continue;
      if (event.type === 'approval/asked' && typeof data.id === 'string' && data.id) approvals.add(data.id);
      else if (event.type === 'approval/decided') approvals.delete(data.id);
      else if (event.type === 'tool/call' && data.name === ASK_USER_TOOL && typeof data.callId === 'string' && data.callId) calls.add(data.callId);
      else if (event.type === 'tool/result') calls.delete(data.message?.toolCallId);
      else if (event.type === 'session/title' && typeof data.title === 'string') title = data.title;
    }
    const values = observation.projections?.values;
    // Observation projections are WIRE views, not the registry's internal fold.
    const questions = values?.userQuestions?.active;
    const projectedWait = Array.isArray(questions) && questions.some(q => q?.state === 'open' || q?.state === 'continued');
    if (typeof values?.title === 'string') title = values.title;
    return { waiting: approvals.size > 0 || calls.size > 0 || projectedWait, projectedWaiting: projectedWait,
      title, catalog: Array.isArray(values?.subagentCatalog) ? values.subagentCatalog.map(entry => entry?.id).filter(id => typeof id === 'string' && id) : [],
      projectionsAvailable: values !== undefined && Array.isArray(questions) };
  }

  /** Coalesce overlapping polls; cold reads are non-activating and cancellable. */
  function refreshSessionState() {
    if (querying) return queryTask;
    querying = true;
    queryTask = (async () => {
      ensureActive();
      const binding = queryBinding;
      if (!binding) {
        stateRead = { status: 'degraded', catalog: 'unavailable', failedSessionIds: [], unavailableProjectionSessionIds: [] };
        return;
      }
      const service = binding.service;
      const signal = AbortSignal.any([queryAbort.signal, binding.signal]);
      const failed = new Set(), unavailable = new Set();
      const staged = new Map();
      const previousSources = new Map([...observedState.keys()].map(id => [id, eventVersions.get(id) || 0]));
      let catalog = 'ok', records = [];
      try {
        records = await service.listSessions(signal);
        if (queryBinding !== binding) throw new Error('Query binding changed');
        if (!Array.isArray(records)) throw new Error('Invalid logical corpus');
      } catch {
        ensureActive();
        catalog = 'unavailable';
        records = [];
      }
      ensureActive();
      const ids = new Set();
      for (const record of records) {
        const header = record?.header;
        if (typeof header?.id !== 'string' || !header.id) { catalog = 'unavailable'; continue; }
        headers.set(header.id, { ...header });
        ids.add(header.id);
      }
      // A successful corpus is authoritative for observable logs. Stale favorite
      // ids and provider-only external identities need not have a local log; keep
      // their metadata/marks without turning a missing title into permanent 503.
      // On listing failure, still try known targets rather than lose live waits.
      if (catalog === 'unavailable') {
        for (const ws of ctx.workspaceRegistry.list() || []) for (const id of ws.sessionIds || []) ids.add(id);
        for (const id of favoriteIds) ids.add(id);
        for (const id of activeSessions) ids.add(id);
        for (const run of subagentRuns.values()) ids.add(run.id);
      }
      // Stage every source until the entire batch is ready. A fast source can
      // change while another worker is blocked on disk, so validating only at
      // the end of that source's worker is not a publication barrier.
      const readSource = async id => {
        staged.delete(id);
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const version = eventVersions.get(id) || 0;
          let observation;
          try {
            observation = await service.observeSession(id, { projectionMode: 'all', signal });
            ensureActive();
            if (queryBinding !== binding) throw new Error('Query binding changed');
            if (observation.header?.id !== id || typeof observation[Symbol.dispose] !== 'function') throw new Error('Invalid observation lease');
            headers.set(id, { ...observation.header });
            const state = summarizeObservation(observation);
            if ((eventVersions.get(id) || 0) !== version) {
              if (attempt === 0) continue;
              throw new Error('Session read changed twice');
            }
            if (!state.projectionsAvailable) {
              unavailable.add(id);
              const previous = observedState.get(id);
              state.projectedWaiting = previous?.projectedWaiting || false;
              state.waiting ||= state.projectedWaiting;
              state.title ??= previous?.title;
            } else unavailable.delete(id);
            state.readVersion = version;
            staged.set(id, { state, version });
            failed.delete(id);
          } catch {
            ensureActive();
            failed.add(id);
            // Keep last-good waiting/title facts; failure is not a negative read.
          } finally {
            try { observation?.[Symbol.dispose]?.(); }
            catch { failed.add(id); staged.delete(id); }
          }
          break;
        }
      };
      const readBatch = async ordered => {
        let cursor = 0;
        const worker = async () => {
          while (cursor < ordered.length) {
            ensureActive();
            await readSource(ordered[cursor++]);
          }
        };
        // Drain all workers even if teardown aborts one before its peers settle.
        await Promise.allSettled(Array.from({ length: Math.min(4, ordered.length) }, () => worker()));
      };
      const invalidatedSources = () => [...staged].filter(([id, cut]) =>
        (eventVersions.get(id) || 0) !== cut.version).map(([id]) => id);
      await readBatch([...ids]);
      for (let round = 0; round < 2; round += 1) {
        const invalidated = invalidatedSources();
        if (!invalidated.length) break;
        await readBatch(invalidated);
      }
      ensureActive();
      if (queryBinding !== binding) catalog = 'unavailable';
      // No await between this final all-source check and publication. A source
      // still changing after bounded rereads is explicitly degraded, never a
      // 200/ok stale cut; its previous durable summary remains available.
      for (const id of invalidatedSources()) { failed.add(id); staged.delete(id); }
      if (queryBinding === binding) {
        for (const [id, { state }] of staged) {
          for (const childId of state.catalog) {
            const prior = catalogParents.get(childId);
            catalogParents.set(childId, prior === undefined || prior === id ? id : null);
          }
          observedState.set(id, state);
        }
      }
      if (catalog === 'ok') {
        for (const [id, version] of previousSources) {
          if (ids.has(id)) continue;
          if ((eventVersions.get(id) || 0) !== version) { failed.add(id); continue; }
          // A full successful logical listing, unlike Agent detach, proves this
          // formerly observed source has gone. Retire only its wait/title facts
          // (and their live wait overlays); terminal reminders, favorites, header
          // lineage and provider-only lifecycle identities are deliberately kept.
          observedState.delete(id);
          openApprovals.delete(id);
          openQuestions.delete(id);
        }
      }
      stateRead = { status: catalog === 'ok' && !failed.size && !unavailable.size ? 'ok' : 'degraded',
        catalog, failedSessionIds: [...failed], unavailableProjectionSessionIds: [...unavailable] };
    })().finally(() => { querying = false; });
    return queryTask;
  }

  function waitingSessions() {
    const waiting = new Set();
    const add = sessionId => waiting.add(rootSessionOf(sessionId));
    for (const [sessionId, state] of observedState) if (state.waiting) add(sessionId);
    for (const [sessionId, ids] of openApprovals) if (ids.size) add(sessionId);
    for (const [sessionId, calls] of openQuestions) if (calls.size) add(sessionId);
    return waiting;
  }

  function attributedSessions(sources) {
    return new Set([...sources].map(rootSessionOf));
  }

  function hasReply(message) {
    return Array.isArray(message?.content) && message.content.some(block =>
      block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '' || block?.type === 'image');
  }

  function finishTurn(sessionId, reason, reply) {
    const root = rootSessionOf(sessionId);
    if (reason === 'error') {
      erroredSessions.add(sessionId);
      unreadSessions.delete(sessionId);
    } else if (reason === 'completed' && reply && !erroredSessions.has(sessionId) && !isBeingRead(root)) {
      unreadSessions.add(sessionId);
    }
  }

  /**
   * The registered workspace whose directory most closely contains this one, by
   * the same longest-prefix rule the page uses to nest workspaces. The browser
   * needs this to lift a hidden child's glyph onto a collapsed ancestor.
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
   * The Session header facts the Host forwards for one Session, if any.
   * @returns the header, or undefined for an unknown Session.
   */
  function sessionHeaderOf(sessionId) {
    try {
      const header = ctx.agents.get(sessionId)?.session?.header;
      if (header?.id === sessionId) headers.set(sessionId, { ...header });
    } catch { /* An Agent may detach; its immutable header remains usable. */ }
    return headers.get(sessionId);
  }

  /**
   * The top-level Session one subagent Session belongs to. A subagent's Session
   * is a log of its own, carrying `parentSession` and never listed under a
   * workspace, so the work it does has to be credited to the Session that
   * spawned it.
   * @returns the root Session id, or the input when it is not a subagent's.
   */
  function rootSessionOf(sessionId) {
    let id = sessionId;
    const seen = new Set([id]);
    for (let hops = 0; hops < 64; hops += 1) {
      const header = sessionHeaderOf(id);
      // A fork has a parent too, but is a distinct workspace conversation.
      const parent = header?.origin === 'subagent' ? header.parentSession
        : header?.origin === undefined ? catalogParents.get(id) : undefined;
      if (typeof parent !== 'string' || !parent) return id;
      if (seen.has(parent)) return sessionId;
      seen.add(parent);
      id = parent;
    }
    return sessionId;
  }

  /**
   * Root Session ids with work in progress right now, subagent children folded
   * in. A workspace whose own Session is idle while a subagent it spawned is
   * still running was reported idle: the child Session belongs to no workspace,
   * so `busy` never named the card above it and the glyph fell through to
   * "finished, unread" or to nothing at all.
   * @returns a set of root Session ids.
   */
  function runningRootSessions() {
    const roots = new Set();
    const running = new Set(activeSessions);
    let agents = [];
    try {
      agents = typeof ctx.agents.list === 'function' ? ctx.agents.list() : [];
    } catch {
      agents = [];
    }
    for (const agent of agents) {
      if (agent && agent.id && agent.status === 'running') running.add(agent.id);
    }
    for (const run of subagentRuns.values()) if (run.running) running.add(run.id);
    for (const sessionId of running) roots.add(rootSessionOf(sessionId));
    return roots;
  }

  /**
   * Check which workspaces are currently busy.
   * @param runningRoots - the running root Session ids, when the caller has
   * already read them; otherwise they are read here.
   */
  function getBusyWorkspaces(allWorkspaces, runningRoots = runningRootSessions()) {
    const busyIds = new Set();
    // Host entities use `id`; the Remote projection alone uses `workspaceId`.
    const present = new Set(allWorkspaces.map(ws => ws.id));
    for (const id of busyTimestamps.keys()) if (!present.has(id)) busyTimestamps.delete(id);
    for (const ws of allWorkspaces) {
      if (Array.isArray(ws.sessionIds) && ws.sessionIds.some(id => runningRoots.has(id))) {
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
    return workspacesHolding(allWorkspaces, attributedSessions(erroredSessions));
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
   * page renders a collapsed group's rows nowhere, so a glyph for a session
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
   * payload exists at all for a glyph: a session parked on a question is not
   * merely busy, and the browser cannot tell the two apart from `busy` alone.
   */
  function statusPayload() {
    const all = ctx.workspaceRegistry.list() || [];
    const runningRoots = runningRootSessions();
    const busy = getBusyWorkspaces(all, runningRoots);
    reconcile(all);
    const waiting = waitingSessions();
    const unread = attributedSessions(unreadSessions);
    const errors = attributedSessions(erroredSessions);
    const sessionTitles = Object.fromEntries([...observedState].filter(([, state]) => typeof state.title === 'string' && state.title.trim()).map(([id, state]) => [id, state.title]));
    // The route's await can yield once after the query publication barrier.
    // Recheck at the synchronous HTTP payload boundary too: any later event
    // makes this an explicitly degraded cut until the next bounded read.
    const stale = [...observedState].filter(([id, state]) => state.readVersion !== (eventVersions.get(id) || 0)).map(([id]) => id);
    const payloadRead = stale.length ? { ...stateRead, status: 'degraded',
      failedSessionIds: [...new Set([...stateRead.failedSessionIds, ...stale])] } : stateRead;
    return {
      protocolVersion: 2,
      pinned: pinnedIds,
      busy: Array.from(busy),
      // The same fact per Session. The browser cannot derive it from `busy`
      // alone: a workspace only says "something in here runs", while a session
      // row has to know whether *it* is the one running — and a subagent's own
      // log is never named by `busy` at all.
      runningSessions: Array.from(runningRoots),
      waiting: workspacesHolding(all, waiting),
      waitingSessions: Array.from(waiting),
      errored: getErroredWorkspaces(all),
      erroredSessions: Array.from(errors),
      unread: workspacesHolding(all, unread),
      unreadSessions: Array.from(unread),
      archivedSessions: Array.from(ctx.workspaceRegistry.archivedSessionIds || []),
      sessionTitles,
      stateRead: payloadRead,
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

  // A boolean residency/status edge is not a completion fact.
  ctx.on('api-session/status', (sessionId, running) => {
    if (disposed) return;
    sessionHeaderOf(sessionId);
    getBusyWorkspaces(ctx.workspaceRegistry.list() || []);
    if (running) {
      activeSessions.add(sessionId);
      if (!turnFacts.has(sessionId)) turnFacts.set(sessionId, { reply: false, failed: false });
      erroredSessions.delete(sessionId);
      unreadSessions.delete(sessionId);
    } else activeSessions.delete(sessionId);
    getBusyWorkspaces(ctx.workspaceRegistry.list() || []);
    requestReorder();
  });

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id, data = event?.data;
    if (disposed || !sessionId || !data) return;
    if (session.header?.id === sessionId) headers.set(sessionId, { ...session.header });
    // A read cut invalidated by live events is retried before publication. Keep
    // last-good durable facts during the read: an unrelated step/message must
    // not temporarily erase a timed-continued question on a degraded poll.
    eventVersions.set(sessionId, (eventVersions.get(sessionId) || 0) + 1);
    if (event.type === 'turn/start') {
      turnFacts.set(sessionId, { turn: data.turn, reply: false, failed: false });
      openQuestions.delete(sessionId);
      erroredSessions.delete(sessionId);
      unreadSessions.delete(sessionId);
    } else if (event.type === 'assistant/message') {
      const facts = turnFacts.get(sessionId);
      if (facts && (facts.turn === undefined || facts.turn === data.turn) && !data.interrupted && hasReply(data.message)) facts.reply = true;
    } else if (event.type === 'turn/end') {
      const facts = turnFacts.get(sessionId);
      const matches = facts && (facts.turn === undefined || facts.turn === data.turn);
      if (matches) finishTurn(sessionId, facts.failed ? 'error' : data.reason?.kind, facts.reply);
      turnFacts.delete(sessionId);
      openQuestions.delete(sessionId);
    } else if (event.type === 'tool/call' && data.name === ASK_USER_TOOL && typeof data.callId === 'string' && data.callId) {
      let calls = openQuestions.get(sessionId);
      if (!calls) openQuestions.set(sessionId, calls = new Set());
      calls.add(data.callId);
    } else if (event.type === 'tool/result') {
      const calls = openQuestions.get(sessionId);
      calls?.delete(data.message?.toolCallId);
      if (!calls?.size) openQuestions.delete(sessionId);
    } else if (event.type === 'approval/asked' && typeof data.id === 'string' && data.id) {
      let ids = openApprovals.get(sessionId);
      if (!ids) openApprovals.set(sessionId, ids = new Set());
      ids.add(data.id);
    } else if (event.type === 'approval/decided' && typeof data.id === 'string') {
      const ids = openApprovals.get(sessionId);
      ids?.delete(data.id);
      if (!ids?.size) openApprovals.delete(sessionId);
    } else if (event.type === 'subagent/catalog' && typeof data.childId === 'string' && data.childId) {
      const prior = catalogParents.get(data.childId);
      catalogParents.set(data.childId, prior === undefined || prior === sessionId ? sessionId : null);
    }
    requestReorder();
  });

  ctx.on('api-session/error', sessionId => {
    if (disposed) return;
    sessionHeaderOf(sessionId);
    erroredSessions.add(sessionId);
    unreadSessions.delete(sessionId);
    const facts = turnFacts.get(sessionId);
    if (facts) facts.failed = true;
  });

  // Native removed means Agent detach, not deletion of the logical Session.
  ctx.on('api-session/removed', sessionId => {
    if (disposed) return;
    sessionHeaderOf(sessionId);
    activeSessions.delete(sessionId);
    requestReorder();
  });

  ctx.on('subagent/start', info => {
    if (disposed || typeof info?.id !== 'string' || !info.id || typeof info.runId !== 'string' || !info.runId || subagentRuns.has(info.runId)) return;
    sessionHeaderOf(info.id);
    subagentRuns.set(info.runId, { id: info.id, local: info.local === true, running: true });
    erroredSessions.delete(info.id);
    unreadSessions.delete(info.id);
    requestReorder();
  });
  ctx.on('subagent/end', info => {
    if (disposed || typeof info?.runId !== 'string') return;
    const run = subagentRuns.get(info.runId);
    if (!run?.running || run.id !== info.id) return;
    run.running = false;
    activeSessions.delete(run.id);
    // Local logs publish their own turn/end; don't acknowledge the same reply
    // twice after a reader has cleared its mark. External epochs have no such
    // local stream, so their paired terminal edge supplies the completion fact.
    if (!run.local || info.stopReason === 'error') finishTurn(run.id, info.stopReason, hasReply({ content: info.lastAssistantMessage }));
    requestReorder();
  });

  // Register HTTP endpoint: GET status
  ctx.effect(() => registerRoute({
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        req.resume();
        return jsonResponse(res, 405, { error: 'Method Not Allowed' });
      }
      try {
        await ready;
        await refreshSessionState();
        const payload = statusPayload();
        jsonResponse(res, payload.stateRead.status === 'degraded' ? 503 : 200, payload);
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
          ensureActive();
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
          const { sessionId, workspaceId, viewId } = body;
          const modern = Object.hasOwn(body, 'viewId');
          if (modern && (typeof viewId !== 'string' || !viewId.trim() || viewId.length > 256)) {
            return jsonResponse(res, 400, { error: 'Invalid viewId' });
          }
          const clearSeen = seen => {
            for (const source of erroredSessions) if (rootSessionOf(source) === seen || source === seen) erroredSessions.delete(source);
            for (const source of unreadSessions) if (rootSessionOf(source) === seen || source === seen) unreadSessions.delete(source);
          };
          if (sessionId === null || typeof sessionId === 'string') {
            const seen = sessionId || null;
            const lease = { sessionId: seen, expiresAt: Date.now() + VIEW_LEASE_MS };
            if (modern) {
              for (const [id, view] of readingViews) if (view.expiresAt <= Date.now()) readingViews.delete(id);
              if (seen) readingViews.set(viewId, lease);
              else readingViews.delete(viewId);
            } else legacyReadingLease = lease;
            if (seen) clearSeen(seen);
            return jsonResponse(res, 200, { success: true });
          }
          if (!modern && typeof workspaceId === 'string' && workspaceId) {
            const ws = ctx.workspaceRegistry.get(workspaceId);
            if (!ws) {
              return jsonResponse(res, 404, { error: 'Workspace not found' });
            }
            for (const id of ws.sessionIds || []) clearSeen(id);
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
            ensureActive();
            pinnedIds = next;
            await reorderAfterCommit();
          }
          return desired;
        });

        await refreshSessionState();
        const payload = statusPayload();

        jsonResponse(res, 200, {
          success: true,
          workspaceId,
          pinned,
          pinnedIds: payload.pinned,
          busyIds: payload.busy,
          runningSessionIds: payload.runningSessions,
          waitingIds: payload.waiting,
          waitingSessionIds: payload.waitingSessions,
          unreadIds: payload.unread,
          unreadSessionIds: payload.unreadSessions,
          erroredIds: payload.errored,
          erroredSessionIds: payload.erroredSessions,
          parents: payload.parents,
          owners: payload.owners,
          archivedSessionIds: payload.archivedSessions,
          sessionTitles: payload.sessionTitles,
          stateRead: payload.stateRead
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
            ensureActive();
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
