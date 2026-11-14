package com.ekosight.taskflow.phone;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * Phone numbers as TaskFlow compares them. The rules are the server's
 * (normalizePhone and hashNumber in server/src/services/sales); the shared
 * test vectors in shared/callingVectors.json keep the two the same.
 */
public final class Numbers {
    private Numbers() {}

    /**
     * Digits only. Ten digits get 91 in front; a 0 and ten digits become 91
     * and the ten; a leading 00 is dropped. Null when fewer than six digits.
     */
    public static String normalise(String value) {
        if (value == null) return null;
        String raw = value.trim();
        if (raw.isEmpty()) return null;
        StringBuilder b = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (c >= '0' && c <= '9') b.append(c);
        }
        String digits = b.toString();
        if (digits.length() < 6) return null;
        if (digits.length() == 10) return "91" + digits;
        if (digits.length() == 11 && digits.charAt(0) == '0') return "91" + digits.substring(1);
        if (digits.length() > 2 && digits.startsWith("00")) return digits.substring(2);
        return digits;
    }

    /** HMAC-SHA256 of a normalised number, keyed by the day's salt (as text), in lowercase hex. */
    public static String hash(String salt, String normalised) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(salt.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return hex(mac.doFinal(normalised.getBytes(StandardCharsets.UTF_8)));
        } catch (GeneralSecurityException e) {
            throw new IllegalStateException("HmacSHA256 is not available", e);
        }
    }

    static String hex(byte[] bytes) {
        char[] out = new char[bytes.length * 2];
        final char[] digits = "0123456789abcdef".toCharArray();
        for (int i = 0; i < bytes.length; i++) {
            out[i * 2] = digits[(bytes[i] >> 4) & 0xf];
            out[i * 2 + 1] = digits[bytes[i] & 0xf];
        }
        return new String(out);
    }

    /** The last digits of a number, for spotting it in a recording's file name. */
    public static String tail(String normalised, int count) {
        if (normalised == null) return null;
        return normalised.length() <= count ? normalised : normalised.substring(normalised.length() - count);
    }
}
