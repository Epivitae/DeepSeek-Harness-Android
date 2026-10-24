# Signing

Both APKs are produced by `bash tools/build-apk.sh`; no Gradle involved.

## Keystores

Keystores are **not committed to this repository**:

| build | signing key | notes |
|---|---|---|
| debug (`dist/dsh-client-debug.apk`) | standard Android debug key (`~/.android/debug.keystore`, generated automatically) | debuggable, ships the local proof activity |
| release (`dist/DSH-Client-1.1.1.apk`) | project release key, generated on first release build or supplied via env vars | universal APK for sideloading |

The release key is a self-signed RSA-2048 certificate (`CN=DSH Client`). Provide it
through environment variables (never commit the keystore or passwords):

```bash
DSH_RELEASE_KEYSTORE=/path/to/dsh-release.keystore \
DSH_RELEASE_ALIAS=dshclient \
DSH_RELEASE_STORE_PASS=... \
DSH_RELEASE_KEY_PASS=... \
bash tools/build-apk.sh
```

If no release key is supplied, `tools/build-apk.sh` generates a local one under
`~/.android/` so builds remain reproducible for development.

## Important

- Keep your release keystore and passwords backed up: Android only accepts an APK
  update signed with the same key. Losing it means users must uninstall/reinstall.
- Debug and release APKs share the package name `ai.deepseek.dshclient` but have
  different signatures; switch builds with `adb uninstall ai.deepseek.dshclient`.
- The release manifest (`app/AndroidManifest.xml`) is not `debuggable`; the
  debug-only intent automation (`--es dshAutoUrl`) and `run-as` are unavailable in
  the release APK. The debug manifest enables them for development.
