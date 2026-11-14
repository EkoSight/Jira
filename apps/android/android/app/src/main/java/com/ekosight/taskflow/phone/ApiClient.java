package com.ekosight.taskflow.phone;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import java.util.UUID;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * TaskFlow's phone endpoints (/device/...), reached with the phone's device
 * token, which opens nothing else in TaskFlow. HTTPS only.
 */
final class ApiClient {
    /** TaskFlow answered with an error: its words, and its code (for example DO_NOT_RECORD). */
    static final class Failure extends IOException {
        private static final long serialVersionUID = 1L;
        final int status;
        final String code;

        Failure(int status, String code, String message) {
            super(message);
            this.status = status;
            this.code = code;
        }
    }

    private final String base;
    private final String token;
    private final String agent;

    ApiClient(String base, String token, String appVersion) {
        if (base == null || !base.startsWith("https://")) throw new IllegalArgumentException("TaskFlow's address must start with https://");
        this.base = base.endsWith("/") ? base.substring(0, base.length() - 1) : base;
        this.token = token;
        this.agent = "TaskFlow-Android/" + appVersion;
    }

    JSONObject get(String path) throws IOException {
        HttpURLConnection c = open(path, "GET", 30_000);
        return read(c);
    }

    JSONObject post(String path, JSONObject body) throws IOException {
        HttpURLConnection c = open(path, "POST", 60_000);
        byte[] bytes = (body == null ? "{}" : body.toString()).getBytes(StandardCharsets.UTF_8);
        c.setDoOutput(true);
        c.setRequestProperty("Content-Type", "application/json");
        c.setFixedLengthStreamingMode(bytes.length);
        try (OutputStream out = c.getOutputStream()) {
            out.write(bytes);
        }
        return read(c);
    }

    /** A file as multipart form data, streamed (never held in memory whole); digest sees every byte sent. */
    JSONObject upload(String path, Map<String, String> fields, String fileName, String mime, InputStream file, MessageDigest digest) throws IOException {
        String boundary = "taskflow-" + UUID.randomUUID();
        HttpURLConnection c = open(path, "POST", 300_000);
        c.setDoOutput(true);
        c.setChunkedStreamingMode(64 * 1024);
        c.setRequestProperty("Content-Type", "multipart/form-data; boundary=" + boundary);
        try (OutputStream out = c.getOutputStream()) {
            for (Map.Entry<String, String> f : fields.entrySet()) {
                write(out, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + f.getKey() + "\"\r\n\r\n" + f.getValue() + "\r\n");
            }
            String safeName = fileName.replace("\"", "").replace("\r", "").replace("\n", "");
            write(out, "--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + safeName + "\"\r\nContent-Type: " + mime + "\r\n\r\n");
            byte[] buffer = new byte[64 * 1024];
            int n;
            while ((n = file.read(buffer)) > 0) {
                out.write(buffer, 0, n);
                if (digest != null) digest.update(buffer, 0, n);
            }
            write(out, "\r\n--" + boundary + "--\r\n");
        }
        return read(c);
    }

    private HttpURLConnection open(String path, String method, int readTimeout) throws IOException {
        HttpURLConnection c = (HttpURLConnection) URI.create(base + path).toURL().openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(20_000);
        c.setReadTimeout(readTimeout);
        c.setUseCaches(false);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("User-Agent", agent);
        if (token != null) c.setRequestProperty("Authorization", "Device " + token);
        return c;
    }

    private static void write(OutputStream out, String text) throws IOException {
        out.write(text.getBytes(StandardCharsets.UTF_8));
    }

    private static JSONObject read(HttpURLConnection c) throws IOException {
        try {
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = in == null ? "" : readAll(in);
            JSONObject json;
            try {
                json = text.isEmpty() ? new JSONObject() : new JSONObject(text);
            } catch (JSONException e) {
                json = new JSONObject();
            }
            if (status >= 300) {
                JSONObject details = json.optJSONObject("details");
                String code = details == null ? null : details.optString("code", null);
                throw new Failure(status, code, json.optString("error", "TaskFlow answered " + status));
            }
            return json;
        } finally {
            c.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16 * 1024];
            int n;
            while ((n = s.read(buffer)) > 0) out.write(buffer, 0, n);
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }
}
