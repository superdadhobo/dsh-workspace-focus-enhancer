/**
 * dsh-workspace-focus-enhancer - Client UI Enhancements
 *
 * Provides:
 * 1. Pin button (📌) on each workspace row in the sidebar:
 *    - Hover to reveal on normal workspaces.
 *    - Always visible & highlighted when pinned.
 *    - Click to toggle pin without expanding/collapsing the workspace.
 * 2. One state badge before the workspace title, resolved in this priority:
 *    - orange question mark : a session in the workspace waits for the user
 *      (approval, plan review, or a question);
 *    - red exclamation mark : a session stopped on an error and is unseen;
 *    - spinning ring        : a session is running;
 *    - green check          : a session finished and its output is unread;
 *    - nothing              : the workspace is idle.
 *    The live waiting/running/unread facts come from the Host's own session
 *    status store when the page exposes it, and from the Host's polled status
 *    otherwise; the two are merged per row, so a fact only one of them knows
 *    still reaches the badge. A workspace whose row is hidden because an
 *    ancestor is collapsed hands its badge up to the nearest visible ancestor,
 *    so collapsing a group never hides that something inside needs attention.
 * 3. Synchronization with the backend ordering service.
 */

window.__ModuleLoader__.load({
  id: "dsh-workspace-focus-enhancer",
  factory: (require) => {
    const module = { exports: {} };

    // The page ships these as built-in modules; requiring them keeps the panel
    // visually identical to the official plugin cards.
    let react = null;
    let jsxRuntime = null;
    let primitives = null;
    let createStore = null;
    let uiAvailable = false;
    try {
      react = require('react');
      jsxRuntime = require('react/jsx-runtime');
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
      createStore = require('@deepseek-ai/dsh-client-store').createSnapshotStore;
      uiAvailable = !!(react && jsxRuntime && primitives && primitives.Switch && createStore);
      // The collapsible group needs two more official pieces; without them the
      // panel still works, just with every switch listed flat.
    } catch {
      uiAvailable = false;
    }

    const CSS = `
      /*
       * Status palette: exactly one value per meaning, declared on the body
       * element because that is where the page puts its own alias tokens — a
       * definition higher up the tree would not see them and would silently
       * fall back. Every place this plugin paints a state reads one of these
       * three names, so a colour can never drift between two of them.
       *
       * Green needs a step of its own. The page's success green is a brand
       * colour made to fill large surfaces, and drawn as a 14px badge stroke on
       * the light sidebar it sits at about 1.6:1, which is why the finished
       * state read washed out. It is taken down to 62% on the light theme,
       * keeping the page's own hue — the green stays the same green, only deep
       * enough to see. The dark theme keeps the page's token untouched, since
       * it already clears 5:1 on a near-black sidebar.
       *
       * Amber is referenced, not mixed, and that is the whole point of it. The
       * favourite star and the waiting question mark are two different shapes
       * carrying two different meanings, but they are the same orange, and a
       * star drawn as a solid mass beside a hairline question mark only reads as
       * one orange if both are literally one value. The star is the reference —
       * it is the orange the user already sees and likes — so the badge takes
       * the star's amber rather than the other way round. It is also the amber
       * the rest of the harness uses for a warning.
       *
       * Red is referenced for the same reason, and it is what the page already
       * gives a deep step for light and a bright one for dark — exactly the
       * treatment it failed to give green. Both are theme tokens that resolve
       * per theme on their own, so neither needs a dark-theme override here.
       */
      body {
        --dsh-order-green: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 62%, #000);
        --dsh-order-amber: var(--dsw-alias-state-warn-primary, #f59e0b);
        --dsh-order-red: var(--dsw-alias-state-error-primary, #ef4444);
      }

      body[data-ds-dark-theme] {
        --dsh-order-green: var(--dsw-alias-state-success-primary, #22c55e);
      }

      .dsh-order-pin-btn {
        width: 24px;
        height: 24px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        background: transparent;
        border-radius: 6px;
        padding: 0;
        cursor: pointer;
        color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.4));
        opacity: 0;
        transition: opacity 0.15s ease, color 0.15s ease, transform 0.1s ease;
        flex-shrink: 0;
        margin-right: 2px;
      }

      /* Reveal pin button when hovering over the workspace row */
      div[data-row-key^="workspace:"]:hover .dsh-order-pin-btn {
        opacity: 0.65;
      }

      .dsh-order-pin-btn:hover {
        opacity: 1 !important;
        color: var(--dsw-alias-label-primary, #ffffff) !important;
        background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
        transform: scale(1.08);
      }

      /* Active / pinned state: always visible and highlighted */
      .dsh-order-pin-btn[data-pinned="true"] {
        opacity: 1 !important;
        color: var(--dsw-alias-brand, #3b82f6) !important;
      }

      .dsh-order-pin-btn svg {
        width: 14px;
        height: 14px;
        fill: currentColor;
      }

      /*
       * A session's star leads the row, ahead of its state badge. Hidden until
       * hover on unstarred rows so the list stays quiet, always visible once
       * starred so a favourite is obvious.
       */
      .dsh-order-star {
        width: 18px;
        height: 18px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        align-self: center;
        margin-right: 2px;
        padding: 0;
        border: none;
        background: transparent;
        border-radius: var(--dsw-radius-xs, 4px);
        cursor: pointer;
        color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.45));
        opacity: 0;
        transition: opacity 0.15s ease, color 0.15s ease, transform 0.1s ease;
      }

      .dsh-order-star svg { width: 14px; height: 14px; display: block; }

      div[data-row-key^="session:"]:hover .dsh-order-star { opacity: 0.7; }

      .dsh-order-star:hover {
        opacity: 1 !important;
        color: var(--dsh-order-amber);
        transform: scale(1.1);
      }

      .dsh-order-star[data-starred="true"] {
        opacity: 1 !important;
        color: var(--dsh-order-amber);
      }

      /*
       * The solid star gains a rim, so its silhouette holds against a pale
       * sidebar instead of dissolving into it. Every site that draws the solid
       * star is listed; the hollow hover star is left alone, since it is an
       * outline already and draws its own.
       *
       * The rim is derived from whatever colour the star is currently drawn in,
       * so it follows the star rather than overriding it: a starred session's
       * amber keeps an amber rim, and the header button, which is neutral until
       * something is starred, keeps a neutral one instead of growing an orange
       * outline around a grey star. The step is the same 62% the badges use, so
       * the plugin draws one deepened amber rather than several near-misses.
       *
       * A stroke-width of 1.9 is measured in this SVG's 24-unit viewBox, so at
       * the 16px header size it renders 1.27px — the same weight the hollow star
       * beside it already stroked its outline at, and the native icon buttons in
       * that very row are stroked 1.3px in a 16-unit viewBox. Both states of the
       * star therefore draw one frame of one weight, and the smaller copies
       * scale with it exactly as the native icons do.
       */
      :is(
        .dsh-order-star[data-starred="true"],
        .dsh-order-star-count,
        .dsh-order-star-filter,
        .dsh-order-star-menu-item
      ) svg path {
        stroke: color-mix(in srgb, currentColor 62%, #000);
        stroke-width: 1.9;
        stroke-linejoin: round;
      }

      /* On a near-black sidebar the rim only has to separate the star from the
       * dark ground, so it takes a shallower step: darkening it as far as the
       * light theme does would read as a thick outline eating into the star
       * rather than a crisp edge on it. */
      body[data-ds-dark-theme] :is(
        .dsh-order-star[data-starred="true"],
        .dsh-order-star-count,
        .dsh-order-star-filter,
        .dsh-order-star-menu-item
      ) svg path {
        stroke: color-mix(in srgb, currentColor 82%, #000);
      }

      /* A workspace's rolled-up star sits after its name, never over the badge. */
      .dsh-order-star-count {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        flex-shrink: 0;
        margin-left: 6px;
        color: var(--dsh-order-amber);
        font-size: 12px;
        line-height: 1;
        align-self: center;
      }

      .dsh-order-star-count svg { width: 12px; height: 12px; display: block; }

      /* One toolbar: title takes the spare space; the plugin's own control stays
       * with the native ones. Foreign plugins' buttons keep whatever order their
       * own stylesheet gives them — restyling or reordering another plugin's
       * node here would couple the two bundles' layouts together. */
      .dsh-order-workspace-header {
        flex-wrap: nowrap;
        gap: 4px;
        min-width: 0;
      }

      .dsh-order-workspace-header > [class*="_sectionLabel"] {
        order: 0;
        flex: 1 1 0%;
        max-width: none;
        min-width: 0;
        text-overflow: ellipsis;
      }

      .dsh-order-workspace-header > .dsh-order-star-filter { order: 2; }
      .dsh-order-workspace-header > [class*="_searchSlot"] {
        order: 3;
        flex: 0 0 28px;
        margin-left: 0;
      }
      .dsh-order-workspace-header > [class*="_headerActions"] { order: 4; }

      /* Match the native 28px buttons, 16px icons, hover and inset focus ring. */
      .dsh-order-workspace-header > .dsh-order-star-filter {
        box-sizing: border-box;
        border-radius: var(--dsw-radius-sm, 8px);
        cursor: pointer;
        width: 28px;
        height: 28px;
        color: var(--dsw-alias-label-secondary);
        background: transparent;
        border: none;
        flex: 0 0 28px;
        justify-content: center;
        align-items: center;
        padding: 0;
        margin: 0;
        display: inline-flex;
        -webkit-app-region: no-drag;
        touch-action: manipulation;
      }

      .dsh-order-workspace-header > .dsh-order-star-filter:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dsh-order-workspace-header > .dsh-order-star-filter:focus-visible {
        outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
        outline-offset: -2px;
      }
      .dsh-order-workspace-header > .dsh-order-star-filter svg { width: 16px; height: 16px; display: block; pointer-events: none; }
      .dsh-order-star-filter[data-active="true"] { color: var(--dsh-order-amber); }

      /* Search already hides the native actions; give its input the same room. */
      .dsh-order-workspace-header:has(> [class*="_searchSlotExpanded"]) > .dsh-order-star-filter,
      [class*="_rail"] > .dsh-order-workspace-header > .dsh-order-star-filter { display: none; }
      .dsh-order-workspace-header:has(> [class*="_searchSlotExpanded"]) > [class*="_sectionLabel"] {
        flex: 0 0 0%;
        max-width: 0;
      }
      .dsh-order-workspace-header > [class*="_searchSlotExpanded"] {
        flex: 1 1 0%;
        max-width: 100%;
        transition: none;
      }
      .dsh-order-workspace-header:has(> [class*="_searchSlotExpanded"]) > [class*="_headerActions"] {
        display: none;
      }

      /* The list of starred sessions, anchored under that button. */
      .dsh-order-star-menu {
        position: absolute;
        z-index: 40;
        min-width: 240px;
        max-width: 320px;
        max-height: 50vh;
        overflow-y: auto;
        padding: 4px;
        border-radius: var(--dsw-radius-md, 12px);
        background: var(--dsw-alias-bg-layer-3, #2b2b2b);
        box-shadow: 0 8px 24px var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, 0.24));
        border: 0.5px solid var(--dsw-alias-border-l4, rgba(255, 255, 255, 0.16));
      }

      .dsh-order-star-menu-empty {
        padding: 10px 12px;
        font-size: 12px;
        color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.45));
      }

      .dsh-order-star-menu-item {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        padding: 7px 10px;
        border: none;
        background: transparent;
        border-radius: var(--dsw-radius-sm, 8px);
        cursor: pointer;
        text-align: left;
        color: var(--dsw-alias-label-primary, rgba(255, 255, 255, 0.92));
        font-size: 13px;
      }

      .dsh-order-star-menu-item:hover { background: var(--dsw-alias-interactive-bg-hover); }
      .dsh-order-star-menu-item svg { width: 12px; height: 12px; flex: none; color: var(--dsh-order-amber); }

      .dsh-order-star-menu-title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .dsh-order-star-menu-where {
        flex: none;
        max-width: 40%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.45));
      }

      /* One workspace state badge: spinner, question, check, or alert. */
      .dsh-order-state {
        width: 14px;
        height: 14px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        align-self: center;
        margin-right: 6px;
      }

      .dsh-order-state svg {
        width: 14px;
        height: 14px;
        display: block;
      }

      .dsh-order-state[data-state="waiting"] svg {
        color: var(--dsh-order-amber);
      }

      .dsh-order-state[data-state="error"] svg {
        color: var(--dsh-order-red);
      }

      .dsh-order-state[data-state="done"] svg {
        color: var(--dsh-order-green);
      }

      /* Running: one arc sweeping around a faint track, matching the Host row spinner. */
      .dsh-order-state[data-state="running"] {
        color: var(--dsh-order-green);
      }

      .dsh-order-state .dsh-spin-track {
        fill: none;
        stroke: currentColor;
        stroke-width: 2.5;
        opacity: 0.22;
      }

      .dsh-order-state .dsh-spin-arc {
        fill: none;
        stroke: currentColor;
        stroke-width: 2.5;
        stroke-linecap: round;
        stroke-dasharray: 15 45;
        transform-origin: 12px 12px;
        animation: dsh-order-spin 1s linear infinite;
      }

      @keyframes dsh-order-spin {
        to { transform: rotate(360deg); }
      }

      @media (prefers-reduced-motion: reduce) {
        .dsh-order-state .dsh-spin-arc {
          animation-duration: 2.4s;
        }
      }

      /*
       * A finished session is marked with the page's own brand green, while the
       * workspace above it wears the deepened green the badges use, so the two
       * disagree about what "finished" looks like in one and the same column.
       * The dot is pointed at the workspace badge's colour instead: a session
       * still reads as a dot and a workspace still reads as a tick — which is
       * the distinction worth keeping — but one state is now one colour. In the
       * dark theme the two already agreed, since the badges keep the page's
       * token there; this is what makes the light theme agree as well.
       *
       * Only the done state is named. The page draws a running session as a
       * neutral spinner and an idle one as a neutral dot, so neither is green to
       * begin with. No shadowing flag either, deliberately: the unseen-failure
       * rule below carries one and has to keep beating this, or a session that
       * broke would quietly go back to looking finished.
       */
      div[data-row-key^="session:"] [data-state="done"] {
        color: var(--dsh-order-green);
      }

      /*
       * A session row whose turn failed: the page's own status store has no idea
       * a turn can fail, so it paints the stop as a plain completion — a green
       * dot on a conversation that actually broke. The dot is recoloured here so
       * the session tells the same story as the workspace above it. The colour is
       * set rather than the dot itself, because the page paints the dot core with
       * the current text colour. Only the failure states are touched, and only
       * while the failure is still unseen.
       */
      .dsh-order-session-errored [data-state="done"],
      .dsh-order-session-errored [data-state="idle"] {
        color: var(--dsh-order-red) !important;
      }
    `;

    // Pin icon SVG
    const PIN_SVG = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="17" x2="12" y2="22"></line>
        <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.89A2 2 0 0 1 15 10.77V5a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v5.77a2 2 0 0 1-1.11 1.79l-1.78.89A2 2 0 0 0 5 15.24Z"></path>
      </svg>
    `;

    // Pinned icon SVG (filled)
    const PIN_FILLED_SVG = `
      <svg viewBox="0 0 24 24" fill="currentColor">
        <path d="M16 3H8C7.45 3 7 3.45 7 4V9.5L5.2 12.2C5.07 12.39 5 12.62 5 12.85V14C5 14.55 5.45 15 6 15H11V21C11 21.55 11.45 22 12 22C12.55 22 13 21.55 13 21V15H18C18.55 15 19 14.55 19 14V12.85C19 12.62 18.93 12.39 18.8 12.2L17 9.5V4C17 3.45 16.55 3 16 3Z"/>
      </svg>
    `;

    const SPINNER_SVG = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle class="dsh-spin-track" cx="12" cy="12" r="9.5"></circle>
        <circle class="dsh-spin-arc" cx="12" cy="12" r="9.5"></circle>
      </svg>
    `;

    const QUESTION_SVG = `
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M9.2 9.1a2.9 2.9 0 1 1 3.7 3.2c-.8.2-1.4 1-1.4 1.9v.5"></path>
        <circle cx="11.6" cy="18.4" r="1.4"></circle>
      </svg>
    `;

    const CHECK_SVG = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="4.5 12.5 9.5 17.5 19.5 6.5"></polyline>
      </svg>
    `;

    const ALERT_SVG = `
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <rect x="10.2" y="4.2" width="3.6" height="10.4" rx="1.8"></rect>
        <circle cx="12" cy="18.6" r="2"></circle>
      </svg>
    `;

    /** Feature switches; kept in step with the Host through the status poll. */
    const SETTINGS_DEFAULT = {
      autoFront: true,
      pinTop: true,
      badgeWaiting: true,
      badgeError: true,
      badgeRunningDone: true,
      /** Expanding one workspace collapses the sibling groups. */
      autoCollapse: true,
      /** Outlines the workspace holding the session on screen. */
      highlightCurrent: true
    };
    const SETTINGS_STORAGE_KEY = 'dsh-workspace-focus-enhancer:settings';
    const SETTINGS_PENDING_KEY = SETTINGS_STORAGE_KEY + ':pending';
    let choiceRevision = 0;

    /** Cache is only a preview; only explicit, unsaved actions may be retried. */
    function readPendingChoices(key, allowedKeys) {
      const pending = new Map();
      try {
        const stored = JSON.parse(window.localStorage.getItem(key) || '[]');
        if (Array.isArray(stored)) for (const entry of stored) {
          if (!Array.isArray(entry) || typeof entry[0] !== 'string' || typeof entry[1] !== 'boolean') continue;
          if (allowedKeys && !allowedKeys.includes(entry[0])) continue;
          pending.set(entry[0], { value: entry[1], revision: ++choiceRevision });
        }
      } catch {}
      return pending;
    }

    function cachePendingChoices(key, pending) {
      try {
        window.localStorage.setItem(key, JSON.stringify(Array.from(pending, ([id, entry]) => [id, entry.value])));
      } catch {}
    }

    const pendingSettings = readPendingChoices(SETTINGS_PENDING_KEY, Object.keys(SETTINGS_DEFAULT));
    let settingsEpoch = 0;
    let settingsSync = null;
    let lastSettingsAttempt = -Infinity;
    let hostProtocol = 0;

    function overlaySettings(base) {
      const next = normalizeSettings(base);
      for (const [key, entry] of pendingSettings) next[key] = entry.value;
      return next;
    }

    /** Read the locally cached switches; absent or broken means defaults. */
    function readStoredSettings() {
      try {
        const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
        return raw ? normalizeSettings(JSON.parse(raw)) : { ...SETTINGS_DEFAULT };
      } catch {
        return { ...SETTINGS_DEFAULT };
      }
    }

    let settings = overlaySettings(readStoredSettings());

    /** Whether the Host has confirmed the current switches (false before its restart). */
    let hostAccepted = false;
    let hostError = '';
    // The panel store carries both facts: the switches and where they persisted,
    // so a change to either repaints the card.
    const settingsStore = uiAvailable ? createStore({ settings, hostAccepted, hostError }) : null;

    /** All switches, so the summary and persistence cover every one. */
    const SETTING_ROWS = [
      { key: 'pinTop', labelKey: 'row.pinTop', hintKey: 'hint.pinTop' },
      { key: 'autoFront', labelKey: 'row.autoFront', hintKey: 'hint.autoFront' },
      { key: 'autoCollapse', labelKey: 'row.autoCollapse', hintKey: 'hint.autoCollapse' },
      { key: 'highlightCurrent', labelKey: 'row.highlightCurrent', hintKey: 'hint.highlightCurrent' },
      { key: 'badgeWaiting', labelKey: 'row.badgeWaiting', hintKey: 'hint.badgeWaiting' },
      { key: 'badgeError', labelKey: 'row.badgeError', hintKey: 'hint.badgeError' },
      { key: 'badgeRunningDone', labelKey: 'row.badgeRunningDone', hintKey: 'hint.badgeRunningDone' }
    ];

    /** Sidebar-behaviour switches: flat on the card. */
    const ORDERING_ROWS = SETTING_ROWS.filter(r => !r.key.startsWith('badge'));

    /** Session-awareness switches, gathered into one collapsible group. */
    const AWARENESS_ROWS = SETTING_ROWS.filter(r => r.key.startsWith('badge'));

    const PANEL_CSS = `
      .dsh-order-panel { display: flex; flex-direction: column; gap: 2px; }
      .dsh-order-panel-row {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
        padding: 10px 0;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
      }
      .dsh-order-panel-row:first-child { border-top: none; }
      .dsh-order-panel-texts { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
      .dsh-order-panel-label { font-size: 13px; color: var(--dsw-alias-label-primary, rgba(255, 255, 255, 0.92)); }
      .dsh-order-panel-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.45)); }
      .dsh-order-panel-switch { margin-top: 2px; flex-shrink: 0; }
      .dsh-order-panel-group { margin-top: 4px; }
      .dsh-order-panel-group-body { padding-left: 20px; }
      .dsh-order-panel-group-tag { margin-left: 8px; flex-shrink: 0; }
      /*
       * An expanded workspace reads as a recessed tray: its header row and the
       * sessions it reveals share one sunken surface, so the open group stands
       * apart from the collapsed ones at a glance. The fill is translucent, so
       * it darkens on dark themes and grays on light ones without a second rule.
       */
      .dsh-order-open-group {
        background: var(--dsw-alias-bg-mask-2, rgba(0, 0, 0, 0.12));
        box-shadow: inset 0 1px 2px var(--dsw-alias-bg-mask-2, rgba(0, 0, 0, 0.12));
        border-radius: var(--dsw-radius-lg, 16px);
      }

      /*
       * The box wraps one whole group: its workspace row plus the sessions it
       * has expanded. Outline, not border, so nothing inside shifts.
       */
      .dsh-order-current-group {
        outline: 1.5px solid var(--dsw-alias-state-business-primary, #5285ff);
        outline-offset: -1.5px;
        border-radius: var(--dsw-radius-lg, 16px);
      }

      .dsh-order-panel-note { font-size: 12px; color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.45)); padding-top: 8px; }
      .dsh-order-panel-error { font-size: 12px; color: var(--dsh-order-red); padding-top: 8px; }

      /* One workspace toggle owns its final layout and scrolling together.
       * Native row glides use Web Animations, so animation:none is insufficient. */
      .dsh-order-workspace-switch { overflow-anchor: none !important; }
      .dsh-order-workspace-switch [data-row-key] {
        transform: none !important;
        opacity: 1 !important;
      }
      .dsh-order-workspace-switch + [aria-hidden="true"][class*="_exits"] { visibility: hidden; }
    `;

    const STAR_SVG = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.8-5.2 2.8 1-5.8L3.6 9.7l5.8-.8z"></path>
      </svg>
    `;

    const STAR_FILLED_SVG = `
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 3.1l2.75 5.6 6.15.85-4.45 4.35 1.05 6.15L12 17.1l-5.5 2.95 1.05-6.15L3.1 9.55l6.15-.85z"></path>
      </svg>
    `;

    /** Badge metadata per state, in display priority order. */
    const STATES = {
      waiting: { svg: QUESTION_SVG, title: '等你回答或确认…' },
      error: { svg: ALERT_SVG, title: '有会话异常中断，点击查看' },
      running: { svg: SPINNER_SVG, title: '正在工作中…' },
      done: { svg: CHECK_SVG, title: '已完成，有新的回复未看' }
    };

    let pinnedSet = new Set();
    /** workspaceId -> true while one of its sessions works, from the Host poll. */
    let fallbackBusy = new Set();
    /** workspaceId -> true when one of its sessions last failed and is unseen. */
    let erroredSet = new Set();
    /**
     * The same fact per session, so a session row can be corrected too. The page's
     * own status store has no failure state at all — a turn that dies simply stops
     * running, which it reports as "finished" — so this is the only way a row can
     * be told apart from a run that ended well.
     */
    let erroredSessionSet = new Set();
    /** workspaceId -> true when one of its sessions waits for an answer. */
    let waitingSet = new Set();
    /** workspaceId -> true when one of its sessions finished with an unread reply. */
    let unreadSet = new Set();
    /** The same fact per session, so the reply being read can be excluded. */
    let unreadSessionSet = new Set();
    /**
     * Whether the Host actually enumerated open per-session marks in the last
     * status reply. `null` covers "not answered yet" and "answered before this
     * feature existed": in both cases the per-session list is not evidence of
     * absence, and the workspace-level list stays the only source of a green
     * check. Without this flag a Host that reports nothing would erase a check
     * the workspaces already carried.
     */
    let sessionMarksKnown = null;
    /**
     * The Host's own workspace tree, child -> parent. The page draws a collapsed
     * group's rows nowhere, so a hidden child's badge has to climb to an ancestor
     * that is still on screen; this is how the climb finds it even when the
     * page's own stores are out of reach.
     */
    let hostParents = Object.create(null);
    /** The Host's own session -> workspace map, for the same reason. */
    let workspaceOfSession = Object.create(null);
    /** Session ids whose failure this page witnessed, cleared once the user opens them. */
    const clientErrored = new Set();

    const FAVORITES_STORAGE_KEY = 'dsh-workspace-focus-enhancer:favorites';

    const FAVORITES_PENDING_KEY = FAVORITES_STORAGE_KEY + ':pending';
    const favoriteChanges = readPendingChoices(FAVORITES_PENDING_KEY);
    let favoritesEpoch = 0;
    let favoritesSync = null;
    let lastFavoritesAttempt = -Infinity;

    function overlayFavorites(base) {
      let next = [...new Set((Array.isArray(base) ? base : []).filter(id => typeof id === 'string'))];
      for (const [id, entry] of favoriteChanges) {
        const had = next.includes(id);
        if (!entry.value) next = next.filter(value => value !== id);
        else if (!had) next.unshift(id);
      }
      return next;
    }

    /** Read the locally cached stars; absent or broken means none. */
    function readStoredFavorites() {
      try {
        const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
      } catch {
        return [];
      }
    }

    /**
     * Starred session ids, newest first. The browser is the immediate source so a
     * star works the moment it is clicked; the Host copy follows once it can
     * accept writes.
     */
    let favoriteIds = overlayFavorites(readStoredFavorites());
    const favoriteSet = new Set(favoriteIds);
    let isFetching = false;
    let disposed = false;
    const pendingPins = new Set();
    let pinTask = Promise.resolve();
    let pinsEpoch = 0;

    /** Live Host status store, when this page exposes it. */
    let live = null;
    /** Root client context, kept so the live store can bind after the Host publishes it. */
    let rootCtx = null;
    let unsubscribeLive = null;
    /** True while a bind attempt is in flight, so a subscriber cannot re-enter it. */
    let liveBinding = false;
    /** One report is enough; a page that never binds must not flood the console. */
    let liveBindWarned = false;
    let workspaceView = null;

    /** The official view store knows whether directory nesting is actually on. */
    function usesWorkspaceTree() {
      try {
        const state = workspaceView ? workspaceView.getSnapshot()
          : JSON.parse(window.localStorage.getItem('dsh.workspace.view.v5') || '{}');
        return state.groupBy === 'workspace-tree';
      } catch {
        return false;
      }
    }

    function bindWorkspaceView(ctx) {
      if (!ctx || typeof ctx.inject !== 'function') return;
      ctx.inject(['slots'], (child) => {
        let offView = null;
        const bind = () => {
          if (disposed) return;
          const entry = child.slots.entries('sidebar.workspaces').find(item => item.store?.spec?.persist === 'dsh.workspace.view.v5');
          const source = entry?.store?.create();
          if (source === workspaceView) return;
          if (typeof offView === 'function') offView();
          workspaceView = source || null;
          resetExpansionMemory();
          let lastMode = workspaceView?.getSnapshot().groupBy;
          const changed = () => {
            if (disposed) return;
            const mode = workspaceView?.getSnapshot().groupBy;
            if (mode !== lastMode) { lastMode = mode; resetExpansionMemory(); }
            refresh();
          };
          offView = workspaceView?.subscribe(changed);
          changed();
        };
        bind();
        const offSlots = child.slots.subscribe('sidebar.workspaces', bind);
        child.effect(() => () => {
          if (typeof offView === 'function') offView();
          if (typeof offSlots === 'function') offSlots();
          workspaceView = null;
        });
      });
    }

    /**
     * Resolve the browser-side services that already know which session is
     * running, which waits for the user, and which finished unread. Safe to
     * call repeatedly until it binds: the Host may publish them after us.
     *
     * A partial bind is rolled back rather than kept: services can appear one at
     * a time, and a half-attached store would leave subscriptions behind on every
     * retry while still showing nothing.
     */
    function attachLiveStatus(ctx) {
      if (disposed || live || liveBinding) return;
      liveBinding = true;
      const unsubscribers = [];
      const release = () => {
        for (const off of unsubscribers.splice(0)) {
          try { if (typeof off === 'function') off(); } catch {}
        }
      };
      try {
        const reflect = ctx && (ctx.reflect || null);
        const read = (name) => {
          if (reflect && typeof reflect.get === 'function') {
            try { return reflect.get(name); } catch { return void 0; }
          }
          return void 0;
        };
        const uiSession = read('uiSession');
        const workspaces = read('workspaces');
        const sessions = read('sessions');
        // The page's own workspace service owns "open this session", including
        // expanding whatever group holds it.
        const uiWorkspace = read('uiWorkspace');
        const status = uiSession && uiSession.sessionStatus;
        if (!status || typeof status.getSnapshot !== 'function' || !workspaces || !sessions) return;
        const changed = () => refresh();
        if (typeof status.subscribe === 'function') unsubscribers.push(status.subscribe(changed));
        if (typeof workspaces.list?.subscribe === 'function') unsubscribers.push(workspaces.list.subscribe(changed));
        if (typeof sessions.list?.subscribe === 'function') unsubscribers.push(sessions.list.subscribe(changed));
        // The Host forwards a session's turn failure over the wire; mirror it here
        // so the red mark works even when the ordering service predates this feature.
        const remote = read('remote');
        if (remote && typeof remote.$on === 'function') {
          try {
            const offError = remote.$on('api-session/error', (sessionId) => {
              if (disposed) return;
              clientErrored.add(sessionId);
              refresh();
            });
            if (typeof offError === 'function') unsubscribers.push(offError);
          } catch {}
        }
        live = { status, workspaces, sessions, uiWorkspace };
        unsubscribeLive = release;
        refresh();
      } catch (err) {
        // Release before giving up, or each retry would add another set of
        // subscriptions on top of the ones already listening.
        release();
        unsubscribeLive = null;
        live = null;
        if (!liveBindWarned) {
          liveBindWarned = true;
          console.warn('[workspace-order] 页面状态服务暂时接不上，先用主机轮询显示状态:', err);
        }
      } finally {
        liveBinding = false;
      }
    }

    /** Interaction kinds the Host itself presents as "waiting for the user". */
    const VISIBLE_PENDING = new Set(['approval', 'plan-review', 'question']);

    /**
     * Aggregate one workspace's sessions into a single badge state.
     * @returns a state key of {@link STATES}, or undefined for idle.
     */
    /**
     * A badge only means something where the user can see it. A workspace whose
     * row is hidden — because an ancestor is collapsed — hands its signal up to
     * the nearest ancestor that is on screen, so nothing is ever lost. The most
     * urgent signal in a subtree wins, using the same order as {@link STATES}.
     * @param own - state per workspace, keyed by workspace id.
     * @param workspaceRows - the Host's workspace rows, which carry their paths.
     * @returns where each signal should actually be drawn.
     */
    function liftHiddenStates(own, workspaceRows) {
      const shown = new Map();
      for (const [workspaceId, state] of own) {
        const target = hasWorkspaceRow(workspaceId) ? workspaceId : visibleAncestorIdOf(workspaceId, workspaceRows);
        if (!target) continue;
        const existing = shown.get(target);
        if (!existing || stateRank(state) < stateRank(existing)) shown.set(target, state);
      }
      return shown;
    }

    /** Which ancestor row is on screen for a hidden workspace, if any. */
    function visibleAncestorIdOf(workspaceId, workspaceRows) {
      if (!usesWorkspaceTree()) return void 0;
      let id = nearestAncestorId(workspaceId, workspaceRows);
      for (let hops = 0; hops < 32 && id; hops += 1) {
        if (hasWorkspaceRow(id)) return workspaceRowElement(id)?.getAttribute('aria-expanded') === 'false' ? id : void 0;
        const parent = nearestAncestorId(id, workspaceRows);
        if (!parent || parent === id) return void 0;
        id = parent;
      }
      return void 0;
    }

    /** Display priority of a state: lower is more urgent, matching STATES order. */
    function stateRank(state) {
      const order = ['waiting', 'error', 'running', 'done'];
      const at = order.indexOf(state);
      return at < 0 ? order.length : at;
    }

    /**
     * The nearest ancestor row the page is actually drawing, walked along the
     * Host's own tree. Needed when the page's stores are out of reach: without
     * this a collapsed group's badge would be dropped instead of climbing.
     * @returns a rendered workspace id, or undefined when nothing matches.
     */
    function visibleAncestorFromHost(workspaceId) {
      if (!usesWorkspaceTree()) return void 0;
      let id = hostParents[workspaceId];
      // Only a collapsed actual ancestor may represent a hidden workspace.
      for (let hops = 0; hops < 32 && id; hops += 1) {
        if (hasWorkspaceRow(id)) return workspaceRowElement(id)?.getAttribute('aria-expanded') === 'false' ? id : void 0;
        const parent = hostParents[id];
        if (!parent || parent === id) return void 0;
        id = parent;
      }
      return void 0;
    }

    /**
     * Badge states from the Host's poll alone, for when the page's own status
     * store cannot be reached. Every source the Host reports is folded in — a
     * waiting session, a failure, work in progress, an unread reply — and the
     * result is lifted exactly like the live path, so a collapsed parent still
     * shows what is happening underneath it.
     * @param viewedId - the session on screen, whose own reply is not "unread".
     * @returns a map of workspace id -> state, already filtered by the switches.
     */
    function computeFallbackStates(viewedId) {
      const own = new Map();
      const consider = (workspaceId, state) => {
        if (!workspaceId) return;
        const existing = own.get(workspaceId);
        if (!existing || stateRank(state) < stateRank(existing)) own.set(workspaceId, state);
      };
      // The switches filter here, before the lift, so a disabled badge can never
      // mask a more urgent one that is still switched on.
      if (stateAllowed('waiting')) for (const id of waitingSet) consider(id, 'waiting');
      if (stateAllowed('error')) for (const id of erroredSet) consider(id, 'error');
      if (stateAllowed('running')) for (const id of fallbackBusy) consider(id, 'running');
      if (stateAllowed('done')) for (const workspaceId of unreadWorkspaces(viewedId)) consider(workspaceId, 'done');

      const shown = new Map();
      for (const [workspaceId, state] of own) {
        // The row the user can see is the one that gets the badge.
        const target = hasWorkspaceRow(workspaceId) ? workspaceId : visibleAncestorFromHost(workspaceId);
        if (!target) continue;
        const existing = shown.get(target);
        if (!existing || stateRank(state) < stateRank(existing)) shown.set(target, state);
      }
      return shown;
    }

    /**
     * Which workspaces hold a finished reply the user has not opened. Derived
     * from the sessions when the Host sent them, so the reply the user is reading
     * right now does not flash a "new reply" check at them for a polling cycle.
     * @param viewedId - the session on screen, if any.
     * @returns a set of workspace ids.
     */
    function unreadWorkspaces(viewedId) {
      // The per-session list is authoritative once the Host enumerates it: with
      // it, the reply on screen can be excluded exactly, and a check the Host
      // already retired in this cycle cannot come back from the workspace list.
      if (sessionMarksKnown && !unreadSessionSet.size) {
        if (Object.keys(workspaceOfSession).length) return new Set();
      }
      if (!unreadSessionSet.size || !Object.keys(workspaceOfSession).length) return unreadSet;
      const out = new Set();
      for (const sessionId of unreadSessionSet) {
        // The reply already in front of the user is not a new one.
        if (sessionId === viewedId) continue;
        const owner = workspaceOfSession[sessionId];
        if (owner) out.add(owner);
      }
      return out;
    }

    /**
     * Badge states to paint, from both sources at once. The page's live store is
     * push-driven but only covers sessions it has bound; the Host poll is slower
     * but covers everything it is told about. Taking the more urgent of the two
     * per row means a fact that only one source knows — a question in a session
     * this page never opened, say — still reaches the badge instead of being
     * masked by the other source's silence.
     * @returns a map of rendered workspace id -> state.
     */
    function effectiveStates(liveStates) {
      const merged = new Map();
      const absorb = (source) => {
        for (const [workspaceId, state] of source) {
          const existing = merged.get(workspaceId);
          if (!existing || stateRank(state) < stateRank(existing)) merged.set(workspaceId, state);
        }
      };
      if (liveStates) absorb(liveStates.states);
      absorb(computeFallbackStates((liveStates && liveStates.mainId) || currentSessionIdFromDom()));
      return merged;
    }

    function stateOfWorkspace(workspaceId, sessionIds, statuses) {
      let waiting = false;
      let errored = false;
      let running = false;
      let done = false;
      // Every session is examined before any answer is given. Returning on the
      // first hit would make the badge depend on the order sessions happen to be
      // listed in: one failed session early in the list would hide a question
      // waiting in a later one, though a question outranks a failure.
      for (const id of sessionIds) {
        const status = statuses.get(id);
        if (status?.running === true) clientErrored.delete(id);
        // A fresh run retires the previous run's local error marker.
        if (clientErrored.has(id)) errored = true;
        if (!status) continue;
        const pending = status.pendingInteraction;
        if (pending && VISIBLE_PENDING.has(pending.kind)) waiting = true;
        if (status.running === true) running = true;
        else if (status.completionUnread === true) done = true;
      }
      // Unseen failure outranks live activity: it is what the user must act on.
      if (erroredSet.has(workspaceId)) errored = true;

      // The documented order: a question the user must answer, then a failure,
      // then work in progress, then a reply waiting to be read.
      if (waiting && stateAllowed('waiting')) return 'waiting';
      if (errored && stateAllowed('error')) return 'error';
      if (running && stateAllowed('running')) return 'running';
      if (done && stateAllowed('done')) return 'done';
      return void 0;
    }

    /** Map every workspace to its badge state from the live Host stores. */
    function computeLiveStates() {
      if (!live) return null;
      const statuses = live.status.getSnapshot();
      if (!(statuses instanceof Map)) return null;
      const workspaceRows = live.workspaces.list.getSnapshot().items || [];
      const mainId = Object.values(live.sessions.list.getSnapshot().byId || {})
        .find((session) => (session.retainedBy && session.retainedBy.mainView || 0) > 0)?.id;
      const own = new Map();
      for (const ws of workspaceRows) {
        const state = stateOfWorkspace(ws.workspaceId, ws.sessionIds || [], statuses);
        if (state) own.set(ws.workspaceId, state);
      }
      return { own, states: liftHiddenStates(own, workspaceRows), mainId };
    }

    /**
     * Tell the Host which session the user has open. One report does two jobs:
     * it retires the red failure mark on the session just opened, and it keeps
     * the Host from counting that same session's freshly finished reply as
     * unread — the user is looking straight at it. Reporting only when a red mark
     * happened to exist would leave the Host guessing, and a reply the user
     * already read would turn into a green check the moment they moved on.
     * Closing the last session reports "none", so a reply that arrives while
     * nothing is open still gets its reminder.
     * @param mainId - the session on screen, or undefined when none is.
     * @param stillMarked - the Host still shows a mark for that session, so the
     * report is worth sending again: a turn can end in the moment between the
     * user opening a session and this report reaching the Host, which would
     * otherwise leave a "new reply" check on the very conversation being read.
     * Repeats are throttled, so a mark that never clears cannot turn into a
     * request every time the sidebar repaints.
     */
    function reportSeenSession(mainId, stillMarked) {
      const next = mainId || null;
      const repeated = next === lastSeenMainId;
      if (repeated) {
        if (!stillMarked) return;
        const now = Date.now();
        if (next !== null && now - lastSeenReportAt < 1500) return;
      }
      lastSeenMainId = next;
      lastSeenReportAt = Date.now();
      if (next) clientErrored.delete(next);
      fetch('/api/workspace-order/clear-error', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: next })
      }).catch(() => {});
    }
    let lastSeenMainId = undefined;
    /** When the last report went out, so repeats for one session stay rare. */
    let lastSeenReportAt = 0;

    /** Adopt the Host's starred list. An unchanged list repaints nothing. */
    function applyFavorites(list) {
      if (!Array.isArray(list)) return;
      if (sameIdList(favoriteIds, list)) return;
      setFavorites(list);
    }

    /** Replace the starred list and repaint, whether or not the value changed. */
    function setFavorites(list) {
      favoriteIds = (Array.isArray(list) ? list : []).filter(id => typeof id === 'string');
      favoriteSet.clear();
      for (const id of favoriteIds) favoriteSet.add(id);
      try {
        window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(favoriteIds));
      } catch {}
      if (starMenu) {
        closeStarMenu();
        const anchor = document.querySelector('.dsh-order-star-filter');
        if (anchor && !disposed) toggleStarMenu(anchor);
      }
      renderDshEnhancements();
    }

    function sameIdList(left, right) {
      return left.length === right.length && left.every((id, i) => id === right[i]);
    }

    /** A new set holding every member of both inputs; never mutates either. */
    function unionOfSets(left, right) {
      const merged = new Set(left);
      for (const value of right) merged.add(value);
      return merged;
    }

    /**
     * Sessions the Host says one workspace holds. The Host's own map is the
     * only enumeration available to this page for a workspace whose rows are
     * hidden behind a collapsed ancestor.
     * @returns the session ids, or an empty list when the Host named none.
     */
    function sessionsOfWorkspace(workspaceId) {
      const out = [];
      if (!workspaceId) return out;
      for (const [sessionId, owner] of Object.entries(workspaceOfSession)) {
        if (owner === workspaceId) out.push(sessionId);
      }
      return out;
    }

    /** Save desired membership, so retrying a lost response cannot undo a star. */
    async function toggleFavorite(sessionId) {
      if (disposed || !sessionId) return false;
      favoriteChanges.set(sessionId, { value: !favoriteSet.has(sessionId), revision: ++choiceRevision });
      favoritesEpoch += 1;
      cachePendingChoices(FAVORITES_PENDING_KEY, favoriteChanges);
      setFavorites(overlayFavorites(favoriteIds));
      return syncFavoritesToHost(true);
    }

    function syncFavoritesToHost(force = false) {
      if (disposed || hostProtocol < 2 || !favoriteChanges.size) return Promise.resolve(false);
      if (favoritesSync) return favoritesSync;
      if (!force && Date.now() - lastFavoritesAttempt < 15000) return Promise.resolve(false);
      lastFavoritesAttempt = Date.now();
      favoritesSync = (async () => {
        try {
          while (!disposed && favoriteChanges.size) {
            const [sessionId, entry] = favoriteChanges.entries().next().value;
            const res = await fetch('/api/workspace-order/toggle-favorite', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ sessionId, favorite: entry.value })
            });
            const data = await res.json().catch(() => ({}));
            if (disposed) return false;
            if (!res.ok || !data.success || !Array.isArray(data.favoriteIds)) throw new Error(data.error || '收藏保存失败');
            if (favoriteChanges.get(sessionId) === entry) favoriteChanges.delete(sessionId);
            favoritesEpoch += 1;
            cachePendingChoices(FAVORITES_PENDING_KEY, favoriteChanges);
            setFavorites(overlayFavorites(data.favoriteIds));
          }
          return !disposed;
        } catch (err) {
          if (!disposed) console.warn('[workspace-order] 收藏暂未保存，将重试本次操作:', err);
          return false;
        }
      })().finally(() => { favoritesSync = null; });
      return favoritesSync;
    }

    /**
     * The session the page is showing, read from the row it marks as selected.
     * Needed because the red and unread marks are retired by opening a session,
     * and the page's own store is exactly what may be out of reach.
     * @returns a session id, or undefined when no row is selected.
     */
    function currentSessionIdFromDom() {
      const selected = document.querySelector('div[data-row-key^="session:"][aria-selected="true"]');
      const key = selected && selected.getAttribute('data-row-key');
      return key ? key.slice('session:'.length) || void 0 : void 0;
    }

    /** Recompute badges, retire the red mark once its session is open, repaint. */
    function refresh() {
      if (disposed) return;
      if (!live && rootCtx) attachLiveStatus(rootCtx);
      const liveStates = computeLiveStates();
      // The live store knows the current session only once it has settled; the
      // page marks the selected row itself, which is never stale. Preferring the
      // store alone would report "nothing open" while the user is looking at a
      // session, and that session's next reply would then be called unread.
      const onScreen = (liveStates && liveStates.mainId) || currentSessionIdFromDom();
      // Whichever source answered, the session on screen must still be able to
      // retire its own mark — otherwise a badge for the open session never clears.
      // A mark that survives a report means the report lost a race with the turn
      // ending, so it is sent again rather than assumed to have landed.
      const stillMarked = onScreen !== undefined
        && (erroredSessionSet.has(onScreen) || unreadSessionSet.has(onScreen));
      reportSeenSession(onScreen, stillMarked);
      renderDshEnhancements();
    }
    async function updateStatus() {
      if (isFetching || disposed || pendingPins.size) return;
      isFetching = true;
      const polledSettingsEpoch = settingsEpoch;
      const polledFavoritesEpoch = favoritesEpoch;
      const polledPinsEpoch = pinsEpoch;
      try {
        const res = await fetch('/api/workspace-order/status');
        if (!res.ok) throw Object.assign(new Error('Status request failed'), { status: res.status });
        if (res.ok) {
          const data = await res.json();
          if (disposed || pendingPins.size || polledPinsEpoch !== pinsEpoch) return;
          setHostError('');
          pinnedSet = new Set(data.pinned || []);
          fallbackBusy = new Set(data.busy || []);
          erroredSet = new Set(data.errored || []);
          // The per-session failure list corrects the session rows, which the
          // page paints as plain completions when a turn breaks.
          erroredSessionSet = new Set(data.erroredSessions || []);
          // Waiting and unread are the two facts the live store would have given
          // us; the Host now reports them too, so a page that cannot reach that
          // store still shows the orange question instead of a green spinner.
          waitingSet = new Set(data.waiting || []);
          unreadSet = new Set(data.unread || []);
          // A green check is the one fact with no second source: the page's own
          // store only knows it for sessions it watched end, and the Host is the
          // only place that remembers "finished, not read yet" across a page
          // reload, a dropped socket, or a Host restart. So the session-level
          // list may only ever ADD a check, never take one away — a turn that
          // ended while the link was down is exactly the case this must show.
          const listedUnread = Array.isArray(data.unreadSessions)
            ? new Set(data.unreadSessions)
            : (Array.isArray(data.unread) ? new Set() : null);
          if (listedUnread === null) {
            sessionMarksKnown = null;
          } else {
            sessionMarksKnown = true;
            unreadSessionSet = unionOfSets(unreadSessionSet, listedUnread);
            // Union alone would remember a check the Host has since retired, so
            // the kept side is narrowed to replies that are still unread by the
            // Host's own account: listed per session, or listed on a workspace
            // whose exact session list is still the only thing the Host sent.
            const stillUnread = new Set(listedUnread);
            for (const workspaceId of unreadSet) {
              for (const sessionId of sessionsOfWorkspace(workspaceId)) stillUnread.add(sessionId);
            }
            for (const sessionId of unreadSessionSet) {
              if (!stillUnread.has(sessionId)) unreadSessionSet.delete(sessionId);
            }
          }
          hostParents = data.parents && typeof data.parents === 'object' ? data.parents : Object.create(null);
          workspaceOfSession = data.owners && typeof data.owners === 'object' ? data.owners : Object.create(null);
          hostProtocol = Number(data.protocolVersion) || 0;
          if (Array.isArray(data.favorites) && polledFavoritesEpoch === favoritesEpoch && !favoritesSync) {
            applyFavorites(overlayFavorites(data.favorites));
          }
          if (data.settings && polledSettingsEpoch === settingsEpoch && !settingsSync) {
            hostAccepted = hostProtocol >= 2 && pendingSettings.size === 0;
            applySettings(overlaySettings(data.settings));
          }
          if (favoriteChanges.size) void syncFavoritesToHost();
          if (pendingSettings.size) void syncLocalToHost();
          refresh();
        }
      } catch (e) {
        if (!disposed) setHostError(e.status === 401 || e.status === 403 ? 'noteHostAuth' : 'noteHostUnavailable');
      } finally {
        isFetching = false;
      }
    }

    function setHostError(messageKey) {
      if (hostError === messageKey) return;
      hostError = messageKey;
      if (settingsStore) settingsStore.set({ settings, hostAccepted, hostError });
    }

    function togglePin(workspaceId, btnElement) {
      if (disposed || hostProtocol < 2 || pendingPins.has(workspaceId)) return Promise.resolve(false);
      pendingPins.add(workspaceId);
      pinsEpoch += 1;
      btnElement.disabled = true;
      const task = pinTask.catch(() => {}).then(() => writePin(workspaceId, btnElement));
      pinTask = task;
      return task;
    }

    async function writePin(workspaceId, btnElement) {
      if (disposed) { pendingPins.delete(workspaceId); return false; }
      // Optimistic update
      const currentlyPinned = pinnedSet.has(workspaceId);
      if (currentlyPinned) {
        pinnedSet.delete(workspaceId);
      } else {
        pinnedSet.add(workspaceId);
      }
      renderDshEnhancements();

      try {
        const res = await fetch('/api/workspace-order/toggle-pin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, pinned: !currentlyPinned })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || '置顶失败，请重试');
        if (disposed) return;
        pinnedSet = new Set(data.pinnedIds || []);
        fallbackBusy = new Set(data.busyIds || []);
        erroredSet = new Set(data.erroredIds || []);
        if (Array.isArray(data.waitingIds)) waitingSet = new Set(data.waitingIds);
        if (Array.isArray(data.unreadIds)) unreadSet = new Set(data.unreadIds);
        if (Array.isArray(data.unreadSessionIds)) unreadSessionSet = new Set(data.unreadSessionIds);
        if (data.parents && typeof data.parents === 'object') hostParents = data.parents;
        if (data.owners && typeof data.owners === 'object') workspaceOfSession = data.owners;
        if (Array.isArray(data.erroredSessionIds)) erroredSessionSet = new Set(data.erroredSessionIds);
      } catch (err) {
        if (disposed) return;
        // Rollback on failure
        if (currentlyPinned) pinnedSet.add(workspaceId);
        else pinnedSet.delete(workspaceId);
        console.error('[workspace-order] 置顶失败:', err);
      } finally {
        pendingPins.delete(workspaceId);
        pinsEpoch += 1;
        if (!disposed) btnElement.disabled = false;
      }
      if (!disposed) refresh();
    }

    /**
     * Resolve the badge state for one row from the already-lifted map. Both the
     * live store and the Host poll produce the same shape, so a row cannot end up
     * with a different answer depending on which one happened to be reachable.
     */
    function resolveState(workspaceId, states) {
      const raw = states ? states.get(workspaceId) : void 0;
      return stateAllowed(raw) ? raw : void 0;
    }

    /** Whether the switch owning this badge state is on. */
    function stateAllowed(state) {
      if (!state) return false;
      if (state === 'waiting') return settings.badgeWaiting;
      if (state === 'error') return settings.badgeError;
      return settings.badgeRunningDone;
    }

    /**
     * Which workspace the box belongs on. The owner is the workspace holding the
     * session on screen, but a collapsed ancestor hides that workspace's row, so
     * the box steps up to the nearest ancestor the user can actually see. An
     * expanded ancestor is therefore never boxed while its child is on screen.
     * @returns a workspace id, or undefined for none.
     */
    function currentWorkspaceId(liveStates) {
      if (!settings.highlightCurrent) return void 0;
      if (liveStates && liveStates.mainId) {
        const rows = live.workspaces.list.getSnapshot().items || [];
        const owner = rows.find(ws => Array.isArray(ws.sessionIds) && ws.sessionIds.includes(liveStates.mainId));
        // A row the user cannot see cannot be boxed; step up, or let the page's
        // own marks decide when the store carries no paths to walk.
        if (owner) {
          const visible = visibleOwnerOf(owner.workspaceId, rows);
          if (visible) return visible;
        }
      }
      return currentWorkspaceFromDom();
    }

    /**
     * The owner itself while its row is on screen, otherwise the nearest rendered
     * ancestor — the only level a collapsed tree still shows.
     * @param workspaceId - the workspace holding the current session.
     * @param workspaceRows - the Host's workspace rows, which carry their paths.
     * @returns the id to box, or undefined when nothing is visible.
     */
    function visibleOwnerOf(workspaceId, workspaceRows) {
      if (hasWorkspaceRow(workspaceId)) return workspaceId;
      return visibleAncestorIdOf(workspaceId, workspaceRows);
    }

    function workspaceRowElement(workspaceId) {
      return document.querySelector(`div[data-row-key="workspace:${window.CSS.escape(workspaceId)}"]`);
    }

    /** Whether this workspace's own row is currently rendered. */
    function hasWorkspaceRow(workspaceId) {
      return !!workspaceRowElement(workspaceId);
    }

    /**
     * The nearest registered workspace whose directory contains this one, by the
     * same longest-prefix rule the page uses to nest workspaces.
     * @returns a workspace id, or undefined when this one has no parent.
     */
    function nearestAncestorId(workspaceId, workspaceRows) {
      const self = workspaceRows.find(ws => ws.workspaceId === workspaceId);
      if (!self || typeof self.path !== 'string') return void 0;
      const child = folderPathOf(self.path);
      let best;
      let bestLength = -1;
      for (const ws of workspaceRows) {
        if (ws.workspaceId === workspaceId || typeof ws.path !== 'string') continue;
        const root = folderPathOf(ws.path);
        if (root.length > bestLength && child !== root && child.startsWith(`${root}/`)) {
          best = ws.workspaceId;
          bestLength = root.length;
        }
      }
      return best;
    }

    /** Normalize separators without reading POSIX backslashes as separators. */
    function folderPathOf(path) {
      const windows = /^[A-Za-z]:[/\\]/.test(path) || path.startsWith('\\\\');
      const normalized = windows ? path.replaceAll('\\', '/') : path;
      return normalized.replace(/\/+$/, '');
    }

    /**
     * Fallback when the live stores are unreachable. The page marks the folder
     * icon of the workspace holding the current session (and of its ancestors),
     * and keeps that mark even while the group is collapsed — so it beats
     * looking for a selected session row, which a collapsed group does not
     * render at all.
     */
    function currentWorkspaceFromDom() {
      const marked = [];
      for (const row of document.querySelectorAll('div[data-row-key^="workspace:"]')) {
        if (!row.querySelector('span[class*="folderActive"]')) continue;
        const id = (row.getAttribute('data-row-key') || '').replace('workspace:', '');
        if (id) marked.push({ id, row, depth: rowDepth(row) });
      }
      if (marked.length) {
        // Deepest wins: ancestors are marked too, the actual owner is innermost.
        marked.sort((a, b) => b.depth - a.depth);
        return marked[0].id;
      }
      // Last resort: the selected session row inside an expanded group.
      const selected = document.querySelector('div[data-row-key^="session:"][aria-selected="true"]');
      const section = selected && selected.closest('div[class*="groupSection"]');
      const row = section && section.querySelector('div[data-row-key^="workspace:"]');
      if (row) {
        const id = (row.getAttribute('data-row-key') || '').replace('workspace:', '');
        if (id) return id;
      }
      return void 0;
    }

    /**
     * Mark every group whose sessions are showing, so an open workspace reads as
     * a recessed tray. Runs alongside the highlight: both live on the same
     * container and neither replaces the other.
     */
    function paintExpandedGroups() {
      const sections = document.querySelectorAll('div[class*="groupSection"]');
      for (const section of sections) {
        // The header row's own aria-expanded is authoritative. Counting session
        // rows instead would misread a parent that only holds nested groups.
        const row = section.querySelector('div[data-row-key^="workspace:"]');
        const expanded = !!row && row.getAttribute('aria-expanded') === 'true';
        if (expanded) section.classList.add('dsh-order-open-group');
        else section.classList.remove('dsh-order-open-group');
      }
    }

    /** Move the box onto the group of the current workspace, and nowhere else. */
    function paintCurrentHighlight(targetId) {
      for (const section of document.querySelectorAll('.dsh-order-current-group')) {
        if (groupOfWorkspaceId(section) !== targetId) section.classList.remove('dsh-order-current-group');
      }
      if (!targetId) return;
      const row = document.querySelector(`div[data-row-key="workspace:${targetId}"]`);
      const section = row && (row.closest('div[class*="groupSection"]') || row.parentElement);
      if (section) section.classList.add('dsh-order-current-group');
    }

    /**
     * The workspace a group container stands for: its own header row, which the
     * page renders first, ahead of any nested group.
     * @returns a workspace id, or undefined when the node is not a group.
     */
    function groupOfWorkspaceId(section) {
      const own = workspaceKeyOf(section) || (section.querySelector
        ? workspaceKeyOf(section.querySelector('div[data-row-key^="workspace:"]'))
        : void 0);
      return own;
    }

    /** The workspace id a row stands for, or undefined. */
    function workspaceKeyOf(node) {
      const key = node && node.getAttribute ? node.getAttribute('data-row-key') : null;
      if (!key || !key.startsWith('workspace:')) return void 0;
      return key.slice('workspace:'.length) || void 0;
    }

    /**
     * How many starred sessions a workspace should roll up onto its own row.
     * A session whose row is on screen carries its own star, so it is not
     * counted here; only the hidden ones climb to the workspace card.
     * @returns the number to show, or 0 for none.
     */
    function hiddenStarCount(workspaceId) {
      if (!favoriteIds.length) return 0;
      let count = 0;
      for (const sessionId of favoriteIds) {
        // A star on screen belongs to its own row, so the card must not repeat it.
        if (renderedSessionRow(sessionId)) continue;
        if (hiddenStarOwnerOf(sessionId) === workspaceId) count += 1;
      }
      return count;
    }

    /**
     * Where a hidden session's star should be drawn: its own workspace when that
     * card is on screen, otherwise the nearest ancestor card the user can see.
     * This is the same "signal must stay visible" rule the state badges follow,
     * so a collapsed parent never swallows a favourite.
     * @returns a workspace id, or undefined when no card can carry it.
     */
    function hiddenStarOwnerOf(sessionId) {
      const rows = live ? (live.workspaces.list.getSnapshot().items || []) : [];
      const owner = rows.find(ws => Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId));
      if (owner) return visibleOwnerOf(owner.workspaceId, rows);
      // The page's workspace list is out of reach, so the Host's own nesting is
      // the only way to find the card this hidden favourite belongs on. Without
      // this the count would silently drop to zero and the star would vanish.
      const self = workspaceOfSession[sessionId];
      if (!self) return void 0;
      if (hasWorkspaceRow(self)) return self;
      return visibleAncestorFromHost(self);
    }

    /** The rendered row of a session, or undefined while it is not on screen. */
    function renderedSessionRow(sessionId) {
      return document.querySelector(`div[data-row-key="session:${sessionId}"]`) || void 0;
    }

    /** Whether a session lives in this workspace, per the Host's own mapping. */
    function sessionBelongsTo(sessionId, workspaceId) {
      if (!live) return false;
      const rows = live.workspaces.list.getSnapshot().items || [];
      const owner = rows.find(ws => Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId));
      return !!owner && owner.workspaceId === workspaceId;
    }

    /**
     * Paint one session row's star: a button that stars or unstars it. Kept as
     * the row's first child so it leads both the name and the state badge.
     */
    function paintSessionStar(row, sessionId) {
      // The ungrouped bucket renders sessions with no owning workspace; they can
      // still be starred, so every session row gets the control.
      const starred = favoriteSet.has(sessionId);
      const existingOutside = row.querySelector(':scope > .dsh-order-star');
      let star = existingOutside;
      if (!star) {
        star = document.createElement('button');
        star.type = 'button';
        star.className = 'dsh-order-star';
        star.addEventListener('click', (event) => {
          event.stopPropagation();
          event.preventDefault();
          toggleFavorite(sessionId);
        });
      }
      const state = starred ? 'true' : 'false';
      if (star.getAttribute('data-starred') !== state) {
        star.setAttribute('data-starred', state);
        star.innerHTML = starred ? STAR_FILLED_SVG : STAR_SVG;
        const label = starred ? '取消收藏' : '收藏此会话';
        star.title = label;
        star.setAttribute('aria-label', label);
        star.setAttribute('aria-pressed', starred ? 'true' : 'false');
      }
      if (row.firstElementChild !== star) row.insertBefore(star, row.firstChild);
    }

    /**
     * Mark one session row as failed, so its dot stops claiming the turn finished
     * cleanly. The page decides a session's dot from what it knows — running, or a
     * completion waiting to be read — and it has no notion of failure, so a turn
     * that broke is painted exactly like one that succeeded. The mark is dropped
     * as soon as the failure has been seen, which is what opening the session does.
     *
     * A running session is left alone: work in progress outranks a stale failure,
     * and the row is about to be repainted anyway. Neither is the session on
     * screen marked — opening it is what "seeing" the failure means, and the row
     * says so itself.
     */
    function paintSessionFailure(row, sessionId) {
      const failed = erroredSessionSet.has(sessionId) || clientErrored.has(sessionId);
      // `data-state="ongoing"` is the page's spinner; a live turn is never a
      // failure, however the previous one ended.
      const spinning = row.querySelector('[data-state="ongoing"]') !== null;
      const onScreen = row.getAttribute('aria-selected') === 'true';
      const wanted = settings.badgeError && failed && !spinning && !onScreen;
      if (row.classList.contains('dsh-order-session-errored') !== wanted) {
        row.classList.toggle('dsh-order-session-errored', wanted);
      }
    }

    /**
     * Paint a workspace row's rolled-up star count, after its name and never in
     * place of the state badge, which keeps its own leading position.
     */
    function paintWorkspaceStar(row, count) {
      const titleContainer = row.querySelector('span[class*="projectText"]');
      if (!titleContainer) return;
      let mark = row.querySelector('.dsh-order-star-count');
      if (!count) {
        if (mark) mark.remove();
        return;
      }
      if (!mark) {
        mark = document.createElement('span');
        mark.className = 'dsh-order-star-count';
        mark.innerHTML = STAR_FILLED_SVG;
        const label = document.createElement('span');
        label.className = 'dsh-order-star-count-text';
        mark.appendChild(label);
      }
      const text = mark.querySelector('.dsh-order-star-count-text');
      const shown = String(count);
      if (text.textContent !== shown) text.textContent = shown;
      const title = `有 ${count} 个已收藏但已折叠的会话`;
      if (mark.title !== title) {
        mark.title = title;
        mark.setAttribute('aria-label', title);
        mark.setAttribute('role', 'img');
      }
      if (mark.previousElementSibling !== titleContainer) {
        row.insertBefore(mark, titleContainer.nextSibling);
      }
    }

    /**
     * The sidebar's own header row: the one holding the search, filter and new
     * buttons. Returned only while it is on screen.
     */
    function sectionHeader() {
      return document.querySelector('div[class*="_sectionHeader"]:has(> [class*="_headerActions"])') || void 0;
    }

    /**
     * Put the favourites button at the head of the sidebar's button row, before
     * search. Idempotent: repeated renders reuse the same element.
     */
    function paintStarFilterButton() {
      const header = sectionHeader();
      if (!header) return;
      header.classList.add('dsh-order-workspace-header');
      let button = header.querySelector('.dsh-order-star-filter');
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'dsh-order-star-filter';
        button.innerHTML = STAR_FILLED_SVG;
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          event.preventDefault();
          toggleStarMenu(button);
        });
      }
      const count = favoriteIds.length;
      const label = count ? `收藏的会话（${count}）` : '收藏的会话';
      if (button.title !== label) {
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-haspopup', 'true');
      }
      button.setAttribute('data-active', count ? 'true' : 'false');
      // Slot the favourites button just ahead of the search box (or the native
      // action cluster when search is absent, as in the collapsed rail). Native
      // React controls are never moved, and neither are other plugins' buttons:
      // each bundle owns its own nodes.
      const search = header.querySelector('div[class*="_searchSlot"]');
      const actions = header.querySelector('div[class*="_headerActions"]');
      const anchor = search || actions;
      if (!anchor || anchor.parentElement !== header) return;
      if (button.parentElement !== header || button.nextElementSibling !== anchor) {
        header.insertBefore(button, anchor);
      }
    }

    /** Whether the favourites menu is currently on screen. */
    let starMenu = null;

    function toggleStarMenu(anchor) {
      if (starMenu) {
        closeStarMenu();
        return;
      }
      const menu = document.createElement('div');
      menu.className = 'dsh-order-star-menu';
      menu.setAttribute('role', 'menu');
      if (!favoriteIds.length) {
        const empty = document.createElement('div');
        empty.className = 'dsh-order-star-menu-empty';
        empty.textContent = '还没有收藏的会话。把鼠标移到会话上，点左侧的星标即可收藏。';
        menu.appendChild(empty);
      } else {
        for (const sessionId of favoriteIds) {
          menu.appendChild(starMenuItem(sessionId));
        }
      }
      placeStarMenu(menu, anchor);
      document.body.appendChild(menu);
      starMenu = menu;
      // A click anywhere else, or Escape, closes it.
      setTimeout(() => {
        if (disposed || starMenu !== menu) return;
        document.addEventListener('click', onDocumentClickForStarMenu, true);
        document.addEventListener('keydown', onKeydownForStarMenu, true);
      }, 0);
    }

    function onDocumentClickForStarMenu(event) {
      if (starMenu && !starMenu.contains(event.target) && !event.target.closest('.dsh-order-star-filter')) closeStarMenu();
    }

    function onKeydownForStarMenu(event) {
      if (event.key === 'Escape') closeStarMenu();
    }

    function closeStarMenu() {
      if (starMenu) {
        starMenu.remove();
        starMenu = null;
      }
      document.removeEventListener('click', onDocumentClickForStarMenu, true);
      document.removeEventListener('keydown', onKeydownForStarMenu, true);
    }

    /** Anchor the menu under its button, kept inside the viewport. */
    function placeStarMenu(menu, anchor) {
      const box = anchor.getBoundingClientRect();
      menu.style.position = 'fixed';
      menu.style.top = `${Math.round(box.bottom + 4)}px`;
      menu.style.left = `${Math.round(Math.max(8, Math.min(box.left, window.innerWidth - 320)))}px`;
    }

    /** One row of the favourites menu: the session's name, and where it lives. */
    function starMenuItem(sessionId) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'dsh-order-star-menu-item';
      item.setAttribute('role', 'menuitem');
      item.innerHTML = STAR_FILLED_SVG;
      const title = document.createElement('span');
      title.className = 'dsh-order-star-menu-title';
      title.textContent = sessionTitleOf(sessionId) || sessionId;
      const where = document.createElement('span');
      where.className = 'dsh-order-star-menu-where';
      where.textContent = workspaceTitleOfSession(sessionId);
      item.appendChild(title);
      item.appendChild(where);
      item.title = `${title.textContent}${where.textContent ? ` · ${where.textContent}` : ''}`;
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
        closeStarMenu();
        openSessionById(sessionId);
      });
      return item;
    }

    /** A session's display title, read from the Host's own list. */
    function sessionTitleOf(sessionId) {
      if (!live) return void 0;
      const row = (live.sessions.list.getSnapshot().byId || {})[sessionId];
      return row && (row.title || row.name);
    }

    /** The workspace a session lives in, for orientation in the menu. */
    function workspaceTitleOfSession(sessionId) {
      if (!live) return '';
      const rows = live.workspaces.list.getSnapshot().items || [];
      const owner = rows.find(ws => Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId));
      return owner ? (owner.title || owner.path || '') : '';
    }

    /**
     * Open a starred session through the page's own workspace service, which
     * expands whatever group holds it — the same path the sidebar's search uses.
     */
    function openSessionById(sessionId) {
      const service = live && live.uiWorkspace;
      if (service && typeof service.openSession === 'function') {
        try {
          service.openSession(sessionId);
          return true;
        } catch (err) {
          console.warn('[workspace-order] 打开会话失败:', err);
        }
      }
      console.warn('[workspace-order] 打不开会话：官方入口当前不可用');
      return false;
    }

    function renderDshEnhancements() {
      if (disposed) return;
      const rows = document.querySelectorAll('div[data-row-key^="workspace:"]');
      const liveStates = computeLiveStates();
      const states = effectiveStates(liveStates);
      paintExpandedGroups();
      paintCurrentHighlight(currentWorkspaceId(liveStates));
      paintStarFilterButton();
      for (const row of rows) {
        const rowKey = row.getAttribute('data-row-key') || '';
        const workspaceId = rowKey.replace('workspace:', '');
        if (!workspaceId) continue;

        const isPinned = pinnedSet.has(workspaceId);
        const state = resolveState(workspaceId, states);

        // 1. Attach Pin Button to row actions
        const actionsContainer = row.querySelector('span[class*="rowActions"]');
        if (actionsContainer && settings.pinTop) {
          let pinBtn = row.querySelector('.dsh-order-pin-btn');
          if (!pinBtn) {
            pinBtn = document.createElement('button');
            pinBtn.type = 'button';
            pinBtn.className = 'dsh-order-pin-btn';
            pinBtn.title = isPinned ? '取消置顶' : '固定置顶';
            pinBtn.addEventListener('click', (e) => {
              e.stopPropagation();
              e.preventDefault();
              togglePin(workspaceId, pinBtn);
            });
          }
          // Keep the pin visible outside the native actions hidden on mouse-out.
          if (pinBtn.parentElement !== row) row.insertBefore(pinBtn, actionsContainer);

          // Update pin button state
          const pinnedState = isPinned ? 'true' : 'false';
          // Replacing the icon triggers the observer; only render state changes.
          if (pinBtn.getAttribute('data-pinned') !== pinnedState) {
            pinBtn.setAttribute('data-pinned', pinnedState);
            pinBtn.innerHTML = isPinned ? PIN_FILLED_SVG : PIN_SVG;
          }
          pinBtn.title = hostProtocol < 2 ? '主机修复尚未加载，请重启 Harness 后使用置顶' : isPinned ? '取消置顶' : '固定置顶';
          pinBtn.disabled = hostProtocol < 2 || pendingPins.has(workspaceId);
          pinBtn.setAttribute('aria-label', pinBtn.title);
        } else {
          // Switched off: drop the button, keeping the pin list untouched.
          const stale = row.querySelector('.dsh-order-pin-btn');
          if (stale) stale.remove();
        }

        // 2. Place the state badge before the title, outside its text container.
        const titleContainer = row.querySelector('span[class*="projectText"]');
        if (titleContainer) {
          let badge = row.querySelector('.dsh-order-state');
          if (state) {
            const meta = STATES[state];
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'dsh-order-state';
            }
            if (badge.getAttribute('data-state') !== state) {
              badge.setAttribute('data-state', state);
              badge.innerHTML = meta.svg;
              badge.title = meta.title;
              badge.setAttribute('role', 'img');
              badge.setAttribute('aria-label', meta.title);
            }
            // Only move the badge when needed so the observer stays idle.
            if (badge.parentElement !== row || badge.nextElementSibling !== titleContainer) {
              row.insertBefore(badge, titleContainer);
            }
          } else {
            if (badge) {
              badge.remove();
            }
          }

          // 3. Roll this workspace's hidden favourites onto its own card.
          paintWorkspaceStar(row, hiddenStarCount(workspaceId));
        }
      }

      // 4. Keep an open favourites menu in step with the list.
      if (starMenu) {
        const anchor = document.querySelector('.dsh-order-star-filter');
        if (!anchor) closeStarMenu();
        else placeStarMenu(starMenu, anchor);
      }

      // 5. Every session on screen carries its own star, and a failed session
      //    wears the failure instead of the plain "finished" the page paints.
      for (const sessionRow of document.querySelectorAll('div[data-row-key^="session:"]')) {
        const key = sessionRow.getAttribute('data-row-key') || '';
        const sessionId = key.slice('session:'.length);
        if (!sessionId) continue;
        paintSessionStar(sessionRow, sessionId);
        paintSessionFailure(sessionRow, sessionId);
      }
    }

    /** Queue only the switch the user changed; unrelated Host choices survive. */
    async function saveSetting(key, value) {
      if (disposed || !Object.hasOwn(SETTINGS_DEFAULT, key) || typeof value !== 'boolean') return false;
      pendingSettings.set(key, { value, revision: ++choiceRevision });
      settingsEpoch += 1;
      cachePendingChoices(SETTINGS_PENDING_KEY, pendingSettings);
      hostAccepted = false;
      applySettingsForce(overlaySettings(settings));
      return syncLocalToHost(true);
    }

    function syncLocalToHost(force = false) {
      if (disposed || hostProtocol < 2 || !pendingSettings.size) return Promise.resolve(false);
      if (settingsSync) return settingsSync;
      if (!force && Date.now() - lastSettingsAttempt < 15000) return Promise.resolve(false);
      lastSettingsAttempt = Date.now();
      settingsSync = (async () => {
        try {
          while (!disposed && pendingSettings.size) {
            const batch = new Map(pendingSettings);
            const patch = Object.fromEntries(Array.from(batch, ([key, entry]) => [key, entry.value]));
            const res = await fetch('/api/workspace-order/settings', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ settings: patch })
            });
            const data = await res.json().catch(() => ({}));
            if (disposed) return false;
            if (!res.ok || !data.success || !data.settings) throw new Error(data.error || '保存失败');
            for (const [key, entry] of batch) if (pendingSettings.get(key) === entry) pendingSettings.delete(key);
            settingsEpoch += 1;
            cachePendingChoices(SETTINGS_PENDING_KEY, pendingSettings);
            hostAccepted = pendingSettings.size === 0;
            applySettingsForce(overlaySettings(data.settings));
          }
          return !disposed;
        } catch (err) {
          if (!disposed) {
            hostAccepted = false;
            applySettingsForce(settings);
            console.warn('[workspace-order] 设置暂未保存，将重试本次操作:', err);
          }
          return false;
        }
      })().finally(() => { settingsSync = null; });
      return settingsSync;
    }

    /** Called after any switch change: reseat expansion memory when re-enabled. */
    function afterSettingsChange(previousAutoCollapse) {
      if (settings.autoCollapse === previousAutoCollapse) return;
      resetExpansionMemory();
    }

    /** Adopt a settings object, cache it locally, and repaint what reads it. */
    function applySettings(next) {
      const previousAutoCollapse = settings.autoCollapse;
      const normalized = normalizeSettings(next);
      const sameValues = sameSettings(settings, normalized);
      settings = normalized;
      afterSettingsChange(previousAutoCollapse);
      // The status poll answers every couple of seconds; nothing changed means
      // no repaint and no storage write. The persistence flag counts as a change
      // because the panel's note reads it.
      if (sameValues && settingsStore && settingsStore.getSnapshot().hostAccepted === hostAccepted) return;
      if (sameValues && !settingsStore) return;
      try {
        window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      } catch {}
      if (settingsStore) settingsStore.set({ settings, hostAccepted, hostError });
      renderDshEnhancements();
    }

    /** Like applySettings, but repaints even when every value already matches. */
    function applySettingsForce(next) {
      const previousAutoCollapse = settings.autoCollapse;
      settings = normalizeSettings(next);
      afterSettingsChange(previousAutoCollapse);
      try {
        window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
      } catch {}
      if (settingsStore) settingsStore.set({ settings, hostAccepted, hostError });
      renderDshEnhancements();
    }

    function sameSettings(left, right) {
      for (const key of Object.keys(SETTINGS_DEFAULT)) if (left[key] !== right[key]) return false;
      return true;
    }

    function normalizeSettings(raw) {
      const next = { ...SETTINGS_DEFAULT };
      if (raw && typeof raw === 'object') {
        for (const key of Object.keys(SETTINGS_DEFAULT)) {
          if (typeof raw[key] === 'boolean') next[key] = raw[key];
        }
      }
      return next;
    }

    /**
     * One switch row: its name, its one-line explanation, and its toggle.
     */
    function SettingRow({ row, value, label, t, toggleSetting }) {
      return jsxRuntime.jsxs('div', { className: 'dsh-order-panel-row', children: [
        jsxRuntime.jsxs('div', { className: 'dsh-order-panel-texts', children: [
          jsxRuntime.jsx('span', { className: 'dsh-order-panel-label', children: label }),
          jsxRuntime.jsx('span', { className: 'dsh-order-panel-hint', children: t(row.hintKey) })
        ] }),
        jsxRuntime.jsx(primitives.Switch, {
          className: 'dsh-order-panel-switch',
          checked: value === true,
          label,
          onChange: (next) => { toggleSetting(row.key, next); }
        })
      ] }, row.key);
    }

    /**
     * The card the Plugins detail page renders for this bundle. Ordering
     * switches stay flat; the three session-awareness badges live in one
     * collapsible group whose header reports how many of them are on.
     */
    function WorkspaceOrderPanel({ view, t, useWorkspaceOrderSettings, toggleSetting }) {
      // Hooks run before any early return: this component serves both views.
      const [open, setOpen] = react.useState(false);
      const collapsible = !!(primitives.DisclosureRow && primitives.IconChecklistOutlineRegular);
      const snapshot = useWorkspaceOrderSettings((value) => value);
      const current = snapshot.settings || {};
      if (view === 'summary') return t('summary', { n: countEnabled(current), total: SETTING_ROWS.length });
      const onCount = AWARENESS_ROWS.filter(row => current[row.key] === true).length;
      const groupState = onCount === AWARENESS_ROWS.length
        ? t('group.allOn')
        : onCount === 0
          ? t('group.allOff')
          : t('group.partOn', { n: onCount, total: AWARENESS_ROWS.length });
      const flatRows = [...ORDERING_ROWS, ...(collapsible ? [] : AWARENESS_ROWS)];
      return jsxRuntime.jsxs('div', { className: 'dsh-order-panel', children: [
        ...flatRows.map((row) => jsxRuntime.jsx(SettingRow, {
          row,
          value: current[row.key],
          label: t(row.labelKey),
          t,
          toggleSetting
        }, row.key)),
        collapsible ? jsxRuntime.jsx(primitives.DisclosureRow, {
          className: 'dsh-order-panel-group',
          icon: jsxRuntime.jsx(primitives.IconChecklistOutlineRegular, { size: 14 }),
          title: t('group.title'),
          open,
          expandable: true,
          expandOnRowClick: true,
          keepContentWhenOpen: true,
          onToggle: () => { setOpen(value => !value); },
          collapsedContent: primitives.Tag
            ? jsxRuntime.jsx(primitives.Tag, {
                className: 'dsh-order-panel-group-tag',
                tone: onCount === AWARENESS_ROWS.length ? 'success' : onCount === 0 ? 'quiet' : 'warning',
                children: groupState
              })
            : groupState,
          children: jsxRuntime.jsx('div', { className: 'dsh-order-panel-group-body', children:
            AWARENESS_ROWS.map((row) => jsxRuntime.jsx(SettingRow, {
              row,
              value: current[row.key],
              label: t(row.labelKey),
              t,
              toggleSetting
            }, row.key))
          })
        }) : null,
        jsxRuntime.jsx('p', {
          className: snapshot.hostAccepted && !snapshot.hostError ? 'dsh-order-panel-note' : 'dsh-order-panel-error',
          role: snapshot.hostAccepted && !snapshot.hostError ? void 0 : 'status',
          children: t(snapshot.hostError || (snapshot.hostAccepted ? 'note' : 'notePendingHost'))
        })
      ] });
    }

    function countEnabled(value) {
      return SETTING_ROWS.reduce((n, row) => n + (value[row.key] ? 1 : 0), 0);
    }

    /**
     * Panel copy, registered into the page's locale service.
     * Keys stay flat: the page's dictionary lookup reads one property, so a
     * nested object would never resolve.
     */
    const PANEL_LOCALE = {
      zh: {
        title: '会话专注增强',
        summary: '置顶与状态徽标 · 已开 {n}/{total} 项',
        'group.title': '工作区内会话状态感知',
        'group.allOn': '全部开启',
        'group.allOff': '已关闭',
        'group.partOn': '部分开启 {n}/{total}',
        'row.pinTop': '工作区置顶',
        'row.autoFront': '工作区自动排序',
        'row.autoCollapse': '无关工作区自动折叠',
        'row.badgeWaiting': '橙色问号',
        'row.badgeError': '红色感叹号',
        'row.badgeRunningDone': '旋转圈与绿色对勾',
        'hint.pinTop': '悬停显示图钉，钉住的工作区永远排最前；关闭后已钉名单仍保留。',
        'hint.autoFront': '有会话开始干活时，该工作区自动移到列表前面。',
        'hint.autoCollapse': '点开一个工作区时，其他展开着的工作区自动收起；它的上级和子级不受影响。',
        'row.highlightCurrent': '高亮当前工作区',
        'hint.highlightCurrent': '把正在看的那个会话所属的工作区，连同它展开的会话一起框一圈边框，一眼定位。',
        'hint.badgeWaiting': '里面有会话等你回答、等批准或等计划确认时显示。',
        'hint.badgeError': '里面有会话异常中断时显示，会话行自己的圆点也一起变红；点开该会话后都消失。',
        'hint.badgeRunningDone': '干活时显示旋转圈，跑完且你还没看时显示绿色对勾；在你眼前跑完的不算没看。',
        note: '开关即时生效，无需刷新页面。',
        notePendingHost: '设置尚未与主机确认，恢复连接后会自动重试。',
        noteHostAuth: '主机拒绝了状态请求，请检查 DSH 登录或访问地址；恢复后会自动重试。',
        noteHostUnavailable: '暂时无法读取主机状态，正在自动重试。'
      },
      en: {
        title: 'Session Focus Enhancer',
        summary: 'Pinning and status badges · {n}/{total} features on',
        'group.title': 'Session awareness inside workspaces',
        'group.allOn': 'All on',
        'group.allOff': 'All off',
        'group.partOn': 'Partly on {n}/{total}',
        'row.pinTop': 'Pin workspace to top',
        'row.autoFront': 'Auto-sort workspaces',
        'row.autoCollapse': 'Auto-collapse unrelated workspaces',
        'row.badgeWaiting': 'Orange question mark',
        'row.badgeError': 'Red exclamation mark',
        'row.badgeRunningDone': 'Spinner and green check',
        'hint.pinTop': 'Pinned workspaces always lead the list; turning this off keeps your pin list.',
        'hint.autoFront': 'A workspace with a running session moves to the front automatically.',
        'hint.autoCollapse': 'Opening a workspace collapses the other expanded ones; its parent and children stay put.',
        'row.highlightCurrent': 'Highlight the current workspace',
        'hint.highlightCurrent': 'Outlines the workspace of the session you are looking at, together with its expanded sessions, so you can find it at a glance.',
        'hint.badgeWaiting': 'Shows while a session waits for your answer, approval, or plan review.',
        'hint.badgeError': 'Shows after a session fails, and turns that session row\'s own dot red; both clear when you open it.',
        'hint.badgeRunningDone': 'Spins while working, turns into a green check when finished unread; a turn you watched finish does not count as unread.',
        note: 'Changes apply immediately; no reload needed.',
        notePendingHost: 'Settings are not confirmed by the Host yet and will retry after reconnecting.',
        noteHostAuth: 'The Host rejected the status request. Check your DSH login and address; requests retry automatically.',
        noteHostUnavailable: 'Host status is temporarily unavailable. Retrying automatically.'
      }
    };

    /**
     * Register this bundle's card on the Plugins detail page. The slot is keyed
     * by package name, so the page shows the card only for this plugin.
     */
    function mountControlPanel(ctx) {
      if (!uiAvailable) return;
      if (!ctx || typeof ctx.inject !== 'function') return;
      // slots and locale come from the page's own plugins; wait for them lazily
      // rather than declaring them, so this plugin still loads without the panel.
      ctx.inject(['slots', 'locale'], registerPanel);
    }

    /** Register the card once the page's slot and locale services exist. */
    function registerPanel(ctx) {
      if (!ctx.slots || typeof ctx.slots.inject !== 'function') return;
      const NS = 'plugins.workspace-order';
      if (ctx.locale && typeof ctx.locale.register === 'function') {
        ctx.effect(() => ctx.locale.register(NS, PANEL_LOCALE), 'workspace-order: panel locale');
      }
      const face = () => ({
        hooks: { workspaceOrderSettings: settingsStore },
        toggleSetting: (key, value) => saveSetting(key, value)
      });
      ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
        name: 'plugins.bundle.config',
        key: 'dsh-workspace-focus-enhancer',
        locale: NS,
        label: () => (ctx.locale && ctx.locale.bind ? ctx.locale.bind(NS)('title') : PANEL_LOCALE.zh.title),
        inject: face
      }, WorkspaceOrderPanel)), 'workspace-order: control panel card');
    }

    /**
     * A header opening uses the native sidebar's shared store to commit the
     * complete expansion change at once. Session/search navigation keeps its
     * native reveal behavior; a DOM expansion alone is not a header click.
     */
    // The native list animates its rows with Web Animations. A toggle must own
    // state, motion and scrolling together; measuring a moving rectangle and
    // repairing it repeatedly makes scrolling chase the native row glide.
    const WORKSPACE_SWITCH_CLASS = 'dsh-order-workspace-switch';
    let expansionPosition = null;

    /** Find only the row's own scrolling ancestor, never the page or chat. */
    function workspaceScroller(row) {
      for (let parent = row.parentElement; parent && parent !== document.body && parent !== document.documentElement; parent = parent.parentElement) {
        if (/(auto|scroll|overlay)/.test(getComputedStyle(parent).overflowY) && parent.clientHeight > 0) return parent;
      }
      return null;
    }

    /** Finish only native finite row effects, leaving status-icon spins alone. */
    function finishWorkspaceMotion(scroller) {
      const elements = Array.from(scroller.querySelectorAll('[data-row-key]'));
      const exits = scroller.nextElementSibling;
      if (exits?.getAttribute('aria-hidden') === 'true' && String(exits.className).includes('_exits')) {
        elements.push(...exits.children);
      }
      for (const element of elements) {
        for (const animation of element.getAnimations?.() || []) {
          const effect = animation.effect;
          if (effect?.target !== element || !Number.isFinite(effect.getComputedTiming().endTime)) continue;
          const frames = effect.getKeyframes();
          if (!frames.some(frame => Object.hasOwn(frame, 'transform') || Object.hasOwn(frame, 'opacity'))) continue;
          try { animation.finish(); } catch { animation.cancel(); }
        }
      }
    }

    function cancelExpansionPosition() {
      const position = expansionPosition;
      expansionPosition = null;
      if (!position) return;
      clearTimeout(position.timeout);
      if (position.frame !== null) cancelAnimationFrame(position.frame);
      // Do not uncover a still-running translate/fade when input interrupts us.
      finishWorkspaceMotion(position.scroller);
      position.scroller.classList.remove(WORKSPACE_SWITCH_CLASS);
    }

    /** Every workspace row in this list, including the valid empty Ungrouped id. */
    function workspaceRows(scroller) {
      return Array.from(scroller.querySelectorAll('div[data-row-key^="workspace:"]'), row => ({
        id: row.getAttribute('data-row-key').slice('workspace:'.length),
        row,
        expanded: row.getAttribute('aria-expanded') === 'true'
      }));
    }

    /** Capture the native row's click intent, rather than inferring it from DOM changes. */
    function onWorkspaceToggle(event) {
      cancelExpansionPosition();
      if (!settings.autoCollapse || event.defaultPrevented || event.button !== 0) return;
      const element = event.target instanceof Element ? event.target : event.target?.parentElement;
      const row = element?.closest('div[data-row-key^="workspace:"]');
      if (!row || row.closest('[inert]')) return;
      const action = element.closest('button, a, input, textarea, select, [role="button"], [contenteditable="true"], [class*="_rowActions"]');
      if (action && row.contains(action)) return;
      const scroller = workspaceScroller(row);
      const state = workspaceView?.getSnapshot?.();
      // This is the shared store published by the native sidebar. If a future
      // host changes that contract, leave its own click handler in charge.
      if (!scroller || !state?.groupExpansion || typeof workspaceView?.store?.update !== 'function') return;
      // A second click can arrive before React has rendered the first one.
      // Explicit store values already contain that first command; DOM flags do
      // not. Tree defaults without an explicit key still come from the view.
      const rows = workspaceRows(scroller).map(entry => ({
        ...entry,
        expanded: typeof state.groupExpansion[entry.id] === 'boolean' ? state.groupExpansion[entry.id] : entry.expanded
      }));
      const index = rows.findIndex(entry => entry.row === row);
      if (index < 0) return;
      const opening = !rows[index].expanded;
      const keep = new Set([rows[index].id, ...ancestorIds(rows, index)]);
      const depth = rowDepth(row);
      for (let i = index + 1; i < rows.length && rowDepth(rows[i].row) > depth; i += 1) keep.add(rows[i].id);
      const closing = opening ? rows.filter((entry, i) => entry.expanded && !keep.has(entry.id)
        && !ancestorIds(rows, i).some(id => rows.some(parent => parent.id === id && parent.expanded && !keep.has(id)))) : [];
      const rect = row.getBoundingClientRect();
      const viewportTop = scroller.getBoundingClientRect().top + scroller.clientTop;
      if (rect.bottom <= viewportTop || rect.top >= viewportTop + scroller.clientHeight) return;
      const position = {
        id: rows[index].id,
        expanded: opening,
        scroller,
        offset: Math.max(0, Math.min(rect.top - viewportTop, scroller.clientHeight - rect.height)),
        closing: closing.map(entry => entry.id),
        frame: null,
        timeout: null
      };
      // Mask native motion and anchoring BEFORE changing state, then resolve
      // final geometry after React's layout commit, before the browser paints.
      expansionPosition = position;
      scroller.classList.add(WORKSPACE_SWITCH_CLASS);
      finishWorkspaceMotion(scroller);
      position.timeout = setTimeout(() => {
        if (expansionPosition === position) cancelExpansionPosition();
      }, 1500);
      // A rendered open row can use native close, including its local limit
      // reset. If a rapid second click precedes that render, native onToggle
      // still sees the old false flag and would reopen it: commit false here.
      if (!opening && row.getAttribute('aria-expanded') === 'true') return;
      try {
        workspaceView.store.update(draft => {
          for (const entry of closing) draft.groupExpansion[entry.id] = false;
          if (opening) for (const id of ancestorIds(rows, index)) draft.groupExpansion[id] = true;
          draft.groupExpansion[position.id] = opening;
        });
      } catch (error) {
        cancelExpansionPosition();
        console.warn('[workspace-order] 工作区切换交回页面处理:', error);
        return;
      }
      // The complete toggle has already been committed in ONE store write.
      // Letting the native row handler toggle again would undo that command.
      event.preventDefault();
      event.stopPropagation();
      restoreExpansionPosition();
    }

    function onExpansionInput() {
      cancelExpansionPosition();
    }

    /** One correction against the committed layout, then one prepaint check. */
    function restoreExpansionPosition(fromFrame = false) {
      const position = expansionPosition;
      if (!position) return;
      const { scroller } = position;
      if (disposed || !settings.autoCollapse || !scroller.isConnected || scroller.clientHeight <= 0) {
        cancelExpansionPosition();
        return;
      }
      const rows = workspaceRows(scroller);
      const entry = rows.find(item => item.id === position.id);
      if (!entry) {
        cancelExpansionPosition();
        return;
      }
      // A queued render is not a committed toggle. Never correct the old DOM.
      if (entry.expanded !== position.expanded || position.closing.some(id => rows.some(item => item.id === id && item.expanded))) return;
      finishWorkspaceMotion(scroller);
      const viewportTop = scroller.getBoundingClientRect().top + scroller.clientTop;
      const rect = entry.row.getBoundingClientRect();
      const offset = Math.max(0, Math.min(position.offset, scroller.clientHeight - rect.height));
      const next = Math.max(0, Math.min(scroller.scrollTop + rect.top - viewportTop - offset, scroller.scrollHeight - scroller.clientHeight));
      if (Math.abs(next - scroller.scrollTop) > 0.5) scroller.scrollTo({ top: next, behavior: 'instant' });
      if (fromFrame) {
        cancelExpansionPosition();
      } else if (position.frame === null) {
        position.frame = requestAnimationFrame(() => {
          if (expansionPosition !== position) return;
          position.frame = null;
          restoreExpansionPosition(true);
        });
      }
    }

    /** Nesting level of a row, read from the indent the page gives it. */
    function rowDepth(row) {
      try {
        const raw = getComputedStyle(row).getPropertyValue('--dsh-workspace-indent');
        const px = parseFloat(raw);
        return Number.isFinite(px) ? Math.round(px / 12) : 0;
      } catch {
        return 0;
      }
    }

    /** Ids of the rows that contain this one, outermost first. */
    function ancestorIds(rows, index) {
      const target = rows[index];
      const depth = rowDepth(target.row);
      if (depth <= 0) return [];
      const found = [];
      let wanted = depth - 1;
      for (let i = index - 1; i >= 0 && wanted >= 0; i -= 1) {
        const d = rowDepth(rows[i].row);
        if (d === wanted) {
          found.push(rows[i].id);
          wanted -= 1;
        }
      }
      return found;
    }

    /** A view or setting change invalidates any unfinished toggle geometry. */
    function resetExpansionMemory() {
      cancelExpansionPosition();
    }

    function apply(ctx) {
      rootCtx = ctx;
      document.querySelectorAll('.dsh-order-workspace-header').forEach(el => el.classList.remove('dsh-order-workspace-header'));
      // Older plugin versions did not remove their buttons when reloaded.
      document.querySelectorAll('.dsh-order-pin-btn, .dsh-order-state, .dsh-order-busy-badge, .dsh-order-star, .dsh-order-star-count, .dsh-order-star-filter').forEach(el => el.remove());
      document.querySelectorAll('.dsh-order-star-menu').forEach(el => el.remove());
      // These marks live on the page's own containers: unmark, never remove.
      document.querySelectorAll('.dsh-order-current-group').forEach(el => el.classList.remove('dsh-order-current-group'));
      document.querySelectorAll('.dsh-order-open-group').forEach(el => el.classList.remove('dsh-order-open-group'));
      // 1. Inject stylesheets: badges first, then the control panel's own rows.
      const styleEl = document.createElement('style');
      styleEl.textContent = CSS + PANEL_CSS;
      document.head.appendChild(styleEl);

      // 1b. Offer the feature switches on the Plugins detail page.
      mountControlPanel(ctx);
      bindWorkspaceView(ctx);

      // 2. Prefer the Host's live session-status store; poll the Host service for
      //    pins, the error ledger, and as the whole-status fallback.
      attachLiveStatus(ctx);
      updateStatus();
      const timer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden && live) return;
        updateStatus();
      }, 2000);

      // Capture the user's target before the page toggles it. Fresh input ends
      // the short compensation, including scrollbar drags and touch scrolling.
      document.addEventListener('click', onWorkspaceToggle, true);
      document.addEventListener('keydown', onExpansionInput, true);
      document.addEventListener('pointerdown', onExpansionInput, { capture: true, passive: true });
      document.addEventListener('wheel', onExpansionInput, { capture: true, passive: true });
      document.addEventListener('touchstart', onExpansionInput, { capture: true, passive: true });
      document.addEventListener('touchmove', onExpansionInput, { capture: true, passive: true });

      // 3. Repaint badges and compensate the committed header-toggle layout.
      let repaintQueued = false;
      const observer = new MutationObserver(() => {
        if (disposed || repaintQueued) return;
        repaintQueued = true;
        queueMicrotask(() => {
          repaintQueued = false;
          if (disposed) return;
          refresh();
          restoreExpansionPosition();
        });
      });
      observer.observe(document.body, {
        childList: true, subtree: true, attributes: true,
        attributeFilter: ['aria-expanded', 'aria-selected', 'data-row-key']
      });

      // Clean up if context unwinds
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(() => () => {
          disposed = true;
          cancelExpansionPosition();
          document.removeEventListener('click', onWorkspaceToggle, true);
          document.removeEventListener('keydown', onExpansionInput, true);
          document.removeEventListener('pointerdown', onExpansionInput, true);
          document.removeEventListener('wheel', onExpansionInput, true);
          document.removeEventListener('touchstart', onExpansionInput, true);
          document.removeEventListener('touchmove', onExpansionInput, true);
          clearInterval(timer);
          observer.disconnect();
          if (unsubscribeLive) {
            try { unsubscribeLive(); } catch {}
          }
          live = null;
          rootCtx = null;
          styleEl.remove();
          document.querySelectorAll('.dsh-order-workspace-header').forEach(el => el.classList.remove('dsh-order-workspace-header'));
          document.querySelectorAll('.dsh-order-pin-btn, .dsh-order-state, .dsh-order-busy-badge, .dsh-order-star, .dsh-order-star-count, .dsh-order-star-filter').forEach(el => el.remove());
          document.querySelectorAll('.dsh-order-star-menu').forEach(el => el.remove());
          closeStarMenu();
          document.querySelectorAll('.dsh-order-current-group').forEach(el => el.classList.remove('dsh-order-current-group'));
          document.querySelectorAll('.dsh-order-open-group').forEach(el => el.classList.remove('dsh-order-open-group'));
        });
      }
    }

    module.exports.apply = apply;
    return module.exports;
  }
});
