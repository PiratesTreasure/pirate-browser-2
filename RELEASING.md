# How to Release an Update

## Every Release

1. Update `CHANGELOG.md` with what changed
2. Bump version in `package.json` (e.g. `2.1.0` → `2.2.0`)
3. Build the installer:
   ```
   npm run build
   ```
4. Go to GitHub → **Releases** → **Draft a new release**
5. Tag: `v2.2.0` (must match package.json version exactly)
6. Title: `Pirate Browser v2.2.0`
7. Description: paste your patch notes (users will see this in the app)
8. Upload the files from `dist/`:
   - `Pirate Browser 2.0 Setup 2.2.0.exe` (installer)
   - `latest.yml` (required for auto-updater to work)
9. Click **Publish release**

Users will see the update notification within 5 seconds of launching the app.
The patch notes they see are the GitHub release description.

## File Checklist
- [ ] `package.json` version bumped
- [ ] `CHANGELOG.md` updated  
- [ ] `dist/latest.yml` uploaded to GitHub release
- [ ] `dist/*.exe` uploaded to GitHub release
- [ ] Release tagged as `v{version}` exactly
