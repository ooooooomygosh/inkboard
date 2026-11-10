package com.inkboard;

import android.app.Activity;
import android.app.ActivityManager;
import android.app.AlertDialog;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.NetworkInfo;
import android.os.Bundle;
import android.os.Handler;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.content.pm.ActivityInfo;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.util.HashMap;
import java.util.Map;

public class MainActivity extends Activity {
    static final String DEFAULT_SERVER = "http://192.168.1.110:8787";
    static final long WATCHDOG_MS = 60_000;
    static final long HEARTBEAT_TIMEOUT_MS = 5 * 60_000;
    static final long OFFLINE_RETRY_MS = 30_000;

    WebView web;
    SharedPreferences prefs;
    final Handler h = new Handler();
    volatile long lastHeartbeat = SystemClock.elapsedRealtime();
    volatile long fullRefreshEveryMs = 30 * 60_000;
    long lastFullRefresh = SystemClock.elapsedRealtime();
    boolean showingOffline = false;
    boolean wasPaused = false;

    // Long-press the top-left corner for 2 s to open the native menu.
    final Runnable cornerMenu = new Runnable() { public void run() { showMenu(); } };

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = DeviceSetup.prefs(this);
        applyProvisioning(getIntent());
        DeviceSetup.apply(this);

        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON | WindowManager.LayoutParams.FLAG_FULLSCREEN);
        w.getDecorView().setBackgroundColor(Color.WHITE);
        Eink.setMode(w, Eink.GU16);
        Eink.setPartialLimit(w, prefs.getInt("partialLimit", 0));
        applyOrientation(prefs.getString("orientation", "landscape"));

        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.WHITE);
        web.setVerticalScrollBarEnabled(false);
        web.setHorizontalScrollBarEnabled(false);
        web.setOverScrollMode(View.OVER_SCROLL_NEVER);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " InkBoard/" + versionName());
        web.addJavascriptInterface(new InkBridge(this), "Ink");
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) {
                Log.i(Eink.TAG, "js: " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
                return true;
            }
        });
        web.setWebViewClient(new WebViewClient() {
            @Override public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showOffline();
            }
            // Fonts ship inside the APK: no download, works offline.
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                String path = req.getUrl().getPath();
                if (path != null && path.startsWith("/fonts/") && path.endsWith(".woff2")) {
                    try {
                        Map<String, String> h = new HashMap<>();
                        h.put("Cache-Control", "max-age=31536000");
                        h.put("Access-Control-Allow-Origin", "*");
                        return new WebResourceResponse("font/woff2", null, 200, "OK", h, getAssets().open("fonts" + path.substring(6)));
                    } catch (Exception ignored) { /* fall through to network */ }
                }
                return null;
            }
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                return false;
            }
            @Override public void onPageFinished(WebView v, String url) {
                if (!url.startsWith("file:")) showingOffline = false;
                lastHeartbeat = SystemClock.elapsedRealtime();
                fullRefreshSoon(400);
            }
        });
        web.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View v, MotionEvent e) {
                float d = getResources().getDisplayMetrics().density;
                switch (e.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        if (e.getX() < 90 * d && e.getY() < 90 * d) h.postDelayed(cornerMenu, 2000);
                        break;
                    case MotionEvent.ACTION_MOVE:
                        if (e.getX() > 120 * d || e.getY() > 120 * d) h.removeCallbacks(cornerMenu);
                        break;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        h.removeCallbacks(cornerMenu);
                        break;
                }
                return false;
            }
        });
        setContentView(web);
        immersive();
        loadDashboard();

        registerReceiver(netReceiver, new IntentFilter(ConnectivityManager.CONNECTIVITY_ACTION));
        registerReceiver(usbReceiver, new IntentFilter("android.hardware.usb.action.USB_STATE"));
        h.postDelayed(new Runnable() { public void run() { reclaimFromPopups(); } }, 5000);
        h.postDelayed(watchdog, WATCHDOG_MS);
    }

    @Override protected void onNewIntent(Intent i) {
        super.onNewIntent(i);
        if (applyProvisioning(i)) loadDashboard();
    }

    @Override protected void onResume() {
        super.onResume();
        immersive();
        Eink.setMode(getWindow(), Eink.GU16);
        if (wasPaused) {
            wasPaused = false;
            web.evaluateJavascript("window.inkResume && window.inkResume()", null);
            fullRefreshSoon(300);
        }
    }

    @Override protected void onPause() {
        super.onPause();
        wasPaused = true;
    }

    @Override protected void onDestroy() {
        try { unregisterReceiver(netReceiver); } catch (Throwable ignored) {}
        try { unregisterReceiver(usbReceiver); } catch (Throwable ignored) {}
        h.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    @Override public void onWindowFocusChanged(boolean f) {
        super.onWindowFocusChanged(f);
        if (f) immersive();
    }

    @Override public void onBackPressed() {
        // Home screen: back goes to the dashboard's own history, never out of the app.
        web.evaluateJavascript("window.inkBack && window.inkBack()", null);
    }

    @Override public boolean onKeyDown(int code, KeyEvent e) {
        // Volume / page keys (or a Bluetooth page turner) switch dashboard pages.
        switch (code) {
            case KeyEvent.KEYCODE_PAGE_DOWN: case KeyEvent.KEYCODE_VOLUME_DOWN: case KeyEvent.KEYCODE_DPAD_RIGHT: case KeyEvent.KEYCODE_DPAD_DOWN:
                web.evaluateJavascript("window.inkKey && window.inkKey('next')", null); return true;
            case KeyEvent.KEYCODE_PAGE_UP: case KeyEvent.KEYCODE_VOLUME_UP: case KeyEvent.KEYCODE_DPAD_LEFT: case KeyEvent.KEYCODE_DPAD_UP:
                web.evaluateJavascript("window.inkKey && window.inkKey('prev')", null); return true;
            case KeyEvent.KEYCODE_ENTER: case KeyEvent.KEYCODE_DPAD_CENTER:
                fullRefreshNow(); return true;
        }
        return super.onKeyDown(code, e);
    }

    // ---------- loading ----------

    boolean applyProvisioning(Intent i) {
        if (i == null) return false;
        boolean changed = false;
        SharedPreferences.Editor ed = prefs.edit();
        if (i.hasExtra("server")) { ed.putString("server", i.getStringExtra("server")); changed = true; }
        if (i.hasExtra("token")) { ed.putString("token", i.getStringExtra("token")); changed = true; }
        if (i.hasExtra("reader")) ed.putString("reader", i.getStringExtra("reader")); // package of your reading app, for the menu
        if (i.hasExtra("timezone")) { DeviceSetup.setTimeZone(this, i.getStringExtra("timezone")); }
        if (i.hasExtra("light")) { Log.i(Eink.TAG, "light ok=" + FrontLight.set(i.getIntExtra("light", 0), i.getIntExtra("warmth", 30)) + " " + FrontLight.state()); }
        ed.apply();
        return changed;
    }

    String server() { return prefs.getString("server", DEFAULT_SERVER).replaceAll("/+$", ""); }
    String token() { return prefs.getString("token", ""); }

    void loadDashboard() {
        showingOffline = false;
        Map<String, String> headers = new HashMap<>();
        headers.put("X-Device-Token", token());
        web.loadUrl(server() + "/d", headers);
    }

    void showOffline() {
        if (showingOffline) return;
        showingOffline = true;
        web.loadUrl("file:///android_asset/offline.html");
    }

    final Runnable watchdog = new Runnable() {
        public void run() {
            long now = SystemClock.elapsedRealtime();
            if (!showingOffline && now - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
                Log.w(Eink.TAG, "watchdog: no heartbeat, reloading");
                loadDashboard();
                lastHeartbeat = now;
            }
            BatteryCare.apply(MainActivity.this);
            reclaimFromPopups();
            if (fullRefreshEveryMs > 0 && now - lastFullRefresh > fullRefreshEveryMs && hasWindowFocus()) {
                fullRefreshNow();
            }
            h.postDelayed(this, WATCHDOG_MS);
        }
    };

    final BroadcastReceiver netReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            ConnectivityManager cm = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
            NetworkInfo ni = cm.getActiveNetworkInfo();
            if (ni != null && ni.isConnected() && showingOffline) h.postDelayed(new Runnable() { public void run() { loadDashboard(); } }, 3000);
        }
    };

    // ---------- system pop-ups ----------

    // The ROM opens a "choose USB mode" activity on every USB connect (the stock launcher used to handle it).
    // Charging is the default choice, so just come back to the front.
    static final String[] POPUPS = {"UsbModeChooserActivity", "UsbStorageActivity", "UsbDebuggingActivity"};

    final BroadcastReceiver usbReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            for (long d : new long[]{1500, 4000, 9000}) h.postDelayed(new Runnable() { public void run() { reclaimFromPopups(); } }, d);
        }
    };

    void reclaimFromPopups() {
        try {
            ActivityManager am = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
            java.util.List<ActivityManager.RunningTaskInfo> t = am.getRunningTasks(1);
            if (t.isEmpty() || t.get(0).topActivity == null) return;
            String top = t.get(0).topActivity.getClassName();
            for (String p : POPUPS) {
                if (top.endsWith(p)) {
                    Log.i(Eink.TAG, "reclaiming screen from " + top);
                    // Back = cancel; the chooser keeps its default (charge only).
                    new Thread(new Runnable() { public void run() {
                        try { new android.app.Instrumentation().sendKeyDownUpSync(KeyEvent.KEYCODE_BACK); } catch (Throwable e) { Log.w(Eink.TAG, "back inject failed", e); }
                    } }).start();
                    h.postDelayed(new Runnable() { public void run() {
                        try { ((ActivityManager) getSystemService(ACTIVITY_SERVICE)).moveTaskToFront(getTaskId(), 0); } catch (Throwable ignored) {}
                        fullRefreshNow();
                    } }, 800);
                    return;
                }
            }
        } catch (Throwable e) {
            Log.w(Eink.TAG, "reclaim failed", e);
        }
    }

    // ---------- e-ink ----------

    void fullRefreshNow() {
        lastFullRefresh = SystemClock.elapsedRealtime();
        Eink.fullRefresh(getWindow());
    }

    void fullRefreshSoon(long delay) {
        h.postDelayed(new Runnable() { public void run() { fullRefreshNow(); } }, delay);
    }

    void immersive() {
        getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    // ---------- native menu ----------

    void showMenu() {
        final String reader = prefs.getString("reader", "");
        final String[] items = {reader.isEmpty() ? "阅读 App（未设置）" : "打开阅读 App", "Wi-Fi 设置", "系统设置", "全屏刷新", "重新加载看板", "关于 InkBoard"};
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Light_Dialog_Alert)
                .setTitle("InkBoard")
                .setItems(items, (d, which) -> {
                    switch (which) {
                        case 0: if (!reader.isEmpty()) launch(reader); break;
                        case 1: startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); break;
                        case 2: startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); break;
                        case 3: fullRefreshNow(); break;
                        case 4: loadDashboard(); break;
                        case 5: new AlertDialog.Builder(this).setMessage("InkBoard " + versionName() + "\n服务器 " + server() + "\n刷新接口 " + (Eink.available() ? "可用" : "不可用")).show(); break;
                    }
                })
                .show();
    }

    void applyOrientation(String o) {
        int v;
        switch (o == null ? "" : o) {
            case "portrait": v = ActivityInfo.SCREEN_ORIENTATION_PORTRAIT; break;
            case "reversePortrait": v = ActivityInfo.SCREEN_ORIENTATION_REVERSE_PORTRAIT; break;
            case "reverseLandscape": v = ActivityInfo.SCREEN_ORIENTATION_REVERSE_LANDSCAPE; break;
            default: v = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE;
        }
        if (getRequestedOrientation() != v) {
            prefs.edit().putString("orientation", o).apply();
            setRequestedOrientation(v);
            fullRefreshSoon(900);
        }
    }

    void launch(String pkg) {
        Intent i = getPackageManager().getLaunchIntentForPackage(pkg);
        if (i != null) startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    String versionName() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Throwable t) { return "?"; }
    }
}
