package com.ekosight.taskflow.phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.Test;

/** Only calls on the company SIM with leads and customers leave the phone; a call TaskFlow started is matched to its entry. */
public class CallLogPickerTest {
    private static final String SALT = "test-salt-0001";
    private static final long T = 1_763_100_000_000L;

    private static Set<String> hashes(String... numbers) {
        Set<String> out = new HashSet<>();
        for (String n : numbers) out.add(Numbers.hash(SALT, Numbers.normalise(n)));
        return out;
    }

    private static CallLogPicker.Entry entry(long id, String number, int type, long at, long sec, String account) {
        return new CallLogPicker.Entry(id, number, type, at, sec, account);
    }

    @Test
    public void sendsOnlyLeadsOnTheCompanySim() {
        List<CallLogPicker.Entry> log = Arrays.asList(
            entry(3, "98110 00001", CallLogPicker.OUTGOING, T, 192, "sim-work"),
            entry(1, "98110 00009", CallLogPicker.OUTGOING, T - 60_000, 40, "sim-work"),
            entry(2, "98110 00001", CallLogPicker.INCOMING, T - 30_000, 10, "sim-personal"),
            entry(4, "98110 00002", CallLogPicker.MISSED, T + 60_000, 0, "sim-work"));
        CallLogPicker.Result r = CallLogPicker.pick(log, new HashSet<>(Collections.singleton("sim-work")), SALT,
            hashes("9811000001"), hashes("9811000002"), hashes("9811000002"), null);
        assertEquals(2, r.send.size());
        assertEquals(3, r.send.get(0).entry.id);
        assertEquals("OUTGOING", r.send.get(0).type);
        assertEquals("919811000001", r.send.get(0).normalised);
        assertNull(r.send.get(0).callId);
        assertFalse(r.send.get(0).doNotRecord);
        // an opted-out number calling in is still sent: the company may answer it
        assertEquals("MISSED", r.send.get(1).type);
        assertTrue(r.send.get(1).doNotRecord);
        assertEquals(1, r.otherSim);
        assertEquals(1, r.notALead.size());
        assertEquals(1, r.notALead.get(0).id);
    }

    @Test
    public void aPhoneThatCannotTellSimsApartLooksAtEveryEntry() {
        List<CallLogPicker.Entry> log = Collections.singletonList(entry(1, "9811000001", CallLogPicker.OUTGOING, T, 5, "anything"));
        assertEquals(1, CallLogPicker.pick(log, null, SALT, hashes("9811000001"), null, null, null).send.size());
        assertEquals(1, CallLogPicker.pick(log, new HashSet<>(), SALT, hashes("9811000001"), null, null, null).send.size());
    }

    @Test
    public void aCallStartedFromTaskFlowGetsItsIdEvenBeforeTheListIsFresh() {
        List<CallLogPicker.Entry> log = Arrays.asList(
            entry(10, "+91 98110 00005", CallLogPicker.OUTGOING, T + 20_000, 0, null),
            entry(11, "+91 98110 00005", CallLogPicker.OUTGOING, T + 15 * 60_000, 30, null),
            entry(12, "+91 98110 00005", CallLogPicker.INCOMING, T + 30_000, 30, null));
        List<CallLogPicker.Pending> pending = Collections.singletonList(new CallLogPicker.Pending(77, "919811000005", T));
        CallLogPicker.Result r = CallLogPicker.pick(log, null, SALT, new HashSet<>(), null, null, pending);
        assertEquals(1, r.send.size());
        assertEquals(Long.valueOf(77), r.send.get(0).callId);
        assertEquals(10, r.send.get(0).entry.id);
        assertEquals("too late, and an incoming call, are not the started call", 2, r.notALead.size());
    }

    @Test
    public void namesTheTypesAsTheServerDoes() {
        assertEquals("REJECTED", CallLogPicker.typeName(CallLogPicker.REJECTED));
        assertEquals("BLOCKED", CallLogPicker.typeName(CallLogPicker.BLOCKED));
        assertEquals("VOICEMAIL", CallLogPicker.typeName(CallLogPicker.VOICEMAIL));
        assertEquals("OTHER", CallLogPicker.typeName(7));
        assertTrue(CallLogPicker.talked(entry(1, "1", CallLogPicker.INCOMING, T, 3, null)));
        assertFalse(CallLogPicker.talked(entry(1, "1", CallLogPicker.MISSED, T, 3, null)));
        assertFalse(CallLogPicker.talked(entry(1, "1", CallLogPicker.OUTGOING, T, 0, null)));
    }
}
