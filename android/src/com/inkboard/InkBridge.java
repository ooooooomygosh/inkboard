package com.inkboard;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.wifi.WifiInfo;
import android.net.wifi.WifiManager;
import android.os.BatteryManager;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import org.json.JSONObject;

/** window.Ink — the dashboard page's handle on the device. */
final class InkBridge {
    final MainActivity a;

    InkBridge(MainActivity a) { this.a = a; }

    private void ui(Runnable r) { a.runOnUiThread(r); }

    @JavascriptInterface public void heartbeat() { a.lastHeartbeat = SystemClock.elapsedRealtime(); }

    @JavascriptInterface public void fullRefresh() { ui(new Runnable() { public void run() { a.fullRefreshNow(); } }); }

    @JavascriptInterface public void setMode(final String mode) {
        ui(new Runnable() { public void run() { Eink.setMode(a.getWindow(), Eink.modeFromName(mode)); } });
    }

    /** Minutes between automatic full refreshes (0 = off). */
    @JavascriptInterface public void setFullRefreshMinutes(int m) { a.fullRefreshEveryMs = m <= 0 ? 0 : m * 60_000L; }

    @JavascriptInterface public void setPartialLimit(final int n) {
        a.prefs.edit().putInt("partialLimit", n).apply();
        ui(new Runnable() { public void run() { Eink.setPartialLimit(a.getWindow(), n); } });
    }

    @JavascriptInterface public void setOrientation(final String o) { ui(new Runnable() { public void run() { a.applyOrientation(o); } }); }

    @JavascriptInterface public void launch(final String pkg) { ui(new Runnable() { public void run() { a.launch(pkg); } }); }

    @JavascriptInterface public void openWifi() {
        a.startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @JavascriptInterface public void openSettings() {
        a.startActivity(new Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
    }

    @JavascriptInterface public void menu() { ui(new Runnable() { public void run() { a.showMenu(); } }); }

    @JavascriptInterface public void reload() { ui(new Runnable() { public void run() { a.loadDashboard(); } }); }

    @JavascriptInterface public String serverUrl() { return a.server(); }

    @JavascriptInterface public void setTimezone(String tz) { DeviceSetup.setTimeZone(a, tz); }

    /** Front-light brightness 0–255 (0 = off). */
    @JavascriptInterface public void setBrightness(int v) {
        try {
            Settings.System.putInt(a.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS_MODE, Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL);
            Settings.System.putInt(a.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS, Math.max(0, Math.min(255, v)));
        } catch (Throwable ignored) {}
    }

    /** brightness / warmth in percent; returns false if the driver refused. */
    @JavascriptInterface public boolean setLight(int brightness, int warmth) { return FrontLight.set(brightness, warmth); }

    @JavascriptInterface public String light() { return FrontLight.state(); }

    /** Stock e-ink contrast level (same setting the system pull-down slider uses). */
    @JavascriptInterface public void setContrast(int level) {
        try { Settings.Global.putInt(a.getContentResolver(), "mogu_contrast_value", level); } catch (Throwable ignored) {}
    }

    @JavascriptInterface public void setBatteryCare(boolean on, int upper, int lower) { BatteryCare.configure(a, on, upper, lower); }

    /** Soft two-note chime through the speaker (something new needs the user). */
    @JavascriptInterface public void chime() {
        new Thread(new Runnable() { public void run() {
            try {
                android.media.ToneGenerator tg = new android.media.ToneGenerator(android.media.AudioManager.STREAM_NOTIFICATION, 55);
                tg.startTone(android.media.ToneGenerator.TONE_PROP_ACK, 260);
                Thread.sleep(420);
                tg.release();
            } catch (Throwable ignored) {}
        } }).start();
    }

    @JavascriptInterface public void update(String url) { Updater.installFromUrl(a, url, a.token()); }

    @JavascriptInterface public void reboot() {
        try { ((PowerManager) a.getSystemService(Context.POWER_SERVICE)).reboot(null); } catch (Throwable ignored) {}
    }

    @JavascriptInterface public String info() {
        JSONObject o = new JSONObject();
        try {
            Intent bat = a.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
            if (bat != null) {
                int level = bat.getIntExtra(BatteryManager.EXTRA_LEVEL, -1);
                int scale = bat.getIntExtra(BatteryManager.EXTRA_SCALE, 100);
                o.put("battery", Math.round(level * 100f / scale));
                o.put("charging", bat.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0);
                o.put("batteryTemp", bat.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, 0) / 10.0);
            }
            WifiManager wm = (WifiManager) a.getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            WifiInfo wi = wm.getConnectionInfo();
            if (wi != null) {
                o.put("ssid", wi.getSSID() == null ? "" : wi.getSSID().replace("\"", ""));
                o.put("rssi", wi.getRssi());
                o.put("wifiLevel", WifiManager.calculateSignalLevel(wi.getRssi(), 5));
            }
            o.put("app", a.versionName());
            o.put("webview", WebView.getCurrentWebViewPackage() != null ? WebView.getCurrentWebViewPackage().versionName : "");
            o.put("einkApi", Eink.available());
            o.put("timezone", java.util.TimeZone.getDefault().getID());
            o.put("uptimeMin", SystemClock.elapsedRealtime() / 60000);
            Runtime rt = Runtime.getRuntime();
            o.put("heapMb", (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024));
            o.put("light", new JSONObject(FrontLight.state()));
            o.put("chargeInput", BatteryCare.charging());
            o.put("batteryCare", a.prefs.getBoolean("batteryCare", true));
            o.put("contrast", Settings.Global.getInt(a.getContentResolver(), "mogu_contrast_value", -1));
        } catch (Throwable ignored) {}
        return o.toString();
    }
}
