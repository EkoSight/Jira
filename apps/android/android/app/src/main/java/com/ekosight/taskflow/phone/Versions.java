package com.ekosight.taskflow.phone;

/** Comparing app versions such as 1.2.10 and 1.2.9. */
public final class Versions {
    private Versions() {}

    /** Whether a is newer than b. Parts that are not numbers count as 0. */
    public static boolean newer(String a, String b) {
        String[] x = a.trim().split("\\.");
        String[] y = b.trim().split("\\.");
        for (int i = 0; i < Math.max(x.length, y.length); i++) {
            int p = i < x.length ? part(x[i]) : 0;
            int q = i < y.length ? part(y[i]) : 0;
            if (p != q) return p > q;
        }
        return false;
    }

    private static int part(String s) {
        try {
            return Integer.parseInt(s.replaceAll("[^0-9].*$", ""));
        } catch (NumberFormatException e) {
            return 0;
        }
    }
}
