package com.ekosight.taskflow.phone;

import android.content.Context;
import android.database.Cursor;
import android.provider.CallLog;
import java.util.ArrayList;
import java.util.List;

/**
 * Reads the phone's call log. The row id only grows, so "after the last id
 * read" never misses an entry written late (a long call is written when it
 * ends) and never reads one twice. Needs the call history permission.
 */
final class CallLogReader {
    private CallLogReader() {}

    private static final String[] COLUMNS = {
        CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.PHONE_ACCOUNT_ID,
    };

    /** Entries after the given id (all, when it is -1) that started no earlier than notBefore, oldest first, at most limit. */
    static List<CallLogPicker.Entry> after(Context ctx, long afterId, long notBefore, int limit) {
        return query(ctx, CallLog.Calls._ID + " > ? AND " + CallLog.Calls.DATE + " >= ?",
            new String[] { String.valueOf(afterId), String.valueOf(notBefore) }, limit);
    }

    /** The given entries again (those whose number was not a lead's yet). */
    static List<CallLogPicker.Entry> byIds(Context ctx, List<Long> ids, long notBefore) {
        if (ids.isEmpty()) return new ArrayList<>();
        StringBuilder in = new StringBuilder();
        String[] args = new String[ids.size() + 1];
        for (int i = 0; i < ids.size(); i++) {
            in.append(i == 0 ? "?" : ",?");
            args[i] = String.valueOf(ids.get(i));
        }
        args[ids.size()] = String.valueOf(notBefore);
        return query(ctx, CallLog.Calls._ID + " IN (" + in + ") AND " + CallLog.Calls.DATE + " >= ?", args, ids.size());
    }

    /** Whether this number rang the phone in the last day (an opted-out lead may be called back then). */
    static boolean calledUsSince(Context ctx, String normalised, long since) {
        try (Cursor c = ctx.getContentResolver().query(CallLog.Calls.CONTENT_URI, new String[] { CallLog.Calls.NUMBER, CallLog.Calls.TYPE },
            CallLog.Calls.DATE + " >= ?", new String[] { String.valueOf(since) }, null)) {
            if (c == null) return false;
            while (c.moveToNext()) {
                int type = c.getInt(1);
                boolean theyRang = type == CallLog.Calls.INCOMING_TYPE || type == CallLog.Calls.MISSED_TYPE || type == CallLog.Calls.REJECTED_TYPE;
                if (theyRang && normalised.equals(Numbers.normalise(c.getString(0)))) return true;
            }
            return false;
        }
    }

    private static List<CallLogPicker.Entry> query(Context ctx, String where, String[] args, int limit) {
        List<CallLogPicker.Entry> out = new ArrayList<>();
        try (Cursor c = ctx.getContentResolver().query(CallLog.Calls.CONTENT_URI, COLUMNS, where, args, CallLog.Calls._ID + " ASC")) {
            if (c == null) return out;
            while (c.moveToNext() && out.size() < limit) {
                out.add(new CallLogPicker.Entry(c.getLong(0), c.getString(1), c.getInt(2), c.getLong(3), c.getLong(4), c.getString(5)));
            }
        }
        return out;
    }
}
