# BayIsland

> Priority-driven **Dynamic Island** & customizable **5-Tab Obsidian Bento Hub** engineered natively for **GNOME Shell 46 (Ubuntu 24.04 Wayland)**.

BayIsland replaces scattered top-bar popups, hardware OSD overlays, and disconnected utility extensions with a single cohesive, borderless pill at the top center of your screen—complete with smooth 60 FPS Clutter morphing, a hover-peek capsule, hardware telemetry, clipboard history, and a true Wayland drag-and-drop file shelf.

---

## Key Advantages

- **Priority-Driven State Arbiter**: All system events (`OSD`, `Notifications`, `Terminal Task Alerts`, `Power/Thermal Warnings`, `Privacy`, `Timers`, `MPRIS Media`, `Hover Peek`, and `File Drag`) pass through a unified priority state machine (`PriorityManager`). Urgent alerts never get buried, concurrent timers & media merge cleanly into a `SPLIT_PILL`, and full-screen behavior stays configurable.
- **Native Wayland & Smooth 60 FPS Morphing**: Built directly on GNOME Shell's `Clutter` compositor actor tree and `St` theme nodes (`MorphEngine`), eliminating Electron/WebKit memory overhead and rendering jitter-free frame-accurate transitions.
- **Custom 2D Cairo Vector Visuals & Minimalist Obsidian UI**: Designed with zero noisy borders or outlines (`outline: none`), high-contrast solid accent fills (`accentCss` / dynamic `accentFgCss`), antialiased **Cairo** telemetry rings (`RingGauge`), and native Cairo volume sliders.
- **Built-in Ecosystem Compatibility (`ExtensionCompat`)**: Dynamically detects active GNOME extensions so nothing overlaps or breaks:
  - **HideTopBar**: Supports `Option A: Drop Below Top Bar`, `Hide Idle While Top Bar Shows`, or `Overlay Top Center`.
  - **OpenBar**: Optional real-time palette synchronization (`openbar-color-sync`) alongside 8 built-in solid color presets & custom RGB picker.
  - **Blur My Shell**, **Quick Settings Tweaks**, **Media Controls**, **Caffeine**, and **Clipboard History**.
- **True Wayland Drag-and-Drop File Bridge**: GNOME Shell's compositor stage cannot act as an XDG drop target/source directly on Wayland. BayIsland spawns a lightweight, click-through **GTK4 drag-and-drop bridge** (`src/helpers/dnd-bridge.js`) dynamically aligned over the Shelf geometry—allowing real drag-in from Nautilus/desktop and drag-out to browsers, chat apps, or editors.
- **Leak-Safe & Privacy-Conscious**: Deterministic lifecycle cleanup via `SignalRegistry` and `TimerRegistry` ensures zero lingering timeouts, D-Bus leaks, or lock-screen issues on `disable()`. Clipboard capture skips entries tagged with password-manager hints (`x-kde-passwordManagerHint`).

---

## Features

### 1. Dynamic Island Capsule States
- **Idle Grab Handle (`104×6 px`)**: Subtle top-center pill line when idle—never blocks window titlebars.
- **Hover-Peek Pill (`36 px` height)**: Symmetrical 3-zone capsule revealed after configurable hover dwell (`160 ms` default):
  - *Left*: `24 px` live Cairo battery percentage ring.
  - *Center*: Short date + live clock.
  - *Right*: Active Ubuntu power profile icon + unread count badge or Do Not Disturb indicator + expand chevron.
- **Compact & Split Pills**: Shows active **MPRIS** playback (mini cover art, track info, animated equalizer) or **Focus Timer**; splits into dual side-by-side modules when both are active concurrently.
- **Transient Banners & Native OSD Replacement**: Intercepts `Main.osdWindowManager.show` for **Volume**, **Mic Mute**, **Screen Brightness**, **Keyboard Backlight**, and **Caffeine**, plus incoming notifications and D-Bus task alerts.
- **Drop Catch (`DROP_CATCH`)**: Automatically expands into a drop-target pill when dragging files toward the top center of the screen, opening straight into the Shelf tab.

### 2. Customizable 5-Tab Expanded Bento Hub
All tabs support custom left-to-right ordering (`tab-order`) and adaptive hub heights while keeping width stationary (`660 px`). Clicking outside the hub or pressing `Esc` collapses it cleanly via `GrabHelper`.

- **Home (`go-home-symbolic`)**
  - Editorial hero today card (`weekday`, large day number, live clock with seconds, and today's calendar agenda).
  - Borderless interactive GNOME monthly calendar (`DBusEventSource`) with solid accent today highlight.
  - **6×1 Quick Actions** grid (icon-only solid-fill tiles with header hover hint): `Wi-Fi`, `Bluetooth`, `Night Light`, `Do Not Disturb`, `Screenshot`, and `Keep Awake`.
  - Dedicated **Focus Timer / Pomodoro** card (`5m`, `15m`, `25m`, `+1m`, `Pause`/`Resume`, `Stop`).
  - Merged **Notifications & Terminal Task Log** feed with per-item dismiss, notification action buttons, and unread counter.
- **Media (`audio-x-generic-symbolic`)**
  - Landscape media stage (`84×84 px` album art cache, animated equalizer, interactive position scrubber, hero play/pause & skip buttons, and inline multi-player switcher).
  - Live **Audio Mixer** card with Cairo smooth volume bar, mute toggle, microphone mute control, and one-click audio output device selector.
- **Power (`battery-good-symbolic`)**
  - Instant **Ubuntu Power Mode** segmented switcher (`Power Saver`, `Balanced`, `Performance`) via `UPower.PowerProfiles`.
  - **2×2 Bento Telemetry** with `48 px` Cairo `RingGauge` dials: **Battery** (charge state, wattage, ThinkPad `BAT0` charge thresholds, health %), **CPU** (live load %, CPU/NVMe hwmon temperatures, Fan RPM), **Memory** (`GiB` usage), and **Disk** (root `/` free space & uptime).
- **Clip (`edit-paste-symbolic`)**
  - Persistent searchable clipboard text history (`Search...` + segmented `All | ★ Pin` filter).
  - Click any entry to copy & optionally auto-paste (`Shift+Insert` or `Ctrl+V` synthesized into the focused app), pin favorites, capture current clipboard, clear unpinned entries, or automatically hand off copied `file://` URIs to Shelf.
- **Shelf (`folder-download-symbolic`)**
  - Temporary file staging shelf with adaptive height (`310 px` empty prompt, scales cleanly with `1–5+` staged files).
  - Drag files in from any app or drag staged rows out directly to browsers/apps; auto-stashes newly saved GNOME screenshots; includes `+ Add Files…`, `Copy File (Ctrl+V)` / `Copy All`, reveal in file manager, pin, and remove.

### 3. Keyboard Shortcuts & D-Bus Automation
| Default Shortcut | Action |
| :--- | :--- |
| `Super + Alt + I` | Toggle Expanded Hub (Smart Auto or chosen default tab) |
| `Super + Alt + T` | Open directly to Home Tab & Focus Timer |
| `Super + Alt + V` | Open directly to Clipboard History Tab |
| `Super + Alt + D` | Open directly to Drag & Drop File Shelf Tab |

- **Terminal Task Done Hook**: Source `scripts/bayisland-shell-hook.sh` in `~/.bashrc` or `~/.zshrc` to receive automatic success/failure alerts in BayIsland when commands run longer than `BAYISLAND_TASK_MIN_SEC` (default `8s`).
- **Session D-Bus Service (`org.bayisland.Shell`)**:
  - `NotifyTask(title, body, success, durationSec)`
  - `ShowBanner(title, body, iconName, durationMs)`
  - `PreviewOsd(iconName, label, level)`
  - `StartTimer(seconds, label)` / `StopTimer()`
  - `ToggleExpand()` / `Collapse()` / `ExpandTab(tab)`
  - `AddShelfFile(uriOrPath)` / `GetState()`

---

## Folder Structure

```text
bayisland/
├── extension.js                      # Extension entry point, manager wiring, GSettings & keybindings
├── prefs.js                          # GTK4 + Libadwaita Preferences UI (Appearance, Modules, Compat, Shortcuts)
├── metadata.json                     # GNOME Shell 46 metadata & extension UUID (bayisland@baydev)
├── stylesheet.css                    # Borderless Obsidian Bento CSS styles (St-compatible)
├── schemas/
│   └── org.gnome.shell.extensions.bayisland.gschema.xml  # GSettings keys & defaults
├── scripts/
│   ├── install-local.sh              # Compile schemas, symlink (or --copy), and enable locally
│   ├── dev-nested.sh                 # Launch isolated nested GNOME Shell (Wayland) preview
│   └── bayisland-shell-hook.sh       # Bash/Zsh Terminal Task Done D-Bus hook
└── src/
    ├── core/
    │   ├── PriorityManager.js        # Central state machine & priority arbiter
    │   ├── SignalRegistry.js         # Leak-free signal connection tracker
    │   └── TimerRegistry.js          # Tracked GLib timeout/interval lifecycle helper
    ├── helpers/
    │   └── dnd-bridge.js             # External GTK4 Wayland drag-and-drop bridge process
    ├── managers/
    │   ├── ClipboardManager.js       # Clipboard capture, persistence, password filter & auto-paste
    │   ├── DropShelfManager.js       # Shelf storage, screenshot monitor & GTK4 bridge IPC
    │   ├── ExternalBusService.js     # org.bayisland.Shell session D-Bus API
    │   ├── MprisManager.js           # Multi-player MPRIS2 D-Bus controller & position tracker
    │   ├── NotificationManager.js    # MessageTray interceptor + task log & unread store
    │   ├── OsdManager.js             # Main.osdWindowManager wrapper & hardware OSD router
    │   ├── PowerManager.js           # UPower DisplayDevice & ThinkPad BAT0 charge-threshold monitor
    │   ├── PowerProfileService.js    # UPower PowerProfiles switcher + /proc & /sysfs telemetry
    │   ├── PrivacyManager.js         # PipeWire/Portal camera & mic active indicator watcher
    │   ├── QuickActionsManager.js    # Wi-Fi, Bluetooth, Night Light, DND, Audio Mixer & Screenshot actions
    │   ├── ResourceManager.js        # Sustained CPU/RAM spike monitor & alerts
    │   └── TimerManager.js           # Countdown & Pomodoro timer engine
    ├── ui/
    │   ├── IslandContainer.js        # Root St actor, GrabHelper modal handler, positioning & IPC bridge sync
    │   ├── MorphEngine.js            # Clutter easing transitions & equalizer animation loop
    │   ├── RingGauge.js              # Custom 2D Cairo antialiased circular progress gauge
    │   ├── CompactView.js            # Idle bar, Hover-Peek capsule, Media & Timer compact pills
    │   ├── SplitView.js              # Dual-slot compact pill (MPRIS + Timer/Task)
    │   ├── TransientView.js          # OSD bars, notification peeks & task banners
    │   ├── ExpandedView.js           # Streamlined header bar & adaptive-height 5-tab container
    │   └── tabs/
    │       ├── HomeTab.js            # Editorial date/calendar, Focus Timer, 6x1 Quick Actions, Notifications
    │       ├── MediaTab.js           # Hero media stage, Cairo scrubber/volume bar & output switcher
    │       ├── PowerTab.js           # Power mode segmented control & 2x2 Cairo telemetry bento
    │       ├── ClipboardTab.js       # Searchable snippet list, pin filter & click-to-paste controls
    │       └── ShelfTab.js           # Adaptive DnD dropzone, staged file rows & drag-out alignment
    └── utils/
        ├── ArtCache.js               # Asynchronous album art loader & cache for MPRIS covers
        ├── ExtensionCompat.js        # Runtime detection of HideTopBar, OpenBar, Blur My Shell, etc.
        └── ThemeBridge.js            # Accent palette resolver, WCAG contrast calculator & OpenBar reader
```

---

## Tech Stack & Architecture

| Layer | Technologies Used |
| :--- | :--- |
| **Runtime & Shell API** | GJS (ES Modules), GNOME Shell 46 (`Shell-14`, `Meta-14`, `St-14`), GLib / GIO |
| **Compositor & Animations** | `Clutter` timeline easing (`MorphEngine`), `St.BoxLayout` / `St.Widget`, `GrabHelper` |
| **Vector Graphics** | Native **2D Cairo (`cairo`)** on `St.DrawingArea` (`RingGauge`, Media volume track), `Pango` text layout |
| **Preferences & Wayland DnD** | **GTK 4.0** & **Libadwaita (`Adw 1.0`)**, JSON-over-stdio Wayland bridge (`Gdk.DragSource`, `Gtk.DropTarget`) |
| **System & Media Buses** | Session & System **D-Bus** (`Gio.DBusProxy`), `UPower`, `PowerProfiles`, `MPRIS2`, `Gvc` (`MixerControl`) |
| **Hardware Telemetry** | Native Linux sysfs & procfs (`/proc/stat`, `/proc/meminfo`, `/proc/uptime`, `/sys/class/hwmon`, `BAT0`) |
| **Configuration** | `GSettings` (`org.gnome.shell.extensions.bayisland`) synced live across shell & preferences |

---

## Installation (Ubuntu 24.04 / GNOME Shell 46)

### Requirements
- **GNOME Shell 46** (tested on **Ubuntu 24.04 LTS Wayland**)
- Standard system packages: `libglib2.0-bin` (`glib-compile-schemas`), `gir1.2-gtk-4.0`, `gir1.2-adw-1`

### Install Locally
```bash
git clone https://github.com/BayuKun28/bayisland.git
cd bayisland
./scripts/install-local.sh
```

By default, `./scripts/install-local.sh` compiles the GSettings schema, symlinks the repository to `~/.local/share/gnome-shell/extensions/bayisland@baydev`, and enables `bayisland@baydev`. Pass `--copy` if you prefer copying files instead of symlinking.

> **Wayland Note**: If this is the first time installing `bayisland@baydev` in your current login session, GNOME Shell scans newly created extension directories at session startup. Log out and log back in once, then run `gnome-extensions enable bayisland@baydev` if not already active.

### Nested Preview & Development
Preview changes safely inside an isolated nested Wayland session without affecting your active desktop:
```bash
./scripts/dev-nested.sh
```

### Terminal Task Alerts Setup
Add to `~/.bashrc` or `~/.zshrc`:
```bash
source /path/to/bayisland/scripts/bayisland-shell-hook.sh
```
Test directly via D-Bus:
```bash
gdbus call --session -d org.bayisland.Shell -o /org/bayisland/Shell \
  -m org.bayisland.Shell.NotifyTask "Build" "Cargo finished" true 18
```
