.pragma library

var DEFAULT_PINNED = []

var lastWrittenHash = null

var LAYOUT_OPTS = {
    slotWidth: 58,
    spacing: 8,
    iconSize: 50,
    hoverScale: 1.36,
    radius: 104,
    sidePadding: 18,
    separatorWidth: 14
}

function normalizeId(value) {
    var id = String(value || "").trim()
    return id.endsWith(".desktop") ? id.slice(0, -8) : id
}

// Combines the shell's app-library view with the desktop-entry index. The
// former may be ordered/fuzzy and may omit apps that have no open window;
// the latter is the complete set of entries Quickshell exposes. Earlier
// entries win so the app-library's richer metadata remains authoritative.
function mergeAppEntries(primary, secondary) {
    var result = []
    var seen = {}

    function append(source) {
        ;(source || []).forEach(function(row) {
            var entry = row && row.entry ? row.entry : row
            if (!entry) return
            var id = normalizeId(entry.id || entry.desktopId)
            if (!id || seen[id]) return

            var copy = {}
            for (var key in entry) copy[key] = entry[key]
            copy.id = id
            if (!copy.name) copy.name = copy.displayName || id
            if (!copy.icon) copy.icon = copy.iconName || copy.appIcon || ""

            seen[id] = true
            result.push(copy)
        })
    }

    append(primary)
    append(secondary)
    return result
}

function stripDesktop(value) { return normalizeId(value) }

function toArray(value) {
    if (Array.isArray(value)) return value
    if (value && Array.isArray(value.pinned)) return value.pinned
    return []
}

function parsePinned(text, fallback) {
    var source = String(text || "").trim()
    if (!source) return (fallback || DEFAULT_PINNED).slice()
    try {
        var parsed = JSON.parse(source)
        var values = toArray(parsed)
        var result = []
        values.forEach(function(value) {
            var id = normalizeId(value)
            if (id && result.indexOf(id) === -1) result.push(id)
        })
        return result
    } catch (error) {
        return (fallback || DEFAULT_PINNED).slice()
    }
}

function serializePinned(ids, order) {
    var clean = parsePinned(JSON.stringify(ids || []), [])
    var orderClean = []
    ;(order || []).forEach(function(value) {
        var id = normalizeId(value)
        if (id && orderClean.indexOf(id) === -1) orderClean.push(id)
    })
    return JSON.stringify({ version: 1, pinned: clean, order: orderClean }, null, 2) + "\n"
}

// Reads the persisted full dock order. The `order` field records the spatial
// layout (pinned and running interleaved); `pinned` records membership only.
// A legacy file without the field falls back to the caller's current order.
function parseOrder(text, fallback) {
    var source = String(text || "").trim()
    if (!source) return (fallback || []).slice()
    try {
        var parsed = JSON.parse(source)
        if (!parsed || !Array.isArray(parsed.order)) return (fallback || []).slice()
        var result = []
        parsed.order.forEach(function(value) {
            var id = normalizeId(value)
            if (id && result.indexOf(id) === -1) result.push(id)
        })
        return result
    } catch (error) {
        return (fallback || []).slice()
    }
}

function isPinned(ids, id) {
    return (ids || []).indexOf(normalizeId(id)) !== -1
}

function togglePinned(ids, id) {
    var next = (ids || []).slice()
    var value = normalizeId(id)
    var index = next.indexOf(value)
    if (index >= 0) next.splice(index, 1)
    else if (value) next.push(value)
    return next
}

function reorderPinned(ids, fromIndex, toIndex) {
    var next = (ids || []).slice()
    if (fromIndex < 0 || fromIndex >= next.length || toIndex < 0 || toIndex >= next.length)
        return next
    var item = next.splice(fromIndex, 1)[0]
    next.splice(toIndex, 0, item)
    return next
}

function insertPinned(ids, id, index) {
    var value = normalizeId(id)
    var next = (ids || []).slice()
    if (!value || next.indexOf(value) !== -1) return next
    var idx = Math.max(0, Math.min(index || 0, next.length))
    next.splice(idx, 0, value)
    return next
}

function removePinned(ids, id) {
    var value = normalizeId(id)
    var next = (ids || []).slice()
    var index = next.indexOf(value)
    if (index >= 0) next.splice(index, 1)
    return next
}

// Builds the visual order of items that flow through the dock. `floatingId`
// is the item being dragged (excluded from the flow; the ghost represents it),
// and `phantomIndex` (>= 0) inserts an empty placeholder slot anywhere in the
// full flow (pinned cluster followed by running unpinned apps) that shows
// where the dragged item will settle, so the gap tracks the cursor across the
// entire dock.
function buildFlow(pinned, runningUnpinned, floatingId, phantomIndex) {
    var flow = []
    var floating = normalizeId(floatingId)
    var hasPhantom = typeof phantomIndex === "number" && phantomIndex >= 0
    var combined = []

    ;(pinned || []).forEach(function(id) {
        var value = normalizeId(id)
        if (value !== floating) combined.push({ id: value })
    })
    ;(runningUnpinned || []).forEach(function(id) {
        var value = normalizeId(id)
        if (value !== floating) combined.push({ id: value })
    })

    var idx = hasPhantom ? Math.max(0, Math.min(phantomIndex, combined.length)) : -1
    for (var i = 0; i < combined.length; i++) {
        if (hasPhantom && i === idx) flow.push({ id: "__phantom__", phantom: true })
        flow.push(combined[i])
    }
    if (hasPhantom && idx === combined.length) flow.push({ id: "__phantom__", phantom: true })
    return flow
}

// Builds the session dock order: pinned apps first (persistent), then running
// apps that are not pinned, preserving their previous relative order so drag
// reorders survive window/app refreshes. Unknown apps append in list order.
function buildDockOrder(pinnedIds, runningIds, previousOrder) {
    var pinned = (pinnedIds || []).map(normalizeId)
    var running = (runningIds || []).map(normalizeId)
    var unpinned = []
    running.forEach(function(id) {
        if (pinned.indexOf(id) === -1 && unpinned.indexOf(id) === -1) unpinned.push(id)
    })
    var position = {}
    ;(previousOrder || []).forEach(function(id, index) { position[normalizeId(id)] = index })
    unpinned.sort(function(a, b) {
        var pa = position[a] === undefined ? 9999 : position[a]
        var pb = position[b] === undefined ? 9999 : position[b]
        return pa - pb
    })
    return pinned.concat(unpinned)
}

// Reconciles the session order against reality: keeps every app that is still
// pinned or running in its current position, appends newly pinned and newly
// running apps in order. This is what lets any app sit in any slot without
// being persisted.
function reconcileDockOrder(previousOrder, pinnedIds, runningIds) {
    var pinned = (pinnedIds || []).map(normalizeId)
    var running = (runningIds || []).map(normalizeId)
    var result = []
    ;(previousOrder || []).forEach(function(id) {
        var value = normalizeId(id)
        if (running.indexOf(value) !== -1 || pinned.indexOf(value) !== -1)
            result.push(value)
    })
    pinned.forEach(function(id) { if (result.indexOf(id) === -1) result.push(id) })
    running.forEach(function(id) { if (result.indexOf(id) === -1) result.push(id) })
    return result
}

// Moves an app to a new slot within the session order. Returns a new array.
function moveInOrder(order, id, index) {
    var value = normalizeId(id)
    var next = (order || []).slice()
    var from = next.indexOf(value)
    if (from < 0) {
        var idx = Math.max(0, Math.min(index || 0, next.length))
        next.splice(idx, 0, value)
        return next
    }
    next.splice(from, 1)
    var idx = Math.max(0, Math.min(index || 0, next.length))
    next.splice(idx, 0, value)
    return next
}

// Keeps only the pinned members of an order, in that order (used to persist
// pinned-app rearrangements without ever persisting running apps).
function orderPinned(order, pinnedIds) {
    var result = []
    ;(order || []).forEach(function(id) {
        var value = normalizeId(id)
        if ((pinnedIds || []).indexOf(value) !== -1 && result.indexOf(value) === -1)
            result.push(value)
    })
    return result
}

// Built-in Launchpad pin. It is not a desktop entry: clicking it asks the
// first-party dock to toggle its app grid (`omarchy-shell omarchy.dock apps`).
// This is the only id resolveDefaultPins may write without a matching entry.
var LAUNCHPAD_ID = "__launchpad__"
var LAUNCHPAD_NAME = "Launchpad"
var LAUNCHPAD_ICON = "view-app-grid-symbolic"
var DEFAULT_PIN_LIMIT = 7

var FILE_MANAGER_CANDIDATES = [
    "org.gnome.Nautilus",
    "nautilus",
    "org.kde.dolphin",
    "dolphin",
    "org.xfce.Thunar",
    "thunar",
    "org.gnome.Nemo",
    "nemo",
    "pcmanfm",
    "pcmanfm-qt",
    "io.elementary.files"
]

var BROWSER_CANDIDATES = [
    "chromium",
    "org.chromium.Chromium",
    "google-chrome",
    "google-chrome-stable",
    "firefox",
    "org.mozilla.firefox",
    "brave-browser",
    "microsoft-edge",
    "helium"
]

var TERMINAL_CANDIDATES = [
    "foot",
    "kitty",
    "com.mitchellh.ghostty",
    "Alacritty",
    "alacritty",
    "org.gnome.Terminal"
]

function isLaunchpadId(id) {
    return normalizeId(id) === LAUNCHPAD_ID
}

function isNoDisplayEntry(entry) {
    if (!entry) return false
    var value = entry.noDisplay
    if (value === undefined) value = entry.NoDisplay
    if (value === true || value === 1) return true
    var text = String(value == null ? "" : value).toLowerCase()
    return text === "true" || text === "1"
}

function categoryText(entry) {
    var value = entry.categories
    if (value === undefined) value = entry.Categories
    if (Array.isArray(value)) return value.join(";").toLowerCase()
    return String(value || "").toLowerCase()
}

// Visible desktop entries only. Hidden handlers (NoDisplay) are not pins.
function visibleDesktopEntries(entries) {
    var result = []
    var seen = {}
    ;(entries || []).forEach(function(row) {
        var entry = row && row.entry ? row.entry : row
        if (!entry || isNoDisplayEntry(entry)) return
        var id = normalizeId(entry.id || entry.desktopId)
        if (!id || seen[id]) return
        seen[id] = true
        result.push({
            id: id,
            name: String(entry.name || entry.displayName || ""),
            categories: categoryText(entry)
        })
    })
    return result
}

function lookupEntryId(list, candidates) {
    var wanted = []
    if (Array.isArray(candidates)) wanted = candidates
    else if (candidates) wanted = [candidates]
    for (var i = 0; i < wanted.length; i++) {
        var needle = normalizeId(wanted[i]).toLowerCase()
        if (!needle) continue
        for (var j = 0; j < list.length; j++) {
            if (list[j].id.toLowerCase() === needle) return list[j].id
        }
    }
    return ""
}

function findByCategory(list, role) {
    var token = String(role || "").toLowerCase()
    if (!token) return ""
    for (var i = 0; i < list.length; i++) {
        var cats = ";" + list[i].categories + ";"
        if (cats.indexOf(";" + token + ";") !== -1) return list[i].id
    }
    return ""
}

function findFileManager(list) {
    var known = lookupEntryId(list, FILE_MANAGER_CANDIDATES)
    if (known) return known
    var byRole = findByCategory(list, "filemanager")
    if (byRole) return byRole
    for (var i = 0; i < list.length; i++) {
        var id = list[i].id.toLowerCase()
        var name = list[i].name.toLowerCase()
        if (id.indexOf("nautilus") !== -1 || id.indexOf("dolphin") !== -1
            || id.indexOf("thunar") !== -1 || id.indexOf("nemo") !== -1)
            return list[i].id
        if (name === "files" || name === "file manager") return list[i].id
    }
    return ""
}

function findCalendar(list) {
    var known = lookupEntryId(list, ["org.gnome.Calendar", "gnome-calendar"])
    if (known) return known
    for (var i = 0; i < list.length; i++) {
        var id = list[i].id.toLowerCase()
        var name = list[i].name.toLowerCase()
        if (id.indexOf("settings") !== -1 || name.indexOf("settings") !== -1) continue
        if (id === "calendar" || name === "calendar" || name === "hey calendar"
            || id.indexOf("calendar") !== -1 || name.indexOf("calendar") !== -1)
            return list[i].id
    }
    return ""
}

// macOS-like first pins for a machine that has no pin file yet. Every id
// except Launchpad must be a visible desktop entry; missing apps are skipped.
// The result is capped so a fresh dock stays short.
function resolveDefaultPins(entries, options) {
    var opts = options || {}
    var list = visibleDesktopEntries(entries)
    var result = []

    function add(id) {
        var value = normalizeId(id)
        if (!value || result.indexOf(value) !== -1) return
        if (result.length >= DEFAULT_PIN_LIMIT) return
        result.push(value)
    }

    var files = findFileManager(list)
    if (files) add(files)
    add(LAUNCHPAD_ID)

    var browser = lookupEntryId(list, opts.defaultBrowser)
        || lookupEntryId(list, BROWSER_CANDIDATES)
        || findByCategory(list, "webbrowser")
    if (browser) add(browser)

    var terminal = lookupEntryId(list, opts.defaultTerminal)
        || lookupEntryId(list, TERMINAL_CANDIDATES)
        || findByCategory(list, "terminalemulator")
    if (terminal) add(terminal)

    var hey = lookupEntryId(list, ["HEY", "hey"])
    if (hey) add(hey)
    var calendar = findCalendar(list)
    if (calendar) add(calendar)
    var obsidian = lookupEntryId(list, ["obsidian", "md.obsidian.Obsidian"])
    if (obsidian) add(obsidian)
    var settings = lookupEntryId(list, ["org.gnome.Settings", "gnome-control-center"])
    if (settings) add(settings)
    return result
}

// `xdg-settings` / `xdg-terminal-exec` probe printed by defaultAppsProbeScript.
function parseDefaultAppProbe(text) {
    var browser = ""
    var terminal = ""
    String(text || "").split(/\r?\n/).forEach(function(line) {
        var trimmed = String(line || "").trim()
        var browserAt = trimmed.indexOf("browser=")
        var terminalAt = trimmed.indexOf("terminal=")
        if (browserAt === 0) browser = probeDesktopId(trimmed.slice(8))
        else if (terminalAt === 0) terminal = probeDesktopId(trimmed.slice(9))
    })
    return { defaultBrowser: browser, defaultTerminal: terminal }
}

function probeDesktopId(value) {
    var text = String(value || "").trim()
    var colon = text.indexOf(":")
    if (colon >= 0) text = text.slice(0, colon).trim()
    return normalizeId(text)
}

function defaultAppsProbeScript() {
    return [
        "browser=$(xdg-settings get default-web-browser 2>/dev/null || true)",
        "terminal=$(xdg-terminal-exec --print-id 2>/dev/null || true)",
        "terminal=${terminal%%:*}",
        "if [ -z \"$terminal\" ] && command -v omarchy-default-terminal >/dev/null 2>&1; then",
        "  name=$(omarchy-default-terminal 2>/dev/null || true)",
        "  case \"$name\" in",
        "    alacritty) terminal=Alacritty.desktop ;;",
        "    foot) terminal=foot.desktop ;;",
        "    ghostty) terminal=com.mitchellh.ghostty.desktop ;;",
        "    kitty) terminal=kitty.desktop ;;",
        "  esac",
        "fi",
        "printf 'browser=%s\\nterminal=%s\\n' \"$browser\" \"$terminal\""
    ].join("\n")
}

// Smooth pointer wave used by the dock. The cosine falloff keeps the hover
// response soft at both ends of the reach; the matching ramp is its integral,
// so neighboring slots move exactly far enough to make room for the growth.
function hoverFalloff(distance, reach) {
    var t = Math.abs(distance) / reach
    if (t >= 1) return 0
    return 0.5 * (1 + Math.cos(Math.PI * t))
}

function hoverRamp(distance, reach) {
    var u = distance / reach
    if (u >= 1) return 0.5
    if (u <= -1) return -0.5
    return 0.5 * u + Math.sin(Math.PI * u) / (2 * Math.PI)
}

// Continuous layout driven by the cursor. Slot centers are measured from the
// resting row, then every slot receives a scale and a centered shift. This is
// important: measuring each center after the previous slot has grown makes the
// hover wave feed back into itself and causes the row to wobble at the edges.
function computeLayout(flow, cursorX, opts) {
    opts = opts || LAYOUT_OPTS
    var placements = {}
    var cursorValid = typeof cursorX === "number" && cursorX >= 0
    var reach = Math.max(opts.slotWidth, opts.radius)
    var growth = opts.iconSize * (opts.hoverScale - 1)
    var spread = growth * (reach / opts.slotWidth)
    var resting = []
    var x = 0

    for (var i = 0; i < flow.length; i++) {
        var item = flow[i]
        var slot = item.separator ? opts.separatorWidth : opts.slotWidth
        resting.push({ item: item, x: x, slot: slot, center: x + slot / 2 })
        x += slot + opts.spacing
    }

    var contentWidth = Math.max(0, x - opts.spacing)
    var pointer = cursorValid ? cursorX : -1
    var startShift = cursorValid ? spread * hoverRamp(-pointer, reach) : 0
    var endShift = cursorValid ? spread * hoverRamp(contentWidth - pointer, reach) : 0
    var recenter = (startShift + endShift) / 2
    var lastEnd = 0
    var grownWidth = 0

    for (var j = 0; j < resting.length; j++) {
        var entry = resting[j]
        var item = entry.item
        var scale = 1
        var lift = 0
        var shift = 0
        if (cursorValid && !item.separator) {
            var distance = entry.center - pointer
            scale = 1 + (opts.hoverScale - 1) * hoverFalloff(distance, reach)
            shift = spread * hoverRamp(distance, reach) - recenter
            lift = (scale - 1) * opts.iconSize * 0.5
        }
        // The delegate itself widens around its center, so its resting x plus
        // the wave shift is already the correct left edge. Keeping that edge
        // stable also keeps a one-icon dock centered while it magnifies.
        var placedX = entry.x + shift
        placements[item.id] = { x: placedX, scale: scale, lift: lift, phantom: !!item.phantom }
        lastEnd = Math.max(lastEnd, placedX + entry.slot * scale)
        grownWidth += entry.slot * (scale - 1)
    }

    var expandedWidth = contentWidth + grownWidth
    return { placements: placements, flowWidth: expandedWidth, totalWidth: expandedWidth + 2 * opts.sidePadding }
}

// Returns the flow index the cursor currently falls over (0..flow.length),
// using the same scaled geometry as the rendered layout so the drop lands
// on the icon the user sees.
function insertionIndexFor(cursorX, flow, opts) {
    opts = opts || LAYOUT_OPTS
    if (!flow || flow.length === 0) return 0
    var x = 0
    var cursorValid = typeof cursorX === "number" && cursorX >= 0
    for (var i = 0; i < flow.length; i++) {
        var item = flow[i]
        var slot = item.separator ? opts.separatorWidth : opts.slotWidth
        var center = x + slot / 2
        var scale = 1
        if (cursorValid) {
            var reach = Math.max(opts.slotWidth, opts.radius)
            scale = 1 + (opts.hoverScale - 1) * hoverFalloff(cursorX - center, reach)
        }
        if (cursorX < x + slot * scale / 2) return i
        x += slot * scale + opts.spacing
    }
    return flow.length
}

function isWebAppClass(value) {
    var v = String(value || "").toLowerCase()
    if (/^chrome[-_.]/.test(v) || /^chromium[-_.]/.test(v) || /^google-chrome[-_.]/.test(v)) return true
    if (/__-default(-\d+)?$/.test(v) || /\.-default(-\d+)?$/.test(v)) return true
    return /^[a-z0-9]+(\.[a-z0-9][a-z0-9-]*)+$/.test(v)
}

// Resolves a window class/appId to a desktop-entry id. Pass 1 is an exact
// id match; pass 2 is the legacy Name-substring fallback, gated on
// isWebAppClass() so short web-app names (e.g. `X`) cannot hijack ordinary
// classes such as `firefox` (see issue #19). Returns the normalized raw id
// when nothing matches, mirroring the previous QML fallback.
function desktopIdForWindow(rawId, entries) {
    var raw = normalizeId(rawId)
    var lower = raw.toLowerCase()
    if (!lower) return ""
    var list = entries || []
    for (var i = 0; i < list.length; i++) {
        var entry = list[i] && list[i].entry ? list[i].entry : (list[i] || {})
        var id = normalizeId(entry.id || entry.desktopId)
        if (id && id.toLowerCase() === lower) return id
    }
    if (!isWebAppClass(lower)) return raw
    for (var j = 0; j < list.length; j++) {
        var candidate = list[j] && list[j].entry ? list[j].entry : (list[j] || {})
        var candidateId = normalizeId(candidate.id || candidate.desktopId)
        var name = String(candidate.name || candidate.displayName || "").toLowerCase()
        if (candidateId && name && lower.indexOf(name) !== -1) return candidateId
    }
    return raw
}

function entryFor(id, entries) {
    var value = normalizeId(id)
    var list = entries || []
    if (isLaunchpadId(value))
        return { id: LAUNCHPAD_ID, name: LAUNCHPAD_NAME, icon: LAUNCHPAD_ICON, builtin: true }
    var lowerValue = value.toLowerCase()
    for (var i = 0; i < list.length; i++) {
        var entry = list[i] && list[i].entry ? list[i].entry : (list[i] || {})
        var candidate = normalizeId(entry.id || entry.desktopId)
        if (candidate === value || candidate.toLowerCase() === lowerValue) return entry
    }
    var pretty = value.split(".").pop().replace(/[-_]+/g, " ").trim()
    if (pretty) pretty = pretty.charAt(0).toUpperCase() + pretty.slice(1)
    return { id: value, name: pretty || value, icon: "application-x-executable" }
}

function buildDockItems(pinned, entries, runningIds) {
    var result = []
    var running = runningIds || []
    ;(pinned || []).forEach(function(id) {
        var entry = entryFor(id, entries)
        result.push({ id: normalizeId(id), name: entry.name || entry.displayName || id,
            icon: entry.icon || entry.iconName || "", pinned: true,
            running: running.indexOf(normalizeId(id)) >= 0 })
    })

    var unpinned = []
    running.forEach(function(id) {
        var normalized = normalizeId(id)
        if (!isPinned(pinned, normalized) && unpinned.indexOf(normalized) === -1)
            unpinned.push(normalized)
    })
    unpinned.forEach(function(id) {
        var entry = entryFor(id, entries)
        result.push({ id: id, name: entry.name || entry.displayName || id,
            icon: entry.icon || entry.iconName || "", pinned: false, running: true })
    })
    return result
}

function hashContent(value) {
    var text = String(value || "")
    var hash = 0
    for (var i = 0; i < text.length; i++)
        hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0
    return hash
}

function shouldReprocess(content) {
    return hashContent(content) !== lastWrittenHash
}

function markWritten(content) { lastWrittenHash = hashContent(content) }

function resetWrittenGuard() { lastWrittenHash = null }

// ---- Dock settings (auto-hide, placement) ------------------------------
var lastSettingsHash = null

function normalizeSide(side) {
    var s = String(side || "bottom").toLowerCase()
    if (s === "left" || s === "right") return s
    return "bottom"
}

function parseSettings(text, fallback) {
    var defaults = fallback || { autoHide: true, dockSide: "bottom" }
    var baseSide = normalizeSide(defaults.dockSide)
    var base = { autoHide: !!defaults.autoHide, dockSide: baseSide }
    var source = String(text || "").trim()
    if (!source) return base
    try {
        var parsed = JSON.parse(source)
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return base
        var out = { autoHide: base.autoHide, dockSide: base.dockSide }
        if (typeof parsed.autoHide === "boolean") out.autoHide = parsed.autoHide
        else if (typeof parsed.autoHide === "string") out.autoHide = parsed.autoHide === "true"
        if (parsed.dockSide !== undefined) out.dockSide = normalizeSide(parsed.dockSide)
        return out
    } catch (error) {
        return base
    }
}

function serializeSettings(settings) {
    var value = settings && typeof settings.autoHide === "boolean" ? settings.autoHide : true
    var side = normalizeSide(settings && settings.dockSide)
    return JSON.stringify({ version: 1, autoHide: value, dockSide: side }, null, 2) + "\n"
}

function shouldReprocessSettings(content) {
    return hashContent(content) !== lastSettingsHash
}

function markSettingsWritten(content) { lastSettingsHash = hashContent(content) }

function resetSettingsGuard() { lastSettingsHash = null }

// ---- Auto-hide state machine (pure, testable) --------------------------
function shouldHideDock(state) {
    var s = state || {}
    var dockEngaged = !!(s.dockEngaged || s.dockHovered || s.edgeHovered)
    return !!(s.autoHide && s.enabled && s.dockReady && !s.autoHidden && !dockEngaged && !s.hideSuppressed)
}

function shouldScheduleHide(state) {
    var s = state || {}
    var dockEngaged = !!(s.dockEngaged || s.dockHovered || s.edgeHovered)
    return !!(s.autoHide && s.enabled && s.dockReady && !s.autoHidden && !dockEngaged && !s.hideSuppressed)
}

function shouldRevealDock(state) {
    var s = state || {}
    return !!(s.autoHide && s.enabled && s.autoHidden && !!s.edgeHovered)
}

// Allows the same pure module to be exercised by Node tests. QML does not
// define `module`, so this branch is inert when imported by Quickshell.
if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        DEFAULT_PINNED: DEFAULT_PINNED,
        LAYOUT_OPTS: LAYOUT_OPTS,
        normalizeId: normalizeId,
        mergeAppEntries: mergeAppEntries,
        stripDesktop: stripDesktop,
        toArray: toArray,
        parsePinned: parsePinned,
        parseOrder: parseOrder,
        serializePinned: serializePinned,
        isPinned: isPinned,
        togglePinned: togglePinned,
        reorderPinned: reorderPinned,
        insertPinned: insertPinned,
        removePinned: removePinned,
        buildFlow: buildFlow,
        buildDockOrder: buildDockOrder,
        reconcileDockOrder: reconcileDockOrder,
        moveInOrder: moveInOrder,
        orderPinned: orderPinned,
        computeLayout: computeLayout,
        insertionIndexFor: insertionIndexFor,
        isWebAppClass: isWebAppClass,
        desktopIdForWindow: desktopIdForWindow,
        entryFor: entryFor,
        buildDockItems: buildDockItems,
        hashContent: hashContent,
        shouldReprocess: shouldReprocess,
        markWritten: markWritten,
        resetWrittenGuard: resetWrittenGuard,
        parseSettings: parseSettings,
        serializeSettings: serializeSettings,
        normalizeSide: normalizeSide,
        shouldReprocessSettings: shouldReprocessSettings,
        markSettingsWritten: markSettingsWritten,
        resetSettingsGuard: resetSettingsGuard,
        shouldHideDock: shouldHideDock,
        shouldScheduleHide: shouldScheduleHide,
        shouldRevealDock: shouldRevealDock,
        LAUNCHPAD_ID: LAUNCHPAD_ID,
        LAUNCHPAD_NAME: LAUNCHPAD_NAME,
        LAUNCHPAD_ICON: LAUNCHPAD_ICON,
        DEFAULT_PIN_LIMIT: DEFAULT_PIN_LIMIT,
        isLaunchpadId: isLaunchpadId,
        resolveDefaultPins: resolveDefaultPins,
        parseDefaultAppProbe: parseDefaultAppProbe,
        defaultAppsProbeScript: defaultAppsProbeScript
    }
}
