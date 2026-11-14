package com.ekosight.taskflow.phone;

import android.content.Context;
import android.net.Uri;
import java.io.IOException;
import java.io.InputStream;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * One sync: tell TaskFlow how the phone is set up, send the calls with leads
 * and customers from the call log, and the recordings of those calls. Runs in
 * the background (SyncJob) or when asked (Sync now); never two at once.
 *
 *   1  heartbeat: the phone's facts in, TaskFlow's settings out (is syncing on,
 *      are recordings kept, has the person accepted the phone policy)
 *   2  the day's number list (salted hashes), at most an hour old
 *   3  call-log entries after the last one read, plus those whose number was
 *      not a lead's yet; only matches leave the phone
 *   4  for each call with a conversation, its recording from the chosen
 *      folder; once TaskFlow confirms the same checksum, the phone's copy goes
 *
 * Where it stopped is kept only after TaskFlow has the entries, so a sync cut
 * off half way starts again from the same place; TaskFlow ignores repeats.
 */
public final class SyncEngine {
    private static final Object LOCK = new Object();
    private static final long HOUR = 3_600_000L;
    private static final int BATCH = 100;

    public static final class Outcome {
        public int sent;
        public int recordings;
        public int removed;
        public String error;
        public boolean retry;
    }

    public static Outcome run(Context ctx) {
        synchronized (LOCK) {
            return new SyncEngine(ctx).sync();
        }
    }

    private final Context ctx;
    private final PhoneStore store;

    private SyncEngine(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.store = new PhoneStore(this.ctx);
    }

    static String iso(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        f.setTimeZone(TimeZone.getTimeZone("UTC"));
        return f.format(new Date(ms));
    }

    private static String localDay() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    static ApiClient api(Context ctx, PhoneStore store) {
        return new ApiClient(store.apiBase(), store.token(), DeviceFacts.appVersion(ctx));
    }

    /** The phone's facts, as TaskFlow's phone list shows them. */
    static JSONObject heartbeatBody(Context ctx, PhoneStore store) throws JSONException {
        return new JSONObject()
            .put("info", DeviceFacts.info(ctx))
            .put("permissions", DeviceFacts.permissions(ctx))
            .put("folder_chosen", store.folderUri() != null)
            .put("work_sim", store.workSimLabel() == null ? JSONObject.NULL : store.workSimLabel())
            .put("setup", store.setup())
            .put("last_error", store.lastError() == null ? JSONObject.NULL : store.lastError());
    }

    private Outcome sync() {
        Outcome out = new Outcome();
        if (!store.configured()) {
            out.error = "This phone is not set up for TaskFlow yet";
            return out;
        }
        try {
            ApiClient api = api(ctx, store);
            JSONObject config = api.post("/device/heartbeat", heartbeatBody(ctx, store));
            store.setConfig(config);
            boolean signedIn = config.optBoolean("signed_in", true);
            if (!config.optBoolean("sync", true)) {
                store.finished(null);
                return out;
            }
            JSONObject policy = config.optJSONObject("policy");
            if (signedIn && policy != null && !policy.optBoolean("acknowledged")) {
                out.error = "Read and accept the company phone policy in TaskFlow first";
                store.finished(out.error);
                return out;
            }
            if (!DeviceFacts.canReadCallLog(ctx)) {
                out.error = "Allow call history in TaskFlow's phone setup";
                store.finished(out.error);
                return out;
            }
            // after a hand-over (or signing out elsewhere) the calls made before it are still sent, with the list already on the phone
            PhoneStore.NumberList list = signedIn ? numbers(api) : store.numbers();
            if (list != null) sendCallLog(api, config, list, out);
            if (!signedIn) {
                store.signOut();
                SyncJob.cancel(ctx);
                out.error = "This phone was signed out of TaskFlow";
                return out;
            }
            store.finished(null);
        } catch (ApiClient.Failure f) {
            out.error = f.getMessage();
            out.retry = f.status >= 500 || f.status == 429;
            if (f.status == 401 || f.status == 403) {
                // the phone was blocked, or its sign-in is gone: nothing more is sent from it
                store.signOut();
                SyncJob.cancel(ctx);
                Notifier.attention(ctx, f.getMessage());
            }
            store.finished(out.error);
        } catch (IOException e) {
            out.error = "No connection to TaskFlow";
            out.retry = true;
            store.finished(out.error);
        } catch (JSONException e) {
            out.error = "TaskFlow sent an answer this app did not understand";
            store.finished(out.error);
        } catch (SecurityException e) {
            out.error = "A permission was withdrawn: open TaskFlow's phone setup";
            store.finished(out.error);
        }
        return out;
    }

    /** Today's numbers: fetched again after an hour, or when the day changes on the phone. */
    private PhoneStore.NumberList numbers(ApiClient api) throws IOException {
        PhoneStore.NumberList cached = store.numbers();
        long now = System.currentTimeMillis();
        String today = localDay();
        if (cached != null && cached.salt != null && now - cached.fetchedAt < HOUR && today.equals(cached.localDay)) return cached;
        PhoneStore.NumberList fresh = PhoneStore.NumberList.from(api.get("/device/numbers"), today, now);
        store.saveNumbers(fresh);
        return fresh;
    }

    private void sendCallLog(ApiClient api, JSONObject config, PhoneStore.NumberList list, Outcome out) throws IOException, JSONException {
        long cursor = store.cursorId();
        long notBefore = store.notBefore();
        List<CallLogPicker.Entry> fresh = CallLogReader.after(ctx, cursor, notBefore, 500);
        List<CallLogPicker.Entry> all = new ArrayList<>(fresh);
        Set<Long> seen = new HashSet<>();
        for (CallLogPicker.Entry e : fresh) seen.add(e.id);
        for (CallLogPicker.Entry e : CallLogReader.byIds(ctx, store.recheckIds(), notBefore)) if (seen.add(e.id)) all.add(e);

        Set<String> work = null;
        if (store.workSimId() >= 0 && Sims.active(ctx).size() > 1) {
            work = Sims.accountIds(ctx, store.workSimId());
            // a phone that cannot say which SIM a call used: the number filter alone decides
            if (work.isEmpty()) work = null;
        }
        CallLogPicker.Result picked = CallLogPicker.pick(all, work, list.salt, list.numbers, list.optedOut, list.noRecord, store.pending());

        List<CallLogPicker.Entry> again = new ArrayList<>(picked.notALead);
        JSONArray awaiting = store.awaiting();
        Set<Long> waitingFor = new HashSet<>();
        for (int i = 0; i < awaiting.length(); i++) waitingFor.add(awaiting.getJSONObject(i).optLong("callId"));
        for (int from = 0; from < picked.send.size(); from += BATCH) {
            List<CallLogPicker.Choice> batch = picked.send.subList(from, Math.min(picked.send.size(), from + BATCH));
            JSONArray entries = new JSONArray();
            Map<String, CallLogPicker.Choice> byLogId = new HashMap<>();
            for (CallLogPicker.Choice c : batch) {
                JSONObject e = new JSONObject()
                    .put("log_id", String.valueOf(c.entry.id))
                    .put("number", c.entry.number)
                    .put("type", c.type)
                    .put("started_at", iso(c.entry.startedAtMs))
                    .put("duration_sec", c.entry.durationSec);
                if (store.workSimLabel() != null) e.put("sim", store.workSimLabel());
                if (c.callId != null) e.put("call_id", c.callId);
                entries.put(e);
                byLogId.put(String.valueOf(c.entry.id), c);
            }
            JSONArray results = api.post("/device/call-log", new JSONObject().put("entries", entries)).optJSONArray("results");
            if (results == null) results = new JSONArray();
            for (int i = 0; i < results.length(); i++) {
                JSONObject r = results.getJSONObject(i);
                CallLogPicker.Choice c = byLogId.get(r.optString("log_id"));
                if (c == null) continue;
                String status = r.optString("status");
                if (c.callId != null) store.removePending(c.callId);
                if ("FAILED".equals(status)) {
                    again.add(c.entry);
                    continue;
                }
                if (!r.has("call_id") || !("ATTACHED".equals(status) || "CREATED".equals(status) || "DUPLICATE".equals(status))) continue;
                if (!"DUPLICATE".equals(status)) out.sent += 1;
                if (CallLogPicker.talked(c.entry) && waitingFor.add(r.getLong("call_id"))) {
                    awaiting.put(new JSONObject()
                        .put("callId", r.getLong("call_id"))
                        .put("startedAt", c.entry.startedAtMs)
                        .put("durationSec", c.entry.durationSec)
                        .put("number", c.normalised)
                        .put("doNotRecord", c.doNotRecord)
                        .put("since", System.currentTimeMillis()));
                }
            }
        }
        long max = cursor;
        for (CallLogPicker.Entry e : fresh) max = Math.max(max, e.id);
        store.setCursor(max);
        store.setRecheck(again);
        store.setAwaiting(awaiting);
        recordings(api, config, out);
    }

    /** The recordings of the calls just sent (and of earlier ones whose file was not there yet). */
    private void recordings(ApiClient api, JSONObject config, Outcome out) throws IOException, JSONException {
        JSONArray waiting = store.awaiting();
        if (waiting.length() == 0) return;
        JSONObject mode = config.optJSONObject("recording_mode");
        String folder = store.folderUri();
        boolean on = config.optBoolean("recordings", false) && mode != null && "AUTOMATIC".equals(mode.optString("mode"));
        if (!on || folder == null) {
            // recordings are off in TaskFlow, or this phone does not save them to a folder: the phone's files are left alone
            store.setAwaiting(new JSONArray());
            return;
        }
        boolean removeCopy = config.optBoolean("remove_phone_copy", true);
        long maxBytes = config.optLong("max_recording_mb", 50) * 1024 * 1024;
        Uri tree = Uri.parse(folder);
        long now = System.currentTimeMillis();
        List<RecordingMatcher.FileInfo> files = Folder.list(ctx, tree, now - 3 * 24 * HOUR);
        Set<String> taken = store.triedFiles();
        JSONArray still = new JSONArray();
        for (int i = 0; i < waiting.length(); i++) {
            JSONObject a = waiting.getJSONObject(i);
            RecordingMatcher.CallInfo call = new RecordingMatcher.CallInfo(a.getLong("startedAt"), a.getLong("durationSec"), a.optString("number"));
            RecordingMatcher.FileInfo f = RecordingMatcher.match(call, files, taken);
            if (f == null) {
                // a dialler may save the file a little after the call; looked for again for three hours
                if (now - a.optLong("since", now) < 3 * HOUR) still.put(a);
                continue;
            }
            taken.add(f.id);
            if (a.optBoolean("doNotRecord")) {
                // the lead asked not to be recorded: the file is not sent, and the phone's copy goes
                if (removeCopy && Folder.delete(ctx, tree, f.id)) out.removed += 1;
                store.markTried(f.id);
                continue;
            }
            if (f.size > maxBytes) {
                store.markTried(f.id);
                continue;
            }
            try {
                upload(api, tree, f, a.getLong("callId"), removeCopy, out);
            } catch (ApiClient.Failure fail) {
                if ("RECORDINGS_OFF".equals(fail.code)) return;
                if (fail.status >= 500 || fail.status == 429) {
                    still.put(a);
                    taken.remove(f.id);
                    continue;
                }
                if ("DO_NOT_RECORD".equals(fail.code) && removeCopy && Folder.delete(ctx, tree, f.id)) out.removed += 1;
                // TaskFlow refused this file for this call (already has one, too long for the call, not audio): not sent again
                store.markTried(f.id);
            }
        }
        store.setAwaiting(still);
    }

    private void upload(ApiClient api, Uri tree, RecordingMatcher.FileInfo f, long callId, boolean removeCopy, Outcome out) throws IOException, JSONException {
        MessageDigest sha;
        try {
            sha = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
        Map<String, String> fields = new HashMap<>();
        fields.put("call_id", String.valueOf(callId));
        JSONObject r;
        try (InputStream in = Folder.open(ctx, tree, f.id)) {
            r = api.upload("/device/recordings", fields, f.name, Folder.mimeOf(f.name), in, sha);
        }
        store.markTried(f.id);
        if (!r.optBoolean("duplicate")) out.recordings += 1;
        String local = Numbers.hex(sha.digest());
        JSONObject rec = r.optJSONObject("recording");
        String remote = r.optString("sha256", rec == null ? "" : rec.optString("sha256", ""));
        // the phone's copy goes only once TaskFlow holds exactly this file
        if (removeCopy && local.equals(remote) && Folder.delete(ctx, tree, f.id)) out.removed += 1;
    }

    /** A recording shared into the app, for the call the person chose. */
    static JSONObject attachShared(Context ctx, PhoneStore store, JSONObject shared, long callId) throws IOException, JSONException {
        String path = shared.getString("path");
        String name = shared.optString("name", "recording" + SharedRecording.extensionOf(path));
        Map<String, String> fields = new HashMap<>();
        fields.put("call_id", String.valueOf(callId));
        fields.put("source", "SHARED");
        try (InputStream in = new java.io.FileInputStream(path)) {
            return api(ctx, store).upload("/device/recordings", fields, name, Folder.mimeOf(name), in, null);
        }
    }
}
