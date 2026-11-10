package com.inkboard;

import android.util.Log;
import java.io.BufferedReader;
import java.io.FileReader;
import java.io.FileWriter;

/**
 * Front light on the reference reader: an LM3630A driving two LED strings (check /proc on yours).
 *   channel A = cold LEDs, channel B = warm LEDs (0-255 each).
 * The stock SystemUI slider writes the same /proc nodes, so both stay usable.
 */
final class FrontLight {
    static final String A = "/proc/lm3630a/leda_brightness";
    static final String B = "/proc/lm3630a/ledb_brightness";

    /** brightness 0-100 (perceptual), warmth 0-100 (share of warm LEDs). */
    static boolean set(int brightness, int warmth) {
        brightness = clamp(brightness, 0, 100);
        warmth = clamp(warmth, 0, 100);
        double level = brightness == 0 ? 0 : 4 + 251 * Math.pow(brightness / 100.0, 2.0);
        int b = (int) Math.round(level * warmth / 100.0);
        int a = (int) Math.round(level - b);
        return write(A, a) & write(B, b);
    }

    static int[] raw() { return new int[]{read(A), read(B)}; }

    static String state() {
        int a = read(A), b = read(B);
        int total = Math.max(0, a) + Math.max(0, b);
        int brightness = total <= 0 ? 0 : (int) Math.round(100 * Math.sqrt(Math.max(0, total - 4) / 251.0));
        int warmth = total <= 0 ? 0 : Math.round(100f * b / total);
        return "{\"a\":" + a + ",\"b\":" + b + ",\"brightness\":" + brightness + ",\"warmth\":" + warmth + "}";
    }

    private static int clamp(int v, int lo, int hi) { return Math.max(lo, Math.min(hi, v)); }

    private static boolean write(String path, int v) {
        try (FileWriter w = new FileWriter(path)) { w.write(String.valueOf(v)); return true; }
        catch (Exception e) { Log.w(Eink.TAG, "write " + path + " failed: " + e); return false; }
    }

    private static int read(String path) {
        try (BufferedReader r = new BufferedReader(new FileReader(path))) { return Integer.parseInt(r.readLine().trim()); }
        catch (Exception e) { return -1; }
    }
}
