package com.ekosight.taskflow.phone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/** The phone's number rules give the server's answers (shared/callingVectors.json, written from the server's code). */
public class NumbersTest {
    static JSONObject vectors() throws Exception {
        String path = System.getProperty("taskflow.vectors", "../../../../shared/callingVectors.json");
        return new JSONObject(new String(Files.readAllBytes(new File(path).toPath()), StandardCharsets.UTF_8));
    }

    @Test
    public void normalisesLikeTheServer() throws Exception {
        JSONArray cases = vectors().getJSONArray("normalise");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            String expected = c.isNull("expected") ? null : c.getString("expected");
            assertEquals("normalise " + c.getString("input"), expected, Numbers.normalise(c.getString("input")));
        }
    }

    @Test
    public void hashesLikeTheServer() throws Exception {
        JSONObject hash = vectors().getJSONObject("hash");
        JSONArray cases = hash.getJSONArray("cases");
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            assertEquals(c.getString("expected"), Numbers.hash(hash.getString("salt"), c.getString("number")));
        }
    }

    @Test
    public void nothingUsableIsNull() {
        assertNull(Numbers.normalise(null));
        assertNull(Numbers.normalise("   "));
        assertNull(Numbers.normalise("12-34"));
        assertEquals("0001", Numbers.tail("919811000001", 4));
        assertEquals("123", Numbers.tail("123", 7));
    }
}
