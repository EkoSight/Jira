package com.ekosight.taskflow.phone;

import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * Finds the recording of a call among the files in the recordings folder.
 * A dialler saves the file when the call ends, so it must be saved after the
 * call started and no more than ten minutes after it ended; a file whose name
 * holds the number's last digits wins, then the one saved nearest the end.
 * A file already used for another call is never used again.
 */
public final class RecordingMatcher {
    private RecordingMatcher() {}

    public static final long AFTER_END_MS = 10 * 60_000L;
    private static final String[] AUDIO = { "m4a", "mp4", "aac", "3gp", "3ga", "mp3", "amr", "ogg", "opus", "wav" };

    public static final class FileInfo {
        public final String id;
        public final String name;
        public final long lastModifiedMs;
        public final long size;

        public FileInfo(String id, String name, long lastModifiedMs, long size) {
            this.id = id;
            this.name = name;
            this.lastModifiedMs = lastModifiedMs;
            this.size = size;
        }
    }

    public static final class CallInfo {
        public final long startedAtMs;
        public final long durationSec;
        public final String normalised;

        public CallInfo(long startedAtMs, long durationSec, String normalised) {
            this.startedAtMs = startedAtMs;
            this.durationSec = durationSec;
            this.normalised = normalised;
        }
    }

    /** Whether a file name is a recording TaskFlow accepts. */
    public static boolean isAudio(String name) {
        if (name == null) return false;
        int dot = name.lastIndexOf('.');
        if (dot < 0) return false;
        String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        for (String a : AUDIO) if (a.equals(ext)) return true;
        return false;
    }

    /** The file's name with only its digits, for finding a number in it. */
    static String digitsOf(String name) {
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c >= '0' && c <= '9') b.append(c);
        }
        return b.toString();
    }

    public static FileInfo match(CallInfo call, List<FileInfo> files, Set<String> taken) {
        long end = call.startedAtMs + Math.max(0, call.durationSec) * 1000L;
        String tail = Numbers.tail(call.normalised, 7);
        FileInfo best = null;
        long bestScore = Long.MAX_VALUE;
        for (FileInfo f : files) {
            if (f == null || f.name == null || !isAudio(f.name) || f.size <= 0) continue;
            if (taken != null && taken.contains(f.id)) continue;
            if (f.lastModifiedMs < call.startedAtMs || f.lastModifiedMs > end + AFTER_END_MS) continue;
            long score = Math.abs(f.lastModifiedMs - end);
            // the number in the name outweighs any difference in time inside the window
            if (tail != null && tail.length() == 7 && digitsOf(f.name).contains(tail)) score -= AFTER_END_MS * 4;
            if (score < bestScore) {
                best = f;
                bestScore = score;
            }
        }
        return best;
    }
}
