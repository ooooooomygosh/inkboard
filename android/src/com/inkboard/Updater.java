package com.inkboard;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;
import android.util.Log;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/** Silent self-update: download an APK and install it through PackageInstaller (INSTALL_PACKAGES). */
final class Updater {
    static void installFromUrl(final Context c, final String url, final String token) {
        new Thread(new Runnable() {
            public void run() {
                HttpURLConnection conn = null;
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    if (token != null) conn.setRequestProperty("X-Device-Token", token);
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(60000);
                    PackageInstaller pi = c.getPackageManager().getPackageInstaller();
                    PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                    int id = pi.createSession(params);
                    PackageInstaller.Session s = pi.openSession(id);
                    try (InputStream in = conn.getInputStream(); OutputStream out = s.openWrite("app.apk", 0, -1)) {
                        byte[] buf = new byte[65536];
                        int n;
                        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                        s.fsync(out);
                    }
                    PendingIntent pi2 = PendingIntent.getBroadcast(c, id, new Intent("com.inkboard.INSTALL_DONE"), 0);
                    s.commit(pi2.getIntentSender());
                    Log.i(Eink.TAG, "update committed from " + url);
                } catch (Throwable t) {
                    Log.e(Eink.TAG, "update failed", t);
                } finally {
                    if (conn != null) conn.disconnect();
                }
            }
        }, "inkboard-updater").start();
    }
}
