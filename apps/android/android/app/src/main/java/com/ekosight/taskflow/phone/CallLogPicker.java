package com.ekosight.taskflow.phone;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Set;

/**
 * Which call-log entries leave the phone. Only calls on the company SIM with a
 * lead or customer the person may see (their numbers arrive as salted hashes)
 * are sent, plus a call started from TaskFlow; every other call stays on the
 * phone. Kept free of Android classes so it is tested on its own.
 */
public final class CallLogPicker {
    private CallLogPicker() {}

    /** Android's CallLog.Calls.TYPE values (public, stable constants). */
    public static final int INCOMING = 1;
    public static final int OUTGOING = 2;
    public static final int MISSED = 3;
    public static final int VOICEMAIL = 4;
    public static final int REJECTED = 5;
    public static final int BLOCKED = 6;

    /** A call TaskFlow started, waiting for its call-log entry. */
    public static final long PENDING_BEFORE_MS = 2 * 60_000L;
    public static final long PENDING_AFTER_MS = 10 * 60_000L;

    /** One row of the phone's call log. */
    public static final class Entry {
        public final long id;
        public final String number;
        public final int type;
        public final long startedAtMs;
        public final long durationSec;
        public final String accountId;

        public Entry(long id, String number, int type, long startedAtMs, long durationSec, String accountId) {
            this.id = id;
            this.number = number;
            this.type = type;
            this.startedAtMs = startedAtMs;
            this.durationSec = durationSec;
            this.accountId = accountId;
        }
    }

    /** A call started from TaskFlow on this phone. */
    public static final class Pending {
        public final long callId;
        public final String normalised;
        public final long dialledAtMs;

        public Pending(long callId, String normalised, long dialledAtMs) {
            this.callId = callId;
            this.normalised = normalised;
            this.dialledAtMs = dialledAtMs;
        }
    }

    /** What the server is told about one entry. */
    public static final class Choice {
        public final Entry entry;
        public final String normalised;
        public final String type;
        public final Long callId;
        public final boolean doNotRecord;

        Choice(Entry entry, String normalised, String type, Long callId, boolean doNotRecord) {
            this.entry = entry;
            this.normalised = normalised;
            this.type = type;
            this.callId = callId;
            this.doNotRecord = doNotRecord;
        }
    }

    public static final class Result {
        /** Entries to send, oldest first. */
        public final List<Choice> send = new ArrayList<>();
        /** Entries on the company SIM whose number is not (yet) a lead's: looked at again for a day, in case the lead is added late. */
        public final List<Entry> notALead = new ArrayList<>();
        /** Entries on another SIM: never sent. */
        public int otherSim;
    }

    /** The server's name for a call-log type. */
    public static String typeName(int type) {
        switch (type) {
            case INCOMING: return "INCOMING";
            case OUTGOING: return "OUTGOING";
            case MISSED: return "MISSED";
            case VOICEMAIL: return "VOICEMAIL";
            case REJECTED: return "REJECTED";
            case BLOCKED: return "BLOCKED";
            default: return "OTHER";
        }
    }

    /**
     * @param entries      call-log rows, in any order
     * @param workAccounts the phone-account ids of the company SIM; null when the phone cannot tell its SIMs apart (one SIM, or an old phone)
     * @param salt         today's salt from TaskFlow
     * @param numbers      hashes of the numbers that may be called
     * @param optedOut     hashes of numbers in scope that asked not to be called (still sent: they may call the company)
     * @param noRecord     hashes of numbers whose calls are not recorded
     * @param pending      calls started from TaskFlow
     */
    public static Result pick(List<Entry> entries, Set<String> workAccounts, String salt, Set<String> numbers,
                              Set<String> optedOut, Set<String> noRecord, List<Pending> pending) {
        Result out = new Result();
        List<Entry> sorted = new ArrayList<>(entries);
        Collections.sort(sorted, (a, b) -> Long.compare(a.id, b.id));
        List<Pending> open = pending == null ? new ArrayList<>() : new ArrayList<>(pending);
        for (Entry e : sorted) {
            if (workAccounts != null && !workAccounts.isEmpty() && e.accountId != null && !workAccounts.contains(e.accountId)) {
                out.otherSim += 1;
                continue;
            }
            String n = Numbers.normalise(e.number);
            if (n == null) continue;
            Long callId = null;
            if (e.type == OUTGOING) {
                Pending match = null;
                for (Pending p : open) {
                    if (p.normalised.equals(n) && e.startedAtMs >= p.dialledAtMs - PENDING_BEFORE_MS && e.startedAtMs <= p.dialledAtMs + PENDING_AFTER_MS) {
                        if (match == null || Math.abs(e.startedAtMs - p.dialledAtMs) < Math.abs(e.startedAtMs - match.dialledAtMs)) match = p;
                    }
                }
                if (match != null) {
                    callId = match.callId;
                    open.remove(match);
                }
            }
            String h = salt == null ? null : Numbers.hash(salt, n);
            boolean known = h != null && ((numbers != null && numbers.contains(h)) || (optedOut != null && optedOut.contains(h)));
            if (!known && callId == null) {
                out.notALead.add(e);
                continue;
            }
            boolean dnr = h != null && noRecord != null && noRecord.contains(h);
            out.send.add(new Choice(e, n, typeName(e.type), callId, dnr));
        }
        return out;
    }

    /** Whether an entry was a conversation (a recording may exist for it). */
    public static boolean talked(Entry e) {
        return (e.type == OUTGOING || e.type == INCOMING) && e.durationSec > 0;
    }
}
