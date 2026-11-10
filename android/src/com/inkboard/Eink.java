package com.inkboard;

import android.util.Log;
import android.view.Window;
import java.lang.reflect.Method;

/**
 * Wraps the vendor e-ink refresh API found in this ROM's framework (found with tools/probe):
 *   Window.setRefreshMode(int), Window.forceGlobalRefresh(boolean), Window.setGu16RefreshLimit(int)
 * Mode values come from WindowManager.LayoutParams.EINK_*_MODE on the device.
 */
final class Eink {
    static final String TAG = "InkBoard";

    static final int INIT = 1;
    static final int DU = 2;
    static final int GC16 = 4;
    static final int GC4 = 8;
    static final int A2 = 16;
    static final int GL16 = 32;
    static final int GU16 = 132;       // ROM default (persist.sys.mRefreshMode)
    static final int AUTO = 32768;

    private static Method setMode, forceRefresh, setGuLimit;

    static {
        try { setMode = Window.class.getMethod("setRefreshMode", int.class); } catch (Throwable t) { Log.w(TAG, "no setRefreshMode", t); }
        try { forceRefresh = Window.class.getMethod("forceGlobalRefresh", boolean.class); } catch (Throwable t) { Log.w(TAG, "no forceGlobalRefresh", t); }
        try { setGuLimit = Window.class.getMethod("setGu16RefreshLimit", int.class); } catch (Throwable t) { Log.w(TAG, "no setGu16RefreshLimit", t); }
    }

    static boolean available() { return setMode != null && forceRefresh != null; }

    static int modeFromName(String name) {
        if (name == null) return GU16;
        switch (name.toLowerCase()) {
            case "init": return INIT;
            case "du": return DU;
            case "gc16": case "full": return GC16;
            case "gc4": return GC4;
            case "a2": case "fast": return A2;
            case "gl16": return GL16;
            case "auto": return AUTO;
            default: return GU16;
        }
    }

    static void setMode(Window w, int mode) {
        if (setMode == null || w == null) return;
        try { setMode.invoke(w, mode); } catch (Throwable t) { Log.w(TAG, "setRefreshMode failed", t); }
    }

    /** Full-screen flashing refresh (clears ghosting). */
    static void fullRefresh(Window w) {
        if (forceRefresh == null || w == null) return;
        try { forceRefresh.invoke(w, true); } catch (Throwable t) { Log.w(TAG, "forceGlobalRefresh failed", t); }
    }

    /** After this many GU16 partial updates the driver does a full refresh by itself. */
    static void setPartialLimit(Window w, int n) {
        if (setGuLimit == null || w == null) return;
        try { setGuLimit.invoke(w, n); } catch (Throwable t) { Log.w(TAG, "setGu16RefreshLimit failed", t); }
    }
}
