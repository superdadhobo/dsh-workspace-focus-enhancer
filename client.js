/**
 * dsh-workspace-focus-enhancer - Client UI Enhancements
 *
 * Provides:
 * 1. Pin button (📌) on each workspace row in the sidebar:
 *    - Hover to reveal on normal workspaces.
 *    - Always visible & highlighted when pinned.
 *    - Click to toggle pin without expanding/collapsing the workspace.
 * 2. One state glyph in the workspace row's folder slot, resolved in this
 *    priority:
 *    - orange question mark : a session in the workspace waits for the user
 *      (approval, plan review, or a question);
 *    - red exclamation mark : a session stopped on an error and is unseen;
 *    - spinning ring        : a session is running;
 *    - green check          : a session finished and its output is unread;
 *    - the page's own folder icon : the workspace is idle.
 *    The glyph takes the place of the folder icon rather than standing next
 *    to it, so the row keeps its width and the workspace name stays exactly
 *    where an idle row's name is.
 *    The live waiting/running/unread facts come from the Host's own session
 *    status store when the page exposes it, and from the Host's polled status
 *    otherwise; the two are merged per row, so a fact only one of them knows
 *    still reaches the glyph. A workspace whose row is hidden because an
 *    ancestor is collapsed hands its glyph up to the nearest visible ancestor,
 *    so collapsing a group never hides that something inside needs attention.
 * 3. Synchronization with the backend ordering service.
 */

window.__ModuleLoader__.load({
  id: "dsh-workspace-focus-enhancer",
  factory: (require) => {
    const module = { exports: {} };

    // Only the two baseline React modules are requested from the page's module
    // table. They are the documented baseline every Client bundle may import.
    //
    // The Harness Client UI packages are deliberately NOT required here.
    // `@deepseek-ai/dsh-client-ui-primitives` and `@deepseek-ai/dsh-client-store`
    // are internal implementation modules: their exports change without notice,
    // and a missing export would silently drop the whole settings card (the
    // panel used to gate itself on `primitives.Switch`). Every control the card
    // needs is therefore built here from plain elements plus the host's
    // `--dsw-alias-*` theme tokens, copying the shipped switch/tag/disclosure
    // markup and behaviour so the card still looks like an official one.
    let react = null;
    let jsxRuntime = null;
    let uiAvailable = false;
    try {
      react = require('react');
      jsxRuntime = require('react/jsx-runtime');
      uiAvailable = !!(react && jsxRuntime && typeof react.useState === 'function');
    } catch {
      uiAvailable = false;
    }

    /**
     * A minimal observable snapshot store, the shape the slot `inject` face
     * accepts under `hooks` (`getSnapshot` + `subscribe`). It replaces the
     * `@deepseek-ai/dsh-client-store` dependency: the renderer binds any such
     * source to a selector hook itself, so a plain object is enough.
     * @param initial - first snapshot.
     * @returns store with get/set/subscribe.
     */
    function createLocalStore(initial) {
      let snapshot = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => { listeners.delete(listener); };
        },
        set: (next) => {
          if (next === snapshot) return;
          snapshot = next;
          for (const listener of [...listeners]) {
            try { listener(); } catch {}
          }
        }
      };
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

      /* A workspace's rolled-up star leads the text, ahead of the name — the
       * same order a session row uses (star, then status dot, then title). The
       * row's own 6px gap supplies the spacing, so no margin here. */
      .dsh-order-star-count {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        flex-shrink: 0;
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
        /*
         * macOS Desktop only excludes interactive controls inside a declared
         * window region. This menu is appended to body, outside any drag row, so
         * it declares its own exclusion: its buttons stay clickable instead of
         * dragging the window, and its visible box is what the region
         * calculation uses.
         */
        -webkit-app-region: no-drag;
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

      /* One workspace state badge: a folder that fills with colour.
       *
       * It is the app's own folder icon — same path, same 1-unit stroke, same
       * 16-unit box — redrawn here so that its inside can be filled. It stands
       * in the row's folder slot rather than standing next to it, so it is
       * 16px, the exact width of the icon it replaces, and it carries no
       * margin: the row's own 6px gap does the spacing. The name therefore
       * lands where it lands on an idle row, and a workspace that has
       * something to say costs the list nothing in width.
       *
       * Two vocabularies, one per column. A session row keeps its own marks —
       * orange question mark, red exclamation mark, green check — because a
       * mark the size of a dot has to say its state without a surround to put
       * it in. A workspace row *is* a container, so it says its state by how
       * full it is and from where the fill came: the green, the amber and the
       * red are shared with the session column, the shape and the motion are
       * not. One colour, one meaning; one column, one way of drawing it. */
      .dsh-order-state {
        width: 16px;
        height: 16px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: none;
        align-self: center;
      }

      .dsh-order-state svg {
        width: 16px;
        height: 16px;
        display: block;
      }

      /*
       * A row that carries a state gives up its folder icon: the state glyph
       * takes that slot, so the row keeps its width and its name stays where
       * it was.
       *
       * The hover arrow goes with it. The app swaps its folder for an arrow
       * when the pointer is over the row, and that swap is two icons in one
       * slot — but this slot already holds the state. The state wins that
       * contest, because a folder icon is decoration while the state is the
       * one thing the row is there to say, and the row stays just as
       * clickable without the arrow.
       */
      div[data-row-key^="workspace:"].dsh-order-has-state > span[class*="folder"],
      div[data-row-key^="workspace:"].dsh-order-has-state > span[class*="chevron"] {
        display: none !important;
      }

      .dsh-order-state[data-state="waiting"],
      .dsh-order-state[data-state="waiting"] svg {
        color: var(--dsh-order-amber);
      }

      .dsh-order-state[data-state="error"],
      .dsh-order-state[data-state="error"] svg {
        color: var(--dsh-order-red);
      }

      .dsh-order-state[data-state="done"],
      .dsh-order-state[data-state="done"] svg {
        color: var(--dsh-order-green);
      }

      /* Running: the folder fills with the same green the session spinner uses. */
      .dsh-order-state[data-state="running"],
      .dsh-order-state[data-state="running"] svg {
        color: var(--dsh-order-green);
      }

      /* The folder itself, in the state's colour.
       *
       * The outline is the app's own folder path at its own 1-unit weight, so a
       * workspace at work and a workspace at rest are the same drawing at the
       * same size; only the inside differs. The faint body under the cells is
       * what makes the empty part of the folder visible at all — without it a
       * half-filled folder reads as a thin box with a few blocks in it. */
      .dsh-order-state svg .dsh-folder-shell {
        fill: currentColor;
        fill-opacity: 0.13;
        stroke: none;
      }

      /* The outline proper, laid over everything so a filled folder still has
       * its edge: the app's own folder path at its own 1-unit weight, which is
       * what makes a busy row and an idle row the same drawing at the same
       * size. */
      .dsh-order-state svg .dsh-folder-outline {
        fill: none;
        stroke: currentColor;
        stroke-width: 1;
        stroke-linejoin: round;
      }

      .dsh-order-state svg .dsh-folder-lip {
        fill: none;
        stroke: currentColor;
        stroke-width: 1;
        stroke-linecap: round;
        opacity: 0.65;
      }

      /* The eight cells: four across, two down, inside the folder's front
       * pocket. Every state lights the same eight cells and differs only in how
       * they come and go, so a workspace never changes shape when its state
       * changes — only its contents do. */
      .dsh-order-state svg .dsh-folder-cell {
        fill: currentColor;
        stroke: none;
        opacity: 1;
      }

      .dsh-order-state svg .dsh-folder-cells {
        display: inline;
      }

      /* The pocket everything falls inside of. Bricks that leave the folder
       * have to leave through its own edge, so the grid is clipped to the part
       * below the lip; without this a falling brick would carry on over the row
       * underneath. */
      .dsh-order-state[data-state="error"] svg .dsh-folder-cells {
        clip-path: url(#dsh-order-pocket);
      }

      /* Green, working: a snake running laps inside the folder.
       *
       * It comes in at the bottom-left, travels right along the bottom, climbs
       * the right-hand edge, comes back along the top and drops down the left —
       * the circuit the ring of cells actually has — and it never stops, because
       * a lap with no end is exactly what "still working" means.
       *
       * One animation drives all eight cells. Each cell knows its own position
       * on the lap and starts that same animation that much earlier, so the lit
       * window travels round the ring by itself; nothing is timed per cell.
       *
       * The lit window is 3/8 of the cycle — two cells at full strength and one
       * behind them half-way. A longer gradient tail vanished into the grid at
       * 16px and left a single blinking square; two solid cells and a fading
       * third read as a body even at that size. */
      .dsh-order-state[data-state="running"] svg .dsh-folder-cell {
        opacity: 0.14;
        animation: dsh-order-snake 2.4s linear infinite;
        animation-delay: calc(-0.3s * var(--dsh-order-lap));
      }

      @keyframes dsh-order-snake {
        0% { opacity: 1; }
        12.5% { opacity: 1; }
        24.9% { opacity: 0.72; }
        37.4% { opacity: 0.14; }
        100% { opacity: 0.14; }
      }

      /* Amber, waiting: the bottom row holds while the top row blinks.
       *
       * The steady half says "this is parked, nothing is progressing"; the
       * blinking half says "and it is waiting on you". Slower and shallower than
       * the green, because a wait is not a progress bar and must not read as
       * one. */
      .dsh-order-state[data-state="waiting"] svg .dsh-folder-cell:nth-of-type(n + 5) {
        animation: dsh-order-blink 1.5s ease-in-out infinite;
      }

      @keyframes dsh-order-blink {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.18; }
      }

      /* Red, broken: the wall comes down.
       *
       * Eight bricks stand in two rows, then the whole wall drops at once. Each
       * brick tumbles its own way — its own lean, its own sideways drift, its
       * own pivot — so what falls is a pile of loose bricks rather than one
       * solid plate tipping over. Nothing fades: a brick stays fully opaque
       * until it has fallen past the folder's own bottom edge and the pocket
       * clip takes it away, which is also why nothing is left lying at the
       * bottom. Once the last one is gone the wall is simply standing again.
       *
       * The lower row has about five units to travel to clear the pocket and
       * the upper row about nine; short travel is what leaves cut-off stubs
       * sitting on the floor. */
      .dsh-order-state[data-state="error"] svg .dsh-folder-cell {
        transform-box: fill-box;
        animation: dsh-order-wall-fall 2.8s infinite;
      }

      @keyframes dsh-order-wall-fall {
        0%, 26% {
          transform: translate(0, 0) rotate(0deg);
          animation-timing-function: cubic-bezier(0.45, 0.02, 1, 0.6);
        }
        58%, 78% {
          transform: translate(var(--dsh-order-fx), var(--dsh-order-fy)) rotate(var(--dsh-order-fr));
          animation-timing-function: linear;
        }
        78.01%, 100% {
          transform: translate(0, 0) rotate(0deg);
        }
      }

      .dsh-order-state[data-state="error"] svg .dsh-folder-cell:nth-of-type(1) {
        --dsh-order-fx: -0.55px; --dsh-order-fy: 5.2px; --dsh-order-fr: 34deg;
        transform-origin: 15% 80%;
      }

      .dsh-order-state[data-state="error"] svg .dsh-folder-cell:nth-of-type(2) {
        --dsh-order-fx: 0.1px; --dsh-order-fy: 5.5px; --dsh-order-fr: -21deg;
        transform-origin: 70% 75%;
      }

      .dsh-order-state[data-state="error"] svg .dsh-folder-cell:nth-of-type(3) {
        --dsh-order-fx: -0.12px; --dsh-order-fy: 5.1px; --dsh-order-fr: 28deg;
        transform-origin: 25% 85%;
      }

      .dsh-order-state[data-state="error"] svg .dsh-folder-cell:nth-of-type(4) {
        --dsh-order-fx: 0.62px; --dsh-order-fy: 5.6px; --dsh-order-fr: -37deg;
        transform-origin: 85% 70%;
      }

      .dsh-order-state[data-state="error"] svg .dsh-folder-cell:nth-of-type(5) {
        --dsh-order-fx: 0.48px; --dsh-order-fy: 8.8px; --dsh-order-fr: -26deg;
        transform-origin: 80% 60%;
      }

      .dsh-order-state[data-state="error"] svg .dsh-folder-cell:nth-of-type(6) {
        --dsh-order-fx: -0.6px; --dsh-order-fy: 9.1px; --dsh-order-fr: 41deg;
        transform-origin: 18% 65%;
      }

      .dsh-order-state[data-state="error"] svg .dsh-folder-cell:nth-of-type(7) {
        --dsh-order-fx: 0.3px; --dsh-order-fy: 8.6px; --dsh-order-fr: -31deg;
        transform-origin: 65% 55%;
      }

      .dsh-order-state[data-state="error"] svg .dsh-folder-cell:nth-of-type(8) {
        --dsh-order-fx: -0.28px; --dsh-order-fy: 9px; --dsh-order-fr: 22deg;
        transform-origin: 35% 60%;
      }

      /* Green, finished unread: all eight blocks, still. The one state that is
       * not moving is the one that is over. */
      .dsh-order-state[data-state="done"] svg .dsh-folder-cell {
        opacity: 1;
      }

      .dsh-order-state[data-state="error"] svg .dsh-folder-lip,
      .dsh-order-state[data-state="done"] svg .dsh-folder-lip {
        display: none;
      }

      /* Motion is the whole message here, so these fall back to a still frame
       * instead of to nothing. A still frame has to show the state, not just
       * stop: the snake stops mid-lap, the amber keeps its steady row and drops
       * the blinking one, the wall keeps standing, and the finished folder stays
       * full. */
      @media (prefers-reduced-motion: reduce) {
        .dsh-order-state[data-state="running"] svg .dsh-folder-cell {
          animation: none;
          opacity: 0.14;
        }

        /* The snake stopped with its head at the bottom-left and its body
         * trailing up the left-hand edge: a frame of the lap, not an empty
         * folder. */
        .dsh-order-state[data-state="running"] svg .dsh-folder-cell:nth-of-type(1) {
          opacity: 1;
        }

        .dsh-order-state[data-state="running"] svg .dsh-folder-cell:nth-of-type(5) {
          opacity: 1;
        }

        .dsh-order-state[data-state="running"] svg .dsh-folder-cell:nth-of-type(6) {
          opacity: 0.72;
        }

        .dsh-order-state[data-state="waiting"] svg .dsh-folder-cell:nth-of-type(n + 5) {
          animation: none;
          opacity: 0.45;
        }

        .dsh-order-state[data-state="error"] svg .dsh-folder-cell {
          animation: none;
        }
      }

      /* One resolved state owns BOTH the shape and colour of a native dot.
       * Never mutate React's data-state or replace its node. */
      body {
        --dsh-order-glyph-waiting: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='none' stroke='%23000' stroke-width='3.1' stroke-linecap='round' d='M9.2 9.1a2.9 2.9 0 1 1 3.7 3.2c-.8.2-1.4 1-1.4 1.9v.5'/><circle cx='11.6' cy='20' r='2.3'/></svg>");
        --dsh-order-glyph-running: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path fill='none' stroke='%23000' stroke-width='3.6' stroke-linecap='round' d='M12 3.4a8.6 8.6 0 1 1-7.5 4.4'/></svg>");
        --dsh-order-glyph-error: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><rect x='9.9' y='3.4' width='4.2' height='11.4' rx='2.1'/><circle cx='12' cy='19.4' r='2.4'/></svg>");
        --dsh-order-glyph-done: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><polyline points='4.2 12.6 9.4 17.8 19.8 6.2' fill='none' stroke='%23000' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/></svg>");
      }
      .dsh-order-session-mark { position:relative; display:inline-block; flex:none; width:10px; height:10px; }
      [data-dsh-order-state="waiting"] { color:var(--dsh-order-amber) !important; --dsh-order-mask:var(--dsh-order-glyph-waiting); }
      [data-dsh-order-state="error"] { color:var(--dsh-order-red) !important; --dsh-order-mask:var(--dsh-order-glyph-error); }
      [data-dsh-order-state="running"], [data-dsh-order-state="done"] { color:var(--dsh-order-green) !important; }
      [data-dsh-order-state="running"] { --dsh-order-mask:var(--dsh-order-glyph-running); }
      [data-dsh-order-state="done"] { --dsh-order-mask:var(--dsh-order-glyph-done); }
      [data-dsh-order-state="idle"] { color:var(--dsw-alias-state-idle-primary,#94a3b8) !important; }
      /* SVG cannot reliably generate ::after boxes. Its owned HTML replacement
       * keeps the leading-cell geometry; the React SVG and its paths stay put. */
      .dsh-order-native-svg-hidden { display:none !important; animation:none !important; }
      .dsh-order-native-svg-hidden * { animation:none !important; }
      .dsh-order-native-mark:not(svg)[data-dsh-order-state]::after, .dsh-order-session-mark::after {
        content:""; position:absolute; inset:0; border:0 !important; border-radius:0;
        background:currentColor; animation:none !important; transform:none;
        -webkit-mask:var(--dsh-order-mask) center / contain no-repeat;
        mask:var(--dsh-order-mask) center / contain no-repeat;
      }
      .dsh-order-native-mark:not(svg)[data-dsh-order-state="idle"]::after,
      .dsh-order-session-mark[data-dsh-order-state="idle"]::after {
        inset:20%; border-radius:50%; -webkit-mask:none; mask:none;
      }
      .dsh-order-native-mark:not(svg)[data-dsh-order-state]::before { display:none !important; }
      .dsh-order-native-mark:not(svg)[data-dsh-order-state="running"]::after,
      .dsh-order-session-mark[data-dsh-order-state="running"]::after { animation:dsh-order-mark-spin 1.1s linear infinite !important; }
      @keyframes dsh-order-mark-spin { to { transform:rotate(360deg); } }
      .dsh-order-pin-btn:focus-visible, .dsh-order-star:focus-visible { opacity:1; outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:-2px; }
      .dsh-order-star-menu-item:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:-2px; }
      .dsh-order-star-menu-item[aria-disabled="true"] { color:var(--dsw-alias-label-secondary); }
      .dsh-order-action-feedback { flex:1 1 100%; font-size:12px; line-height:1.5; color:var(--dsh-order-red); user-select:text; white-space:normal; }
      [data-row-key]:has(> .dsh-order-action-feedback) { flex-wrap:wrap; }
      .dsh-order-star-menu-feedback { margin:2px 10px 6px; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary); user-select:text; }
      .dsh-order-star-menu { min-width:min(240px,calc(100vw - 16px)); max-width:min(320px,calc(100vw - 16px)); }
      .dsh-order-star-menu-item { min-height:28px; }
      .dsh-order-star-menu:focus-visible, .dsh-order-star-menu-action:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:-2px; }
      .dsh-order-star-menu-action, .dsh-order-star-menu-archive-action { margin:0 10px 6px; border:0; border-radius:4px; background:transparent; color:var(--dsw-alias-state-business-primary); cursor:pointer; padding:4px; }
      .dsh-order-star-menu-archive { position:sticky; bottom:-4px; background:var(--dsw-alias-bg-layer-3,#2b2b2b); border-top:1px solid var(--dsw-alias-border-l4); padding-top:4px; }
      .dsh-order-star-menu-archive-note { margin:2px 10px 6px; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary); white-space:normal; user-select:text; }
      .dsh-order-star-menu-archive-action { min-height:28px; }
      .dsh-order-star-menu-archive-action:disabled { color:var(--dsw-alias-label-secondary); cursor:default; }
      .dsh-order-star-menu-archive-action:focus-visible { outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary)); outline-offset:-2px; }
      @media (prefers-reduced-motion:reduce) {
        .dsh-order-pin-btn, .dsh-order-star { transition:none; transform:none !important; }
        .dsh-order-native-mark:not(svg)[data-dsh-order-state="running"]::after,
        .dsh-order-session-mark[data-dsh-order-state="running"]::after { animation:none !important; }
        body.dsh-order-sessions-first [data-row-key] { animation:none; transition:none; }
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

    /*
     * The workspace badge is the app's own folder icon, redrawn rather than
     * reused.
     *
     * The path below is copied verbatim from the folder the sidebar paints on
     * an idle workspace row (same 16-unit box, same 1-unit stroke, same tab and
     * same lip across the front). Reusing the drawing is what lets a workspace
     * that has something to say sit in the list without looking like a
     * different kind of row: the silhouette is the one the eye already knows.
     *
     * What the app's icon has not got is an interior, and the interior is where
     * this badge speaks. Eight blocks are laid into the front panel — four
     * across, two down — and every state draws those same eight blocks; only
     * what they do differs. A workspace therefore never changes shape when its
     * state changes, and the four states read as four conditions of one object
     * rather than four different icons.
     *
     * Cell 0 sits bottom-left, cell 3 bottom-right, cell 4 top-left, cell 7
     * top-right. The snake is the only state that cares about that order.
     */
    const FOLDER_PATH = 'M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z';
    const FOLDER_LIP = 'M3.63501 7.66614H12.3647';
    const BADGE_CLIP_ID = 'dsh-order-pocket';

    /**
     * The pocket: the folder's front panel, below the lip and inset by half the
     * outline's stroke. It is both the region the bricks stand in and the hole
     * they fall through.
     */
    const FOLDER_POCKET = 'M2.00439 8.16614H13.9958V12.8894C13.9958 13.1655 13.7719 13.3894 13.4958 13.3894H2.50439C2.22825 13.3894 2.00439 13.1655 2.00439 12.8894Z';

    /** Cells inside the front panel: 4 across, 2 down, in fill order. */
    const FOLDER_CELLS = (() => {
      const left = 2.7;
      const top = 8.28;
      const size = 2.2;
      const gapX = 0.6;
      const gapY = 0.6;
      const cells = [];
      // Bottom row first (y grows downward, so the bottom row is the larger y),
      // left to right; then the row above it.
      for (let row = 1; row >= 0; row -= 1) {
        for (let col = 0; col < 4; col += 1) {
          cells.push({
            x: left + col * (size + gapX),
            y: top + row * (size + gapY)
          });
        }
      }
      // The lap the working snake runs: in at the bottom-left, right along the
      // bottom, up the right-hand side, back along the top and down the left,
      // which is the one circuit a ring of cells this shape actually has. Lap
      // positions are handed out in reverse so that "one step later" is always
      // one step further round in this direction — the badge's single animation
      // drives all eight cells by delay alone, and a delay can only run one way.
      const lapOrder = [0, 1, 2, 3, 7, 6, 5, 4];
      const lapPosition = new Array(8);
      lapOrder.forEach((cellIndex, step) => {
        // Each cell starts the lap animation a step earlier than the one behind
        // it, and a negative delay is how a cell is put *forward* in its own
        // timeline. Counting the steps backwards is what makes the head travel
        // lapOrder forwards: left to right along the bottom first, which is the
        // way the snake is meant to come in.
        lapPosition[cellIndex] = lapOrder.length - 1 - step;
      });

      return cells.map(({ x, y }, index) => (
        `<rect class="dsh-folder-cell" style="--dsh-order-lap:${lapPosition[index]}" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${size}" height="${size}" rx="0.35"></rect>`
      )).join('');
    })();

    /**
     * One folder badge. Every state draws the same folder and the same eight
     * blocks; the stylesheet decides what they do. Nothing here is
     * state-specific, so switching state never rewrites the drawing — only the
     * rules that paint it.
     */
    function folderSvg() {
      return `
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path class="dsh-folder-shell" d="${FOLDER_PATH}"></path>
        <g class="dsh-folder-cells">${FOLDER_CELLS}</g>
        <path class="dsh-folder-outline" d="${FOLDER_PATH}"></path>
        <path class="dsh-folder-lip" d="${FOLDER_LIP}"></path>
      </svg>
    `;
    }

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
      highlightCurrent: true,
      /** Show own sessions above nested sub-workspaces in tree view. */
      treeSessionsFirst: true
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
    const settingsStore = uiAvailable ? createLocalStore({ settings, hostAccepted, hostError }) : null;

    /** All switches, so the summary and persistence cover every one. */
    const SETTING_ROWS = [
      { key: 'pinTop', labelKey: 'row.pinTop', hintKey: 'hint.pinTop' },
      { key: 'autoFront', labelKey: 'row.autoFront', hintKey: 'hint.autoFront' },
      { key: 'autoCollapse', labelKey: 'row.autoCollapse', hintKey: 'hint.autoCollapse' },
      { key: 'treeSessionsFirst', labelKey: 'row.treeSessionsFirst', hintKey: 'hint.treeSessionsFirst' },
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
       * The card's own switch, tag and disclosure row. These copy the shipped
       * primitives' measurements and states (36x20 track, 16px thumb, 999px
       * radius, focus ring at 2px offset) but read only the host's
       * --dsw-alias-* theme tokens, so a renamed token degrades the look
       * instead of breaking the control, and nothing depends on a private
       * module's exports.
       */
      .dsh-order-panel-switch {
        box-sizing: border-box;
        position: relative;
        flex: 0 0 auto;
        width: 36px;
        height: 20px;
        padding: 2px;
        border: 0;
        border-radius: 999px;
        background: var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.2));
        cursor: pointer;
        transition: background 0.12s ease;
      }
      .dsh-order-panel-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary, #5285ff); }
      .dsh-order-panel-switch:disabled { cursor: default; opacity: 0.5; }
      .dsh-order-panel-switch:focus-visible {
        outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #5285ff));
        outline-offset: 2px;
      }
      .dsh-order-panel-switch-thumb {
        display: block;
        width: 16px;
        height: 16px;
        border-radius: 50%;
        background: var(--dsw-alias-label-primary-foreground, #fff);
        transition: transform 0.12s ease;
      }
      .dsh-order-panel-switch[aria-checked="false"] .dsh-order-panel-switch-thumb {
        background: var(--dsw-alias-switch-thumb, rgba(255, 255, 255, 0.7));
      }
      .dsh-order-panel-switch[aria-checked="true"] .dsh-order-panel-switch-thumb { transform: translate(16px); }

      .dsh-order-panel-group-tag {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 1px 8px;
        font-size: 11px;
        line-height: 17px;
        font-weight: 500;
        white-space: nowrap;
      }
      .dsh-order-panel-group-tag[data-tone="quiet"] { color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.45)); }
      .dsh-order-panel-group-tag[data-tone="warning"] {
        background: color-mix(in srgb, var(--dsh-order-amber) 12%, transparent);
        color: var(--dsh-order-amber);
      }
      .dsh-order-panel-group-tag[data-tone="success"] {
        background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #22c55e) 12%, transparent);
        color: var(--dsw-alias-state-success-primary, #22c55e);
      }

      .dsh-order-panel-group-header {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 32px;
        cursor: pointer;
        user-select: none;
      }
      .dsh-order-panel-group-header:focus-visible {
        outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #5285ff));
        outline-offset: 2px;
        border-radius: var(--dsw-radius-sm, 8px);
      }
      .dsh-order-panel-group-title {
        font-size: 13px;
        font-weight: 500;
        color: var(--dsw-alias-label-primary, rgba(255, 255, 255, 0.92));
      }
      .dsh-order-panel-chevron {
        width: 0;
        height: 0;
        flex: 0 0 auto;
        border-left: 4px solid currentColor;
        border-top: 4px solid transparent;
        border-bottom: 4px solid transparent;
        color: var(--dsw-alias-label-tertiary, rgba(255, 255, 255, 0.45));
        transition: transform 0.12s ease;
        transform: rotate(0deg);
      }
      .dsh-order-panel-chevron[data-open="true"] { transform: rotate(90deg); }
      @media (prefers-reduced-motion: reduce) {
        .dsh-order-panel-chevron,
        .dsh-order-panel-switch,
        .dsh-order-panel-switch-thumb { transition: none; }
      }
      /*
       * An expanded workspace reads as a recessed tray: its header row and the
       * sessions it reveals share one sunken surface, so the open group stands
       * apart from the collapsed ones at a glance.
       *
       * Level 1 (top-level expanded workspace): delicate, translucent tint with a subtle frame.
       * Level 2+ (nested expanded sub-workspaces): micro-stepped tint with a crisp inner frame
       * so it reads as "a smaller tray inside a bigger tray" without stacking into blackness.
       */
      .dsh-order-open-group {
        background: rgba(0, 0, 0, 0.045);
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.05), inset 0 1px 2px rgba(0, 0, 0, 0.03);
        border-radius: var(--dsw-radius-lg, 16px);
      }

      div[class*="groupSection"] div[class*="groupSection"].dsh-order-open-group {
        background: rgba(0, 0, 0, 0.04);
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.07), inset 0 1px 2px rgba(0, 0, 0, 0.04);
      }

      div[class*="groupSection"] div[class*="groupSection"] div[class*="groupSection"].dsh-order-open-group {
        background: rgba(0, 0, 0, 0.025);
        box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08), inset 0 1px 2px rgba(0, 0, 0, 0.04);
      }

      body[data-ds-dark-theme] .dsh-order-open-group {
        background: rgba(255, 255, 255, 0.05);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07);
      }

      body[data-ds-dark-theme] div[class*="groupSection"] div[class*="groupSection"].dsh-order-open-group {
        background: rgba(255, 255, 255, 0.04);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.09);
      }

      body[data-ds-dark-theme] div[class*="groupSection"] div[class*="groupSection"] div[class*="groupSection"].dsh-order-open-group {
        background: rgba(255, 255, 255, 0.03);
        box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.11);
      }

      /*
       * Enhance folder icon contrast in workspace rows.
       * The native app styles the folder slot with label-tertiary (~40% opacity),
       * which easily washes out against shaded tray backgrounds. Lifting to label-secondary
       * gives folders crisp outlines so sub-workspaces and sessions are never confused.
       */
      div[data-row-key^="workspace:"] span[class*="folder"]:not([class*="folderActive"]) {
        color: var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.65));
        opacity: 0.88;
      }
      body[data-ds-dark-theme] div[data-row-key^="workspace:"] span[class*="folder"]:not([class*="folderActive"]) {
        color: var(--dsw-alias-label-secondary, rgba(255, 255, 255, 0.72));
        opacity: 0.88;
      }

      /* Own sessions and overflow precede nested groups. React nodes stay put.
       * Keyboard traversal uses this same semantic order; reading-flow is an
       * additional progressive enhancement, not our keyboard implementation. */
      body.dsh-order-sessions-first div[class*="groupSection"] { display:flex; flex-direction:column; reading-flow:flex-visual; }
      body.dsh-order-sessions-first div[class*="groupSection"] > [role="group"] { order:1; margin-top:4px; }

      /*
       * The box wraps one whole group: its workspace row plus the sessions it
       * has expanded. Outline, not border, so nothing inside shifts.
       */
      .dsh-order-current-group {
        outline: 1.5px solid var(--dsw-alias-state-business-primary, #5285ff);
        outline-offset: -1.5px;
        border-radius: var(--dsw-radius-lg, 16px);
      }

      /* The tray owns the one 12px step. Mark actual row ownership by closest
       * groupSection, independent of any direct or multi-level HoverCard wrapper.
       * Keep native base padding, border inset and overflow padding unchanged. */
      body.dsh-order-tree-trays div[class*="groupSection"] div[class*="groupSection"] { margin-inline-start:12px; }
      body.dsh-order-tree-trays [data-dsh-order-tray-row] { --dsh-workspace-indent:0px; }

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
      waiting: { svg: folderSvg(), key: 'state.waiting' },
      error: { svg: folderSvg(), key: 'state.error' },
      running: { svg: folderSvg(), key: 'state.running' },
      done: { svg: folderSvg(), key: 'state.done' }
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
    /**
     * The same fact per session, so a rendered row can wear the question in the
     * leading cell when the page paints nothing there — which, in this build,
     * is every row that is not mid-turn.
     */
    let waitingSessionSet = new Set();
    /**
     * Root sessions with work in progress, from the Host poll. The page's own
     * live store only covers sessions it has bound, and a row behind a live
     * store that has not settled yet would otherwise show nothing while its
     * workspace above spins.
     */
    let runningSessionSet = new Set();
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

    // Completion is Host-confirmed, never inferred from a native stop. A read
    // retirement or a new run invalidates the old affirmation. Only a matching
    // post-run Host snapshot can confirm another successful unread completion.
    const retiredLocalUnread = new Set();
    let archivedSessionSet = new Set();
    let archivedSessionsKnown = false;
    let hostSessionTitles = Object.create(null);
    let sessionTitlesKnown = false;

    /** Wall clock of the last successful Host status poll; 0 before the first. */
    let lastStatusAt = 0;

    /** How long a poll stays fresh enough to outrank the local store. */
    const HOST_FRESH_MS = 10000;

    /** Whether the Host ledger answered recently enough to arbitrate. */
    function hostFresh() {
      return lastStatusAt > 0 && Date.now() - lastStatusAt < HOST_FRESH_MS;
    }

    /** One Host-confirmed unread predicate shared by native dots, fallback
     * glyphs and workspace roll-ups, including during connection outages. */
    function localDoneCounts(sessionId) {
      // Native completionUnread includes cancelled/blocked/no-reply stops. It
      // is never proof of successful completion. Only an accepted exact Host
      // affirmation counts; a connection outage preserves that existing fact.
      return unreadSessionSet.has(sessionId) && !retiredLocalUnread.has(sessionId);
    }
    const unreadEpochs = new Map();
    let lastRunSignals = new Map();
    let activeUnreadRoots = new Set();
    function invalidateUnread(root, source = root) {
      unreadEpochs.set(root, (unreadEpochs.get(root) || 0) + 1);
      for (const id of new Set([root, source])) {
        unreadSessionSet.delete(id); retiredLocalUnread.add(id);
      }
    }
    function observeRunSignals() {
      const statuses = statusSnapshot(), list = sessionListSnapshot(), byId = list.byId || {};
      const parents = subagentParentsOf(byId, list.projectionsBySession);
      const next = new Map(), active = new Set();
      const consider = (kind, id, running) => {
        const key = `${kind}:${id}`, root = rootSessionIdOf(id, parents);
        next.set(key, running);
        if (!running) return;
        active.add(root);
        // Track each source independently: a rapid second run may start while
        // another source still paints its old ongoing SVG.
        if (lastRunSignals.get(key) !== true) invalidateUnread(root, id);
      };
      for (const [id, value] of statuses) consider('status', id, value?.running === true);
      for (const [id, value] of Object.entries(byId)) consider('summary', id, value?.running === true);
      for (const row of document.querySelectorAll('div[data-row-key^="session:"]')) consider('dom', row.getAttribute('data-row-key').slice(8), pageStatusDot(row)?.getAttribute('data-state') === 'ongoing');
      lastRunSignals = next; activeUnreadRoots = active;
    }
    function unreadPollCut() {
      observeRunSignals();
      return { epochs:new Map(unreadEpochs), running:new Set(activeUnreadRoots) };
    }
    function applyUnreadSnapshot(ids, cut) {
      if (!Array.isArray(ids)) { sessionMarksKnown = null; return; }
      observeRunSignals();
      sessionMarksKnown = true;
      const listed = new Set(ids), next = new Set(unreadSessionSet);
      const viewed = document.hidden ? null : computeMainSessionId() || currentSessionIdFromDom();
      for (const id of new Set([...next, ...listed])) {
        const sameEpoch = (cut.epochs.get(id) || 0) === (unreadEpochs.get(id) || 0);
        if (!sameEpoch || cut.running.has(id) || activeUnreadRoots.has(id) || id === viewed || !listed.has(id)) {
          next.delete(id); retiredLocalUnread.add(id); continue;
        }
        next.add(id); retiredLocalUnread.delete(id);
      }
      unreadSessionSet = next;
    }
    function computeMainSessionId() {
      return Object.values(sessionListSnapshot().byId || {}).find(row => (row?.retainedBy?.mainView || 0) > 0)?.id;
    }

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

    /** Each service has an independent Cordis injection lifetime. */
    const live = { status:null, workspaces:null, sessions:null, uiWorkspace:null, locale:null };
    let rootCtx = null;
    let liveBindingsInstalled = false;
    let workspaceView = null;

    function snapshotOf(source, fallback) {
      try { return source?.getSnapshot?.() ?? fallback; } catch { return fallback; }
    }
    function sessionListSnapshot() { return snapshotOf(live.sessions?.list, { byId:{}, projectionsBySession:{} }); }
    function workspaceListSnapshot() { return snapshotOf(live.workspaces?.list, { items:[] }); }
    function statusSnapshot() {
      const value = snapshotOf(live.status, null);
      return value instanceof Map ? value : new Map();
    }
    function text(key, vars = {}) {
      let value;
      try { value = live.locale?.bind?.('plugins.workspace-order')(key, vars); } catch {}
      if (!value || value === key) {
        const lang = /^zh/i.test(document.documentElement?.lang || navigator.language || 'zh') ? 'zh' : 'en';
        value = PANEL_LOCALE[lang][key] || PANEL_LOCALE.en[key] || key;
      }
      return String(value).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
    }
    function nativeText(key) {
      try {
        const value = live.locale?.bind?.('workspace')(key);
        if (value && value !== key) return value;
      } catch {}
      const fallback = { 'session.new':'native.new', 'session.untitled':'native.untitled',
        'toast.archivedNotOpenable':'native.archivedGuard', 'menu.unarchiveSession':'native.unarchive' };
      return text(fallback[key] || key);
    }

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

    /** Cordis re-runs each injection when its service starts/replaces and unwinds
     * its child effect when it stops. No all-or-nothing bind or leaked retries. */
    function attachLiveStatus(ctx) {
      if (disposed || liveBindingsInstalled || typeof ctx?.inject !== 'function') return;
      liveBindingsInstalled = true;
      for (const name of ['uiSession', 'workspaces', 'sessions', 'uiWorkspace', 'remote', 'locale']) {
        ctx.inject([name], child => {
          if (disposed) return;
          const service = child[name];
          const key = name === 'uiSession' ? 'status' : name;
          const value = name === 'uiSession' ? service?.sessionStatus : service;
          live[key] = value;
          const offs = [];
          const source = name === 'uiSession' ? value : name === 'locale' ? service?.state : service?.list;
          if (typeof source?.subscribe === 'function') offs.push(source.subscribe(refresh));
          if (name === 'remote' && typeof service?.$on === 'function') {
            offs.push(service.$on('api-session/error', sessionId => {
              if (disposed) return;
              clientErrored.add(sessionId);
              refresh();
            }));
          }
          child.effect(() => () => {
            for (const off of offs) { try { if (typeof off === 'function') off(); } catch {} }
            if (live[key] === value) live[key] = null;
            if (!disposed) refresh();
          });
          refresh();
        });
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
      const out = new Set(), rows = workspaceListSnapshot().items || [];
      for (const sessionId of unreadSessionSet) {
        if (sessionId === viewedId || isSessionArchived(sessionId) || !localDoneCounts(sessionId)) continue;
        const owner = workspaceOfSession[sessionId] || rows.find(row => row.sessionIds?.includes(sessionId))?.workspaceId;
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

    /**
     * Which Session spawned each subagent, from the two places the page records
     * it: the parent's own catalog, and the subagent flag on its summary. A
     * subagent's Session is a log of its own and belongs to no workspace, so
     * without this map its activity has nowhere to land and the workspace card
     * above the Session that started it reads idle while work is still going on.
     * @returns a map of child Session id -> the Session that spawned it.
     */
    function subagentParentsOf(byId, projections) {
      const parents = new Map();
      for (const [parentId, projection] of Object.entries(projections || {})) {
        const catalog = projection && projection.values && projection.values.subagentCatalog;
        if (!Array.isArray(catalog)) continue;
        for (const child of catalog) {
          if (child && typeof child.id === 'string' && child.id) parents.set(child.id, parentId);
        }
      }
      for (const [id, row] of Object.entries(byId || {})) {
        if (!row || row.origin !== 'subagent') continue;
        if (typeof row.parentId !== 'string' || !row.parentId) continue;
        if (!parents.has(id)) parents.set(id, row.parentId);
      }
      return parents;
    }

    /** The top-level Session one Session belongs to, walking the subagent chain. */
    function rootSessionIdOf(sessionId, parents) {
      let id = sessionId;
      for (let hops = 0; hops < 16; hops += 1) {
        const parent = parents.get(id);
        if (typeof parent !== 'string' || !parent || parent === id) break;
        id = parent;
      }
      return id;
    }

    /**
     * Root Sessions with a run in progress right now, subagents folded in. The
     * page knows this per row — that is where its "subagents running" line comes
     * from — but the workspace badge only ever looked at a Session's own run, so
     * a parent parked while its child worked read as finished instead.
     * @param statuses - the page's live per-session status snapshot.
     * @param byId - the page's session summaries.
     * @param parents - child -> parent, from {@link subagentParentsOf}.
     * @returns a set of root Session ids.
     */
    function runningRootSessions(statuses, byId, parents) {
      const roots = new Set();
      const consider = (id) => {
        if (typeof id === 'string' && id) roots.add(rootSessionIdOf(id, parents));
      };
      for (const [id, status] of statuses) {
        if (status && status.running === true) consider(id);
      }
      for (const [id, row] of Object.entries(byId)) {
        if (row && row.running === true) consider(id);
      }
      return roots;
    }

    function stateOfWorkspace(workspaceId, sessionIds, statuses, busyRoots) {
      let waiting = false;
      let errored = false;
      let running = false;
      let done = false;
      // Every session is examined before any answer is given. Returning on the
      // first hit would make the badge depend on the order sessions happen to be
      // listed in: one failed session early in the list would hide a question
      // waiting in a later one, though a question outranks a failure.
      for (const id of sessionIds) {
        // A subagent this Session spawned is still working, so the card is busy
        // even though the Session's own turn is over. Running outranks the
        // finished-unread check below, which is what used to paint a green tick
        // on a workspace that was in fact still being worked on.
        if (busyRoots && busyRoots.has(id)) {
          running = true;
        }
        const status = statuses.get(id);
        if (status?.running === true) clientErrored.delete(id);
        // A fresh run retires the previous run's local error marker.
        if (clientErrored.has(id)) errored = true;
        if (!status) continue;
        const pending = status.pendingInteraction;
        if (pending && VISIBLE_PENDING.has(pending.kind)) waiting = true;
        if (status.running === true) {
          running = true;
        } else if (status.completionUnread === true) {
          // The page's own store is per-browser and cannot be retracted by
          // another client; the Host's shared ledger can, and once its answer
          // is newer than this page's sighting it wins — that is what makes
          // "read on the phone" clear the desktop's green too.
          if (localDoneCounts(id)) done = true;
        } else {
        }
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
      observeRunSignals();
      const statuses = statusSnapshot();
      const workspaceRows = workspaceListSnapshot().items || [];
      const list = sessionListSnapshot();
      const byId = list.byId || {};
      const mainId = Object.values(byId).find(row => (row?.retainedBy?.mainView || 0) > 0)?.id;
      const parents = subagentParentsOf(byId, list.projectionsBySession);
      const roots = new Map();
      const consider = (id, state) => {
        if (!stateAllowed(state) || isSessionArchived(id)) return;
        const root = rootSessionIdOf(id, parents);
        if (isSessionArchived(root) || !document.hidden && root === mainId && ['error','done'].includes(state)) return;
        const prior = roots.get(root);
        if (!prior || stateRank(state) < stateRank(prior)) roots.set(root, state);
      };
      for (const id of new Set([...statuses.keys(), ...Object.keys(byId), ...clientErrored])) {
        const status = statuses.get(id);
        if (status?.running || byId[id]?.running) {
          clientErrored.delete(id);
          consider(id, 'running');
        }
        if (VISIBLE_PENDING.has(status?.pendingInteraction?.kind)) consider(id, 'waiting');
        if (clientErrored.has(id) && (document.hidden || id !== mainId)) consider(id, 'error');
      }
      for (const id of unreadSessionSet) if (localDoneCounts(id)) consider(id, 'done');
      const own = new Map();
      for (const ws of workspaceRows) {
        for (const id of ws.sessionIds || []) {
          const state = roots.get(id);
          if (state && (!own.has(ws.workspaceId) || stateRank(state) < stateRank(own.get(ws.workspaceId)))) own.set(ws.workspaceId, state);
        }
      }
      // DOM/native facts are equal-priority inputs too, not merely a fallback
      // when the whole live tuple happens to be unavailable.
      for (const row of document.querySelectorAll('div[data-row-key^="session:"]')) {
        const id = row.getAttribute('data-row-key').slice(8);
        const state = sessionState(row, id, roots);
        const owner = workspaceRows.find(ws => ws.sessionIds?.includes(id))?.workspaceId
          || workspaceOfSession[id] || groupOfWorkspaceId(row.closest('div[class*="groupSection"]'));
        if (owner && state && (!own.has(owner) || stateRank(state) < stateRank(own.get(owner)))) own.set(owner, state);
      }
      return { own, states:liftHiddenStates(own, workspaceRows), mainId, roots };
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
    // A document (not storage or a tab's copied sessionStorage) owns its reading
    // view. Client-only HMR reuses this id and replaces the old 18s Host lease.
    const VIEW_ID_KEY = Symbol.for('dsh-workspace-focus-enhancer:reading-view-id');
    const viewId = document[VIEW_ID_KEY] || window.crypto?.randomUUID?.() || `focus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    if (!document[VIEW_ID_KEY]) Object.defineProperty(document, VIEW_ID_KEY, { value:viewId });
    const seenRequests = new Set();
    function abortSeenRequests() {
      for (const controller of seenRequests) controller.abort();
      seenRequests.clear();
    }
    function sendSeenLease(sessionId) {
      if (disposed) return;
      // Superseded reading reports must not revive an older viewed session.
      // These controllers never own settings, favorites, or their pending data.
      abortSeenRequests();
      const controller = new AbortController();
      seenRequests.add(controller);
      fetch('/api/workspace-order/clear-error', {
        method:'POST', headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ sessionId, viewId }), keepalive:true, signal:controller.signal
      }).catch(() => {}).finally(() => { seenRequests.delete(controller); });
    }
    const SEEN_HEARTBEAT_MS = 5000;
    let lastSeenMainId;
    let lastSeenReportAt = -Infinity;
    function reportSeenSession(mainId, stillMarked, force = false) {
      if (disposed) return;
      const next = document.hidden ? null : mainId || null;
      const changed = next !== lastSeenMainId;
      const elapsed = Date.now() - lastSeenReportAt;
      if (!force && next === lastSeenMainId && elapsed < SEEN_HEARTBEAT_MS && (!stillMarked || elapsed < 1500)) return;
      lastSeenMainId = next;
      lastSeenReportAt = Date.now();
      if (next) {
        clientErrored.delete(next);
        if (changed) invalidateUnread(next);
        else { unreadSessionSet.delete(next); retiredLocalUnread.add(next); }
      }
      sendSeenLease(next);
    }
    function releaseSeenLease() {
      // Page hide/unload still releases while the plugin is alive. Context
      // teardown may follow removed Host routes: it aborts, never sends anew.
      if (disposed) return;
      sendSeenLease(null);
      lastSeenMainId = null;
      lastSeenReportAt = Date.now();
    }

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
        const focusedId = document.activeElement?.getAttribute('data-session-id');
        const hadMenuFocus = starMenu.contains(document.activeElement);
        const previousFocus = document.activeElement;
        const anchor = starMenuAnchor;
        closeStarMenu();
        if (anchor?.isConnected && !disposed) {
          toggleStarMenu(anchor);
          const focused = focusedId && Array.from(starMenu.querySelectorAll('[data-session-id]')).find(item => item.getAttribute('data-session-id') === focusedId);
          if (focused) focused.focus({ preventScroll:true });
          else if (!hadMenuFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll:true });
        }
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
          favoritesError = '';
          if (!disposed) {
            for (const star of document.querySelectorAll('.dsh-order-star[aria-describedby]')) feedbackNear(star, '');
            const note = starMenu?.querySelector('.dsh-order-star-menu-feedback');
            if (note?.textContent === text('error.favoriteSave')) {
              for (const item of starMenu.querySelectorAll('[aria-describedby]')) item.removeAttribute('aria-describedby');
              note.remove();
            }
          }
          return !disposed;
        } catch (err) {
          if (!disposed) {
            favoritesError = 'error.favoriteSave';
            if (starMenu) menuFeedback(starMenu.querySelector('[role="menuitem"]') || starMenu, text(favoritesError));
            console.warn('[workspace-order] 收藏暂未保存，将重试本次操作:', err);
          }
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
      if (rootCtx) attachLiveStatus(rootCtx);
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
    let statusPollQueued = false;
    async function updateStatus() {
      statusPollQueued = false;
      if (isFetching || disposed || pendingPins.size) { if (!disposed) statusPollQueued = true; return; }
      isFetching = true;
      const polledSettingsEpoch = settingsEpoch;
      const polledFavoritesEpoch = favoritesEpoch;
      const polledPinsEpoch = pinsEpoch;
      // Stamp when the question was asked, not when the answer landed: a turn
      // can end in flight, and the stale reply must not count as a newer
      // ledger that retires the green the ending just raised.
      const requestedAt = Date.now();
      const polledUnreadCut = unreadPollCut();
      try {
        const res = await fetch('/api/workspace-order/status');
        const data = await res.json();
        if (data?.stateRead?.status === 'degraded') {
          if (!disposed) { setHostError('noteHostDegraded'); refresh(); }
          return; // HTTP 200 must not turn an error payload into an exact ledger.
        }
        if (!res.ok || data?.error || data?.success === false || !Array.isArray(data?.pinned)) {
          throw Object.assign(new Error('Status request failed'), { status: res.status });
        }
        if (res.ok) {
          if (disposed || pendingPins.size || polledPinsEpoch !== pinsEpoch) return;
          setHostError('');
          lastStatusAt = requestedAt;
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
          waitingSessionSet = new Set(data.waitingSessions || []);
          // Running sessions, subagents folded into the Session that started
          // them. A page that cannot reach the live store still needs this:
          // the workspace above the row would spin while the row itself showed
          // a plain idle dot.
          runningSessionSet = new Set(data.runningSessions || []);
          unreadSet = new Set(data.unread || []);
          // A supplied exact list is authoritative. Never union it with the
          // workspace ledger or the previous poll (that resurrected old unread).
          applyUnreadSnapshot(data.unreadSessions, polledUnreadCut);
          applySessionMetadata(data.archivedSessions, data.sessionTitles);
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
        if (statusPollQueued && !disposed && !pendingPins.size) queueMicrotask(updateStatus);
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
      const pinnedUnreadCut = unreadPollCut();

      try {
        const res = await fetch('/api/workspace-order/toggle-pin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ workspaceId, pinned: !currentlyPinned })
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || '置顶失败，请重试');
        if (disposed) return;
        feedbackNear(btnElement, '');
        if (Array.isArray(data.pinnedIds)) pinnedSet = new Set(data.pinnedIds);
        if (data.stateRead?.status === 'degraded') setHostError('noteHostDegraded');
        else {
          if (Array.isArray(data.busyIds)) fallbackBusy = new Set(data.busyIds);
          if (Array.isArray(data.runningSessionIds)) runningSessionSet = new Set(data.runningSessionIds);
          if (Array.isArray(data.erroredIds)) erroredSet = new Set(data.erroredIds);
          if (Array.isArray(data.waitingIds)) waitingSet = new Set(data.waitingIds);
          if (Array.isArray(data.waitingSessionIds)) waitingSessionSet = new Set(data.waitingSessionIds);
          if (Array.isArray(data.unreadIds)) unreadSet = new Set(data.unreadIds);
          if (Array.isArray(data.unreadSessionIds)) applyUnreadSnapshot(data.unreadSessionIds, pinnedUnreadCut);
          applySessionMetadata(data.archivedSessionIds, data.sessionTitles);
          if (data.parents && typeof data.parents === 'object') hostParents = data.parents;
          if (data.owners && typeof data.owners === 'object') workspaceOfSession = data.owners;
          if (Array.isArray(data.erroredSessionIds)) erroredSessionSet = new Set(data.erroredSessionIds);
        }
      } catch (err) {
        if (disposed) return;
        // Rollback on failure
        if (currentlyPinned) pinnedSet.add(workspaceId);
        else pinnedSet.delete(workspaceId);
        console.error('[workspace-order] 置顶失败:', err);
        feedbackNear(btnElement, 'error.pinSave');
      } finally {
        pendingPins.delete(workspaceId);
        pinsEpoch += 1;
        if (!disposed) btnElement.disabled = false;
      }
      if (!disposed) { refresh(); if (statusPollQueued) void updateStatus(); }
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
        const rows = workspaceListSnapshot().items || [];
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
      const row = workspaceRowElement(targetId);
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
      const rows = live ? (workspaceListSnapshot().items || []) : [];
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
      return document.querySelector(`div[data-row-key="session:${window.CSS.escape(sessionId)}"]`) || void 0;
    }

    /** Whether a session lives in this workspace, per the Host's own mapping. */
    function sessionBelongsTo(sessionId, workspaceId) {
      if (!live) return false;
      const rows = workspaceListSnapshot().items || [];
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
          void toggleFavorite(sessionId).then(saved => feedbackNear(star, saved ? '' : 'error.favoriteSave'));
        });
      }
      const state = starred ? 'true' : 'false';
      if (star.getAttribute('data-starred') !== state) {
        star.setAttribute('data-starred', state);
        star.innerHTML = starred ? STAR_FILLED_SVG : STAR_SVG;
      }
      const label = text(starred ? 'action.unfavorite' : 'action.favorite');
      star.title = label;
      star.setAttribute('aria-label', label);
      star.setAttribute('aria-pressed', starred ? 'true' : 'false');
      if (row.firstElementChild !== star) row.insertBefore(star, row.firstChild);
    }

    /**
     * Where the page keeps a session row's state dot.
     *
     * The page paints a dot into the session's leading cell only while it has a
     * state it can name — running, waiting, or a completion this page has not
     * read — and hands the cell to the `sidebar.session.row.leading` slot for
     * everything else. The slot is an empty `display: contents` div in this
     * build, so an idle row has no dot at all. Handing back the cell — not the
     * row — is what lets the fallback mark take the dot's place without
     * shifting the title, and appending after the page's own child leaves the
     * slot's contents under the page's control.
     */
    function sessionMarkCell(row) {
      return row.querySelector('[data-slot="sidebar.session.row.leading"]')
        || row.querySelector('span[class*="slot"]');
    }

    /**
     * The page's own status dot on this row, or null while it paints none.
     * The dot sits in the same leading span as the slot, one level outside it,
     * so it has to be looked up from the cell rather than from the slot.
     */
    function pageStatusDot(row) {
      const cell = row.querySelector('span[class*="slot"]');
      if (!cell) return row.querySelector('[data-state]');
      return cell.querySelector('[data-state]') || row.querySelector('[data-state]');
    }

    function applySessionMetadata(archived, titles) {
      if (Array.isArray(archived)) { archivedSessionSet = new Set(archived); archivedSessionsKnown = true; }
      if (titles && typeof titles === 'object' && !Array.isArray(titles)) { hostSessionTitles = titles; sessionTitlesKnown = true; }
    }
    function isSessionArchived(sessionId) {
      const native = workspaceListSnapshot().archivedSessionIds;
      if (Array.isArray(native) && native.includes(sessionId)) return true;
      if (archivedSessionsKnown) return archivedSessionSet.has(sessionId);
      if (Array.isArray(native)) return false;
      return !!renderedSessionRow(sessionId)?.className?.includes('_archived');
    }
    function archiveMetadataKnown() {
      const native = workspaceListSnapshot();
      return native.phase === 'ready' && native.state !== 'loading' && Array.isArray(native.archivedSessionIds)
        || archivedSessionsKnown && hostFresh() && !hostError;
    }
    function liveSessionStatus(sessionId) { return statusSnapshot().get(sessionId); }
    function sessionState(row, sessionId, roots) {
      if (isSessionArchived(sessionId)) return undefined;
      const dot = pageStatusDot(row);
      const native = dot?.getAttribute('data-state');
      const status = liveSessionStatus(sessionId);
      const viewed = !document.hidden && (row?.getAttribute('aria-selected') === 'true'
        || sessionId === lastSeenMainId);
      const candidates = [];
      if (native === 'warning' || waitingSessionSet.has(sessionId) || VISIBLE_PENDING.has(status?.pendingInteraction?.kind)) candidates.push('waiting');
      if (!viewed && (native === 'error' || erroredSessionSet.has(sessionId) || clientErrored.has(sessionId))) candidates.push('error');
      if (native === 'ongoing' || runningSessionSet.has(sessionId) || status?.running) candidates.push('running');
      if (roots?.has(sessionId) && (!viewed || !['error','done'].includes(roots.get(sessionId)))) candidates.push(roots.get(sessionId));
      if (!viewed && localDoneCounts(sessionId)) candidates.push('done');
      return candidates.filter(stateAllowed).sort((a,b) => stateRank(a) - stateRank(b))[0];
    }
    /** A native dot and a fallback share exactly one resolution. Each switch
     * filters candidates BEFORE ranking, so disabling waiting never hides error. */
    function paintSessionMark(row, sessionId, roots) {
      const state = sessionState(row, sessionId, roots);
      const dot = pageStatusDot(row);
      let mark = row.querySelector('.dsh-order-session-mark');
      for (const stale of row.querySelectorAll('.dsh-order-native-mark')) {
        if (stale !== dot) clearNativeMark(stale);
      }
      if (dot) {
        const native = dot.getAttribute('data-state');
        // Preserve native states controlled by a disabled switch unless another
        // enabled state won. Retire old native completion only if its own switch
        // is enabled; this is not a global hiding rule.
        const retired = !state && settings.badgeRunningDone && native === 'done' && !localDoneCounts(sessionId);
        if (dot.tagName?.toLowerCase() === 'svg') {
          if (!state && !retired) { clearNativeMark(dot); mark?.remove(); return; }
          // Read CSS dimensions before hiding. A rotating SVG's bounding box can
          // expand mid-frame, so computed width/height outrank that measurement.
          const computed = getComputedStyle(dot);
          const bounds = dot.getBoundingClientRect();
          const previous = nativeSvgSizes.get(dot) || { width:10, height:10 };
          const dimension = (css, measured, fallback) => parseFloat(css) > 0 ? parseFloat(css) : measured > 0 ? measured : fallback;
          const size = { width:dimension(computed.width, bounds.width, previous.width), height:dimension(computed.height, bounds.height, previous.height) };
          nativeSvgSizes.set(dot, size);
          dot.classList.add('dsh-order-native-mark', 'dsh-order-native-svg-hidden');
          dot.removeAttribute('data-dsh-order-state');
          setOwnedAttribute(dot, 'aria-hidden', 'true');
          for (const label of dot.parentElement.querySelectorAll('[class*="visuallyHidden"]')) {
            setOwnedAttribute(label, 'aria-hidden', 'true'); nativeStatusLabels.add(label);
          }
          if (!mark) { mark = document.createElement('span'); mark.className = 'dsh-order-session-mark'; }
          mark.setAttribute('role','img');
          mark.setAttribute('data-dsh-order-native-svg','');
          mark.setAttribute('data-dsh-order-state', state || 'idle');
          mark.setAttribute('aria-label', text(state ? STATES[state].key : 'state.idle'));
          mark.title = mark.getAttribute('aria-label');
          mark.style.width = `${size.width}px`; mark.style.height = `${size.height}px`;
          if (mark.parentElement !== dot.parentElement || mark.nextElementSibling !== dot) dot.parentElement.insertBefore(mark, dot);
          return;
        }
        if (mark) mark.remove();
        if (state || retired) {
          dot.classList.add('dsh-order-native-mark');
          dot.setAttribute('data-dsh-order-state', state || 'idle');
          setOwnedAttribute(dot, 'aria-hidden', 'false');
          setOwnedAttribute(dot, 'role', 'img');
          for (const label of dot.parentElement.querySelectorAll('[class*="visuallyHidden"]')) {
            setOwnedAttribute(label, 'aria-hidden', 'true');
            nativeStatusLabels.add(label);
          }
          setOwnedAttribute(dot, 'aria-label', state ? text(STATES[state].key) : text('state.idle'));
          setOwnedAttribute(dot, 'title', state ? text(STATES[state].key) : text('state.idle'));
        } else clearNativeMark(dot);
        return;
      }
      if (!state) { if (mark) mark.remove(); return; }
      const cell = sessionMarkCell(row);
      if (!cell) { if (mark) mark.remove(); return; }
      if (!mark) { mark = document.createElement('span'); mark.className = 'dsh-order-session-mark'; mark.setAttribute('role','img'); }
      mark.removeAttribute('data-dsh-order-native-svg');
      mark.style.width = ''; mark.style.height = '';
      mark.setAttribute('data-dsh-order-state', state);
      mark.setAttribute('aria-label', text(STATES[state].key));
      mark.title = text(STATES[state].key);
      if (mark.parentElement !== cell) cell.appendChild(mark);
    }
    const ownedAttributes = new Map();
    const nativeStatusLabels = new Set();
    const nativeSvgSizes = new WeakMap();
    function setOwnedAttribute(node, name, value) {
      let attrs = ownedAttributes.get(node);
      if (!attrs) { attrs = new Map(); ownedAttributes.set(node, attrs); }
      const previous = attrs.get(name);
      if (!previous || node.getAttribute(name) !== previous.value) attrs.set(name, { original:node.getAttribute(name), value });
      else previous.value = value;
      if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    }
    function restoreOwnedAttributes(node) {
      const attrs = ownedAttributes.get(node);
      if (!attrs) return;
      for (const [name, entry] of attrs) if (node.getAttribute(name) === entry.value) {
        if (entry.original === null) node.removeAttribute(name); else node.setAttribute(name, entry.original);
      }
      ownedAttributes.delete(node);
    }
    function clearNativeMark(dot) {
      dot.classList.remove('dsh-order-native-mark', 'dsh-order-native-svg-hidden');
      nativeSvgSizes.delete(dot);
      dot.removeAttribute('data-dsh-order-state');
      restoreOwnedAttributes(dot);
      for (const label of nativeStatusLabels) if (!label.isConnected || dot.parentElement?.contains(label)) {
        restoreOwnedAttributes(label); nativeStatusLabels.delete(label);
      }
    }

    /**
     * Paint a workspace row's rolled-up star count. It leads the text, ahead of
     * the state badge and the name — the same side a session row puts its own
     * star on — so a favourite that climbs out of a collapsed workspace lands
     * where the eye already looks for stars instead of at the far right of the
     * card.
     *
     * It sits *before* the name, and after the state glyph when one is
     * showing: the glyph has taken the folder slot, so the star follows it
     * and then the name — the same order a session row uses (star, then status
     * dot, then title).
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
      const countText = mark.querySelector('.dsh-order-star-count-text');
      const shown = String(count);
      if (countText.textContent !== shown) countText.textContent = shown;
      const title = text('favorites.hiddenCount', { n:count });
      if (mark.title !== title) {
        mark.title = title;
        mark.setAttribute('aria-label', title);
        mark.setAttribute('role', 'img');
      }
      // Ahead of the name. The state glyph, when one is showing, stands in the
      // folder slot further left, so the star lands between the two.
      const anchor = titleContainer;
      // Only move the mark when needed so the observer stays idle.
      if (mark.parentElement !== row || mark.nextElementSibling !== anchor) {
        row.insertBefore(mark, anchor);
      }
    }

    /**
     * The sidebar's own header row: the one holding the search, filter and new
     * buttons. Returned only while it is on screen.
     *
     * The row carries a stable `data-sidebar-workspace-header` attribute, which
     * survives the build renaming the CSS Module classes. The class selector is
     * kept as a fallback for hosts that predate the attribute.
     */
    function sectionHeader() {
      return document.querySelector('[data-sidebar-workspace-header]')
        || document.querySelector('div[class*="_sectionHeader"]:has(> [class*="_headerActions"])')
        || void 0;
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
        button.addEventListener('keydown', event => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' || event.altKey || event.ctrlKey || event.metaKey) return;
          event.preventDefault(); event.stopPropagation();
          if (!starMenu) toggleStarMenu(button);
          const items = menuFocusableItems(starMenu);
          (event.key === 'ArrowUp' ? items.at(-1) : items[0])?.focus();
        });
      }
      const count = favoriteIds.length;
      const label = text(count ? 'favorites.count' : 'action.favorites', { n:count });
      if (button.title !== label) {
        button.title = label;
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-haspopup', 'menu');
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
    let starMenuAnchor = null;
    let favoritesError = '';
    function feedbackNear(anchor, key) {
      if (!anchor?.isConnected) return;
      let note = anchor.parentElement.querySelector('.dsh-order-action-feedback');
      if (!note) { note = document.createElement('span'); note.className = 'dsh-order-action-feedback'; note.setAttribute('role','status'); anchor.parentElement.appendChild(note); }
      note.textContent = key ? text(key) : '';
      if (!note.id) note.id = `dsh-focus-feedback-${viewId}-${++semanticId}`;
      if (key) setOwnedAttribute(anchor, 'aria-describedby', note.id);
      else { note.remove(); restoreOwnedAttributes(anchor); }
    }
    function menuFeedback(item, message, removableId) {
      const menu = item.closest('.dsh-order-star-menu');
      if (!menu) return;
      let note = menu.querySelector('.dsh-order-star-menu-feedback');
      if (!note) { note = document.createElement('div'); note.className = 'dsh-order-star-menu-feedback'; note.setAttribute('role','status'); menu.appendChild(note); }
      note.textContent = message;
      if (!note.id) note.id = `dsh-focus-menu-feedback-${viewId}`;
      item.setAttribute('aria-describedby', note.id);
      menu.querySelector('.dsh-order-star-menu-action')?.remove();
      if (removableId) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'dsh-order-star-menu-action';
        remove.setAttribute('role','menuitem'); remove.textContent = text('action.removeFavorite');
        remove.addEventListener('click', async event => {
          event.preventDefault(); event.stopPropagation();
          const saved = await toggleFavorite(removableId);
          if (!saved && starMenu) menuFeedback(starMenu.querySelector('[role="menuitem"]') || starMenu, text('error.favoriteSave'));
        });
        menu.appendChild(remove);
      }
    }

    function menuFocusableItems(menu) {
      return Array.from(menu?.querySelectorAll('[role="menuitem"]') || []).filter(treeFocusable);
    }
    function paintArchivedMenuFooter(menu) {
      const archivedItems = Array.from(menu.querySelectorAll('[data-session-id]')).filter(item => isSessionArchived(item.getAttribute('data-session-id')));
      let footer = menu.querySelector('.dsh-order-star-menu-archive');
      if (!archivedItems.length) {
        if (footer) {
          for (const item of menu.querySelectorAll('[aria-describedby]')) if (item.getAttribute('aria-describedby') === `dsh-focus-archive-note-${viewId}`) item.removeAttribute('aria-describedby');
          footer.remove();
        }
        return;
      }
      if (!footer) {
        footer = document.createElement('div'); footer.className = 'dsh-order-star-menu-archive';
        const note = document.createElement('div'); note.className = 'dsh-order-star-menu-archive-note';
        note.id = `dsh-focus-archive-note-${viewId}`; note.setAttribute('role','status'); footer.appendChild(note);
        const action = document.createElement('button'); action.type = 'button'; action.className = 'dsh-order-star-menu-archive-action';
        action.setAttribute('role','menuitem'); action.setAttribute('aria-describedby',note.id);
        action.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          // Match the native viewing-store action. This only reveals archived
          // rows so the user can choose native Unarchive; it never opens one.
          if (typeof workspaceView?.store?.update !== 'function') { note.textContent = text('error.archiveViewUnavailable'); return; }
          try {
            workspaceView.store.update(draft => { draft.archivedFilter = 'only'; });
            if (workspaceView.getSnapshot().archivedFilter !== 'only') throw new Error('Archive filter was not applied');
            closeStarMenu(true);
          } catch { note.textContent = text('error.archiveViewUnavailable'); }
        });
        footer.appendChild(action); menu.appendChild(footer);
      }
      const note = footer.querySelector('.dsh-order-star-menu-archive-note');
      const action = footer.querySelector('.dsh-order-star-menu-archive-action');
      const available = typeof workspaceView?.store?.update === 'function';
      const message = nativeText('toast.archivedNotOpenable') + (available ? '' : ` ${text('error.archiveViewUnavailable')}`);
      if (note.textContent !== message) note.textContent = message;
      const actionLabel = text('action.viewArchived');
      if (action.textContent !== actionLabel) action.textContent = actionLabel;
      action.disabled = !available; action.setAttribute('aria-disabled', available ? 'false' : 'true');
      for (const item of archivedItems) item.setAttribute('aria-describedby', note.id);
    }
    function toggleStarMenu(anchor) {
      if (starMenu) {
        closeStarMenu();
        return;
      }
      const menu = document.createElement('div');
      menu.className = 'dsh-order-star-menu';
      menu.id = `dsh-focus-menu-${viewId}`;
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', text('action.favorites'));
      // macOS Desktop only excludes controls inside a declared window region.
      // This menu lives on body, so it declares the exclusion itself; the CSS
      // companion rule is the `-webkit-app-region: no-drag` on this class.
      menu.setAttribute('data-window-drag-exclude', '');
      menu.tabIndex = -1;
      starMenuAnchor = anchor;
      anchor.setAttribute('aria-controls', menu.id);
      anchor.setAttribute('aria-expanded', 'true');
      if (!favoriteIds.length) {
        const empty = document.createElement('div');
        empty.className = 'dsh-order-star-menu-empty';
        empty.textContent = text('favorites.empty');
        menu.appendChild(empty);
      } else {
        for (const sessionId of favoriteIds) {
          menu.appendChild(starMenuItem(sessionId));
        }
      }
      paintArchivedMenuFooter(menu);
      document.body.appendChild(menu);
      placeStarMenu(menu, anchor);
      starMenu = menu;
      (menuFocusableItems(menu)[0] || menu).focus({ preventScroll:true });
      // Keys can arrive before a zero-delay timer. Capture at window immediately
      // so document-level native shortcuts cannot swallow this popup's Escape.
      window.addEventListener('keydown', onKeydownForStarMenu, true);
      if (favoritesError) menuFeedback(menu.querySelector('[role="menuitem"]') || menu, text(favoritesError));
      // A click anywhere else, or Escape, closes it.
      setTimeout(() => {
        if (disposed || starMenu !== menu) return;
        document.addEventListener('click', onDocumentClickForStarMenu, true);
      }, 0);
    }

    function onDocumentClickForStarMenu(event) {
      if (starMenu && !starMenu.contains(event.target) && !event.target.closest('.dsh-order-star-filter')) closeStarMenu();
    }

    function onKeydownForStarMenu(event) {
      if (!starMenu) return;
      if (event.key === 'Escape') {
        const ownsFocus = starMenu.contains(document.activeElement) || starMenuAnchor?.contains(document.activeElement);
        const visible = node => !!node.getClientRects().length && !node.closest('[hidden], [inert], [aria-hidden="true"]')
          && !['hidden','collapse'].includes(getComputedStyle(node).visibility);
        const modal = Array.from(document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')).some(visible);
        if (!ownsFocus || !visible(starMenu) || modal || event.defaultPrevented) {
          closeStarMenu(false); return; // give native dialogs/editors their Escape
        }
        event.preventDefault(); event.stopImmediatePropagation(); closeStarMenu(true); return;
      }
      if (!starMenu.contains(event.target)) return;
      if (event.key === 'Tab') {
        // Return to the trigger, then let the browser perform ordinary Tab out.
        closeStarMenu(true); return;
      }
      const items = menuFocusableItems(starMenu);
      const index = items.indexOf(document.activeElement);
      let next;
      if (event.key === 'ArrowDown') next = items[(index + 1) % items.length];
      else if (event.key === 'ArrowUp') next = items[(index + items.length - 1) % items.length];
      else if (event.key === 'Home') next = items[0];
      else if (event.key === 'End') next = items.at(-1);
      else return;
      if (next) { event.preventDefault(); event.stopPropagation(); next.focus(); }
    }

    function closeStarMenu(restoreFocus = false) {
      if (starMenu) {
        starMenu.remove();
        starMenu = null;
      }
      document.removeEventListener('click', onDocumentClickForStarMenu, true);
      window.removeEventListener('keydown', onKeydownForStarMenu, true);
      if (starMenuAnchor) {
        starMenuAnchor.setAttribute('aria-expanded','false');
        starMenuAnchor.removeAttribute('aria-controls');
        if (restoreFocus && starMenuAnchor.isConnected) starMenuAnchor.focus({ preventScroll:true });
      }
      starMenuAnchor = null;
    }

    /** Anchor the menu under its button, kept inside the viewport. */
    function placeStarMenu(menu, anchor) {
      const box = anchor.getBoundingClientRect();
      menu.style.position = 'fixed';
      const bounds = menu.getBoundingClientRect();
      const width = Math.min(bounds.width || 320, window.innerWidth - 16);
      const height = Math.min(bounds.height, window.innerHeight / 2);
      menu.style.top = `${Math.round(Math.max(8, Math.min(box.bottom + 4, window.innerHeight - height - 8)))}px`;
      menu.style.left = `${Math.round(Math.max(8, Math.min(box.left, window.innerWidth - width - 8)))}px`;
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
      title.textContent = sessionTitleOf(sessionId);
      const where = document.createElement('span');
      where.className = 'dsh-order-star-menu-where';
      where.textContent = workspaceTitleOfSession(sessionId);
      item.appendChild(title);
      item.appendChild(where);
      item.title = `${title.textContent}${where.textContent ? ` · ${where.textContent}` : ''}`;
      if (isSessionArchived(sessionId)) { item.disabled = true; item.setAttribute('aria-disabled','true'); item.title += ` · ${nativeText('toast.archivedNotOpenable')}`; }
      item.setAttribute('data-session-id', sessionId);
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        event.preventDefault();
        void openSessionById(sessionId, item);
      });
      return item;
    }

    /** A session's display title, read from the Host's own list. */
    function sessionTitleOf(sessionId) {
      const row = (sessionListSnapshot().byId || {})[sessionId];
      if (row?.blank) return nativeText('session.new');
      const title = row ? row.title : hostSessionTitles[sessionId];
      return typeof title === 'string' && title.trim() ? title : nativeText('session.untitled');
    }

    /** The workspace a session lives in, for orientation in the menu. */
    function workspaceTitleOfSession(sessionId) {
      if (!live) return '';
      const rows = workspaceListSnapshot().items || [];
      const owner = rows.find(ws => Array.isArray(ws.sessionIds) && ws.sessionIds.includes(sessionId));
      return owner ? (owner.title || owner.path || '') : '';
    }

    /**
     * Open a starred session through the page's own workspace service, which
     * expands whatever group holds it — the same path the sidebar's search uses.
     */
    async function openSessionById(sessionId, item) {
      // The public openSession API is not the sidebar's guardedOpen. Apply the
      // same archive guard BEFORE invoking it; never silently unarchive a star.
      if (isSessionArchived(sessionId)) { menuFeedback(item, nativeText('toast.archivedNotOpenable')); return false; }
      const list = sessionListSnapshot();
      const nativeKnown = list.phase === 'ready' && list.state !== 'loading';
      // Session summaries and archive membership have independent service
      // lifetimes. A ready session catalog does not certify an absent archive
      // service, and title metadata is not a complete existence catalog.
      if (!archiveMetadataKnown()) { menuFeedback(item, text('error.sessionUnknown')); return false; }
      const missing = nativeKnown && !Object.hasOwn(list.byId || {}, sessionId)
        && (!sessionTitlesKnown || !Object.hasOwn(hostSessionTitles, sessionId));
      if (missing) { menuFeedback(item, text('error.sessionMissing'), sessionId); return false; }
      const service = live.uiWorkspace;
      if (typeof service?.openSession !== 'function') { menuFeedback(item, text('error.openUnavailable')); return false; }
      try {
        item?.setAttribute('aria-busy','true');
        // Cordis consumers receive a ctx-shadowed ServiceProxy. Navigation owns
        // the native mainReference and lifetime, not this plugin's child scope.
        const owner = service[Symbol.for('cordis.original')] || service;
        await Reflect.apply(owner.openSession, owner, [sessionId]);
        if (!disposed) closeStarMenu(true);
        return true;
      } catch (err) {
        if (!disposed) menuFeedback(item, text('error.openFailed'));
        return false;
      } finally { item?.removeAttribute('aria-busy'); }
    }

    const treeSemanticNodes = new Set();
    let semanticId = 0;
    function ownedId(node) {
      if (!node.id) setOwnedAttribute(node, 'id', `dsh-focus-${viewId}-${++semanticId}`);
      treeSemanticNodes.add(node);
      return node.id;
    }
    function groupChildren(section) {
      const children = Array.from(section.children);
      return [...children.filter(node => node.getAttribute('role') !== 'group'),
        ...children.filter(node => node.getAttribute('role') === 'group')];
    }
    function treeFocusable(node) {
      if (!node || node.disabled || node.tabIndex < 0 || node.closest('[inert], [hidden], [aria-hidden="true"]') || !node.getClientRects().length) return false;
      const visibility = getComputedStyle(node).visibility;
      return visibility !== 'hidden' && visibility !== 'collapse';
    }
    function visualTreeRows(tree) {
      const walk = node => {
        if (node.matches('[data-row-key]')) return [node];
        const children = node.matches('div[class*="groupSection"]') ? groupChildren(node) : Array.from(node.children);
        return children.flatMap(walk);
      };
      return walk(tree).filter(treeFocusable);
    }
    function sidebarTreeOf(node) {
      const tree = node?.closest?.('[role="tree"]');
      return tree?.querySelector('div[class*="groupSection"]') ? tree : null;
    }
    function restoreTreeSemantics() {
      for (const node of treeSemanticNodes) restoreOwnedAttributes(node);
      treeSemanticNodes.clear();
    }
    function syncTreeOrderMode() {
      const treeMode = usesWorkspaceTree();
      const active = treeMode && settings.treeSessionsFirst !== false;
      document.body.classList.toggle('dsh-order-tree-trays', treeMode);
      document.body.classList.toggle('dsh-order-sessions-first', active);
      for (const row of document.querySelectorAll('[data-dsh-order-tray-row]')) {
        if (!treeMode || !row.closest('div[class*="groupSection"]')) row.removeAttribute('data-dsh-order-tray-row');
      }
      if (treeMode) for (const section of document.querySelectorAll('div[class*="groupSection"]')) {
        for (const row of section.querySelectorAll('[data-row-key]')) {
          if (row.closest('div[class*="groupSection"]') === section) row.setAttribute('data-dsh-order-tray-row', '');
        }
      }
      if (!active) { restoreTreeSemantics(); return; }
      for (const node of treeSemanticNodes) if (!node.isConnected) { restoreOwnedAttributes(node); treeSemanticNodes.delete(node); }
      // Own every direct child, including HoverCard anchors, exactly once. This
      // makes the accessibility tree follow flex order without reparenting React
      // nodes or depending on how many spans the native anchor contains.
      for (const section of document.querySelectorAll('div[class*="groupSection"]')) {
        if (!sidebarTreeOf(section)) continue;
        treeSemanticNodes.add(section);
        setOwnedAttribute(section, 'role', 'group');
        setOwnedAttribute(section, 'aria-owns', groupChildren(section).map(ownedId).join(' '));
      }
    }
    function onTreeKeydown(event) {
      if (!document.body.classList.contains('dsh-order-sessions-first') || event.defaultPrevented
        || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const target = event.target instanceof Element ? event.target : null;
      const tree = sidebarTreeOf(target);
      const row = target?.closest('[data-row-key]');
      if (!tree || !row || target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const rows = visualTreeRows(tree);
      const index = rows.indexOf(row);
      if (index < 0) return;
      let next;
      if (event.key === 'Tab') {
        // Tab retains each row's native action buttons. Only bridge reordered
        // row boundaries; inside a row the browser handles its controls normally.
        const controls = Array.from(row.querySelectorAll('button, a[href], [tabindex]'))
          .filter(treeFocusable);
        if (!event.shiftKey && (target === row && controls.length || target !== row && target !== controls.at(-1))) return;
        if (event.shiftKey && target !== row) return;
        const adjacent = rows[index + (event.shiftKey ? -1 : 1)];
        if (!adjacent) {
          // The last *visual* row need not be last in React's DOM. Leave the
          // entire tree instead of wrapping back into its later DOM siblings.
          const all = Array.from(document.querySelectorAll('button, a[href], input, textarea, select, [tabindex]'))
            .filter(treeFocusable);
          const inside = all.map((node,i) => tree.contains(node) ? i : -1).filter(i => i >= 0);
          const edge = event.shiftKey ? inside[0] : inside.at(-1);
          next = all[edge + (event.shiftKey ? -1 : 1)];
          if (!next) return; // no page target: retain browser-chrome Tab behavior
        } else next = event.shiftKey ? Array.from(adjacent.querySelectorAll('button, a[href], input, textarea, select, [tabindex]'))
          .filter(treeFocusable).at(-1) || adjacent : adjacent;
      } else {
        // Native row buttons and editors keep their own Arrow/Home/End behavior.
        if (target !== row || event.shiftKey) return;
        if (event.key === 'ArrowDown') next = rows[Math.min(rows.length - 1, index + 1)];
        else if (event.key === 'ArrowUp') next = rows[Math.max(0, index - 1)];
        else if (event.key === 'Home') next = rows[0];
        else if (event.key === 'End') next = rows.at(-1);
        else if (event.key === 'ArrowRight' && row.matches('[data-row-key^="workspace:"]')) {
          if (row.getAttribute('aria-expanded') === 'false') { event.preventDefault(); event.stopPropagation(); row.click(); return; }
          next = rows[index + 1];
        } else if (event.key === 'ArrowLeft') {
          if (row.matches('[data-row-key^="workspace:"]') && row.getAttribute('aria-expanded') === 'true') {
            event.preventDefault(); event.stopPropagation(); row.click(); return;
          }
          const section = row.closest('div[class*="groupSection"]');
          const owner = row.matches('[data-row-key^="workspace:"]') ? section?.parentElement?.closest('div[class*="groupSection"]') : section;
          next = owner && Array.from(owner.querySelectorAll('[data-row-key^="workspace:"]')).find(node => node.closest('div[class*="groupSection"]') === owner);
        } else return;
      }
      if (next) {
        next.focus();
        if (document.activeElement === next) { event.preventDefault(); event.stopPropagation(); }
      }
    }

    function renderDshEnhancements() {
      if (disposed) return;
      for (const node of Array.from(ownedAttributes.keys())) if (!node.isConnected) {
        if (node.classList.contains('dsh-order-native-mark')) clearNativeMark(node);
        else restoreOwnedAttributes(node);
        treeSemanticNodes.delete(node); nativeStatusLabels.delete(node);
      }
      syncTreeOrderMode();
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
          pinBtn.title = text(hostProtocol < 2 ? 'error.hostProtocol' : isPinned ? 'action.unpin' : 'action.pin');
          pinBtn.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
          pinBtn.disabled = hostProtocol < 2 || pendingPins.has(workspaceId);
          pinBtn.setAttribute('aria-label', pinBtn.title);
        } else {
          // Switched off: drop the button, keeping the pin list untouched.
          const stale = row.querySelector('.dsh-order-pin-btn');
          if (stale) stale.remove();
        }

        // 2. Put the state glyph in the row's folder slot.
        //
        //    The glyph takes the place of the folder icon rather than standing
        //    next to it, so the row keeps the width it had while idle and the
        //    name stays exactly where it was. A workspace that has something to
        //    say therefore costs the list nothing.
        //
        //    The glyph goes in *before* the folder: the stylesheet hides the
        //    folder on rows that carry a state, and the folder's own slot
        //    would otherwise be left empty.
        const titleContainer = row.querySelector('span[class*="projectText"]');
        if (titleContainer) {
          const folderSlot = row.querySelector(':scope > span[class*="folder"]');
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
              badge.title = text(meta.key);
              badge.setAttribute('role', 'img');
              badge.setAttribute('aria-label', text(meta.key));
            }
            badge.title = text(meta.key);
            badge.setAttribute('aria-label', badge.title);
            // Only move the badge when needed so the observer stays idle.
            const anchor = folderSlot || titleContainer;
            if (badge.parentElement !== row || badge.nextElementSibling !== anchor) {
              row.insertBefore(badge, anchor);
            }
            row.classList.add('dsh-order-has-state');
          } else {
            if (badge) {
              badge.remove();
            }
            row.classList.remove('dsh-order-has-state');
          }

          // 3. Roll this workspace's hidden favourites onto its own card.
          paintWorkspaceStar(row, hiddenStarCount(workspaceId));
        }
      }

      // 4. Keep an open favourites menu in step with the list.
      if (starMenu) {
        const anchor = document.querySelector('.dsh-order-star-filter');
        if (!anchor) closeStarMenu();
        else {
          placeStarMenu(starMenu, anchor);
          const ownedFocus = starMenu.contains(document.activeElement);
          for (const item of starMenu.querySelectorAll('[data-session-id]')) {
            const id = item.getAttribute('data-session-id');
            const title = item.querySelector('.dsh-order-star-menu-title');
            const name = sessionTitleOf(id);
            if (title.textContent !== name) title.textContent = name;
            const archived = isSessionArchived(id);
            item.disabled = archived;
            if (archived) item.setAttribute('aria-disabled','true'); else item.removeAttribute('aria-disabled');
          }
          paintArchivedMenuFooter(starMenu);
          if (ownedFocus && (!starMenu.contains(document.activeElement) || document.activeElement.disabled)) (menuFocusableItems(starMenu)[0] || starMenu).focus({ preventScroll:true });
        }
      }

      // 5. Every session on screen carries its own star, and a failed session
      //    wears the failure instead of the plain "finished" the page paints.
      //    The unread ledger reconciles each row's dot across clients; whatever
      //    the page leaves unpainted is drawn by the mark that follows.
      for (const sessionRow of document.querySelectorAll('div[data-row-key^="session:"]')) {
        const key = sessionRow.getAttribute('data-row-key') || '';
        const sessionId = key.slice('session:'.length);
        if (!sessionId) continue;
        paintSessionStar(sessionRow, sessionId);
        paintSessionMark(sessionRow, sessionId, liveStates?.roots);
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
     * The card's own switch: a real `role="switch"` button, so assistive
     * technology and keyboard users get the same control the shipped cards
     * offer, without importing the page's internal primitives module. Markup
     * and the `aria-checked` contract follow the host's own switch.
     * @param props - `checked`, `label`, and the change callback.
     * @returns the switch button.
     */
    function ToggleSwitch({ checked, label, onChange }) {
      return jsxRuntime.jsx('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked === true,
        'aria-label': label,
        title: label,
        className: 'dsh-order-panel-switch',
        onClick: () => { onChange(checked !== true); },
        children: jsxRuntime.jsx('span', { className: 'dsh-order-panel-switch-thumb' })
      });
    }

    /** The small state pill the disclosure header carries. */
    function TagPill({ tone, children }) {
      return jsxRuntime.jsx('span', { className: 'dsh-order-panel-group-tag', 'data-tone': tone, children });
    }

    /** A chevron that points down while closed and up while open. */
    function Chevron({ open }) {
      return jsxRuntime.jsx('span', { className: 'dsh-order-panel-chevron', 'data-open': open === true, 'aria-hidden': 'true' });
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
        jsxRuntime.jsx(ToggleSwitch, {
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
      const snapshot = useWorkspaceOrderSettings((value) => value);
      const current = snapshot.settings || {};
      if (view === 'summary') return t('summary', { n: countEnabled(current), total: SETTING_ROWS.length });
      const onCount = AWARENESS_ROWS.filter(row => current[row.key] === true).length;
      const groupState = onCount === AWARENESS_ROWS.length
        ? t('group.allOn')
        : onCount === 0
          ? t('group.allOff')
          : t('group.partOn', { n: onCount, total: AWARENESS_ROWS.length });
      // Row click and Enter/Space both toggle, like the shipped disclosure row.
      const onHeaderKeyDown = (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        setOpen((value) => !value);
      };
      return jsxRuntime.jsxs('div', { className: 'dsh-order-panel', children: [
        ...ORDERING_ROWS.map((row) => jsxRuntime.jsx(SettingRow, {
          row,
          value: current[row.key],
          label: t(row.labelKey),
          t,
          toggleSetting
        }, row.key)),
        jsxRuntime.jsxs('div', { className: 'dsh-order-panel-group', 'data-open': open === true || void 0, children: [
          jsxRuntime.jsxs('div', {
            className: 'dsh-order-panel-group-header',
            role: 'button',
            tabindex: '0',
            'aria-expanded': open === true,
            onClick: () => { setOpen((value) => !value); },
            onKeyDown: onHeaderKeyDown,
            children: [
              jsxRuntime.jsx(Chevron, { open }),
              jsxRuntime.jsx('span', { className: 'dsh-order-panel-group-title', children: t('group.title') }),
              jsxRuntime.jsx(TagPill, {
                tone: onCount === AWARENESS_ROWS.length ? 'success' : onCount === 0 ? 'quiet' : 'warning',
                children: groupState
              })
            ]
          }),
          open ? jsxRuntime.jsx('div', { className: 'dsh-order-panel-group-body', children:
            AWARENESS_ROWS.map((row) => jsxRuntime.jsx(SettingRow, {
              row,
              value: current[row.key],
              label: t(row.labelKey),
              t,
              toggleSetting
            }, row.key))
          }) : null
        ] }),
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
        'state.waiting': '等你回答、批准或确认计划',
        'state.error': '会话异常中断，打开后清除提醒',
        'state.running': '正在工作',
        'state.done': '已完成，有新回复未读',
        'state.idle': '空闲',
        'native.new': '新会话', 'native.untitled': '未命名',
        'native.archivedGuard': '此会话已归档，请先取消归档再查看。',
        'native.unarchive': '取消归档',
        'action.pin': '固定置顶', 'action.unpin': '取消置顶',
        'action.favorite': '收藏此会话', 'action.unfavorite': '取消收藏',
        'action.favorites': '收藏的会话', 'action.removeFavorite': '移除此收藏',
        'action.viewArchived': '查看已归档会话',
        'error.archiveViewUnavailable': '归档列表入口暂不可用，请等待侧栏恢复后重试。',
        'favorites.count': '收藏的会话（{n}）',
        'favorites.hiddenCount': '有 {n} 个已收藏但已折叠的会话',
        'favorites.empty': '还没有收藏的会话。使用会话左侧的星标即可收藏。',
        'error.favoriteSave': '收藏暂未保存，已保留本次选择，恢复连接后重试。',
        'error.pinSave': '置顶保存失败，已恢复原状态，请重试。',
        'error.sessionMissing': '此会话已不存在，可以移除此收藏。',
        'error.sessionUnknown': '暂时无法确认会话是否已归档，请恢复连接后重试。',
        'error.openUnavailable': '官方会话入口暂不可用，请稍后重试。',
        'error.openFailed': '无法打开此会话，请稍后重试。',
        'error.hostProtocol': '主机修复尚未加载，请重启 Harness 后使用置顶。',
        noteHostDegraded: '部分会话状态暂不可达，保留上次状态并自动重试。',
        title: '会话专注增强',
        summary: '置顶与状态徽标 · 已开 {n}/{total} 项',
        'group.title': '工作区内会话状态感知',
        'group.allOn': '全部开启',
        'group.allOff': '已关闭',
        'group.partOn': '部分开启 {n}/{total}',
        'row.pinTop': '工作区置顶',
        'row.autoFront': '工作区自动排序',
        'row.autoCollapse': '无关工作区自动折叠',
        'row.treeSessionsFirst': '树形下直属会话排在上方',
        'row.badgeWaiting': '工作区：橙色下排常亮、上排闪烁',
        'row.badgeError': '工作区：红色砖墙崩塌',
        'row.badgeRunningDone': '工作区：绿色小蛇绕圈与绿色实心',
        'hint.pinTop': '悬停显示图钉，钉住的工作区永远排最前；关闭后已钉名单仍保留。',
        'hint.autoFront': '有会话开始干活时，该工作区自动移到列表前面。',
        'hint.autoCollapse': '点开一个工作区时，其他展开着的工作区自动收起；它的上级和子级不受影响。',
        'hint.treeSessionsFirst': '按树结构分组时，工作区自身的会话优先排在子工作区前面，避免被误认成最底下一个子工作区内的会话。',
        'row.highlightCurrent': '高亮当前工作区',
        'hint.highlightCurrent': '把正在看的那个会话所属的工作区，连同它展开的会话一起框一圈边框，一眼定位。',
        'hint.badgeWaiting': '里面有会话等你回答、等批准或等计划确认时显示：文件夹里下面一排橙色方块稳稳亮着，上面一排一明一暗地闪，表示这件事停在这里等你。图形直接顶替工作区前面的文件夹图标，名称位置不变。',
        'hint.badgeError': '里面有会话异常中断时显示：文件夹里排成两排的红色方块像一堵墙，整排一起散落掉出、一块不剩，随后重新砌好、循环往复；会话行自己的小圆圈也一起变红，点开该会话后都消失。',
        'hint.badgeRunningDone': '干活时像贪吃蛇在文件夹里绕圈：从左下角进场往右跑，沿右边上去、从上面往回、再从左边下来，一圈接一圈不停；跑完且你还没看时，文件夹里八个小方块全部实心亮着、完全不动。在你眼前跑完的不算没看。完成与已读以主机的共享记录为准：另一端点开过，这一端的绿色和会话行的绿点也会消失；本端没看到的完成，会话行圆点也会补上绿色。',
        note: '开关即时生效，无需刷新页面。',
        notePendingHost: '设置尚未与主机确认，恢复连接后会自动重试。',
        noteHostAuth: '主机拒绝了状态请求，请检查 DSH 登录或访问地址；恢复后会自动重试。',
        noteHostUnavailable: '暂时无法读取主机状态，正在自动重试。'
      },
      en: {
        'state.waiting': 'Waiting for your answer, approval, or plan review',
        'state.error': 'Session failed; open it to clear the reminder',
        'state.running': 'Working', 'state.done': 'Finished with an unread reply', 'state.idle': 'Idle',
        'native.new': 'New Session', 'native.untitled': 'Untitled',
        'native.archivedGuard': 'This session is archived. Unarchive it before opening.',
        'native.unarchive': 'Unarchive',
        'action.pin': 'Pin to top', 'action.unpin': 'Unpin',
        'action.favorite': 'Favorite this session', 'action.unfavorite': 'Remove favorite',
        'action.favorites': 'Favorite sessions', 'action.removeFavorite': 'Remove this favorite',
        'action.viewArchived': 'View Archived Sessions',
        'error.archiveViewUnavailable': 'The archive-list entry is unavailable. Wait for the sidebar to reconnect and try again.',
        'favorites.count': 'Favorite sessions ({n})',
        'favorites.hiddenCount': '{n} favorite sessions are collapsed',
        'favorites.empty': 'No favorite sessions yet. Use the star beside a session to favorite it.',
        'error.favoriteSave': 'Favorite not saved yet. Your choice is kept and will retry after reconnecting.',
        'error.pinSave': 'Pin could not be saved. The previous state was restored; try again.',
        'error.sessionMissing': 'This session no longer exists. You can remove this favorite.',
        'error.sessionUnknown': 'Cannot confirm whether this session is archived. Reconnect and try again.',
        'error.openUnavailable': 'The native session entry is unavailable. Try again shortly.',
        'error.openFailed': 'Cannot open this session. Try again shortly.',
        'error.hostProtocol': 'Restart Harness to load the Host fix before pinning.',
        noteHostDegraded: 'Some session states are unavailable. Keeping the last known state and retrying.',
        title: 'Session Focus Enhancer',
        summary: 'Pinning and status badges · {n}/{total} features on',
        'group.title': 'Session awareness inside workspaces',
        'group.allOn': 'All on',
        'group.allOff': 'All off',
        'group.partOn': 'Partly on {n}/{total}',
        'row.pinTop': 'Pin workspace to top',
        'row.autoFront': 'Auto-sort workspaces',
        'row.autoCollapse': 'Auto-collapse unrelated workspaces',
        'row.treeSessionsFirst': 'Own sessions first in tree',
        'row.badgeWaiting': 'Workspace: steady amber lower row, blinking upper row',
        'row.badgeError': 'Workspace: falling red brick wall',
        'row.badgeRunningDone': 'Workspace: green snake on a lap, and solid green',
        'hint.pinTop': 'Pinned workspaces always lead the list; turning this off keeps your pin list.',
        'hint.autoFront': 'A workspace with a running session moves to the front automatically.',
        'hint.autoCollapse': 'Opening a workspace collapses the other expanded ones; its parent and children stay put.',
        'hint.treeSessionsFirst': 'In tree view, show the workspace\'s own sessions above its nested sub-workspaces to avoid visual confusion.',
        'row.highlightCurrent': 'Highlight the current workspace',
        'hint.highlightCurrent': 'Outlines the workspace of the session you are looking at, together with its expanded sessions, so you can find it at a glance.',
        'hint.badgeWaiting': 'Shows while a session waits for your answer, approval, or plan review: the lower amber row stays lit and the upper row blinks. The session uses a question mark. It replaces the folder icon without moving the name.',
        'hint.badgeError': 'Shows after a session fails: the red brick wall falls out of the folder and rebuilds. The session uses a red exclamation mark. Both reminders clear when you open it.',
        'hint.badgeRunningDone': 'While working, a green snake runs laps inside the folder: in at the bottom-left, right along the bottom, up the right-hand side, back along the top and down the left, round and round. Once finished and unread the folder goes solid green and still. A turn you watched finish does not count as unread. The shared Host ledger decides finished and read: opening a session on one client clears the green on the others, and a completion this page never watched still greens that session\'s dot.',
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
        const section = row.closest('div[class*="groupSection"]');
        const raw = getComputedStyle(section || row).getPropertyValue('--dsh-workspace-indent');
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

    /**
     * The pocket the red bricks fall out of.
     *
     * One shared clip path, in the drawing's own 16-unit coordinates, mounted
     * once and pointed at by every error badge. A brick that has fallen past the
     * folder's bottom edge is clipped away by it — which is what lets the bricks
     * fall out of sight instead of spilling over the row underneath, and what
     * keeps the pocket empty once the wall is down.
     */
    function mountBadgeClip() {
      if (document.getElementById(BADGE_CLIP_ID)) return;
      const holder = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      holder.setAttribute('data-dsh-order-clip','');
      holder.setAttribute('width', '0');
      holder.setAttribute('height', '0');
      holder.setAttribute('aria-hidden', 'true');
      holder.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
      holder.innerHTML = `<defs><clipPath id="${BADGE_CLIP_ID}" clipPathUnits="userSpaceOnUse">`
        + `<path d="${FOLDER_POCKET}"></path>`
        + '</clipPath></defs>';
      document.body.appendChild(holder);
    }

    function apply(ctx) {
      rootCtx = ctx;
      document.querySelectorAll('.dsh-order-workspace-header').forEach(el => el.classList.remove('dsh-order-workspace-header'));
      // Older plugin versions did not remove their buttons when reloaded.
      document.querySelectorAll('.dsh-order-pin-btn, .dsh-order-state, .dsh-order-busy-badge, .dsh-order-star, .dsh-order-star-count, .dsh-order-star-filter, .dsh-order-session-mark').forEach(el => el.remove());
      document.querySelectorAll('.dsh-order-star-menu').forEach(el => el.remove());
      // The shared pocket clip is re-mounted by apply(); drop a stale copy first.
      document.querySelectorAll('[data-dsh-order-clip]').forEach(el => el.remove());
      document.querySelectorAll('#' + BADGE_CLIP_ID).forEach(el => (el.closest('svg') || el).remove());
      // These marks live on the page's own containers: unmark, never remove.
      document.querySelectorAll('.dsh-order-current-group').forEach(el => el.classList.remove('dsh-order-current-group'));
      document.querySelectorAll('.dsh-order-open-group').forEach(el => el.classList.remove('dsh-order-open-group'));
      document.querySelectorAll('.dsh-order-has-state').forEach(el => el.classList.remove('dsh-order-has-state'));
      document.body.classList.remove('dsh-order-sessions-first');
      // 1. Inject stylesheets: badges first, then the control panel's own rows.
      const styleEl = document.createElement('style');
      styleEl.textContent = CSS + PANEL_CSS;
      document.head.appendChild(styleEl);
      mountBadgeClip();

      // 1b. Offer the feature switches on the Plugins detail page.
      mountControlPanel(ctx);
      bindWorkspaceView(ctx);

      // 2. Prefer the Host's live session-status store; poll the Host service for
      //    pins, the error ledger, and as the whole-status fallback.
      attachLiveStatus(ctx);
      updateStatus();
      const timer = setInterval(() => { if (!document.hidden) void updateStatus(); }, 2000);
      const heartbeat = setInterval(() => {
        if (!disposed) reportSeenSession(computeLiveStates().mainId || currentSessionIdFromDom(), false);
      }, SEEN_HEARTBEAT_MS);
      const onVisibility = () => {
        reportSeenSession(computeLiveStates().mainId || currentSessionIdFromDom(), false, true);
        if (!document.hidden) { void updateStatus(); refresh(); }
      };
      document.addEventListener('visibilitychange', onVisibility);
      window.addEventListener('pagehide', releaseSeenLease);
      window.addEventListener('beforeunload', releaseSeenLease);
      document.addEventListener('keydown', onTreeKeydown, true);

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
        attributeFilter: ['aria-expanded', 'aria-selected', 'data-row-key', 'data-state']
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
          clearInterval(heartbeat);
          // Host routes may already have disappeared. Do not initiate a late
          // keepalive POST; abandoned views expire, and client HMR reuses the id.
          abortSeenRequests();
          document.removeEventListener('visibilitychange', onVisibility);
          window.removeEventListener('pagehide', releaseSeenLease);
          window.removeEventListener('beforeunload', releaseSeenLease);
          document.removeEventListener('keydown', onTreeKeydown, true);
          observer.disconnect();
          restoreTreeSemantics();
          for (const node of Array.from(ownedAttributes.keys())) restoreOwnedAttributes(node);
          for (const key of Object.keys(live)) live[key] = null;
          rootCtx = null;
          styleEl.remove();
          document.querySelectorAll('.dsh-order-workspace-header').forEach(el => el.classList.remove('dsh-order-workspace-header'));
          document.querySelectorAll('.dsh-order-pin-btn, .dsh-order-state, .dsh-order-busy-badge, .dsh-order-star, .dsh-order-star-count, .dsh-order-star-filter, .dsh-order-session-mark').forEach(el => el.remove());
          document.querySelectorAll('.dsh-order-star-menu').forEach(el => el.remove());
          closeStarMenu();
          document.querySelectorAll('.dsh-order-current-group').forEach(el => el.classList.remove('dsh-order-current-group'));
          document.querySelectorAll('.dsh-order-open-group').forEach(el => el.classList.remove('dsh-order-open-group'));
          document.querySelectorAll('.dsh-order-has-state').forEach(el => el.classList.remove('dsh-order-has-state'));
          document.body.classList.remove('dsh-order-sessions-first', 'dsh-order-tree-trays');
          document.querySelectorAll('[data-dsh-order-tray-row]').forEach(el => el.removeAttribute('data-dsh-order-tray-row'));
          document.querySelectorAll('.dsh-order-native-mark').forEach(clearNativeMark);
          document.querySelectorAll('[data-dsh-order-clip], .dsh-order-action-feedback').forEach(el => el.remove());
        });
      }
    }

    module.exports.apply = apply;
    return module.exports;
  }
});
