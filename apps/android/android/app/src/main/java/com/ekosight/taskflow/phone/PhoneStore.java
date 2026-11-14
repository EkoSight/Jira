package com.ekosight.taskflow.phone;

import android.content.Context;
import android.content.SharedPreferences;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * What the app keeps on the phone, in its private storage (never in a backup:
 * see res/xml/data_extraction_rules.xml): the device token, the company SIM,
 * the recordings folder, where the call log was read up to, and the day's
 * salted number list.
 */
final class PhoneStore {
    private static final String NAME = "taskflow.phone";
    private static final long DAY = 86_400_000L;
    private final SharedPreferences p;
    private final File numbersFile;

    PhoneStore(Context ctx) {
        Context app = ctx.getApplicationContext();
        p = app.getSharedPreferences(NAME, Context.MODE_PRIVATE);
        numbersFile = new File(app.getFilesDir(), "taskflow-numbers.json");
    }

    // ------------------------------------------------------------ the phone itself

    synchronized String installId() {
        String id = p.getString("installId", null);
        if (id == null) {
            id = UUID.randomUUID().toString().replace("-", "");
            p.edit().putString("installId", id).apply();
        }
        return id;
    }

    // ------------------------------------------------------------ who is signed in

    boolean configured() { return token() != null && apiBase() != null; }
    String apiBase() { return p.getString("apiBase", null); }
    String token() { return p.getString("token", null); }
    long deviceId() { return p.getLong("deviceId", 0); }
    long userId() { return p.getLong("userId", 0); }
    String userName() { return p.getString("userName", null); }
    /** Calls from before this person signed in on the phone are never sent as theirs. */
    long notBefore() { return p.getLong("notBefore", 0); }

    synchronized void signIn(String apiBase, String token, long deviceId, long userId, String userName, JSONObject recordingMode) {
        boolean samePerson = userId == userId() && deviceId == deviceId();
        SharedPreferences.Editor e = p.edit()
            .putString("apiBase", apiBase).putString("token", token).putLong("deviceId", deviceId)
            .putLong("userId", userId).putString("userName", userName)
            .putString("recordingMode", recordingMode == null ? null : recordingMode.toString());
        if (!samePerson) {
            e.putLong("notBefore", System.currentTimeMillis()).putLong("cursorId", -1)
                .remove("recheck").remove("pending").remove("awaiting").remove("config").putString("lastError", null);
            numbersFile.delete();
        }
        e.apply();
    }

    /** Ends this person's use of the phone. The SIM, the folder and the setup stay: they belong to the phone. */
    synchronized void signOut() {
        p.edit().remove("token").remove("deviceId").remove("userId").remove("userName").remove("config").remove("recordingMode")
            .remove("recheck").remove("pending").remove("awaiting").remove("cursorId").remove("notBefore").remove("shared")
            .putString("lastError", null).apply();
        numbersFile.delete();
    }

    // ------------------------------------------------------------ the company SIM and the folder

    int workSimId() { return p.getInt("workSimId", -1); }
    String workSimLabel() { return p.getString("workSimLabel", null); }
    String workSimNumber() { return p.getString("workSimNumber", null); }

    void setWorkSim(int id, String label, String number) {
        p.edit().putInt("workSimId", id).putString("workSimLabel", label).putString("workSimNumber", number).apply();
    }

    String folderUri() { return p.getString("folderUri", null); }
    String folderName() { return p.getString("folderName", null); }
    void setFolder(String uri, String name) { p.edit().putString("folderUri", uri).putString("folderName", name).apply(); }

    // ------------------------------------------------------------ setup, settings from TaskFlow

    JSONObject setup() { return json("setup", new JSONObject()); }
    void setSetup(JSONObject setup) { p.edit().putString("setup", setup.toString()).apply(); }
    JSONObject config() { return json("config", null); }
    void setConfig(JSONObject config) {
        SharedPreferences.Editor e = p.edit().putString("config", config.toString());
        JSONObject mode = config.optJSONObject("recording_mode");
        if (mode != null) e.putString("recordingMode", mode.toString());
        e.apply();
    }
    JSONObject recordingMode() { return json("recordingMode", null); }

    // ------------------------------------------------------------ syncing

    long cursorId() { return p.getLong("cursorId", -1); }
    void setCursor(long id) { p.edit().putLong("cursorId", id).apply(); }
    long lastSyncAt() { return p.getLong("lastSyncAt", 0); }
    String lastError() { return p.getString("lastError", null); }

    void finished(String error) {
        SharedPreferences.Editor e = p.edit().putString("lastError", error);
        if (error == null) e.putLong("lastSyncAt", System.currentTimeMillis());
        e.apply();
    }

    /** Entries whose number was not a lead's yet: looked at again for a day, in case the lead is added late. */
    synchronized List<Long> recheckIds() {
        JSONObject all = json("recheck", new JSONObject());
        List<Long> out = new ArrayList<>();
        long cutoff = System.currentTimeMillis() - DAY;
        for (Iterator<String> it = all.keys(); it.hasNext();) {
            String k = it.next();
            if (all.optLong(k) >= cutoff) out.add(Long.parseLong(k));
        }
        return out;
    }

    synchronized void setRecheck(List<CallLogPicker.Entry> entries) {
        JSONObject all = new JSONObject();
        long cutoff = System.currentTimeMillis() - DAY;
        try {
            for (CallLogPicker.Entry e : entries) {
                if (e.startedAtMs >= cutoff && all.length() < 300) all.put(String.valueOf(e.id), e.startedAtMs);
            }
        } catch (JSONException ignored) {
            // a number key cannot fail
        }
        p.edit().putString("recheck", all.toString()).apply();
    }

    /** Calls started from TaskFlow on this phone, waiting for their call-log entry (kept three hours). */
    synchronized List<CallLogPicker.Pending> pending() {
        JSONArray all = jsonArray("pending");
        List<CallLogPicker.Pending> out = new ArrayList<>();
        long cutoff = System.currentTimeMillis() - 3 * 3_600_000L;
        for (int i = 0; i < all.length(); i++) {
            JSONObject o = all.optJSONObject(i);
            if (o != null && o.optLong("dialledAt") >= cutoff) {
                out.add(new CallLogPicker.Pending(o.optLong("callId"), o.optString("number"), o.optLong("dialledAt")));
            }
        }
        return out;
    }

    synchronized void addPending(long callId, String normalised, long dialledAt) {
        JSONArray next = new JSONArray();
        try {
            for (CallLogPicker.Pending q : pending()) {
                if (q.callId != callId) next.put(new JSONObject().put("callId", q.callId).put("number", q.normalised).put("dialledAt", q.dialledAtMs));
            }
            next.put(new JSONObject().put("callId", callId).put("number", normalised).put("dialledAt", dialledAt));
        } catch (JSONException ignored) {
            // plain values
        }
        p.edit().putString("pending", next.toString()).apply();
    }

    synchronized void removePending(long callId) {
        JSONArray next = new JSONArray();
        try {
            for (CallLogPicker.Pending q : pending()) {
                if (q.callId != callId) next.put(new JSONObject().put("callId", q.callId).put("number", q.normalised).put("dialledAt", q.dialledAtMs));
            }
        } catch (JSONException ignored) {
            // plain values
        }
        p.edit().putString("pending", next.toString()).apply();
    }

    /** Calls whose recording is looked for in the folder (a dialler can save it a little late). */
    synchronized JSONArray awaiting() { return jsonArray("awaiting"); }
    synchronized void setAwaiting(JSONArray list) { p.edit().putString("awaiting", list.toString()).apply(); }

    /** Files TaskFlow refused, or already took: never sent again. */
    synchronized Set<String> triedFiles() {
        JSONObject all = json("tried", new JSONObject());
        Set<String> out = new HashSet<>();
        for (Iterator<String> it = all.keys(); it.hasNext();) out.add(it.next());
        return out;
    }

    synchronized void markTried(String fileId) {
        JSONObject all = json("tried", new JSONObject());
        JSONObject next = new JSONObject();
        long cutoff = System.currentTimeMillis() - 7 * DAY;
        try {
            for (Iterator<String> it = all.keys(); it.hasNext();) {
                String k = it.next();
                if (all.optLong(k) >= cutoff) next.put(k, all.optLong(k));
            }
            next.put(fileId, System.currentTimeMillis());
        } catch (JSONException ignored) {
            // plain values
        }
        p.edit().putString("tried", next.toString()).apply();
    }

    // ------------------------------------------------------------ a recording shared into the app

    JSONObject shared() { return json("shared", null); }
    void setShared(JSONObject shared) { p.edit().putString("shared", shared == null ? null : shared.toString()).apply(); }

    // ------------------------------------------------------------ the day's numbers (a file: the list can be long)

    static final class NumberList {
        final String salt;
        final String localDay;
        final long fetchedAt;
        final Set<String> numbers = new HashSet<>();
        final Set<String> optedOut = new HashSet<>();
        final Set<String> noRecord = new HashSet<>();

        NumberList(String salt, String localDay, long fetchedAt) {
            this.salt = salt;
            this.localDay = localDay;
            this.fetchedAt = fetchedAt;
        }

        static NumberList from(JSONObject r, String localDay, long now) {
            NumberList out = new NumberList(r.optString("salt", null), localDay, now);
            fill(out.numbers, r.optJSONArray("numbers"));
            fill(out.optedOut, r.optJSONArray("opted_out"));
            fill(out.noRecord, r.optJSONArray("no_record"));
            return out;
        }

        private static void fill(Set<String> into, JSONArray from) {
            if (from == null) return;
            for (int i = 0; i < from.length(); i++) into.add(from.optString(i));
        }

        JSONObject toJson() throws JSONException {
            return new JSONObject().put("salt", salt).put("localDay", localDay).put("fetchedAt", fetchedAt)
                .put("numbers", new JSONArray(numbers)).put("opted_out", new JSONArray(optedOut)).put("no_record", new JSONArray(noRecord));
        }
    }

    synchronized NumberList numbers() {
        if (!numbersFile.exists()) return null;
        try (FileInputStream in = new FileInputStream(numbersFile)) {
            byte[] bytes = new byte[(int) numbersFile.length()];
            int read = 0;
            while (read < bytes.length) {
                int n = in.read(bytes, read, bytes.length - read);
                if (n < 0) break;
                read += n;
            }
            JSONObject o = new JSONObject(new String(bytes, 0, read, StandardCharsets.UTF_8));
            return NumberList.from(o, o.optString("localDay"), o.optLong("fetchedAt"));
        } catch (IOException | JSONException e) {
            return null;
        }
    }

    synchronized void saveNumbers(NumberList list) {
        File tmp = new File(numbersFile.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(list.toJson().toString().getBytes(StandardCharsets.UTF_8));
        } catch (IOException | JSONException e) {
            tmp.delete();
            return;
        }
        if (!tmp.renameTo(numbersFile)) tmp.delete();
    }

    // ------------------------------------------------------------ helpers

    private JSONObject json(String key, JSONObject fallback) {
        String raw = p.getString(key, null);
        if (raw == null) return fallback;
        try {
            return new JSONObject(raw);
        } catch (JSONException e) {
            return fallback;
        }
    }

    private JSONArray jsonArray(String key) {
        String raw = p.getString(key, null);
        if (raw == null) return new JSONArray();
        try {
            return new JSONArray(raw);
        } catch (JSONException e) {
            return new JSONArray();
        }
    }
}
