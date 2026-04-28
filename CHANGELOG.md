# Pirate Browser 2.0 — Changelog

## v2.5.0
- Auto Speed Boost: Add max cycles limit (stops automatically after N purchases, resets on each enable)
- Auto Speed Boost: Add time window setting (restrict boosts to specific hours, supports overnight ranges)
- Port Updates: Fix 30-minute auto-post never firing (background job registration was silently failing); add Post Now button
- Webview: Add Force Reset button to toolbar — destroys and recreates frozen webviews without restarting the app
- Webview: Auto-heal on unresponsive/crash now recreates the webview instead of calling reload on a broken WebContents
- User scripts directory: App now loads scripts from %APPDATA%\Pirate Browser 2.0\scripts\ in addition to bundled scripts — personal scripts placed here survive app updates

## v2.1.0
- Added Pirate Analytics dashboard (Fleet Overview, Route Profitability, Transactions, Trends)
- Added auto-updater with patch notes — updates install automatically
- Fixed Depart Manager save button (broken breakeven element references)
- Fixed Mass Moor resume not working after mass-moor
- Added contribution tracking toggle back to Depart Manager
- Fixed utilization tracking for both cargo and tanker vessel types
- Fixed bunker cost recording via cash delta monitor
- Fuel and CO2 purchases now recorded with exact amount and cost

## v2.0.0
- Initial release
- Multi-account management with isolated sessions
- Script injection system with enable/disable toggles
- Depart Manager, Auto Repair, Auto Drydock, Mass Moor scripts
- Pirate Bunker integration tab
