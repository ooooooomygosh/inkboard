package com.inkboard;

import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.BatteryManager;
import android.util.Log;
import java.io.BufferedReader;
import java.io.FileReader;
import java.io.FileWriter;

/**
 * Keeps an always-plugged-in battery between `lower` and `upper` percent by toggling the
 * AXP2585 charger input (/proc/axp2585/charge_enable). While input is off the reader runs
 * on battery; below `lower` (or 20 % as a hard floor) input is switched back on.
 */
final class BatteryCare {
    static final String NODE = "/proc/axp2585/charge_enable";

    static void apply(Context c) {
        SharedPreferences p = DeviceSetup.prefs(c);
        boolean on = p.getBoolean("batteryCare", true);
        int upper = p.getInt("batteryUpper", 80), lower = p.getInt("batteryLower", 70);
        Intent bat = c.registerReceiver(null, new IntentFilter(Intent.ACTION_BATTERY_CHANGED));
        if (bat == null) return;
        int level = Math.round(100f * bat.getIntExtra(BatteryManager.EXTRA_LEVEL, 50) / bat.getIntExtra(BatteryManager.EXTRA_SCALE, 100));
        int cur = read();
        int want = cur;
        if (!on || level <= Math.min(lower, 20) || level <= lower) want = 1;
        else if (level >= upper) want = 0;
        if (want != cur && cur >= 0) {
            write(want);
            Log.i(Eink.TAG, "battery care: level=" + level + "% -> charging " + (want == 1 ? "on" : "paused"));
        }
    }

    static void configure(Context c, boolean on, int upper, int lower) {
        upper = Math.max(50, Math.min(100, upper));
        lower = Math.max(20, Math.min(upper - 5, lower));
        DeviceSetup.prefs(c).edit().putBoolean("batteryCare", on).putInt("batteryUpper", upper).putInt("batteryLower", lower).apply();
        apply(c);
    }

    static boolean charging() { return read() == 1; }

    private static int read() {
        try (BufferedReader r = new BufferedReader(new FileReader(NODE))) { return Integer.parseInt(r.readLine().trim()); }
        catch (Exception e) { return -1; }
    }

    private static void write(int v) {
        try (FileWriter w = new FileWriter(NODE)) { w.write(String.valueOf(v)); }
        catch (Exception e) { Log.w(Eink.TAG, "battery care write failed: " + e); }
    }
}
