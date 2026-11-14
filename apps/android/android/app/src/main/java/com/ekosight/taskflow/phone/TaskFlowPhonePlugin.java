package com.ekosight.taskflow.phone;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.telecom.PhoneAccountHandle;
import android.telecom.TelecomManager;
import android.telephony.SubscriptionInfo;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * TaskFlowPhone: what the TaskFlow web client asks of a company Android phone
 * (client/src/lib/phoneBridge.js). It dials on the company SIM, reads the call
 * log, finds recordings in the folder the person chose, and syncs, sending only
 * calls with leads and customers. Every method answers in plain words.
 */
@CapacitorPlugin(
    name = "TaskFlowPhone",
    permissions = {
        @Permission(alias = "phone", strings = { Manifest.permission.CALL_PHONE, Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_PHONE_NUMBERS }),
        @Permission(alias = "callLog", strings = { Manifest.permission.READ_CALL_LOG }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }),
    }
)
public class TaskFlowPhonePlugin extends Plugin {
    private final ExecutorService work = Executors.newSingleThreadExecutor();
    private PhoneStore store;
    private CallWatcher watcher;

    @Override
    public void load() {
        store = new PhoneStore(getContext());
        watcher = new CallWatcher(getContext());
        Notifier.createChannel(getContext());
        if (store.configured()) SyncJob.schedule(getContext());
        Activity activity = getActivity();
        if (activity != null) keepShared(activity.getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        keepShared(intent);
    }

    @Override
    protected void handleOnResume() {
        if (store != null && store.configured()) SyncJob.soon(getContext(), 2_000);
    }

    @Override
    protected void handleOnDestroy() {
        work.shutdown();
    }

    /** A recording shared to TaskFlow from another app waits for "Which call is this?". */
    private void keepShared(Intent intent) {
        JSONObject shared = SharedRecording.take(getContext(), intent);
        if (shared == null) return;
        SharedRecording.discard(store.shared());
        store.setShared(shared);
        notifyListeners("sharedRecording", toJs(shared), true);
    }

    // ------------------------------------------------------------ helpers

    private static JSObject toJs(JSONObject o) {
        try {
            return o == null ? new JSObject() : JSObject.fromJSONObject(o);
        } catch (JSONException e) {
            return new JSObject();
        }
    }

    /** A number the page sent: JSON numbers arrive as Integer or Long. */
    private static Long number(PluginCall call, String name) {
        Object v = call.getData().opt(name);
        return v instanceof Number ? Long.valueOf(((Number) v).longValue()) : null;
    }

    private void background(PluginCall call, Task task) {
        work.execute(() -> {
            try {
                call.resolve(task.run());
            } catch (ApiClient.Failure f) {
                call.reject(f.getMessage(), f.code);
            } catch (IOException e) {
                call.reject("No connection to TaskFlow. Try again when the phone is online.");
            } catch (JSONException | RuntimeException e) {
                call.reject("Something went wrong on the phone: " + e.getMessage());
            }
        });
    }

    private interface Task {
        JSObject run() throws IOException, JSONException;
    }

    private boolean policyAccepted() {
        JSONObject config = store.config();
        JSONObject policy = config == null ? null : config.optJSONObject("policy");
        return policy == null || policy.optBoolean("acknowledged");
    }

    // ------------------------------------------------------------ the phone

    @PluginMethod
    public void phoneInfo(PluginCall call) {
        String dialler = DeviceFacts.diallerPackage(getContext());
        JSObject out = new JSObject();
        out.put("installId", store.installId());
        out.put("maker", Build.MANUFACTURER);
        out.put("model", Build.MODEL);
        out.put("androidVersion", Build.VERSION.RELEASE);
        out.put("sdk", Build.VERSION.SDK_INT);
        out.put("appVersion", DeviceFacts.appVersion(getContext()));
        out.put("diallerPackage", dialler);
        out.put("diallerLabel", DeviceFacts.diallerLabel(getContext(), dialler));
        call.resolve(out);
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject out = new JSObject();
        out.put("configured", store.configured());
        out.put("installId", store.installId());
        if (store.configured()) {
            out.put("deviceId", store.deviceId());
            out.put("userId", store.userId());
            out.put("userName", store.userName());
        }
        if (store.workSimId() >= 0) {
            JSObject sim = new JSObject();
            sim.put("id", store.workSimId());
            sim.put("label", store.workSimLabel());
            if (store.workSimNumber() != null) sim.put("number", store.workSimNumber());
            out.put("workSim", sim);
        }
        if (store.folderUri() != null) {
            JSObject folder = new JSObject();
            folder.put("uri", store.folderUri());
            folder.put("name", store.folderName());
            out.put("folder", folder);
        }
        if (store.lastSyncAt() > 0) out.put("lastSyncAt", SyncEngine.iso(store.lastSyncAt()));
        out.put("lastError", store.lastError());
        out.put("setup", toJs(store.setup()));
        if (store.config() != null) out.put("config", toJs(store.config()));
        if (store.recordingMode() != null) out.put("recordingMode", toJs(store.recordingMode()));
        call.resolve(out);
    }

    // ------------------------------------------------------------ permissions

    private String stateOf(String alias) {
        if ("notifications".equals(alias) && Build.VERSION.SDK_INT < 33) return "granted";
        PermissionState s = getPermissionState(alias);
        return s == null ? "prompt" : s.toString();
    }

    private JSObject permissionStates() {
        JSObject out = new JSObject();
        out.put("phone", stateOf("phone"));
        out.put("callLog", stateOf("callLog"));
        out.put("notifications", stateOf("notifications"));
        return out;
    }

    @Override
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        call.resolve(permissionStates());
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        List<String> aliases = new ArrayList<>();
        aliases.add("phone");
        aliases.add("callLog");
        if (Build.VERSION.SDK_INT >= 33) aliases.add("notifications");
        requestPermissionForAliases(aliases.toArray(new String[0]), call, "permissionsAnswered");
    }

    @PermissionCallback
    private void permissionsAnswered(PluginCall call) {
        call.resolve(permissionStates());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    // ------------------------------------------------------------ the company SIM

    @PluginMethod
    public void listSims(PluginCall call) {
        JSArray sims = new JSArray();
        try {
            for (SubscriptionInfo info : Sims.active(getContext())) sims.put(Sims.describe(getContext(), info));
        } catch (JSONException e) {
            call.reject("Could not read the SIMs");
            return;
        }
        // a phone with one SIM uses it, without asking
        if (sims.length() == 1 && store.workSimId() < 0) {
            JSONObject only = sims.optJSONObject(0);
            store.setWorkSim(only.optInt("id"), only.optString("label"), only.optString("number", null));
        }
        JSObject out = new JSObject();
        out.put("sims", sims);
        call.resolve(out);
    }

    @PluginMethod
    public void setWorkSim(PluginCall call) {
        Long id = number(call, "id");
        SubscriptionInfo info = id == null ? null : Sims.find(getContext(), id.intValue());
        if (info == null) {
            call.reject("That SIM is not in the phone");
            return;
        }
        store.setWorkSim(info.getSubscriptionId(), Sims.labelOf(info), Sims.numberOf(getContext(), info));
        call.resolve();
    }

    // ------------------------------------------------------------ battery

    @PluginMethod
    public void batteryStatus(PluginCall call) {
        JSObject out = new JSObject();
        out.put("unrestricted", DeviceFacts.batteryUnrestricted(getContext()));
        call.resolve(out);
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        Context ctx = getContext();
        Intent ask = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + ctx.getPackageName()));
        ask.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            ctx.startActivity(ask);
        } catch (ActivityNotFoundException e) {
            Intent list = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            list.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(list);
        }
        call.resolve();
    }

    // ------------------------------------------------------------ the recordings folder

    @PluginMethod
    public void pickRecordingsFolder(PluginCall call) {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, pick, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        Uri tree = data == null ? null : data.getData();
        if (result.getResultCode() != Activity.RESULT_OK || tree == null) {
            call.reject("cancelled");
            return;
        }
        try {
            getContext().getContentResolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (SecurityException e) {
            call.reject("Android did not let TaskFlow keep access to that folder. Choose it again.");
            return;
        }
        String previous = store.folderUri();
        if (previous != null && !previous.equals(tree.toString())) {
            try {
                getContext().getContentResolver().releasePersistableUriPermission(Uri.parse(previous), Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            } catch (SecurityException ignored) {
                // already gone
            }
        }
        String name = Folder.name(getContext(), tree);
        store.setFolder(tree.toString(), name == null ? "Chosen folder" : name);
        JSObject out = new JSObject();
        out.put("uri", tree.toString());
        out.put("name", store.folderName());
        call.resolve(out);
    }

    // ------------------------------------------------------------ signing the phone in and out

    @PluginMethod
    public void configure(PluginCall call) {
        String apiBase = call.getString("apiBase");
        String token = call.getString("token");
        Long deviceId = number(call, "deviceId");
        Long userId = number(call, "userId");
        // only the TaskFlow this app opens may sign the phone in
        String server = getBridge().getServerUrl();
        Uri api = apiBase == null ? null : Uri.parse(apiBase);
        Uri own = server == null ? null : Uri.parse(server);
        if (api == null || own == null || !"https".equals(api.getScheme()) || api.getHost() == null || !api.getHost().equals(own.getHost())) {
            call.reject("This phone can only be signed in to the TaskFlow it opens");
            return;
        }
        if (token == null || token.length() < 20 || deviceId == null || userId == null) {
            call.reject("TaskFlow did not send what the phone needs to sign in");
            return;
        }
        JSObject mode = call.getObject("recordingMode");
        store.signIn(apiBase, token, deviceId, userId, call.getString("userName"), mode);
        SyncJob.schedule(getContext());
        SyncJob.soon(getContext(), 1_000);
        call.resolve();
    }

    @PluginMethod
    public void heartbeat(PluginCall call) {
        if (!store.configured()) {
            call.reject("This phone is not set up for TaskFlow yet");
            return;
        }
        background(call, () -> {
            JSONObject config = SyncEngine.api(getContext(), store).post("/device/heartbeat", SyncEngine.heartbeatBody(getContext(), store));
            store.setConfig(config);
            return toJs(config);
        });
    }

    @PluginMethod
    public void saveSetup(PluginCall call) {
        JSObject setup = call.getObject("setup");
        store.setSetup(setup == null ? new JSONObject() : setup);
        call.resolve();
    }

    @PluginMethod
    public void syncNow(PluginCall call) {
        work.execute(() -> {
            SyncEngine.Outcome o = SyncEngine.run(getContext());
            if (o.error != null) {
                call.reject(o.error);
                return;
            }
            JSObject out = new JSObject();
            out.put("sent", o.sent);
            out.put("recordings", o.recordings);
            out.put("removed", o.removed);
            call.resolve(out);
        });
    }

    /** Signing out sends what is waiting first; earlier calls stay with this person. */
    @PluginMethod
    public void signOut(PluginCall call) {
        if (!store.configured()) {
            call.resolve();
            return;
        }
        background(call, () -> {
            SyncEngine.run(getContext());
            if (store.configured()) {
                try {
                    SyncEngine.api(getContext(), store).post("/device/sign-out", new JSONObject());
                } catch (ApiClient.Failure f) {
                    if (f.status != 401 && f.status != 403) throw f;
                }
            }
            store.signOut();
            SyncJob.cancel(getContext());
            return new JSObject();
        });
    }

    // ------------------------------------------------------------ calling

    /**
     * Dials at once on the company SIM. A call TaskFlow already allowed has its
     * id; one started with no connection does not, and is refused here when the
     * number asked not to be called, unless they rang the phone in the last day.
     */
    @SuppressLint("MissingPermission") // checked by DeviceFacts.canPlaceCalls; a SecurityException is caught
    @PluginMethod
    public void placeCall(PluginCall call) {
        Context ctx = getContext();
        String number = call.getString("number");
        String normalised = Numbers.normalise(number);
        Long callId = number(call, "callId");
        if (normalised == null) {
            call.reject("That is not a phone number");
            return;
        }
        if (!store.configured()) {
            call.reject("Set up this phone for your calls first");
            return;
        }
        if (!policyAccepted()) {
            call.reject("Read and accept the company phone policy in the phone setup first");
            return;
        }
        if (!DeviceFacts.canPlaceCalls(ctx)) {
            call.reject("Allow phone calls in the phone setup first");
            return;
        }
        if (callId == null) {
            PhoneStore.NumberList list = store.numbers();
            if (list != null && list.salt != null && list.optedOut.contains(Numbers.hash(list.salt, normalised))) {
                boolean theyRang = DeviceFacts.canReadCallLog(ctx) && CallLogReader.calledUsSince(ctx, normalised, System.currentTimeMillis() - 86_400_000L);
                if (!theyRang) {
                    call.reject("This number asked not to be called.", "OPTED_OUT");
                    return;
                }
            }
        }
        TelecomManager telecom = ctx.getSystemService(TelecomManager.class);
        if (telecom == null) {
            call.reject("This phone cannot place calls");
            return;
        }
        Bundle extras = new Bundle();
        PhoneAccountHandle sim = Sims.handleFor(ctx, store.workSimId());
        if (sim != null) extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, sim);
        if (callId != null) store.addPending(callId, normalised, System.currentTimeMillis());
        watcher.start(() -> {
            SyncJob.soon(ctx, 4_000);
            Notifier.callEnded(ctx);
        });
        try {
            telecom.placeCall(Uri.fromParts("tel", number, null), extras);
        } catch (SecurityException e) {
            watcher.stop();
            call.reject("Allow phone calls in the phone setup first");
            return;
        }
        JSObject out = new JSObject();
        out.put("placed", true);
        out.put("sim", store.workSimLabel());
        call.resolve(out);
    }

    // ------------------------------------------------------------ a recording shared into the app

    @PluginMethod
    public void sharedRecording(PluginCall call) {
        JSONObject shared = store.shared();
        JSObject out = new JSObject();
        if (shared != null) {
            out.put("name", shared.optString("name"));
            out.put("size", shared.optLong("size"));
            if (shared.has("lastModified")) out.put("lastModified", shared.optLong("lastModified"));
        }
        out.put("waiting", shared != null);
        call.resolve(out);
    }

    @PluginMethod
    public void attachShared(PluginCall call) {
        JSONObject shared = store.shared();
        Long callId = number(call, "callId");
        if (shared == null || callId == null) {
            call.reject(shared == null ? "Nothing was shared" : "Choose the call");
            return;
        }
        if (!store.configured()) {
            call.reject("Set up this phone for your calls first");
            return;
        }
        background(call, () -> {
            JSONObject r = SyncEngine.attachShared(getContext(), store, shared, callId);
            SharedRecording.discard(shared);
            store.setShared(null);
            return toJs(r);
        });
    }

    @PluginMethod
    public void dropShared(PluginCall call) {
        SharedRecording.discard(store.shared());
        store.setShared(null);
        call.resolve();
    }

    // ------------------------------------------------------------ the app itself

    /** The version on the phone and the newest one TaskFlow offers, with a short-lived download link. */
    @PluginMethod
    public void appUpdate(PluginCall call) {
        if (!store.configured()) {
            call.reject("This phone is not set up for TaskFlow yet");
            return;
        }
        background(call, () -> {
            JSONObject r = SyncEngine.api(getContext(), store).get("/device/app");
            String current = DeviceFacts.appVersion(getContext());
            String latest = r.optString("version", null);
            JSObject out = new JSObject();
            out.put("current", current);
            out.put("latest", latest);
            out.put("newer", latest != null && Versions.newer(latest, current));
            String url = r.optString("url", null);
            if (url != null && url.startsWith("/")) {
                Uri base = Uri.parse(store.apiBase());
                url = base.getScheme() + "://" + base.getEncodedAuthority() + url;
            }
            out.put("url", url);
            out.put("notes", r.optString("notes", null));
            return out;
        });
    }

    /** Opens a TaskFlow link (the app's download) in the phone's browser. Only TaskFlow's own address. */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        Uri u = url == null ? null : Uri.parse(url);
        Uri base = store.apiBase() == null ? null : Uri.parse(store.apiBase());
        if (u == null || base == null || !"https".equals(u.getScheme()) || u.getHost() == null || !u.getHost().equals(base.getHost())) {
            call.reject("Only TaskFlow's own links open from here");
            return;
        }
        Intent view = new Intent(Intent.ACTION_VIEW, u);
        view.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(view);
        call.resolve();
    }
}
