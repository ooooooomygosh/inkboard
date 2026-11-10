import java.lang.reflect.*;
public class Probe {
  static void dump(String cn, String filter) {
    try {
      Class<?> c = Class.forName(cn);
      System.out.println("== " + cn);
      for (Field f : c.getDeclaredFields()) {
        if (filter != null && !f.getName().toLowerCase().matches(filter)) continue;
        f.setAccessible(true);
        Object v = null;
        if (Modifier.isStatic(f.getModifiers())) { try { v = f.get(null); } catch (Throwable t) {} }
        System.out.println("  F " + Modifier.toString(f.getModifiers()) + " " + f.getType().getSimpleName() + " " + f.getName() + " = " + v);
      }
      for (Method m : c.getDeclaredMethods()) {
        if (filter != null && !m.getName().toLowerCase().matches(filter)) continue;
        System.out.println("  M " + m.toGenericString());
      }
    } catch (Throwable t) { System.out.println("!! " + cn + " " + t); }
  }
  public static void main(String[] a) {
    dump("android.os.EpdUtil", null);
    dump("android.view.View", ".*(eink|epd|refresh|ink).*");
    dump("android.view.ViewRootImpl", ".*(eink|epd|refresh).*");
    dump("android.view.SurfaceControl", ".*(eink|epd|refresh).*");
    dump("android.app.Activity", ".*(eink|epd|refresh).*");
    dump("android.view.Window", ".*(eink|epd|refresh).*");
    dump("android.view.WindowManager$LayoutParams", ".*(eink|epd|refresh).*");
    dump("com.eink.swtcon.ISwtconControl", null);
    dump("com.eink.swtcon.ISwtconControl$Stub", null);
    try {
      Class<?> sm = Class.forName("android.os.ServiceManager");
      String[] s = (String[]) sm.getMethod("listServices").invoke(null);
      for (String x : s) if (x.toLowerCase().matches(".*(eink|swtcon|epd|disp|light|power).*")) System.out.println("svc " + x);
    } catch (Throwable t) { System.out.println("!! svc " + t); }
  }
}
