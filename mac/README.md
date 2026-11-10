# ANVIL Crew (macOS)

A small native window (AppKit + WKWebView, ~370 KB, no bundled browser) onto the ANVIL Crew web app. It is not a second server: it shows the instance served at `http://127.0.0.1:3080/`, reached on this Mac through the `com.anvil.dsh-fabric-tunnel` LaunchAgent.

## Build / install

```sh
mac/build.sh             # builds mac/build/ANVIL Crew.app (arm64, Swift 6 mode, warnings are errors)
mac/build.sh --install   # also replaces /Applications/ANVIL Crew.app (quits a running copy first)
```

The icon is rendered from `ds-bot/assets/brand/icon.svg` when present, otherwise from `mac/icon.svg`. The bundle is signed ad hoc (`codesign -s -`). Set `ANVIL_CREW_URL` in the environment to point a process at another base URL (used for testing the unreachable view).

## Sign-in

On launch the app loads `/`. If the main-frame response is 401 it runs `~/.local/bin/dsbot url` off the main thread and loads the returned `?token=` URL, which sets the 30-day session cookie in the default persistent WebKit store. At most one automatic attempt per 30 seconds. The token is never logged, shown or written to disk. If the server or `dsbot` is unreachable, a native status view shows `dsbot status` with Retry and Restart tunnel, and retries every 10 s. The Fabric menu offers Open in Browser, Copy Phone Link (clipboard only, marked concealed) and Fabric Status.

## Signed / notarized build later

Needs a Developer ID Application certificate, `codesign --options runtime` (hardened runtime) with an entitlements file containing `com.apple.security.device.audio-input` (microphone), then `notarytool submit` and `stapler staple`. The app is not sandboxed because it runs `dsbot` and `launchctl`.
