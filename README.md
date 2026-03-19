# 🏴‍☠️ Pirate Browser 2.0

A dedicated desktop browser for [ShippingManager](https://shippingmanager.cc) — built for serious players who run multiple accounts and want full automation without the faff.

[![Latest Release](https://img.shields.io/github/v/release/PiratesTreasure/pirate-browser-2?style=flat-square&color=e8912a)](https://github.com/PiratesTreasure/pirate-browser-2/releases/latest)
[![Platform](https://img.shields.io/badge/platform-Windows-blue?style=flat-square)](https://github.com/PiratesTreasure/pirate-browser-2/releases/latest)

---

## ⬇️ Download & Install

1. Go to [**Releases**](https://github.com/PiratesTreasure/pirate-browser-2/releases/latest)
2. Download **`Pirate Browser 2.0 Setup x.x.x.exe`**
3. Run the installer — creates a desktop shortcut automatically
4. Future updates install themselves from inside the app

> **Note:** Windows may show a SmartScreen warning since the app isn't signed. Click **More info → Run anyway**.

---

## ✨ Features

### Multi-Account Management
Run multiple ShippingManager accounts side by side, each with their own isolated session, cookies and login. Switch between them instantly with tabs — no logging in and out.

### Auto-Updater
New versions notify you inside the app with patch notes. One click downloads and installs the update — no need to revisit GitHub.

### Script System
39 built-in automation scripts, all toggleable per account. Enable only what you need. Scripts load automatically every time the page loads.

---

## 🤖 Built-in Scripts

### Automation
| Script | What it does |
|--------|-------------|
| **Depart Manager** | Auto-departs vessels on a schedule, manages fuel/CO2 purchasing, route price optimisation |
| **Auto Repair** | Automatically repairs vessels when they drop below a condition threshold |
| **Auto Drydock** | Sends vessels for drydock when hours run low, restores settings after |
| **Mass Moor / Resume** | Moor or resume an entire fleet with checkbox selection |
| **Auto Speed Boost** | Automatically applies speed boosts to vessels |
| **Auto Stock** | Manages stock purchases automatically |
| **Auto Happy Staff** | Keeps staff happiness topped up |
| **Auto Marketing** | Renews marketing campaigns automatically |
| **Auto Co-Op Tickets** | Handles co-op ticket distribution |
| **Depart All Loop** | Repeatedly clicks Depart All until every vessel has departed |
| **Captain Blackbeard** | Advanced departure automation |

### Analytics & Tracking
| Script | What it does |
|--------|-------------|
| **Pirate Analytics** | Full fleet dashboard — income, utilisation, route profitability, trends, transaction log |
| **API Stats Monitor** | Live API performance monitoring |
| **Departure Log Viewer** | Browse historical departure records |
| **Bunker Price Display** | Shows live fuel and CO2 prices |
| **Fuel/CO2 Forecast Calendar** | Price forecast for upcoming time slots |
| **Demand Summary** | Port demand overview across all routes |

### Tools & Utilities
| Script | What it does |
|--------|-------------|
| **Smuggler's Eye** | Cargo price optimisation |
| **Vessel Shopping Cart** | Add multiple vessels to cart and buy in bulk |
| **Vessel Sell Cart** | Sell multiple vessels at once |
| **VIP Vessel Shop** | Browse and buy VIP vessels |
| **Export Vessel History** | Export departure history to CSV |
| **Export Vessels CSV** | Export full fleet data |
| **Export Messages** | Export alliance/chat messages |
| **Alliance Search** | Search and filter alliance members |
| **Alliance Chat Notifications** | Desktop notifications for alliance chat |
| **Distance Filter** | Filter route planner by distance |
| **Premium Feature Unlocker** | Unlocks certain premium UI features |
| **ChatBot** | Automated chat responses |
| **Cleanup System Messages** | Removes clutter from system message feed |
| **Harbor Improvements** | UI improvements to the harbor view |
| **Map Unlock** | Unlocks additional map features |

---

## 📊 Pirate Analytics

The flagship feature — a full fleet performance dashboard accessible from the Tools menu.

**Fleet Overview** — every vessel with total revenue, average per trip, net revenue after fees, utilisation %, avg speed, contribution points and fuel used. Click any column to sort.

**Route Profitability** — ranked list of all routes by total revenue, showing avg per trip, contribution and revenue per nautical mile.

**Transactions** — every income and outgoing event: departure income with fee breakdown, fuel/CO2 purchases, drydock costs, marketing campaigns. Filter by type.

**Trends** — daily chart for 7 or 30 days showing income, outgoing, net profit and contribution per day.

Export everything as CSV or JSON.

---

## 🔧 For Developers

```bash
git clone https://github.com/PiratesTreasure/pirate-browser-2.git
cd pirate-browser-2
npm install
npm start          # Run in development mode
npm run build      # Build Windows installer (run as admin or with Developer Mode enabled)
```

Scripts live in `src/scripts/` and follow the UserScript metadata format (`@name`, `@description`, `@order`, `@enabled`). Drop any `.js` file in there and it appears in the scripts panel automatically.

---

## 📋 Releasing an Update

See [RELEASING.md](RELEASING.md) for the full release checklist.

Short version: bump version in `package.json` → `npm run build` → create GitHub release tagged `v{version}` → upload `Setup.exe` + `latest.yml` from `dist/`.

---

## 🏴‍☠️ Credits

Built by [PiratesTreasure](https://github.com/PiratesTreasure) for the ShippingManager community.
