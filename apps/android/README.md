# TaskFlow for company Android phones

The TaskFlow web client in a thin Android shell (Capacitor 8.5.3), plus one
native plugin, **TaskFlowPhone**, that lets TaskFlow:

- dial on the company SIM when someone taps **Call**;
- read the call log for the exact time and length of calls with leads and
  customers (every other call is checked on the phone and never sent);
- find the recording of such a call in the folder the person chose, send it,
  and remove the phone's copy once TaskFlow holds exactly that file;
- sync every 15 minutes, and soon after each call.

How calling works end to end, the privacy design and the rollout steps are in
[docs/SIM_CALLING.md](../../docs/SIM_CALLING.md). This file is about building and
installing the app.

> **Status.** This app has not been built into an APK or run on a phone yet.
> The build machine here had no Android SDK. What was checked: the plain-Java
> logic has JUnit tests (`npm run test:java`), and the Android code was
> type-checked against Android 16's framework classes and Capacitor's API.
> The first signed build and the real-phone checklist in docs/SIM_CALLING.md
> come before any rollout.

## How it is put together

| Part | Where |
| --- | --- |
| Capacitor project (generated, then edited) | `android/` |
| The plugin | `android/app/src/main/java/com/ekosight/taskflow/phone/` |
| Plain-Java logic, tested on its own | `Numbers`, `CallLogPicker`, `RecordingMatcher`, `Versions` |
| Its tests | `android/app/src/test/java/com/ekosight/taskflow/phone/` |
| The web side | `client/src/lib/phoneBridge.js`, `client/src/components/sales/PhoneCall.jsx`, `client/src/pages/PhoneSetup.jsx` |
| What the phone may reach on the server | `server/src/routes/device.js` (`/api/taskflow/device/…`, device token only) |

The app opens the company's TaskFlow address, so the screens are the same
TaskFlow everyone uses in a browser, and deploying TaskFlow updates them
without a new app. Only that address may load inside the app (Capacitor's
`allowNavigation`), so only TaskFlow's own pages can use the phone features;
every other link opens in the phone's browser. The plugin also refuses to be
signed in to any other address.

The plugin uses only Android's own APIs (JobScheduler for the background sync,
the Storage Access Framework for the folder), so it adds no libraries to the app.

## Before the first build: decide these once

- **The TaskFlow address**, `https://…` only: `TASKFLOW_URL`.
- **The application id** (`TASKFLOW_APP_ID`, default `com.ekosight.taskflow`).
  Phones treat a different id as a different app, so it cannot change after the
  first install.
- **The signing key.** Create it once and keep it out of the repository, backed
  up in two safe places. A phone only accepts an update signed with the same
  key; without it, every phone would have to uninstall and reinstall.

  ```sh
  keytool -genkeypair -v -keystore taskflow-release.jks -alias taskflow \
    -keyalg RSA -keysize 4096 -validity 10000
  ```

## Building a release

Needs Node 22, JDK 21 and the Android SDK (platform 36, build tools) with
`ANDROID_HOME` set.

```sh
cd apps/android
npm ci
export TASKFLOW_URL=https://taskflow.example.com      # the company's address
export TASKFLOW_VERSION_NAME=1.0.0                     # shown to people
export TASKFLOW_VERSION_CODE=1                         # +1 for every release
export TASKFLOW_KEYSTORE=/secure/path/taskflow-release.jks
export TASKFLOW_KEYSTORE_PASSWORD=…  TASKFLOW_KEY_ALIAS=taskflow  TASKFLOW_KEY_PASSWORD=…
npm run build:release
# → android/app/build/outputs/apk/release/app-release.apk
```

`npm run build:release` writes `capacitor.config.json` from the environment
(it holds the company address, so it is not committed), copies it into the
Android project and runs Gradle. Without the `TASKFLOW_KEYSTORE…` variables
the release is left unsigned, and phones will not install it.

In CI, keep the keystore and passwords as secrets; never print them.

## Tests

```sh
npm run test:java          # no Android SDK needed: JUnit against the shared answers
cd android && ./gradlew test   # the same tests, on a machine with the SDK
```

The phone-number rules (normalising, salted hashes) are tested against
`shared/callingVectors.json`, which the server's tests check too, so the phone
and the server cannot drift apart.

## Getting it onto company phones

Upload the signed APK in **Settings → Sales CRM → Calls from company phones →
Phones & the app**. Phones that already have the app offer the update in their
setup page.

1. **Device management (preferred for company phones).** Push the APK from the
   company's device management tool, which installs and updates it without
   anyone touching "unknown apps". Some tools can also pre-grant the app's
   permissions or exempt it from battery optimisation; check what the
   company's own tool supports before relying on it.
2. **Without device management.** On the phone, open TaskFlow in the browser,
   go to **Settings → My account → Calls from a company phone → Download the
   Android app** (a private link that lasts 30 minutes), and allow "Install
   unknown apps" for the browser when Android asks. Turn that permission off
   again afterwards.

Then open the app, sign in as usual, and follow **Set up this phone for
calls**.

## Permissions, and why

| Permission | Why |
| --- | --- |
| Phone (`CALL_PHONE`, `READ_PHONE_STATE`, `READ_PHONE_NUMBERS`) | Dial on the company SIM, know when the call ends, show the SIM's number |
| Call history (`READ_CALL_LOG`) | The time and length of calls with leads and customers |
| Notifications | "How did the call go?" after a call, and problems with syncing |
| Battery optimisation exemption (asked once) | So background sync is not stopped |

No storage permission: recordings are read, and removed, only inside the
folder the person picks, through the access that choice gives. The app does
not record audio itself (Android 10 and later do not allow ordinary apps to
record calls); it relies on the phone's own dialler.

Google Play restricts call-log access, so this app is meant for company phones
through device management or a private download, not the Play Store.

## The plugin's methods

All return promises; errors are plain sentences.

| Method | Does |
| --- | --- |
| `phoneInfo()` | Install id, maker, model, Android version, app version, default dialler |
| `status()` | Signed in or not, company SIM, folder, last sync, last problem, setup ticks |
| `checkPermissions()` / `requestPermissions()` | `phone`, `callLog`, `notifications` |
| `listSims()` / `setWorkSim({ id })` | The SIMs; a phone with one SIM uses it without asking |
| `batteryStatus()` / `openBatterySettings()` | Whether TaskFlow is exempt from battery optimisation |
| `pickRecordingsFolder()` | Android's folder picker, with lasting access |
| `configure({ apiBase, token, deviceId, userId, userName })` | Signs the phone in (TaskFlow's own address only) |
| `heartbeat()` / `saveSetup({ setup })` | Tells TaskFlow how the phone is set up |
| `placeCall({ number, callId })` | Dials on the company SIM; refuses an opted-out number when offline |
| `syncNow()` | One sync now |
| `signOut()` | Sends what is waiting, then ends this person's use of the phone |
| `sharedRecording()` / `attachShared({ callId })` / `dropShared()` | A recording shared into the app |
| `appUpdate()` / `openUrl({ url })` | A newer version, and its download |

## Keeping it working

- **Battery.** Samsung: Settings → Apps → TaskFlow → Battery → Unrestricted.
  OPPO (ColorOS): Settings → Battery → (More settings →) App battery
  management → TaskFlow → allow background activity and auto-launch.
  Motorola: Settings → Apps → TaskFlow → App battery usage → Unrestricted.
  Menu names differ between versions; the setup page opens the right screen
  where Android allows it.
- **Stopped apps.** If someone force-stops the app, Android cancels its
  background sync until it is opened again; the next sync starts from the last
  call-log entry it sent, so nothing is skipped or sent twice.
- **A new person on the phone.** An administrator uses **Hand to someone else**,
  or the person signs out in the setup page. Calls before that stay with the
  earlier person; the new person's calls start when they sign in.
