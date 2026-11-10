package com.inkboard;

import android.app.AlarmManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.BatteryManager;
import android.provider.Settings;
import android.util.Log;

/** One-time and on-boot device configuration. Needs WRITE_SECURE_SETTINGS / SET_TIME_ZONE (platform-signed). */
final class DeviceSetup {
    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences("inkboard", Context.MODE_PRIVATE);
    }

    static void apply(Context c) {
        SharedPreferences p = prefs(c);
        try {
            // Keep the screen on whenever powered (AC | USB | wireless).
            int plugged = BatteryManager.BATTERY_PLUGGED_AC | BatteryManager.BATTERY_PLUGGED_USB | BatteryManager.BATTERY_PLUGGED_WIRELESS;
            Settings.Global.putInt(c.getContentResolver(), Settings.Global.STAY_ON_WHILE_PLUGGED_IN, plugged);
            // On battery, sleep after the configured timeout (default 30 min).
            Settings.System.putInt(c.getContentResolver(), Settings.System.SCREEN_OFF_TIMEOUT, p.getInt("screenOffMs", 30 * 60 * 1000));
        } catch (Throwable t) {
            Log.w(Eink.TAG, "settings write failed", t);
        }
        setTimeZone(c, p.getString("timezone", "Asia/Shanghai"));
    }

    static void setTimeZone(Context c, String tz) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            if (tz != null && !tz.equals(java.util.TimeZone.getDefault().getID())) am.setTimeZone(tz);
            prefs(c).edit().putString("timezone", tz).apply();
        } catch (Throwable t) {
            Log.w(Eink.TAG, "setTimeZone failed", t);
        }
    }
}
