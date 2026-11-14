package com.ekosight.taskflow.phone;

import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * A call recording shared to TaskFlow from another app (Google's Phone app on
 * Motorola keeps its recordings inside itself, and shares them this way). The
 * file is copied into the app's own storage until the person says which call
 * it belongs to; nothing is sent before that.
 */
final class SharedRecording {
    private SharedRecording() {}

    private static final long MAX_BYTES = 200L * 1024 * 1024;

    /** The shared file in a share intent, copied; null when the intent is not a shared recording. */
    @SuppressWarnings("deprecation")
    static JSONObject take(Context ctx, Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        Uri uri = Build.VERSION.SDK_INT >= 33 ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class) : intent.getParcelableExtra(Intent.EXTRA_STREAM);
        if (uri == null) return null;
        ContentResolver resolver = ctx.getContentResolver();
        String name = "recording";
        long size = -1;
        long modified = 0;
        try (Cursor c = resolver.query(uri, null, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int n = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int s = c.getColumnIndex(OpenableColumns.SIZE);
                int m = c.getColumnIndex(DocumentsContract.Document.COLUMN_LAST_MODIFIED);
                if (n >= 0 && !c.isNull(n)) name = c.getString(n);
                if (s >= 0 && !c.isNull(s)) size = c.getLong(s);
                if (m >= 0 && !c.isNull(m)) modified = c.getLong(m);
            }
        } catch (SecurityException | IllegalArgumentException e) {
            // some apps share a file without describing it: the name stays "recording"
        }
        if (!RecordingMatcher.isAudio(name)) {
            String type = intent.getType();
            if (type == null || !type.startsWith("audio/")) return null;
        }
        File dir = new File(ctx.getCacheDir(), "shared");
        if (!dir.exists() && !dir.mkdirs()) return null;
        File[] old = dir.listFiles();
        if (old != null) for (File f : old) f.delete();
        File copy = new File(dir, "recording-" + System.currentTimeMillis() + extensionOf(name));
        long copied = 0;
        try (InputStream in = resolver.openInputStream(uri); OutputStream out = new FileOutputStream(copy)) {
            if (in == null) return null;
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = in.read(buffer)) > 0) {
                copied += n;
                if (copied > MAX_BYTES) throw new IOException("too large");
                out.write(buffer, 0, n);
            }
        } catch (IOException | SecurityException e) {
            copy.delete();
            return null;
        }
        try {
            JSONObject o = new JSONObject().put("path", copy.getAbsolutePath()).put("name", name).put("size", size >= 0 ? size : copied);
            if (modified > 0) o.put("lastModified", modified);
            return o;
        } catch (JSONException e) {
            return null;
        }
    }

    static String extensionOf(String name) {
        int dot = name.lastIndexOf('.');
        return dot < 0 ? ".m4a" : name.substring(dot).toLowerCase(java.util.Locale.ROOT);
    }

    static void discard(JSONObject shared) {
        if (shared == null) return;
        String path = shared.optString("path", null);
        if (path != null) new File(path).delete();
    }
}
