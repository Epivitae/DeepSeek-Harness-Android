package ai.deepseek.dshclient;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Typeface;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;

/**
 * Diagnostic activity for the on-device capability proof (task-1 step 2).
 *
 * Launched by tools/android-proof/run-proof.sh:
 *   adb shell am start -n ai.deepseek.dshclient/.ProofActivity \
 *       --es server http://192.168.1.10:3080 --es token <token>
 *
 * It authenticates natively, installs the cookie, then loads a bundled test
 * page with loadDataWithBaseURL(serverOrigin) and asks page JS to report
 * location.origin, POST /api/session/list and a session/follow WebSocket.
 */
public class ProofActivity extends Activity {
    private static final String TAG = "DSH_PROOF";

    private static final int C_BG = 0xFF0B0C0F;
    private static final int C_SURFACE = 0xFF14181F;
    private static final int C_TEXT = 0xFFE8EDF4;
    private static final int C_MUTED = 0xFF8B98A9;
    private static final int C_ACCENT = 0xFF4F8CFF;
    private static final int C_ERROR = 0xFFFF6B6B;
    private static final int C_OK = 0xFF3DDC84;
    private static final int C_WARN = 0xFFFFD166;

    private LinearLayout nativeLog;
    private TextView finalView;
    private FrameLayout webHolder;
    private WebView webView;
    private String server = "";
    private String token = "";
    private boolean finished;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().setStatusBarColor(C_BG);
        getWindow().setNavigationBarColor(C_BG);

        server = getIntent().getStringExtra("server");
        token = getIntent().getStringExtra("token");
        if (server == null || server.isEmpty()) {
            server = "http://192.168.1.10:3080";
        }
        if (token == null) {
            token = "";
        }
        buildUi();
        startProof();
    }

    private void buildUi() {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(C_BG);
        root.setPadding(dp(18), dp(14), dp(18), dp(10));

        TextView title = new TextView(this);
        title.setText("DSH WebView capability proof");
        title.setTextColor(C_TEXT);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        root.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("loadDataWithBaseURL(serverOrigin) + native cookie auth");
        subtitle.setTextColor(C_MUTED);
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subLp.bottomMargin = dp(10);
        root.addView(subtitle, subLp);

        // Proof page (scrollable, reports its own rows with big fonts).
        webHolder = new FrameLayout(this);
        webHolder.setBackgroundColor(C_BG);
        LinearLayout.LayoutParams webLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        root.addView(webHolder, webLp);

        TextView logTitle = new TextView(this);
        logTitle.setText("native log");
        logTitle.setTextColor(C_MUTED);
        logTitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        root.addView(logTitle);

        ScrollView logScroll = new ScrollView(this);
        nativeLog = new LinearLayout(this);
        nativeLog.setOrientation(LinearLayout.VERTICAL);
        nativeLog.setBackgroundColor(C_SURFACE);
        nativeLog.setPadding(dp(10), dp(6), dp(10), dp(6));
        logScroll.addView(nativeLog);
        LinearLayout.LayoutParams logLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(120));
        root.addView(logScroll, logLp);

        finalView = new TextView(this);
        finalView.setText("PROOF RUNNING…");
        finalView.setTextColor(C_WARN);
        finalView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        finalView.setTypeface(Typeface.DEFAULT_BOLD);
        LinearLayout.LayoutParams finalLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        finalLp.topMargin = dp(8);
        root.addView(finalView, finalLp);

        setContentView(root);
    }

    private void startProof() {
        addLine("device: " + Build.MANUFACTURER + " " + Build.MODEL + " / Android "
                + Build.VERSION.RELEASE + " (SDK " + Build.VERSION.SDK_INT + ")", C_MUTED);
        addLine("server: " + server, C_MUTED);
        setFinal("PROOF RUNNING… native auth", C_WARN);
        Log.i(TAG, "PROOF START server=" + server);

        new Thread(new Runnable() {
            @Override
            public void run() {
                final ServerAuth.Result result = ServerAuth.login(server, token);
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (!result.ok) {
                            addLine("FAIL native auth: " + result.error, C_ERROR);
                            setFinal("PROOF FAIL — native auth: " + result.error, C_ERROR);
                            Log.i(TAG, "PROOF FINAL FAIL native-auth: " + result.error);
                            return;
                        }
                        addLine("OK native auth: " + result.detail, C_OK);
                        CookieManager manager = CookieManager.getInstance();
                        manager.setAcceptCookie(true);
                        manager.setCookie(result.origin, result.cookie);
                        manager.flush();
                        String name = result.cookie.split("=", 2)[0];
                        addLine("OK CookieManager.setCookie(" + result.origin + ") called ["
                                + name + ", flushed]", C_OK);
                        loadProofPage(result.origin);
                    }
                });
            }
        }, "dsh-proof-auth").start();
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private void loadProofPage(String origin) {
        if (webView == null) {
            webView = new WebView(this);
            WebSettings settings = webView.getSettings();
            settings.setJavaScriptEnabled(true);
            settings.setDomStorageEnabled(true);
            settings.setAllowFileAccess(false);
            settings.setMediaPlaybackRequiresUserGesture(false);
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
            webView.setWebContentsDebuggingEnabled(true);
            webView.setBackgroundColor(C_BG);
            webView.addJavascriptInterface(new ProofBridge(), "Proof");
            webView.setWebChromeClient(new WebChromeClient() {
                @Override
                public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
                    Log.i(TAG, "console: " + message.message() + " @" + message.sourceId());
                    return true;
                }
            });
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    Log.i(TAG, "proof page finished " + url);
                }
            });
        }
        addLine("UA: " + webView.getSettings().getUserAgentString(), C_MUTED);

        if (webView.getParent() == null) {
            webHolder.addView(webView, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }

        final String html;
        try {
            html = readAsset("proof/index.html");
        } catch (IOException e) {
            addLine("FAIL read proof asset: " + e, C_ERROR);
            setFinal("PROOF FAIL — " + e, C_ERROR);
            return;
        }
        addLine("loadDataWithBaseURL(" + origin + "/, " + html.length() + " chars)", C_MUTED);
        webView.loadDataWithBaseURL(origin + "/", html, "text/html", "utf-8", null);
    }

    private String readAsset(String path) throws IOException {
        StringBuilder sb = new StringBuilder();
        try (InputStream in = getAssets().open(path);
             BufferedReader reader = new BufferedReader(
                     new InputStreamReader(in, StandardCharsets.UTF_8))) {
            char[] buffer = new char[8192];
            int n;
            while ((n = reader.read(buffer)) != -1) {
                sb.append(buffer, 0, n);
            }
        }
        return sb.toString();
    }

    private void finishProof(boolean ok, String detail) {
        if (finished) {
            return;
        }
        finished = true;
        setFinal(ok ? "PROOF OK — " + detail : "PROOF FAIL — " + detail,
                ok ? C_OK : C_ERROR);
        Log.i(TAG, "PROOF FINAL " + (ok ? "OK" : "FAIL") + " " + detail);
    }

    private void setFinal(String text, int color) {
        finalView.setText(text);
        finalView.setTextColor(color);
    }

    private void addLine(String text, int color) {
        Log.i(TAG, "native: " + text);
        if (nativeLog == null) {
            return;
        }
        TextView line = new TextView(this);
        line.setText(text);
        line.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        line.setTextColor(color);
        line.setTypeface(Typeface.MONOSPACE);
        nativeLog.addView(line);
    }

    /** Bridge used by the bundled proof page: window.Proof.report(step,status,detail). */
    public final class ProofBridge {
        @JavascriptInterface
        public void report(final String step, final String status, final String detail) {
            final boolean ok = "ok".equals(status);
            Log.i(TAG, "JS " + (ok ? "OK  " : "FAIL") + " " + step + ": " + detail);
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    addLine((ok ? "OK  " : "FAIL") + " " + step + ": " + detail,
                            ok ? C_OK : C_ERROR);
                    if ("final".equals(step)) {
                        finishProof(ok, detail);
                    } else if ("fail".equals(step)) {
                        finishProof(false, detail);
                    }
                }
            });
        }
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                getResources().getDisplayMetrics());
    }
}
