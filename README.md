[![CI](https://github.com/Shieldmonkey/Shieldmonkey/actions/workflows/ci.yml/badge.svg)](https://github.com/Shieldmonkey/Shieldmonkey/actions/workflows/ci.yml)
[![Test](https://github.com/Shieldmonkey/Shieldmonkey/actions/workflows/test.yml/badge.svg)](https://github.com/Shieldmonkey/Shieldmonkey/actions/workflows/test.yml)
[![GitHub last commit](https://img.shields.io/github/last-commit/Shieldmonkey/Shieldmonkey?style=flat-square)](https://github.com/Shieldmonkey/Shieldmonkey/commits/main)
[![GitHub issues](https://img.shields.io/github/issues/Shieldmonkey/Shieldmonkey?style=flat-square&color=blue)](https://github.com/Shieldmonkey/Shieldmonkey/issues)
[![License](https://img.shields.io/github/license/Shieldmonkey/Shieldmonkey?style=flat-square&color=orange)](LICENSE)


[日本語版 README (Japanese)](README.ja.md)

![Shieldmonkey](assets/header.jpeg)

# Shieldmonkey

Shieldmonkey is an open-source, Manifest V3 compliant userscript manager designed with security and auditability as the top priorities.

## Design and Features

![Shieldmonkey Architecture](assets/architecture_diagram.png)

### Strict Content Security Policy (CSP)
Shieldmonkey enforces a strict Content Security Policy (CSP) to prevent the extension from communicating with external entities unintentionally.
External connections from Background Scripts and injected pages are blocked. Consequently, the following features are intentionally excluded:

- Functions that bypass CORS, such as `GM_xmlHttpRequest`
- Dynamic loading of external scripts via `require`
- Automatic backup to cloud services
- Automatic script updates

All updates are performed manually by the user, preventing unintentional code replacement or execution in the background.

### Auditable Builds
To ensure transparency, we follow these build policies:

- The source code of the built extension is intentionally not minified (compressed or obfuscated) to prioritize ease of auditing.
- SourceMaps are included for debugging and verification.
- A minified version is also provided for distribution size considerations, but we recommend using the non-minified version.

We provide manual installation from GitHub as an option for users who prioritize auditability and control. You can choose between the convenience and review process of the Browser Stores, or the security of using a fixed, auditable version built from source.

### Supply Chain Security
We prioritize supply chain security by leveraging `pnpm` configuration and strict versioning policies.

- **Strict Version Pinning (package.json)**: All dependencies in `package.json` are pinned to exact versions (no `^` or `~`). We do not use range specifiers, ensuring that the exact same code is used across all builds.
- **`pnpm-workspace.yaml` Configuration**:
  - **`blockExoticSubdeps=true`**: Prevents installation of dependencies from untrusted sources (e.g., Git URLs), ensuring all packages come from the registry.
  - **`minimumReleaseAge=10080`**: We only install packages that have been published for at least 7 days. This mitigates the risk of installing newly compromised packages (zero-day malicious updates).
  - **`trustPolicy=no-downgrade`**: Prevents dependencies from being silently downgraded to older versions.
- **`ignore-scripts`**: Script execution is disabled by default in `pnpm`. We also explicitly set `ignore-scripts=true` in `.npmrc` as a fallback for `npm` users, preventing malicious build scripts from running.
- **Immutable Lockfile**: We enforce `lockfile=true` and use `pnpm install --frozen-lockfile` in CI to ensure reproducible builds.

## Features

- Script management (install, edit, delete, disable)
- Editing environment powered by CodeMirror 6
- `.user.js` format support
- Local import/export

### Backup and file sync

- **Desktop:** Select a folder in Settings and enable automatic backup. Script changes are saved by the background worker. shieldmonkey_dump.json is the complete restore copy, scripts contains editable .user.js copies, and history holds older JSON snapshots. You can place the folder in a third party sync directory; ShieldMonkey itself does not connect to a cloud service.
- **Mobile:** Automatic backup downloads a dated JSON file after script changes. Manual export and JSON restore are also available.
- **Restore:** Preview added, updated, unchanged, and local-only scripts, then choose Merge or Replace. A recovery JSON of the current scripts is downloaded before applying changes. On desktop, edits to .user.js files in the backup folder can be imported back into the same script ID.
- **Conflicts:** Automatic backup stops instead of overwriting JSON or script files changed outside ShieldMonkey. Use Restore in Settings to review those changes. Older JSON backups remain readable.

Backups contain script code and enabled states. They do not include GM_setValue data or extension settings. Since backup files contain script code and permission information, review the sharing settings of the destination folder.
History snapshots are not deleted automatically; review them as storage grows.

## Tech Stack

- React 19
- Vite (w/ CRXJS)
- TypeScript
- CodeMirror 6
- IndexedDB
- Vanilla CSS / Sass

## Installation and Build

1. Clone the repository
   ```bash
   git clone https://github.com/shieldmonkey/shieldmonkey.git
   cd shieldmonkey
   ```

2. Install dependencies
   Since `ignore-scripts=true` is set in `.npmrc`, you can safely install dependencies using:
   ```bash
   pnpm install
   ```

3. Build
   ```bash
   pnpm run build
   ```

4. Load the extension
   Open `chrome://extensions` in Chrome, enable Developer Mode, and load the generated `dist` directory.

### Vivaldi on Android

Use the dedicated build when loading an unpacked extension through Vivaldi's Android folder picker. The standard build's `_locales` directory is not loaded correctly through that picker. The dedicated build uses a literal manifest name and description and omits `_locales`; translations used inside the UI remain bundled in JavaScript.

```bash
pnpm run build:vivaldi
adb push dist-vivaldi /sdcard/Download/ShieldMonkeyVivaldi
```

In `vivaldi://extensions`, enable Developer mode and choose the `Download/ShieldMonkeyVivaldi` folder with **Load unpacked**. After loading, open the extension's **Details** and enable **Allow user scripts**.

## testing

You can run E2E tests to verify Shieldmonkey's functionality.

```bash
# Install Playwright Browsers (first time only)
pnpm exec playwright install chromium --with-deps

# Build the extension
pnpm run build

# Run E2E tests
pnpm run test:e2e
```

Tests include:
- Script installation and import
- Script management on the options page (create, edit, delete)
- Backup and restore functionality
- CSP policy verification
- Popup page behavior check
