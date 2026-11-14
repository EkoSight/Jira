package com.ekosight.taskflow.phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.Test;

/** A call's recording is the audio file saved when it ended; the number in the name wins; a file is used once. */
public class RecordingMatcherTest {
    private static final long T = 1_763_100_000_000L;
    private static final RecordingMatcher.CallInfo CALL = new RecordingMatcher.CallInfo(T, 192, "919811000001");

    private static RecordingMatcher.FileInfo file(String id, String name, long modified) {
        return new RecordingMatcher.FileInfo(id, name, modified, 1024);
    }

    @Test
    public void picksTheFileSavedNearestTheEnd() {
        List<RecordingMatcher.FileInfo> files = Arrays.asList(
            file("a", "Call recording Sample Farms_261114_100000.m4a", T + 192_000 + 4_000),
            file("b", "Call recording Other_261114_100500.m4a", T + 192_000 + 90_000));
        assertEquals("a", RecordingMatcher.match(CALL, files, null).id);
    }

    @Test
    public void theNumberInTheNameWins() {
        List<RecordingMatcher.FileInfo> files = Arrays.asList(
            file("a", "Call recording Someone_261114_100000.m4a", T + 192_000 + 1_000),
            file("b", "9811000001_261114_100312.amr", T + 192_000 + 300_000));
        assertEquals("b", RecordingMatcher.match(CALL, files, null).id);
    }

    @Test
    public void nothingOutsideTheWindowOrAlreadyUsedOrNotAudio() {
        List<RecordingMatcher.FileInfo> files = Arrays.asList(
            file("before", "a.m4a", T - 1_000),
            file("late", "b.m4a", T + 192_000 + RecordingMatcher.AFTER_END_MS + 1_000),
            file("taken", "c.m4a", T + 193_000),
            file("text", "notes.txt", T + 193_000),
            new RecordingMatcher.FileInfo("empty", "d.m4a", T + 193_000, 0));
        assertNull(RecordingMatcher.match(CALL, files, Collections.singleton("taken")));
        assertEquals("taken", RecordingMatcher.match(CALL, files, null).id);
    }

    @Test
    public void knowsTheRecordingTypes() {
        assertTrue(RecordingMatcher.isAudio("x.M4A"));
        assertTrue(RecordingMatcher.isAudio("x.opus"));
        assertFalse(RecordingMatcher.isAudio("x.jpg"));
        assertFalse(RecordingMatcher.isAudio("noext"));
    }
}
