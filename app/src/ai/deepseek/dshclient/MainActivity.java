package ai.deepseek.dshclient;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebBackForwardList;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * DSH Android shell.
 *
 * Start-up: saved {baseUrl, token} -> native HttpURLConnection auth
 * (GET /?token=..., redirects disabled, parse Set-Cookie, verify with
 * POST /api/session/list) -> install cookie into CookieManager ->
 * WebView.loadDataWithBaseURL(baseUrl, bundledIndexHtml, ...).
 *
 * Because the base URL is the DSH server origin, the bundled UI is same-origin
 * with the server: fetch('/api/...') and WebSocket ws(s)://host/api/remote.mux
 * carry the auth cookie with no CORS/file-origin hacks. The UI is inlined by
 * tools/bundle-ui.mjs, so no relative asset requests are made.
 *
 * First run: native dark setup screen (server URL / full dsh URL + token).
 */
public class MainActivity extends Activity {
    private static final String TAG = "DSH";
    private static final String PREFS = "dsh";
    private static final String K_ORIGIN = "origin";
    private static final String K_TOKEN = "token";
    private static final String K_PRIMARY = "primary";
    private static final String K_FALLBACK = "fallback";
    private static final String K_ACTIVE = "active";

    private static final int C_BG = 0xFF0B0C0F;
    private static final int C_SURFACE = 0xFF161A21;
    private static final int C_STROKE = 0xFF2A3342;
    private static final int C_TEXT = 0xFFE8EDF4;
    private static final int C_MUTED = 0xFF8B98A9;
    private static final int C_HINT = 0xFF5B6779;
    private static final int C_ACCENT = 0xFF4F8CFF;
    private static final int C_ON_ACCENT = 0xFF06121F;
    private static final int C_ERROR = 0xFFFF6B6B;

    private SharedPreferences prefs;
    /** Active server origin currently loaded in the WebView. */
    private String origin;
    private String token;
    /** Configured primary (LAN) origin and optional Tailscale fallback. */
    private String primaryOrigin;
    private String fallbackOrigin;
    private volatile boolean fallbackSwitching;
    private long fallbackLastAttemptMs;

    private FrameLayout root;
    private WebView webView;
    private View splashView;
    private boolean pageReady;
    private boolean taskRunning;
    private boolean appVisible = true;
    private Bundle pendingWebState;

    // Setup screen widgets (null when the setup screen is not visible).
    private LinearLayout setupView;
    private EditText setupPrimary;
    private EditText setupFallback;
    private EditText setupToken;
    private TextView setupStatus;
    private Button setupButton;

    private final Runnable hideSplashRunnable = new Runnable() {
        @Override
        public void run() {
            hideSplash();
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        NotifyCenter.ensureChannel(this);
        primaryOrigin = prefs.getString(K_PRIMARY, prefs.getString(K_ORIGIN, null));
        fallbackOrigin = prefs.getString(K_FALLBACK, null);
        if (fallbackOrigin != null && fallbackOrigin.trim().isEmpty()) fallbackOrigin = null;
        origin = prefs.getString(K_ACTIVE, primaryOrigin);
        token = prefs.getString(K_TOKEN, null);
        if (savedInstanceState != null && savedInstanceState.containsKey("webview")) {
            pendingWebState = savedInstanceState;
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(C_BG);
        setContentView(root);
        applyEdgeToEdge();

        if (maybeAutoConfigure()) {
            return;
        }

        if (primaryOrigin != null && !primaryOrigin.isEmpty()
                && token != null && !token.isEmpty()) {
            showLoadingOverlay("正在连接服务器… / Connecting…");
            authAndLoadBest(primaryOrigin, fallbackOrigin, token);
        } else {
            showSetup(null);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        maybeAutoConfigure();
    }

    /**
     * Debug-only automation hook so the shell can be verified end-to-end
     * without typing on the device:
     *
     *   adb shell am start -n ai.deepseek.dshclient/.MainActivity \
     *       --es dshAutoUrl "http://192.168.1.10:3080/?token=..." 
     *
     * Ignored unless the APK is debuggable (debug builds only).
     */
    private boolean maybeAutoConfigure() {
        Intent intent = getIntent();
        String autoUrl = intent == null ? null : intent.getStringExtra("dshAutoUrl");
        if (autoUrl == null || autoUrl.isEmpty()) {
            return false;
        }
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (!debuggable) {
            Log.w(TAG, "ignoring dshAutoUrl: app is not debuggable");
            return false;
        }
        try {
            ServerAuth.Cfg cfg = ServerAuth.parseConfig(autoUrl,
                    intent.getStringExtra("dshAutoToken"));
            String autoFallback = intent.getStringExtra("dshAutoFallback");
            String fallback = null;
            if (autoFallback != null && !autoFallback.trim().isEmpty()) {
                try {
                    fallback = ServerAuth.parseConfig(autoFallback, cfg.token).origin;
                } catch (IllegalArgumentException ignored) {
                    Log.w(TAG, "ignoring bad dshAutoFallback: " + autoFallback);
                }
            }
            primaryOrigin = cfg.origin;
            fallbackOrigin = fallback;
            origin = cfg.origin;
            token = cfg.token;
            saveConfig(cfg.origin, fallback, cfg.origin, cfg.token);
            Log.i(TAG, "auto-config from intent: " + cfg.origin
                    + (fallback == null ? "" : " fallback=" + fallback));
            showLoadingOverlay("正在连接服务器… / Connecting…");
            authAndLoadBest(cfg.origin, fallback, cfg.token);
            return true;
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "bad dshAutoUrl: " + e.getMessage());
            return false;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        appVisible = true;
        if (webView != null) {
            webView.onResume();
            if (pageReady) {
                webView.evaluateJavascript(
                        "(function(){try{window.DSH_onResume&&window.DSH_onResume();}catch(e){}})()",
                        null);
            }
        }
    }

    @Override
    protected void onPause() {
        appVisible = false;
        if (webView != null) {
            if (taskRunning) {
                // Keep JS + the Remote-mux WebSocket alive while a turn is
                // running so the completion notification can still fire.
                webView.resumeTimers();
            } else {
                webView.onPause();
            }
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        hideSplash();
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    // ------------------------------------------------------------ edge-to-edge

    private void applyEdgeToEdge() {
        Window window = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            window.setDecorFitsSystemWindows(false);
        } else {
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                            | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        window.setStatusBarColor(Color.TRANSPARENT);
        window.setNavigationBarColor(Color.TRANSPARENT);
        if (Build.VERSION.SDK_INT >= 29) {
            window.setNavigationBarContrastEnforced(false);
        }

        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                    Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
                    Insets cut = insets.getInsets(WindowInsets.Type.displayCutout());
                    Insets ime = insets.getInsets(WindowInsets.Type.ime());
                    v.setPadding(
                            Math.max(bars.left, cut.left),
                            Math.max(bars.top, cut.top),
                            Math.max(bars.right, cut.right),
                            Math.max(Math.max(bars.bottom, cut.bottom), ime.bottom));
                    return insets;
                }
            });
        } else {
            root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
                @Override
                @SuppressWarnings("deprecation")
                public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                    v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                            insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
                    return insets;
                }
            });
        }
        root.requestApplyInsets();
    }

    // ---------------------------------------------------------------- auth flow

    /**
     * Try the primary (LAN) origin first; when it is unreachable and a
     * Tailscale fallback is configured, try that before surfacing an error.
     */
    private void authAndLoadBest(final String primary, final String fallback, final String tok) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                final ServerAuth.Result primaryResult = ServerAuth.login(primary, tok);
                ServerAuth.Result fallbackResult = null;
                ServerAuth.Result result = primaryResult;
                boolean usedFallback = false;
                if (!primaryResult.ok && fallback != null && !fallback.isEmpty()
                        && !fallback.equals(primary)) {
                    Log.i(TAG, "primary failed, trying fallback " + fallback);
                    fallbackResult = ServerAuth.login(fallback, tok);
                    if (fallbackResult.ok) {
                        result = fallbackResult;
                        usedFallback = true;
                    }
                }
                final ServerAuth.Result finalResult = result;
                final ServerAuth.Result finalFallbackResult = fallbackResult;
                final boolean finalUsedFallback = usedFallback;
                final String finalFallback = fallback;
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        if (finalResult.ok) {
                            primaryOrigin = primary;
                            fallbackOrigin = finalFallback;
                            origin = finalResult.origin;
                            token = tok;
                            saveConfig(primary, finalFallback, origin, tok);
                            applyCookie(origin, finalResult.cookie);
                            loadApp(origin);
                            if (finalUsedFallback) {
                                Toast.makeText(MainActivity.this,
                                        "内网连接失败，已切换到 Tailscale",
                                        Toast.LENGTH_LONG).show();
                            }
                        } else {
                            Log.w(TAG, "auth failed: " + finalResult.error);
                            String message = finalResult.error == null ? "连接失败" : finalResult.error;
                            if (finalFallbackResult != null) {
                                message = "内网连接失败：" + primaryResult.error
                                        + "\n\nTailscale 连接失败：" + finalFallbackResult.error;
                            }
                            if (setupView != null) {
                                setSetupBusy(false);
                                showSetupMessage(message + "\n提示：令牌由终端里的 dsh web "
                                        + "启动日志打印，重启 dsh web 后令牌会变化。", true);
                            } else {
                                showSetup(message);
                            }
                        }
                    }
                });
            }
        }, "dsh-auth-best").start();
    }

    private void saveConfig(String primary, String fallback, String active, String tok) {
        prefs.edit()
                .putString(K_PRIMARY, primary)
                .putString(K_FALLBACK, fallback == null ? "" : fallback)
                .putString(K_ACTIVE, active)
                .putString(K_ORIGIN, active)
                .putString(K_TOKEN, tok)
                .apply();
    }

    /** Parse an optional fallback address (URL or host[:port]). */
    private String fallbackOriginFromInput(String input, String tok) {
        if (input == null || input.trim().isEmpty()) return null;
        return ServerAuth.parseConfig(input, tok).origin;
    }

    private void applyCookie(String baseOrigin, String cookie) {
        try {
            CookieManager manager = CookieManager.getInstance();
            manager.setAcceptCookie(true);
            if (webView != null) {
                manager.setAcceptThirdPartyCookies(webView, false);
            }
            manager.setCookie(baseOrigin, cookie);
            manager.flush();
            Log.i(TAG, "CookieManager.setCookie(" + baseOrigin + ") called + flushed");
        } catch (Exception e) {
            Log.e(TAG, "applyCookie failed", e);
        }
    }

    // ---------------------------------------------------------------- web view

    private void loadApp(final String base) {
        pageReady = false;
        if (webView == null) {
            webView = createWebView();
        }
        root.removeAllViews();
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setupView = null;
        setupStatus = null;
        setupButton = null;
        setupPrimary = null;
        setupFallback = null;
        setupToken = null;
        showLoadingOverlay("正在加载界面… / Loading…");

        final String html;
        try {
            html = readAsset("ui/index.html");
        } catch (IOException e) {
            Log.e(TAG, "bundled ui/index.html missing", e);
            showSetup("内置界面缺失 / Bundled UI missing: " + e.getMessage());
            return;
        }

        String url = base.endsWith("/") ? base : base + "/";
        if (pendingWebState != null) {
            WebBackForwardList restored = webView.restoreState(pendingWebState);
            pendingWebState = null;
            if (restored != null && restored.getSize() > 0) {
                Log.i(TAG, "restored WebView state (" + restored.getSize() + " entries)");
                return;
            }
        }
        webView.loadDataWithBaseURL(url, html, "text/html", "utf-8", null);
        Log.i(TAG, "loadDataWithBaseURL(" + url + ", html " + html.length() + " chars)");
    }

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private WebView createWebView() {
        WebView view = new WebView(this);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " DSHClient/0.1");
        if (Build.VERSION.SDK_INT >= 26) {
            settings.setSafeBrowsingEnabled(false);
        }

        view.setBackgroundColor(C_BG);
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        if (debuggable) {
            WebView.setWebContentsDebuggingEnabled(true);
        }
        view.addJavascriptInterface(new Bridge(), "DSHNative");
        view.setWebViewClient(new ShellClient());
        view.setWebChromeClient(new ShellChrome());
        return view;
    }

    private String readAsset(String path) throws IOException {
        StringBuilder sb = new StringBuilder();
        try (InputStream in = getAssets().open(path);
             BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            char[] buffer = new char[8192];
            int n;
            while ((n = reader.read(buffer)) != -1) {
                sb.append(buffer, 0, n);
            }
        }
        return sb.toString();
    }

    // ---------------------------------------------------------------- setup UI

    private void showSetup(String error) {
        pageReady = false;
        hideSplash();
        if (webView != null) {
            webView.stopLoading();
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        setupView = null;
        root.removeAllViews();

        final int contentW = Math.min(getResources().getDisplayMetrics().widthPixels, dp(560));
        final int padH = dp(20);

        LinearLayout page = new LinearLayout(this);
        page.setOrientation(LinearLayout.VERTICAL);
        page.setBackgroundColor(C_BG);

        // Scrollable content (title, URL/token fields, hints). The Connect
        // button lives in a fixed bottom bar below, so it always stays visible
        // above the IME on a phone (root is padded by the IME inset).
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setClipToPadding(false);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(padH, dp(26), padH, dp(8));

        TextView title = new TextView(this);
        title.setText("DeepSeek Harness");
        title.setTextColor(C_TEXT);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        box.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText("连接你的 DSH 服务器  ·  Connect to your DSH server");
        subtitle.setTextColor(C_MUTED);
        subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        LinearLayout.LayoutParams subLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        subLp.topMargin = dp(6);
        box.addView(subtitle, subLp);

        setupPrimary = field(
                "http://192.168.1.10:3080 或 https://<machine>.<tailnet>.ts.net:3080/?token=…",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        setupPrimary.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_NEXT);
        if (primaryOrigin != null) {
            setupPrimary.setText(primaryOrigin);
        } else if (origin != null) {
            setupPrimary.setText(origin);
        }
        box.addView(labeledField("内网地址 / PRIMARY URL", setupPrimary));

        setupFallback = field("可选：https://<machine>.<tailnet>.ts.net:3080",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        setupFallback.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_NEXT);
        if (fallbackOrigin != null) {
            setupFallback.setText(fallbackOrigin);
        }
        box.addView(labeledField("Tailscale 地址 / FALLBACK URL（可选）", setupFallback));

        setupToken = field("粘贴令牌（?token= 后面的部分）",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        setupToken.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_DONE);
        box.addView(labeledField("令牌 / TOKEN", setupToken));

        TextView hint = new TextView(this);
        hint.setText("提示：主地址填内网 http://192.168.1.10:3080；Tailscale 地址选填"
                + "（如 https://<machine>.<tailnet>.ts.net:3080），内网连不上时会自动切换。"
                + "令牌会自动解析。\n"
                + "Tip: primary = LAN URL, fallback = Tailscale URL (optional). "
                + "The app switches to the fallback when the primary is unreachable.");
        hint.setTextColor(C_HINT);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        hint.setLineSpacing(0, 1.15f);
        LinearLayout.LayoutParams hintLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hintLp.topMargin = dp(18);
        box.addView(hint, hintLp);

        TextView footnote = new TextView(this);
        footnote.setText("令牌只保存在本机 SharedPreferences；页面通过原生 Cookie 认证。");
        footnote.setTextColor(C_HINT);
        footnote.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        LinearLayout.LayoutParams footLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        footLp.topMargin = dp(12);
        box.addView(footnote, footLp);

        scroll.addView(box, new ScrollView.LayoutParams(
                contentW, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_HORIZONTAL));
        page.addView(scroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        // Fixed bottom bar: inline status + Connect. Padded by the IME inset
        // via applyEdgeToEdge(), so it stays above the keyboard.
        LinearLayout bottom = new LinearLayout(this);
        bottom.setOrientation(LinearLayout.VERTICAL);
        bottom.setGravity(Gravity.CENTER_HORIZONTAL);
        bottom.setBackgroundColor(C_BG);
        bottom.setPadding(padH, dp(6), padH, dp(14));

        View divider = new View(this);
        divider.setBackgroundColor(C_STROKE);
        bottom.addView(divider, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(1)));

        setupStatus = new TextView(this);
        setupStatus.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        setupStatus.setTextColor(error == null ? C_MUTED : C_ERROR);
        if (error == null) {
            setupStatus.setVisibility(View.GONE);
        } else {
            setupStatus.setText(error + "\n提示：令牌由终端里的 dsh web 启动日志打印，"
                    + "重启 dsh web 后令牌会变化。");
            setupStatus.setVisibility(View.VISIBLE);
        }
        LinearLayout.LayoutParams statusLp = new LinearLayout.LayoutParams(
                contentW - 2 * padH, ViewGroup.LayoutParams.WRAP_CONTENT);
        statusLp.topMargin = dp(10);
        statusLp.bottomMargin = dp(8);
        bottom.addView(setupStatus, statusLp);

        setupButton = new Button(this);
        setupButton.setText("连接 / Connect");
        setupButton.setAllCaps(false);
        setupButton.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        setupButton.setTextColor(C_ON_ACCENT);
        setupButton.setTypeface(Typeface.DEFAULT_BOLD);
        setupButton.setBackground(rounded(C_ACCENT, 12, 0));
        setupButton.setMinHeight(dp(52));
        LinearLayout.LayoutParams buttonLp = new LinearLayout.LayoutParams(
                contentW - 2 * padH, dp(52));
        setupButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                connectFromSetup();
            }
        });
        bottom.addView(setupButton, buttonLp);

        page.addView(bottom, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(page, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setupView = page;

        if (setupPrimary.getText().length() > 0) {
            setupPrimary.setSelection(setupPrimary.getText().length());
        }
    }

    /** Label row with a 44dp "Paste" touch target + the field below it. */
    private View labeledField(String labelText, final EditText edit) {
        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        LinearLayout.LayoutParams rowLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        rowLp.topMargin = dp(18);
        wrap.addView(row, rowLp);

        TextView label = new TextView(this);
        label.setText(labelText);
        label.setTextColor(C_MUTED);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        label.setLetterSpacing(0.1f);
        row.addView(label, new LinearLayout.LayoutParams(0,
                ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        TextView paste = new TextView(this);
        paste.setText("粘贴 / Paste");
        paste.setTextColor(C_ACCENT);
        paste.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        paste.setGravity(Gravity.CENTER_VERTICAL);
        paste.setMinHeight(dp(44));
        paste.setPadding(dp(12), dp(6), dp(4), dp(6));
        paste.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                pasteInto(edit);
            }
        });
        row.addView(paste, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        wrap.addView(edit, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return wrap;
    }

    private void pasteInto(EditText target) {
        try {
            ClipboardManager clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
            if (clipboard == null || !clipboard.hasPrimaryClip()) {
                showSetupMessage("剪贴板为空 / Clipboard is empty", false);
                return;
            }
            ClipData clip = clipboard.getPrimaryClip();
            if (clip == null || clip.getItemCount() == 0) {
                showSetupMessage("剪贴板为空 / Clipboard is empty", false);
                return;
            }
            CharSequence text = clip.getItemAt(0).coerceToText(this);
            String pasted = text == null ? "" : text.toString().trim();
            if (pasted.isEmpty()) {
                showSetupMessage("剪贴板为空 / Clipboard is empty", false);
                return;
            }
            // A pasted full dsh URL fills both fields; also works from the
            // token field, which is the common phone flow (copy URL, paste).
            if (pasted.indexOf("?token=") >= 0 || pasted.startsWith("http://")
                    || pasted.startsWith("https://")) {
                try {
                    ServerAuth.Cfg cfg = ServerAuth.parseConfig(pasted, "");
                    setupPrimary.setText(cfg.origin);
                    setupToken.setText(cfg.token);
                    showSetupMessage("已粘贴并解析服务器地址与令牌 / Parsed URL + token", false);
                    return;
                } catch (IllegalArgumentException ignored) {
                    // fall through and paste as-is
                }
            }
            target.setText(pasted);
            target.setSelection(pasted.length());
        } catch (Exception e) {
            showSetupMessage("粘贴失败 / Paste failed: " + e.getMessage(), true);
        }
    }

    private void showSetupMessage(String message, boolean isError) {
        if (setupStatus == null) {
            return;
        }
        setupStatus.setText(message);
        setupStatus.setTextColor(isError ? C_ERROR : C_MUTED);
        setupStatus.setVisibility(View.VISIBLE);
    }

    private void connectFromSetup() {
        final ServerAuth.Cfg cfg;
        final String fallback;
        try {
            cfg = ServerAuth.parseConfig(setupPrimary.getText().toString(),
                    setupToken.getText().toString());
            fallback = fallbackOriginFromInput(setupFallback.getText().toString(), cfg.token);
        } catch (IllegalArgumentException e) {
            showSetupMessage(e.getMessage(), true);
            return;
        }
        hideKeyboard();
        setupPrimary.setText(cfg.origin);
        if (fallback != null) setupFallback.setText(fallback);
        primaryOrigin = cfg.origin;
        fallbackOrigin = fallback;
        setSetupBusy(true);
        showSetupMessage("正在连接 " + cfg.origin
                + (fallback == null ? "" : "（备用 " + fallback + "）")
                + " …\nVerifying token & session API…", false);
        authAndLoadBest(cfg.origin, fallback, cfg.token);
    }

    private void setSetupBusy(boolean busy) {
        if (setupButton != null) {
            setupButton.setEnabled(!busy);
            setupButton.setText(busy ? "请稍候… / Connecting…" : "连接 / Connect");
            setupButton.setAlpha(busy ? 0.6f : 1f);
        }
        if (setupPrimary != null) {
            setupPrimary.setEnabled(!busy);
        }
        if (setupFallback != null) {
            setupFallback.setEnabled(!busy);
        }
        if (setupToken != null) {
            setupToken.setEnabled(!busy);
        }
    }

    private void hideKeyboard() {
        View focused = getCurrentFocus();
        if (focused == null) {
            return;
        }
        InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (imm != null) {
            imm.hideSoftInputFromWindow(focused.getWindowToken(), 0);
        }
    }

    private TextView label(String text) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextColor(C_MUTED);
        view.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        view.setLetterSpacing(0.1f);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(20);
        lp.bottomMargin = dp(6);
        view.setLayoutParams(lp);
        return view;
    }

    private EditText field(String hint, int inputType) {
        EditText edit = new EditText(this);
        edit.setHint(hint);
        edit.setHintTextColor(C_HINT);
        edit.setTextColor(C_TEXT);
        edit.setTextSize(TypedValue.COMPLEX_UNIT_SP, 16);
        edit.setInputType(inputType);
        edit.setSingleLine(true);
        edit.setBackground(rounded(C_SURFACE, 10, C_STROKE));
        int padH = dp(14);
        int padV = dp(13);
        edit.setPadding(padH, padV, padH, padV);
        return edit;
    }

    private GradientDrawable rounded(int fill, int radiusDp, int strokeColor) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radiusDp));
        if (strokeColor != 0) {
            drawable.setStroke(dp(1), strokeColor);
        }
        return drawable;
    }

    // ------------------------------------------------------------------ splash

    private void showLoadingOverlay(String message) {
        hideSplash();

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(C_BG);

        TextView logo = new TextView(this);
        logo.setText("DSH");
        logo.setTextColor(C_TEXT);
        logo.setTextSize(TypedValue.COMPLEX_UNIT_SP, 40);
        logo.setTypeface(Typeface.DEFAULT_BOLD);
        logo.setLetterSpacing(0.08f);
        logo.setGravity(Gravity.CENTER);
        box.addView(logo);

        ProgressBar spinner = new ProgressBar(this);
        LinearLayout.LayoutParams spinnerLp = new LinearLayout.LayoutParams(dp(28), dp(28));
        spinnerLp.topMargin = dp(26);
        spinnerLp.gravity = Gravity.CENTER_HORIZONTAL;
        box.addView(spinner, spinnerLp);

        TextView label = new TextView(this);
        label.setText(message);
        label.setTextColor(C_MUTED);
        label.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        label.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams labelLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        labelLp.topMargin = dp(14);
        labelLp.leftMargin = dp(24);
        labelLp.rightMargin = dp(24);
        box.addView(label, labelLp);

        splashView = box;
        root.addView(box, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.postDelayed(hideSplashRunnable, 20000);
    }

    private void hideSplash() {
        root.removeCallbacks(hideSplashRunnable);
        if (splashView != null) {
            root.removeView(splashView);
            splashView = null;
        }
    }

    /** Ask for the Android 13+ notification permission once the UI is ready. */
    private void maybeRequestNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        try {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED) return;
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1001);
        } catch (Exception e) {
            Log.w(TAG, "notification permission request failed", e);
        }
    }

    // ------------------------------------------------------------------- back

    @Override
    public void onBackPressed() {
        if (webView == null || setupView != null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){try{return !!(window.DSH_onBack&&window.DSH_onBack());}catch(e){return false;}})()",
                new ValueCallback<String>() {
                    @Override
                    public void onReceiveValue(String value) {
                        if (!"true".equals(value)) {
                            moveTaskToBack(true);
                        }
                    }
                });
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_MENU) {
            // Escape hatch to the native setup screen (token rotated etc.).
            showSetup(null);
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ----------------------------------------------------------------- bridge

    /** Exposed to the bundled UI as window.DSHNative (see docs contract). */
    public final class Bridge {
        // The bundled UI calls bridge methods through a helper that always
        // passes two arguments, e.g. DSHNative.pageReady(undefined, undefined).
        // Android's JS bridge resolves @JavascriptInterface methods by argument
        // count, so every method is provided with the 2-arg shape the UI uses
        // plus plain 0/1-arg overloads for direct callers.
        @JavascriptInterface
        public String getBaseUrl() {
            return getBaseUrl(null, null);
        }

        @JavascriptInterface
        public String getBaseUrl(String ignoredA, String ignoredB) {
            return origin == null ? "" : origin;
        }

        @JavascriptInterface
        public String appVersion() {
            return appVersion(null, null);
        }

        @JavascriptInterface
        public String appVersion(String ignoredA, String ignoredB) {
            try {
                String name = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
                return name == null ? "1.0.0" : name;
            } catch (Exception e) {
                return "1.0.0";
            }
        }

        @JavascriptInterface
        public void pageReady() {
            pageReady(null, null);
        }

        @JavascriptInterface
        public void pageReady(String ignoredA, String ignoredB) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    pageReady = true;
                    hideSplash();
                    maybeRequestNotificationPermission();
                    Log.i(TAG, "pageReady from UI");
                }
            });
        }

        @JavascriptInterface
        public void pageLoaded() {
            pageReady(null, null);
        }

        @JavascriptInterface
        public void pageLoaded(String ignoredA, String ignoredB) {
            pageReady(null, null);
        }

        @JavascriptInterface
        public void toast(String message) {
            toast(message, null);
        }

        @JavascriptInterface
        public void toast(final String message, String ignored) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Toast.makeText(MainActivity.this,
                            message == null ? "" : message, Toast.LENGTH_SHORT).show();
                }
            });
        }

        @JavascriptInterface
        public void openExternal(String url) {
            openExternal(url, null);
        }

        @JavascriptInterface
        public void openExternal(final String url, String ignored) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                    } catch (Exception e) {
                        Toast.makeText(MainActivity.this, "无法打开链接 / Cannot open link",
                                Toast.LENGTH_SHORT).show();
                    }
                }
            });
        }

        @JavascriptInterface
        public void notify(String title, String body) {
            final String t = title;
            final String b = body;
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    NotifyCenter.post(MainActivity.this, t, b);
                }
            });
        }

        @JavascriptInterface
        public void notify(String title, String body, String ignored) {
            notify(title, body);
        }

        @JavascriptInterface
        public String isAppVisible() {
            return appVisible ? "true" : "false";
        }

        @JavascriptInterface
        public String isAppVisible(String ignoredA, String ignoredB) {
            return appVisible ? "true" : "false";
        }

        @JavascriptInterface
        public void setTaskRunning(String running, String ignored) {
            taskRunning = "true".equals(running) || "1".equals(running);
            if (taskRunning && webView != null) {
                webView.resumeTimers();
            }
        }

        /**
         * Called by the UI after the primary origin has been unreachable for a
         * while. Authenticates the configured Tailscale fallback and reloads
         * the UI onto it when successful. Returns "true" when a switch attempt
         * was started (async result is reported via toast/reload).
         */
        @JavascriptInterface
        public String activateFallback() {
            return activateFallback(null, null);
        }

        @JavascriptInterface
        public String activateFallback(String reason, String ignored) {
            if (fallbackSwitching) return "false";
            if (fallbackOrigin == null || fallbackOrigin.isEmpty()) return "false";
            if (token == null || token.isEmpty()) return "false";
            if (fallbackOrigin.equals(origin)) return "false";
            long now = System.currentTimeMillis();
            if (now - fallbackLastAttemptMs < 15000) return "false";
            fallbackLastAttemptMs = now;
            fallbackSwitching = true;
            final String target = fallbackOrigin;
            final String tok = token;
            Log.i(TAG, "activateFallback -> " + target + " (" + reason + ")");
            new Thread(new Runnable() {
                @Override
                public void run() {
                    final ServerAuth.Result result = ServerAuth.login(target, tok);
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            fallbackSwitching = false;
                            if (result.ok) {
                                origin = result.origin;
                                saveConfig(primaryOrigin, fallbackOrigin, origin, tok);
                                applyCookie(origin, result.cookie);
                                loadApp(origin);
                                Toast.makeText(MainActivity.this,
                                        "已切换到 Tailscale 地址", Toast.LENGTH_SHORT).show();
                            } else {
                                Log.w(TAG, "fallback failed: " + result.error);
                                Toast.makeText(MainActivity.this,
                                        "Tailscale 地址连不上，请确认 Tailscale 已登录并开启",
                                        Toast.LENGTH_LONG).show();
                            }
                        }
                    });
                }
            }, "dsh-fallback").start();
            return "true";
        }

        @JavascriptInterface
        public void reset() {
            reset(null, null);
        }

        @JavascriptInterface
        public void reset(String ignoredA, String ignoredB) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    Log.i(TAG, "DSHNative.reset()");
                    if (webView != null) {
                        webView.stopLoading();
                        root.removeView(webView);
                        webView.destroy();
                        webView = null;
                    }
                    pageReady = false;
                    origin = null;
                    token = null;
                    prefs.edit().remove(K_ORIGIN).remove(K_TOKEN)
                            .remove(K_PRIMARY).remove(K_FALLBACK).remove(K_ACTIVE).apply();
                    try {
                        CookieManager.getInstance().removeAllCookies(null);
                        CookieManager.getInstance().flush();
                    } catch (Exception e) {
                        Log.w(TAG, "clear cookies failed", e);
                    }
                    showSetup(null);
                }
            });
        }
    }

    // -------------------------------------------------------- webview clients

    private final class ShellClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (uri == null) {
                return false;
            }
            String scheme = uri.getScheme() == null
                    ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if ("http".equals(scheme) || "https".equals(scheme)) {
                if (isServerUrl(uri)) {
                    return false;
                }
                openExternalUrl(uri.toString());
                return true;
            }
            if ("about".equals(scheme) || "data".equals(scheme) || "blob".equals(scheme)
                    || "javascript".equals(scheme)) {
                return false;
            }
            openExternalUrl(uri.toString());
            return true;
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            Log.i(TAG, "onPageFinished " + url);
            // Fallback in case the bundled page never calls DSHNative.pageReady().
            root.postDelayed(hideSplashRunnable, 2500);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request,
                                    WebResourceError error) {
            if (request != null && request.isForMainFrame()) {
                Log.e(TAG, "main frame error " + error.getErrorCode() + ": "
                        + error.getDescription() + " " + request.getUrl());
            }
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                        android.webkit.WebResourceResponse response) {
            Log.w(TAG, "http error " + response.getStatusCode() + " " + request.getUrl());
        }
    }

    private final class ShellChrome extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(android.webkit.ConsoleMessage message) {
            Log.i(TAG, "console: " + message.message() + " @" + message.sourceId()
                    + ":" + message.lineNumber());
            return true;
        }

        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.deny();
        }
    }

    private void openExternalUrl(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
        } catch (Exception e) {
            Toast.makeText(this, "无法打开链接 / Cannot open link", Toast.LENGTH_SHORT).show();
        }
    }

    private boolean isServerUrl(Uri uri) {
        if (origin == null || uri.getHost() == null) {
            return false;
        }
        try {
            URI base = new URI(origin);
            String baseScheme = base.getScheme();
            String baseHost = base.getHost();
            if (baseScheme == null || baseHost == null) {
                return false;
            }
            if (!baseScheme.equalsIgnoreCase(uri.getScheme())) {
                return false;
            }
            if (!baseHost.equalsIgnoreCase(uri.getHost())) {
                return false;
            }
            int basePort = base.getPort() == -1
                    ? ("https".equalsIgnoreCase(baseScheme) ? 443 : 80) : base.getPort();
            int uriSchemeDefault = "https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80;
            int uriPort = uri.getPort() == -1 ? uriSchemeDefault : uri.getPort();
            return basePort == uriPort;
        } catch (URISyntaxException e) {
            return false;
        }
    }

    // ------------------------------------------------------------------ misc

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                getResources().getDisplayMetrics());
    }
}
