# Building & installing the DSH Android client

The client is a plain Android app (no Gradle, no AndroidX) built with the Debian
Android SDK: `aapt2` → `javac` → `d8` → `zipalign` → `apksigner`.

## Requirements

- `/usr/lib/android-sdk` with `platforms/android-31` and `build-tools/31.0.0`
- JDK 17 (`javac`, `keytool`), Node 22 (`tools/bundle-ui.mjs`), `python3`, `zip`
- `adb` for installing on a device

## Build

```bash
bash tools/build-apk.sh
```

This runs `tools/bundle-ui.mjs` first (inlines `web/index.html` + its local CSS/JS
into `app/assets/ui/index.html`, so the WebView never makes relative asset
requests), then produces:

| output | signing | notes |
|---|---|---|
| `dist/dsh-client-debug.apk` | debug | `debuggable`, ships `ProofActivity`, enables the adb automation hook and WebView CDP |
| `dist/DSH-Client-1.2.1.apk` | release | universal APK, deliverable for the Honor phone; no diagnostic activity, not debuggable, WebView CDP gated off |

The two builds differ only by manifest (`app/AndroidManifest.xml` vs
`app/AndroidManifest-debug.xml`) and signing key. The release manifest declares just
the single launcher activity; the debug manifest adds `android:debuggable="true"`
and a diagnostic `ProofActivity` used for local WebView capability checks.

Signing details: [app/SIGNING.md](../app/SIGNING.md). The debug APK is Android's
standard debug key; the release APK is signed with a stable project keystore.
Both are `minSdk 24`, `targetSdk 31`, versionName `1.2.1` / versionCode `5`.

## Verification

The release APK was installed and exercised on a real target phone over adb
wireless debugging (Honor 50, Android 14 / MagicOS, arm64, 1080×2340):
native setup → token auth → home session list → open history → send prompt →
streamed reply → model sheet → settings → force-stop/relaunch auto-login. No
JavaScript errors were observed, and layout / IME / safe-area behaviour matched
the phone screenshots in [`docs/screenshots/`](screenshots).

Local device-proof evidence (`tools/android-proof/`) and captured live-session
frames (`tools/fixtures/`) are gitignored; they can be regenerated locally.

## Install on the Honor phone (target device)

1. **Transfer the APK**: copy `dist/DSH-Client-1.2.1.apk` to the phone (USB/MTP,
   `adb push`, cloud drive, Tailscale file transfer, ...).
2. **Allow install from unknown sources** for the app doing the install
   (Files/Chrome): Settings → Security → Install unknown apps → allow.
3. **Install** by tapping the APK. Or over USB with adb:
   ```bash
   adb install dist/DSH-Client-1.2.1.apk
   ```
4. Open **DSH**. The native dark setup screen asks for the server URL and token:
   - paste the whole URL printed by `dsh web` (`http://…:3080/?token=…`) into the
     first field — the token is parsed automatically, or use the **粘贴 / Paste**
     affordance next to each field;
   - tap **连接 / Connect**. The app authenticates natively, stores
     `{baseUrl, token}` locally, and loads the bundled UI (same-origin with the
     server: fetch + WebSocket + cookie).

### Connection options

| option | URL | when |
|---|---|---|
| LAN (same Wi-Fi as the host) | `http://192.168.1.10:3080/?token=…` | phone and host on the same network; needs cleartext HTTP (allowed by the app) |
| Tailscale | `https://<machine>.<tailnet>.ts.net:3080/?token=…` | phone on any network with Tailscale; HTTPS, no cleartext |

**Tokens rotate whenever `dsh web` restarts.** Get the current one from the
terminal that runs it (the `dsh web: <url>?token=…` line) or from the host:

```bash
journalctl -u <your-dsh-web-unit> --no-pager | grep 'dsh web:' | tail -1
# or read the URL printed by the terminal running `dsh web`
```

If the token is stale, the next launch shows the native setup screen with an
inline "令牌无效或已过期" error. To re-open setup from inside the app: UI settings
→ 更换服务器 / 重新登录 (calls `DSHNative.reset()`), or long-press the Menu key.

## Phone-specific behaviour

- The WebView is padded with system-bar / display-cutout / IME insets, so the
  composer stays above the keyboard (`adjustResize` semantics) and content is not
  hidden by the status bar, gesture bar or notch.
- The setup screen keeps **Connect** in a fixed bottom bar above the IME; fields
  use URI / visible-password input types (no Autocorrect) and 44dp+ touch targets.
- Back button: routed into the page (`window.DSH_onBack()`), then backgrounds the
  app. External links open in the system browser.
- `tools/build-apk.sh` targets Chrome-91-compatible WebView content; the release
  build keeps `usesCleartextTraffic=true` for LAN `http://` servers.
