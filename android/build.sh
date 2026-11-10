#!/usr/bin/env bash
# Build InkBoard without Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
# Signing: many e-ink ROMs are signed with the public AOSP test keys. If yours is, signing InkBoard with the
# AOSP *platform* key makes it a system-uid app (front light, refresh API, settings) without root.
# Put platform.pk8 + platform.x509.pem from AOSP build/make/target/product/security/ into keys/.
# Otherwise set KEY/CERT to your own key; the app still works, minus the system-only features.
# Usage: ./build.sh [--install]
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_SDK:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/34.0.0"
JAR="$SDK/platforms/android-27/android.jar"
export JAVA_HOME="${JAVA_HOME_17:-/opt/homebrew/opt/openjdk@17}"
ADB="${ADB:-$(command -v adb || ls -d "$HOME"/Library/Android/*/platform-tools/adb 2>/dev/null | head -1)}"

VERSION_CODE=$(( ($(date +%s) - 1767225600) / 60 ))   # minutes since 2026-01-01
VERSION_NAME="1.0.$VERSION_CODE"

rm -rf build && mkdir -p build/gen build/classes build/dex
"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -I "$JAR" --manifest AndroidManifest.xml -A assets \
  --min-sdk-version 27 --target-sdk-version 27 \
  --version-code "$VERSION_CODE" --version-name "$VERSION_NAME" \
  --java build/gen -o build/unsigned.apk build/res.zip
"$JAVA_HOME/bin/javac" -nowarn -source 8 -target 8 -encoding UTF-8 -cp "$JAR" -d build/classes \
  $(find src build/gen -name '*.java') 2>&1 | grep -v "^warning" || true
"$BT/d8" --min-api 27 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
(cd build/dex && zip -q ../unsigned.apk classes.dex)
"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk
KEY="${KEY:-keys/platform.pk8}"; CERT="${CERT:-keys/platform.x509.pem}"
[[ -f "$KEY" && -f "$CERT" ]] || { echo "缺签名密钥：把 platform.pk8 / platform.x509.pem 放进 android/keys/（见脚本开头说明）"; exit 1; }
"$BT/apksigner" sign --key "$KEY" --cert "$CERT" --out build/inkboard.apk build/aligned.apk
echo "built build/inkboard.apk ($VERSION_NAME)"

if [[ "${1:-}" == "--install" ]]; then
  "$ADB" install -r build/inkboard.apk
  "$ADB" shell am start -n com.inkboard/.MainActivity >/dev/null
fi
