#!/bin/bash
# Baut die iOS-App als Release, signiert manuell mit einem je Lauf erzeugten Distributionszertifikat
# und lädt sie zu TestFlight hoch (Vorgehen wie bei Meeterz – Cloud-Signierung ergab „Invalid Signature“).
# Benötigt: APPLE_TEAM_ID, ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_P8, GITHUB_RUN_NUMBER
set -o pipefail
BUNDLE_ID="de.hausgeist.koeven"
export CI_PREFIX="Hausgeist CI"
cd "$(dirname "$0")/../ios"

for v in APPLE_TEAM_ID ASC_KEY_ID ASC_ISSUER_ID ASC_KEY_P8; do
  [ -n "${!v}" ] || { echo "::error::Secret $v fehlt"; exit 20; }
done
xcodebuild -version

KEYDIR="$HOME/.appstoreconnect/private_keys"
mkdir -p "$KEYDIR"
printf "%s\n" "$ASC_KEY_P8" > "$KEYDIR/AuthKey_${ASC_KEY_ID}.p8"
export ASC_KEY_PATH="$KEYDIR/AuthKey_${ASC_KEY_ID}.p8"

brew list xcodegen >/dev/null 2>&1 || brew install xcodegen >/dev/null

# Release: Push gegen die Produktionsumgebung, fortlaufende Build-Nummer
sed -i '' 's/aps-environment: development/aps-environment: production/' project.yml
sed -i '' "s/CURRENT_PROJECT_VERSION: \"1\"/CURRENT_PROJECT_VERSION: \"${GITHUB_RUN_NUMBER:-1}\"/" project.yml

mkdir -p build
WORK="$PWD/build/signing"
PROFILE_NAME="$CI_PREFIX ${GITHUB_RUN_NUMBER:-0}-$(date +%s)"
KC="$PWD/build/ci.keychain-db"
trap 'security delete-keychain "$KC" >/dev/null 2>&1' EXIT

echo "== Alte CI-Zertifikate aufräumen"
python3 ../ci/asc.py purge
echo "== Zertifikat und Profil erzeugen"
python3 ../ci/asc.py create "$WORK" "$BUNDLE_ID" "$PROFILE_NAME"
[ -f "$WORK/ids.json" ] || { echo "::error::Zertifikat/Profil konnten nicht erzeugt werden"; exit 33; }
PROFILE_UUID=$(python3 -c "import json;print(json.load(open('$WORK/ids.json'))['uuid'])")

openssl x509 -inform DER -in "$WORK/cert.der" -out "$WORK/cert.pem"
openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -out "$WORK/sign.p12" -passout pass:ci -legacy >/dev/null 2>&1 \
  || openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" -out "$WORK/sign.p12" -passout pass:ci
security create-keychain -p ci "$KC"
security set-keychain-settings -lut 21600 "$KC"
security unlock-keychain -p ci "$KC"
for url in https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer https://www.apple.com/certificateauthority/AppleWWDRCAG6.cer; do
  curl -sfL "$url" -o "$WORK/ca.cer" && security import "$WORK/ca.cer" -k "$KC" -T /usr/bin/codesign >/dev/null 2>&1
done
security import "$WORK/sign.p12" -k "$KC" -P ci -T /usr/bin/codesign -T /usr/bin/security
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k ci "$KC" >/dev/null 2>&1
security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
security find-identity -v -p codesigning "$KC"

for d in "$HOME/Library/MobileDevice/Provisioning Profiles" "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"; do
  mkdir -p "$d" && cp "$WORK/profile.mobileprovision" "$d/$PROFILE_UUID.mobileprovision"
done

python3 - "$PROFILE_NAME" <<'PY'
import sys
s = open("project.yml").read()
assert "CODE_SIGN_STYLE: Automatic" in s
s = s.replace("CODE_SIGN_STYLE: Automatic",
              f'CODE_SIGN_STYLE: Manual\n        CODE_SIGN_IDENTITY: "Apple Distribution"\n        PROVISIONING_PROFILE_SPECIFIER: "{sys.argv[1]}"', 1)
open("project.yml", "w").write(s)
PY
xcodegen generate

echo "== Archivieren"
xcodebuild archive -project Hausgeist.xcodeproj -scheme Hausgeist -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/Hausgeist.xcarchive \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" > archive.log 2>&1
RES=$?
grep -E "error:|ARCHIVE (SUCCEEDED|FAILED)" archive.log | sort -u | head -30
[ $RES -eq 0 ] || { tail -40 archive.log; echo "::error::Archivieren fehlgeschlagen"; exit 30; }

cat > build/ExportOptions.plist <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>teamID</key><string>${APPLE_TEAM_ID}</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key><dict><key>${BUNDLE_ID}</key><string>${PROFILE_NAME}</string></dict>
  <key>uploadSymbols</key><false/>
  <key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
PL

echo "== Exportieren"
xcodebuild -exportArchive -archivePath build/Hausgeist.xcarchive \
  -exportOptionsPlist build/ExportOptions.plist -exportPath build/export > export.log 2>&1
RES=$?
grep -iE "error|EXPORT" export.log | sort -u | head -20
[ $RES -eq 0 ] || { echo "::error::Export fehlgeschlagen"; exit 31; }
IPA=$(ls build/export/*.ipa | head -1)
rm -rf build/ipa-check && mkdir -p build/ipa-check && unzip -q "$IPA" -d build/ipa-check
codesign -dvv build/ipa-check/Payload/*.app 2>&1 | grep -E "Authority|TeamIdentifier"

echo "== Hochladen"
xcrun altool --upload-app -f "$IPA" -t ios --apiKey "$ASC_KEY_ID" --apiIssuer "$ASC_ISSUER_ID" > upload.log 2>&1
RES=$?
tail -20 upload.log
[ $RES -eq 0 ] || { echo "::error::Upload fehlgeschlagen"; exit 32; }
echo "### Build ${GITHUB_RUN_NUMBER} ist zu TestFlight hochgeladen" >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
echo "Nach der Verarbeitung (meist 5–15 Minuten) erscheint er in App Store Connect unter TestFlight." >> "${GITHUB_STEP_SUMMARY:-/dev/null}"
