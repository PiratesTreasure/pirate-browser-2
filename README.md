# 🏴‍☠️ Pirate Browser 2.0

> **Multi-account ShippingManager automation suite**  
> Run multiple accounts simultaneously, each with its own isolated session and independently configurable scripts.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![Electron](https://img.shields.io/badge/electron-28-47848F?logo=electron)
![Scripts](https://img.shields.io/badge/scripts-38%20included-e8912a)
![License](https://img.shields.io/badge/license-MIT-green)

---

## ✨ Features

- **Multi-account tabs** — Each account runs in a fully isolated browser session (separate cookies, separate login). Switch between accounts instantly with a single click.
- **38 included scripts** — All RebelShip userscripts pre-loaded and ready to toggle
- **Per-account script control** — Enable/disable any script independently for each account
- **Script management** — Add new `.js` scripts, remove existing ones, or open the scripts folder directly
- **Custom frameless UI** — Dark nautical theme with a clean, professional interface
- **Persistent config** — Account list and script states saved automatically between sessions

---

## 📦 Installation

### Prerequisites
- [Node.js](https://nodejs.org/) v18 or newer
- [Git](https://git-scm.com/)

### Setup

```bash
# 1. Clone the repository
git clone https://github.com/YOUR_USERNAME/pirate-browser-2.git
cd pirate-browser-2

# 2. Install dependencies
npm install

# 3. Run in development mode
npm run dev

# 4. Or run normally
npm start
```

### Build Windows installer / portable

```bash
# Build both NSIS installer + portable .exe
npm run build

# Portable .exe only
npm run build:portable

# NSIS installer only
npm run build:installer
```

Output goes to the `dist/` folder.

---

## 🗂️ Project Structure

```
pirate-browser-2/
├── main.js              # Electron main process
├── preload.js           # Secure IPC bridge (contextBridge)
├── package.json
├── public/
│   └── icon.ico         # App icon (replace with your own)
└── src/
    ├── renderer/
    │   └── index.html   # Full UI (HTML + CSS + JS, single file)
    └── scripts/         # ← Drop .js userscripts here
        ├── admin-view_user.js
        ├── api-stats_user.js
        ├── auto-anchor_user.js
        ├── ... (38 scripts total)
        └── vessel-sell_user.js
```

---

## 🧩 Managing Scripts

### Adding a script
1. Click **Scripts** in the toolbar → **Add** button
2. Browse to your `.js` userscript file
3. It appears immediately in the list — toggle it on per account

Or manually drop `.js` files into `src/scripts/` and click the **folder** icon → restart or use **Add** to refresh.

### Removing a script
Open the Scripts panel, hover a script, click the **×** button on the right.

### Editing a script
Scripts are plain `.js` files. Click the **folder** icon in the Scripts panel to open the scripts directory in Explorer, then edit with any text editor. Reload the page to re-inject.

### Script metadata (UserScript headers)
Scripts are parsed for standard `==UserScript==` headers:

```js
// ==UserScript==
// @name        My Script
// @description What it does
// @version     1.0
// @order       10        ← lower = injected first
// @enabled     false     ← default state
// ==/UserScript==
```

---

## 🖥️ Usage

### Accounts
| Action | How |
|--------|-----|
| Add account | Click **+** in the tab bar |
| Switch account | Click any tab |
| Rename account | Double-click a tab label |
| Remove account | Hover tab → click **×** |

Each account has its own:
- Cookie / session storage (independent login)
- Script enable/disable states
- Browsing history

### Scripts
| Action | How |
|--------|-----|
| Open script panel | Click **Scripts** button in toolbar |
| Toggle a script | Click the toggle switch |
| Enable all | **All On** button |
| Disable all | **All Off** button |
| Add script | **Add** button → file picker |
| Remove script | Hover script → click **×** |
| Open folder | Click folder icon |

---

## ⚙️ Configuration

Config is stored automatically at:
```
%APPDATA%\pirate-browser-config\config.json
```

This includes:
- Account list (id + label)
- Per-account script enable states

---

## 🔧 Development

```bash
# Start with DevTools open
npm run dev
```

Hot-reload is not configured — restart the app after changes to `main.js` or `preload.js`. The renderer HTML reloads on window reload.

---

## 📋 Included Scripts

| Script | Description |
|--------|-------------|
| API Stats Monitor | Monitor all API calls in the background |
| Alliance Search | Search all open alliances |
| Auto Co-Op | Shows open Co-Op tickets, auto-sends COOP vessels |
| Auto Drydock | Automatic drydock management |
| Auto Happy Staff (No-Points) | Manages staff salaries for morale |
| Auto Happy Staff (Points) | Buys Employee Workshop for morale |
| Auto Marketing | Shows reputation, auto-renews campaigns |
| Auto Repair | Auto-repairs vessels at wear threshold |
| Auto Speed Boost | Auto-buys 4× Speed Boost |
| Captain Blackbeard | Auto-negotiates hijacked vessels |
| Auto Anchor Points | Auto-purchases anchor points |
| Demand Summary | Demand & ranking dashboard with CSV export |
| Depart Manager | Unified departure management |
| Smuggler's Eye | Auto-adjusts cargo prices |
| Mass Moor | Mass moor/resume vessels |
| Forecast Calendar | Fuel/CO2 price forecast calendar |
| Departure Log Viewer | View departure tracking logs |
| Auto Stock | IPO alerts and investment tabs |
| Alliance Chat Notification | Red dot for unread alliance messages |
| Alliance Tools | Alliance ID display, CEO edit buttons |
| Bunker Price Display | Shows fuel and CO2 prices with fill levels |
| Distance Filter | Filter ports by distance in route planner |
| Fast Delivery | Fast delivery for built vessels |
| ChatBot | Automated chatbot for alliance/DMs |
| Vessel Shopping Cart | Bulk purchase vessels |
| Vessel Sell Cart | Bulk-sell vessels |
| Vessel Details Fix | Fix missing vessel details |
| Harbor Improvements | Repositions harbor details button |
| Auto Port Refresh | Refreshes port menu every 30s |
| Depart All Loop | Clicks Depart All until all vessels depart |
| Premium Feature Unlocker | Unlocks premium map themes, tanker ops, zoom |
| VIP Vessel Shop | Quick access to buy VIP vessels |
| Export All Vessels | Export fleet as CSV |
| Export Messages | Export DMs as CSV/JSON |
| Export Vessel History | Export voyage history as CSV |
| Cleanup System Messages | Bulk delete system inbox messages |
| Admin View | Enable admin/mod UI elements (cosmetic only) |
| RebelShip Header Optimizer | Handles all RebelShip UI header elements |

---

## ⚠️ Disclaimer

This tool is for personal use only. Scripts interact with ShippingManager client-side. The Admin View script is cosmetic only — it provides no actual admin or backend privileges.

---

## 📄 License

MIT — see [LICENSE](LICENSE)
