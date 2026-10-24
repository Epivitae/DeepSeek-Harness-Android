#!/usr/bin/env bash
# Build the DSH Android client WITHOUT Gradle / AndroidX.
#
#   bash tools/build-apk.sh
#
# Outputs:
#   dist/dsh-client-debug.apk    debug-signed (debuggable; automation hooks on)
#   dist/DSH-Client-1.1.1.apk    release-signed universal APK (deliverable)
#
# Pipeline: bundle HTML assets -> aapt2 compile -> aapt2 link (release +
# debug manifest) -> javac (Java 8 bytecode) -> d8 -> add classes.dex ->
# zipalign -> apksigner. Requires the Debian Android SDK (platforms/android-31,
# build-tools/31.0.0), JDK 17 (javac/keytool), node, python3, zip.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SDK="${ANDROID_SDK_ROOT:-/usr/lib/android-sdk}"
BT="$SDK/build-tools/31.0.0"
PLATFORM="$SDK/platforms/android-31/android.jar"
AAPT2="$BT/aapt2"
D8="$BT/d8"
ZIPALIGN="$BT/zipalign"
APKSIGNER="$BT/apksigner"

BUILD="$ROOT/.build"
DIST="$ROOT/dist"
MANIFEST_RELEASE="$ROOT/app/AndroidManifest.xml"
MANIFEST_DEBUG="$ROOT/app/AndroidManifest-debug.xml"

DEBUG_KS="${DSH_DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"
RELEASE_KS="${DSH_RELEASE_KEYSTORE:-$HOME/.android/dsh-release.keystore}"
RELEASE_ALIAS="${DSH_RELEASE_ALIAS:-dshclient}"
RELEASE_STORE_PASS="${DSH_RELEASE_STORE_PASS:-dshclient}"
RELEASE_KEY_PASS="${DSH_RELEASE_KEY_PASS:-dshclient}"

MIN_SDK=24
TARGET_SDK=31
VERSION_CODE=3
VERSION_NAME="1.1.1"
DEBUG_VERSION_NAME="1.1.1-debug"

say() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- sanity check
say "checking toolchain"
for tool in "$AAPT2" "$D8" "$ZIPALIGN" "$APKSIGNER"; do
    [ -x "$tool" ] || die "missing executable: $tool"
done
[ -f "$PLATFORM" ] || die "missing android.jar: $PLATFORM"
for cmd in node javac keytool python3 zip; do
    command -v "$cmd" >/dev/null 2>&1 || die "missing command: $cmd"
done
for mf in "$MANIFEST_RELEASE" "$MANIFEST_DEBUG"; do
    [ -f "$mf" ] || die "missing manifest: $mf"
done
echo "SDK: $SDK"
echo "javac: $(javac -version 2>&1)"

# ------------------------------------------------------------------- 1. bundle
say "bundling web UI into app/assets/ui (tools/bundle-ui.mjs)"
node "$ROOT/tools/bundle-ui.mjs"

# ------------------------------------------------------------------ 2. aapt2
say "compiling resources (aapt2 compile)"
rm -rf "$BUILD"
mkdir -p "$BUILD/res" "$BUILD/gen-release" "$BUILD/gen-debug" "$BUILD/classes" \
    "$BUILD/dex" "$BUILD/apk/release" "$BUILD/apk/debug" "$DIST"
"$AAPT2" compile --dir "$ROOT/app/res" -o "$BUILD/res/resources.zip"

link_apk() {
    local manifest="$1" out="$2" genDir="$3" versionName="$4"
    "$AAPT2" link \
        -o "$out" \
        -I "$PLATFORM" \
        --manifest "$manifest" \
        -A "$ROOT/app/assets" \
        --java "$genDir" \
        --min-sdk-version "$MIN_SDK" \
        --target-sdk-version "$TARGET_SDK" \
        --version-code "$VERSION_CODE" \
        --version-name "$versionName" \
        "$BUILD/res/resources.zip"
}

say "linking release resources + assets"
link_apk "$MANIFEST_RELEASE" "$BUILD/apk/release/base.apk" "$BUILD/gen-release" "$VERSION_NAME"

say "linking debug resources + assets"
link_apk "$MANIFEST_DEBUG" "$BUILD/apk/debug/base.apk" "$BUILD/gen-debug" "$DEBUG_VERSION_NAME"

# ------------------------------------------------------------------- 3. javac
say "compiling Java (javac --release 8)"
find "$ROOT/app/src" "$BUILD/gen-release" -name '*.java' | sort > "$BUILD/sources.txt"
javac \
    --release 8 \
    -encoding UTF-8 \
    -Xlint:-options \
    -classpath "$PLATFORM" \
    -d "$BUILD/classes" \
    @"$BUILD/sources.txt"

# ---------------------------------------------------------------------- 4. d8
say "dexing with d8 (min-api $MIN_SDK)"
find "$BUILD/classes" -name '*.class' -print0 \
    | xargs -0 "$D8" --release --lib "$PLATFORM" --min-api "$MIN_SDK" --output "$BUILD/dex"
[ -f "$BUILD/dex/classes.dex" ] || die "d8 produced no classes.dex"

for mode in release debug; do
    python3 - "$BUILD/apk/$mode/base.apk" "$BUILD/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, "a", zipfile.ZIP_DEFLATED) as z:
    z.write(dex, "classes.dex")
print("added classes.dex to " + apk)
PY
    say "zipaligning ($mode)"
    "$ZIPALIGN" -f -p 4 "$BUILD/apk/$mode/base.apk" "$BUILD/apk/$mode/aligned.apk"
done

# ------------------------------------------------------------------- 5. sign
say "keystores"
mkdir -p "$(dirname "$DEBUG_KS")"
if [ ! -f "$DEBUG_KS" ]; then
    keytool -genkeypair \
        -keystore "$DEBUG_KS" \
        -storepass android -keypass android \
        -alias androiddebugkey \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=Android Debug,O=Android,C=US" >/dev/null
    echo "generated debug keystore: $DEBUG_KS"
else
    echo "using debug keystore: $DEBUG_KS"
fi
mkdir -p "$(dirname "$RELEASE_KS")"
if [ ! -f "$RELEASE_KS" ]; then
    keytool -genkeypair \
        -keystore "$RELEASE_KS" \
        -storepass "$RELEASE_STORE_PASS" -keypass "$RELEASE_KEY_PASS" \
        -alias "$RELEASE_ALIAS" \
        -keyalg RSA -keysize 2048 -validity 10000 \
        -dname "CN=DSH Client,O=DeepSeek Harness,C=CN" >/dev/null
    echo "generated release keystore: $RELEASE_KS (alias $RELEASE_ALIAS)"
else
    echo "using release keystore: $RELEASE_KS (alias $RELEASE_ALIAS)"
fi

say "signing debug APK"
rm -f "$DIST/dsh-client-debug.apk"
"$APKSIGNER" sign \
    --ks "$DEBUG_KS" \
    --ks-pass pass:android --key-pass pass:android \
    --ks-key-alias androiddebugkey \
    --min-sdk-version "$MIN_SDK" \
    --out "$DIST/dsh-client-debug.apk" \
    "$BUILD/apk/debug/aligned.apk"

say "signing release APK"
rm -f "$DIST/DSH-Client-$VERSION_NAME.apk"
"$APKSIGNER" sign \
    --ks "$RELEASE_KS" \
    --ks-pass "pass:$RELEASE_STORE_PASS" \
    --key-pass "pass:$RELEASE_KEY_PASS" \
    --ks-key-alias "$RELEASE_ALIAS" \
    --min-sdk-version "$MIN_SDK" \
    --out "$DIST/DSH-Client-$VERSION_NAME.apk" \
    "$BUILD/apk/release/aligned.apk"

# ------------------------------------------------------------------ 6. report
say "verify signatures"
for apk in "$DIST/dsh-client-debug.apk" "$DIST/DSH-Client-$VERSION_NAME.apk"; do
    echo "--- $apk"
    "$APKSIGNER" verify --print-certs "$apk" | head -n 4
done

say "done"
ls -lh "$DIST"/*.apk
sha256sum "$DIST"/*.apk
echo
echo "install debug (debuggable, automation hooks):"
echo "  adb install -r $DIST/dsh-client-debug.apk"
echo "install release (deliverable; uninstall debug build first - different signature):"
echo "  adb uninstall ai.deepseek.dshclient || true"
echo "  adb install $DIST/DSH-Client-$VERSION_NAME.apk"
echo "launch:"
echo "  adb shell am start -n ai.deepseek.dshclient/.MainActivity"
