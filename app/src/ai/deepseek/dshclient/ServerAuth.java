package ai.deepseek.dshclient;

import android.util.Log;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URI;
import java.net.URISyntaxException;
import java.net.URL;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * Native DSH web authentication, done completely outside the WebView:
 *
 *   1. GET  {origin}/?token={token}   (redirects disabled) -- the 303 response
 *      carries `Set-Cookie: dsh-auth-...=v1...`; that cookie is the session.
 *   2. POST {origin}/api/session/list (JSON-RPC over HTTP) with the cookie,
 *      to prove the cookie is accepted before handing it to CookieManager.
 *
 * The resulting cookie is then installed into WebView's CookieManager so the
 * bundled UI can be loaded with loadDataWithBaseURL(origin, ...) and be
 * same-origin with the server (fetch + WebSocket + cookie all just work).
 */
final class ServerAuth {
    static final String TAG = "DSH_AUTH";
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 25000;
    private static final String UA = "DSH-Android/0.1";

    private ServerAuth() {
    }

    static final class Cfg {
        final String origin;
        final String token;

        Cfg(String origin, String token) {
            this.origin = origin;
            this.token = token;
        }
    }

    static final class Result {
        final boolean ok;
        final String error;
        final String cookie;   // "name=value; Path=/; HttpOnly; SameSite=Strict"
        final String origin;
        final String detail;   // human readable evidence string

        Result(boolean ok, String error, String cookie, String origin, String detail) {
            this.ok = ok;
            this.error = error;
            this.cookie = cookie;
            this.origin = origin;
            this.detail = detail;
        }

        static Result fail(String error) {
            return new Result(false, error, null, null, null);
        }
    }

    // ---------------------------------------------------------------- parsing

    /**
     * Accepts all of the shapes a user may paste:
     *   - "http://192.168.1.10:3080/?token=XXX"  (full dsh web URL)
     *   - "https://<machine>.<tailnet>.ts.net:3080/?token=XXX"
     *   - "http://192.168.1.10:3080" / "192.168.1.10:3080" (origin only)
     *   - separate token, or token field containing the full URL.
     */
    static Cfg parseConfig(String primaryInput, String tokenInput) {
        String primary = primaryInput == null ? "" : primaryInput.trim();
        String token = tokenInput == null ? "" : tokenInput.trim();

        String lowerToken = token.toLowerCase(Locale.ROOT);
        if (lowerToken.startsWith("http://") || lowerToken.startsWith("https://")) {
            String fromTokenUrl = tokenFromUrl(token);
            if (fromTokenUrl != null) {
                if (primary.isEmpty()) {
                    primary = token;
                }
                token = fromTokenUrl;
            }
        }

        String fromPrimaryUrl = tokenFromUrl(primary);
        if (fromPrimaryUrl != null) {
            if (token.isEmpty()) {
                token = fromPrimaryUrl;
            }
            int cut = primary.indexOf('?');
            if (cut < 0) {
                cut = primary.indexOf('#');
            }
            if (cut >= 0) {
                primary = primary.substring(0, cut);
            }
        }

        if (token.startsWith("?token=")) {
            token = token.substring("?token=".length());
        } else if (token.startsWith("token=")) {
            token = token.substring("token=".length());
        }
        token = token.trim();
        primary = primary.trim();
        while (primary.endsWith("/")) {
            primary = primary.substring(0, primary.length() - 1);
        }

        if (primary.isEmpty()) {
            throw new IllegalArgumentException("请输入服务器地址 / Server URL is required");
        }
        if (token.isEmpty()) {
            throw new IllegalArgumentException(
                    "请输入令牌 / Token is required (it is printed by `dsh web` in the terminal)");
        }
        return new Cfg(normalizeOrigin(primary), token);
    }

    private static String tokenFromUrl(String s) {
        int i = s.indexOf("?token=");
        if (i < 0) {
            i = s.indexOf("&token=");
        }
        if (i < 0) {
            i = s.indexOf("#token=");
        }
        if (i < 0) {
            return null;
        }
        String t = s.substring(i + "?token=".length());
        int amp = t.indexOf('&');
        if (amp >= 0) {
            t = t.substring(0, amp);
        }
        return t.trim();
    }

    static String normalizeOrigin(String raw) {
        String s = raw == null ? "" : raw.trim();
        if (!s.contains("://")) {
            s = "http://" + s;
        }
        try {
            URI u = new URI(s);
            String scheme = u.getScheme() == null ? "http" : u.getScheme().toLowerCase(Locale.ROOT);
            if (!"http".equals(scheme) && !"https".equals(scheme)) {
                throw new IllegalArgumentException("只支持 http:// 或 https:// 地址");
            }
            String host = u.getHost();
            if (host == null || host.isEmpty()) {
                throw new IllegalArgumentException("服务器地址格式不正确 / Bad server URL");
            }
            int port = u.getPort();
            return scheme + "://" + host + (port == -1 ? "" : ":" + port);
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("服务器地址格式不正确 / Bad server URL: " + e.getMessage());
        }
    }

    // ---------------------------------------------------------------- network

    static Result login(String rawOrigin, String rawToken) {
        final String origin;
        final String token;
        try {
            origin = normalizeOrigin(rawOrigin);
            token = rawToken == null ? "" : rawToken.trim();
        } catch (IllegalArgumentException e) {
            return Result.fail(e.getMessage());
        }
        if (token.isEmpty()) {
            return Result.fail("请输入令牌 / Token is required");
        }

        HttpURLConnection conn = null;
        try {
            String authUrl = origin + "/?token=" + URLEncoder.encode(token, "UTF-8");
            conn = (HttpURLConnection) new URL(authUrl).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Accept", "text/html,*/*");
            int code = conn.getResponseCode();
            Log.i(TAG, "GET " + origin + "/?token=*** -> HTTP " + code);

            if (code == 401 || code == 403) {
                return Result.fail("令牌无效或已过期 / Token rejected (HTTP " + code + ")");
            }
            if (code >= 400) {
                return Result.fail("服务器返回错误 HTTP " + code + " / Server error");
            }

            String pair = findAuthCookie(conn.getHeaderFields());
            if (pair == null || pair.isEmpty()) {
                return Result.fail("服务器没有返回登录 Cookie / No auth cookie (HTTP " + code
                        + "). Is the token current?");
            }

            String cookieName = pair.substring(0, Math.max(0, pair.indexOf('=')));
            String cookie = pair + "; Path=/; HttpOnly; SameSite=Strict";

            // Verify the cookie actually authenticates before trusting it.
            String verifyError = verifySessionList(origin, pair);
            if (verifyError != null) {
                return Result.fail(verifyError);
            }

            String detail = "HTTP " + code + ", Set-Cookie " + cookieName
                    + ", POST /api/session/list verified";
            Log.i(TAG, "auth OK: " + detail);
            return new Result(true, null, cookie, origin, detail);
        } catch (Exception e) {
            String msg = friendly(e);
            Log.w(TAG, "auth failed: " + msg, e);
            return Result.fail(msg);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /** Returns null when the cookie works, otherwise a user-facing error. */
    private static String verifySessionList(String origin, String cookiePair) {
        HttpURLConnection conn = null;
        try {
            String rpcId = UUID.randomUUID().toString();
            String body = "{\"type\":\"client-request\",\"rpcId\":\"" + rpcId
                    + "\",\"method\":\"session/list\",\"payload\":{\"args\":{\"_request\":{}}}}";
            byte[] payload = body.getBytes(StandardCharsets.UTF_8);

            conn = (HttpURLConnection) new URL(origin + "/api/session/list").openConnection();
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Cookie", cookiePair);
            conn.setRequestProperty("User-Agent", UA);
            conn.setFixedLengthStreamingMode(payload.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(payload);
            }

            int code = conn.getResponseCode();
            String response = readAll(code < 400 ? conn.getInputStream() : conn.getErrorStream());
            Log.i(TAG, "POST /api/session/list -> HTTP " + code + " " + abbreviate(response));

            if (code == 401 || code == 403) {
                return "令牌无效或已过期 / Cookie rejected by server (HTTP " + code + ")";
            }
            if (code >= 400) {
                return "验证会话失败 HTTP " + code + " / Session check failed";
            }
            if (response == null || !response.contains("\"ok\":true")) {
                return "会话接口返回异常 / Unexpected session/list response";
            }
            return null;
        } catch (Exception e) {
            return "验证会话失败 / Verify failed: " + friendly(e);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static String findAuthCookie(Map<String, List<String>> headers) {
        if (headers == null) {
            return null;
        }
        String fallback = null;
        for (Map.Entry<String, List<String>> entry : headers.entrySet()) {
            if (entry.getKey() == null || !"Set-Cookie".equalsIgnoreCase(entry.getKey())) {
                continue;
            }
            List<String> values = entry.getValue();
            if (values == null) {
                continue;
            }
            for (String value : values) {
                if (value == null || value.indexOf('=') < 0) {
                    continue;
                }
                String pair = value.split(";", 2)[0].trim();
                if (pair.startsWith("dsh-auth-")) {
                    return pair;
                }
                if (fallback == null) {
                    fallback = pair;
                }
            }
        }
        return fallback;
    }

    private static String readAll(InputStream in) throws IOException {
        if (in == null) {
            return "";
        }
        StringBuilder sb = new StringBuilder();
        try (BufferedReader reader = new BufferedReader(
                new InputStreamReader(in, StandardCharsets.UTF_8))) {
            char[] buf = new char[4096];
            int n;
            while ((n = reader.read(buf)) != -1) {
                sb.append(buf, 0, n);
                if (sb.length() > 512 * 1024) {
                    break;
                }
            }
        }
        return sb.toString();
    }

    private static String abbreviate(String s) {
        if (s == null) {
            return "<null>";
        }
        String one = s.replace('\n', ' ');
        return one.length() <= 240 ? one : one.substring(0, 240) + "…";
    }

    private static String friendly(Exception e) {
        if (e instanceof SocketTimeoutException) {
            return "连接服务器超时 / Timed out";
        }
        if (e instanceof ConnectException) {
            return "无法连接服务器，请检查地址与网络 / Cannot connect to server";
        }
        if (e instanceof UnknownHostException) {
            return "无法解析服务器地址 / Unknown host";
        }
        String m = e.getMessage();
        return "网络错误 / Network error: " + (m == null ? e.getClass().getSimpleName() : m);
    }
}
