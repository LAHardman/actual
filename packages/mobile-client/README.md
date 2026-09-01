# Mobile client (personal use)

This package wraps the built Actual web client in a [Capacitor](https://capacitorjs.com/)
native shell so you can run Actual as a real app on your own iPhone and Android
phone, alongside the desktop app. It is set up for **personal sideloading**, not
for App Store or Play Store distribution.

## How it works

There is no separate mobile UI to maintain. The app loads the same build the web
client produces (`packages/desktop-client/build`), rendered with Actual's
existing narrow-width mobile layout. The budget engine (`loot-core`) runs inside
the WebView as WASM SQLite, exactly as it does in a browser.

This is also why the app is a Capacitor WebView rather than a React Native /
Expo app: the engine depends on browser APIs (Web Workers, WASM SQLite,
`SharedArrayBuffer`) that React Native does not provide.

## Prerequisites

- Node.js >= 22 and Yarn ^4.9.1 (see the repo root `README.md`)
- **iOS:** macOS with Xcode, CocoaPods (`brew install cocoapods`), and an Apple
  ID. iOS apps cannot be built on Linux or Windows.
- **Android:** Android Studio with the SDK and platform tools, plus a JDK 21.
  Set `ANDROID_HOME` to your SDK location.

Run `yarn install` from the repo root first.

## Build the web bundle first

Every native build serves a pre-built web bundle, so build it before syncing:

```bash
yarn build:browser
```

The root `start:*` and `build:mobile` scripts below do this for you.

## Android

Live-reload onto a connected device or emulator:

```bash
yarn start:android
```

Build a debug APK you can keep:

```bash
yarn build:browser
yarn workspace mobile-client build:android
```

The APK lands in `packages/mobile-client/build/app-debug.apk`. Install it with:

```bash
adb install -r packages/mobile-client/build/app-debug.apk
```

You can also copy the APK to the phone and open it, after enabling
"install unknown apps" for your file manager.

## iOS

```bash
yarn build:browser
yarn workspace mobile-client sync:ios
open packages/mobile-client/ios/App/App.xcworkspace
```

Then, in Xcode:

1. Select the **App** target → **Signing & Capabilities**.
2. Change **Bundle Identifier** from `org.actualbudget` to something unique to
   you, e.g. `com.yourname.actualbudget`. Free provisioning registers this ID
   against your Apple ID, so it cannot clash with the upstream project's.
3. Tick **Automatically manage signing** and pick your personal team (adding
   your Apple ID under Xcode → Settings → Accounts creates one).
4. Select your iPhone as the run destination and press Run.

The first launch will fail to open until you trust the certificate on the phone:
**Settings → General → VPN & Device Management →** your Apple ID **→ Trust**.

> **Free Apple ID builds expire after 7 days.** The app stays installed but
> stops launching until you rebuild and re-run from Xcode. A paid Apple
> Developer account ($99/year) extends this to a year. Your budget data is not
> affected by re-signing.

`yarn start:ios` does the same thing with live reload, for iterating on the UI.

## Development vs. release builds

`capacitor.config.ts` switches on `NODE_ENV`. Without it set, the app is
packaged with the **development** configuration, which allows cleartext HTTP and
mixed content so an emulator can reach a local sync server. That is convenient
while iterating, but you do not want it on the phone you actually use.

The `release:*` scripts set `NODE_ENV=production`, which drops that block:

```bash
yarn build:browser
yarn workspace mobile-client release:android   # or release:ios
```

The `build:*` and `start:*` scripts intentionally keep the development
configuration.

## Syncing with the desktop app

The phone and desktop sync through a **sync server** — a budget file kept only
on one device does not sync. If you do not already run one:

```bash
yarn start:server
```

In the app, choose **Use a server** on the welcome screen and enter the server's
URL, then open the same budget file you use on desktop.

A few things worth knowing:

- The URL has to be reachable from the phone. `localhost` refers to the phone
  itself, so use the machine's LAN address (e.g. `http://192.168.1.10:5006`) or
  a public hostname.
- Prefer HTTPS. iOS App Transport Security blocks plain HTTP by default; the
  development Capacitor config only whitelists `localhost` and `10.0.2.2`
  (the Android emulator's alias for your host machine).
- Putting the sync server behind a reverse proxy with a real certificate is the
  most reliable setup for day-to-day use.

## Troubleshooting

**"Actual requires access to SharedArrayBuffer"** — the WebView is not
cross-origin isolated. The error screen offers an unsupported fallback mode;
read the warning first, as Actual uses `SharedArrayBuffer` to keep concurrent
access to a budget file safe.

**Blank screen after launching** — the web bundle is missing or stale. Re-run
`yarn build:browser` followed by `yarn workspace mobile-client sync:ios`
(or `sync:android`).

**Android emulator cannot reach the sync server** — use `http://10.0.2.2:5006`
rather than `localhost`, which the emulator resolves to itself.
