# 改造一台 Android 墨水屏阅读器

参考设备是一台 7.8 英寸、300 dpi、Android 8.1 的墨水屏阅读器。大多数国产 Android 电纸书的做法相通：厂商在 framework 里加了私有的刷新接口，系统用 AOSP 测试密钥签名，USB 调试可以打开。下面的步骤按“先摸清、再改动、每一步可撤销”的顺序写。

## 1. 摸清设备

打开开发者选项和 USB 调试，连上电脑：

```bash
adb shell getprop ro.build.version.release      # Android 版本
adb shell getprop ro.build.tags                 # test-keys 说明系统用公开测试密钥签名
adb shell wm size; adb shell wm density         # 分辨率和密度 → CSS 视口 = 分辨率 / (density/160)
adb shell dumpsys webviewupdate | head           # 系统 WebView 版本和允许的提供者
adb shell pm list packages -f                   # 装了哪些应用
adb shell ls /proc /sys/class/backlight         # 前光、充电控制节点
```

记下 CSS 视口尺寸（参考设备是 749×998），编辑器的网格按这个尺寸排版。

## 2. 找刷新接口

厂商的 e-ink 接口一般藏在 `Window`、`View` 或一个 `EpdUtil` 之类的类里。`tools/probe/Probe.java` 用反射把名字里带 eink、epd、refresh 的字段和方法全部打出来，再列出相关的系统服务：

```bash
cd tools/probe
javac -source 8 -target 8 -cp $ANDROID_HOME/platforms/android-27/android.jar Probe.java
$ANDROID_HOME/build-tools/34.0.0/d8 --min-api 27 --output . Probe*.class
adb push classes.dex /data/local/tmp/probe.dex
adb shell CLASSPATH=/data/local/tmp/probe.dex app_process / Probe
```

参考设备上找到的是：

- `Window.setRefreshMode(int)`：切换波形（GC16 全刷、GU16 局刷、A2 快刷、DU 黑白等）；
- `Window.forceGlobalRefresh(boolean)`：立刻全屏刷新，清残影；
- `Window.setGu16RefreshLimit(int)`：局刷累计多少次后由驱动自动全刷。

`android/src/com/inkboard/Eink.java` 用反射调用它们，找不到就安静降级，App 照常运行，只是残影要靠系统自己处理。别的设备把方法名和常量换成探测出来的即可；欢迎把你的设备的探测结果提交上来。

## 3. 升级系统 WebView（可选，但很值）

旧系统自带的 WebView 可能停在 Chrome 61 这一代，很多 CSS 特性用不了。前端已经按旧内核编译，不升级也能跑；升级后渲染更快、更稳。

系统只认包名为 `com.android.webview` 的提供者。如果系统用测试密钥签名（`ro.build.tags` 是 `test-keys`），可以：

1. 找一个支持你 Android 版本的 Chromium SystemWebView APK（Android 8 最高到 138 这一代）；
2. 用 `tools/rename_webview.py` 把包名改成同样长度的 `com.android.webview`；
3. 用 AOSP 的 testkey 重新签名，`adb install -r` 作为系统 WebView 的普通更新装上去。

不动 system 分区，不需要 root；`adb shell pm uninstall com.android.webview` 就能回到原版。

## 4. 编译壳 App

```bash
cd android
./build.sh            # 只编译
./build.sh --install  # 编译并安装、启动
```

`build.sh` 不用 Gradle：`aapt2 → javac → d8 → zipalign → apksigner`，几秒钟完成。默认找 `~/Library/Android/sdk`，可以用 `ANDROID_SDK`、`JAVA_HOME_17`、`ADB` 环境变量改。

**签名**：如果系统用 AOSP 测试密钥签名，用 AOSP 的 platform 密钥（`build/make/target/product/security/platform.pk8` 和 `platform.x509.pem`）签 InkBoard，它就成为 `android.uid.system` 应用，可以写系统设置、控制前光和充电，不需要 root。把这两个文件放进 `android/keys/`（已在 `.gitignore` 里）。系统不是测试密钥的话，用 `KEY=… CERT=… ./build.sh` 换成自己的密钥，看板照常工作，只是前光、充电控制和部分系统设置不可用。

壳 App 做的事：

| 文件 | 作用 |
|---|---|
| `MainActivity.java` | 全屏 WebView、作为桌面、开机自启、断网页面、看门狗、左上角长按 2 秒弹出原生菜单 |
| `InkBridge.java` | `window.Ink`：刷新、前光、对比度、屏幕方向、打开 App、提示音、Wi-Fi 设置 |
| `Eink.java` | 厂商刷新接口的反射封装 |
| `FrontLight.java` | 前光：冷暖两路 LED 的亮度，按时间段自动调 |
| `BatteryCare.java` | 常年插电时在 70%～80% 之间开关充电输入 |
| `DeviceSetup.java` | 插电常亮、时区、关闭自动息屏 |
| `Updater.java` | 收到 `update` 指令后从给定地址下载 APK 静默安装（需要系统签名） |
| `BootReceiver.java` | 开机启动 |

前光和充电节点是参考设备的（`/proc/lm3630a/…`、`/proc/axp2585/charge_enable`），换设备时先 `adb shell ls /proc` 找到对应节点，再改这两个文件里的路径。

## 5. 连上云端

```bash
adb shell am start -n com.inkboard/.MainActivity \
  --es server https://inkboard.<你的子域>.workers.dev \
  --es token <DEVICE_TOKEN> \
  --es timezone Asia/Shanghai \
  --es reader <阅读 App 的包名>
```

`reader` 是菜单里“打开阅读 App”启动的应用，可以省略。看板底部导航的按钮也能设成 `launch:<包名>`。

## 6. 让它像一块看板

```bash
adb shell cmd package set-home-activity com.inkboard/.MainActivity   # 设为桌面
cp debloat.example.txt debloat.txt                                   # 写上要隐藏的应用
./debloat.sh
```

`debloat.sh` 用 `pm uninstall -k --user 0` 隐藏应用：APK 还在 system 分区，数据保留，`./restore.sh` 或 `./restore.sh <包名>` 随时恢复。建议隐藏原厂桌面、系统 OTA（防止系统更新覆盖改动）、工厂测试应用；保留你常用的阅读 App。

## 7. 摆放

- 支架竖放或横放都行，编辑器里选“横屏 / 竖屏 / 反向”；
- 常插电，开着电池保养；
- 前光按时间段设：白天关，傍晚低亮暖色；
- 夜间模式只显示时间、天气和明天第一件事，点一下回到看板。

## 撤销所有改动

```bash
./android/restore.sh                                  # 恢复隐藏的系统应用
adb shell pm uninstall com.inkboard                   # 卸载看板
adb shell pm uninstall com.android.webview            # 回到原版 WebView（如果升级过）
```

然后在系统设置里把默认桌面换回原厂桌面。
