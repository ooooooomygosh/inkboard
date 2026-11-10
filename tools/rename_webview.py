"""Rename a Chromium SystemWebView APK's package to com.android.webview (same-length byte patch)."""
import sys, zipfile
src, dst, old, new = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
assert len(old) == len(new), "names must be same length"
pairs = [(old.encode(), new.encode()), (old.encode('utf-16-le'), new.encode('utf-16-le'))]
with zipfile.ZipFile(src) as zi, zipfile.ZipFile(dst, 'w') as zo:
    for info in zi.infolist():
        if info.filename.startswith('META-INF/'):
            continue
        data = zi.read(info.filename)
        if info.filename in ('AndroidManifest.xml', 'resources.arsc'):
            n = 0
            for a, b in pairs:
                n += data.count(a); data = data.replace(a, b)
            print(info.filename, 'patched', n)
        ni = zipfile.ZipInfo(info.filename, date_time=info.date_time)
        ni.compress_type = info.compress_type
        ni.external_attr = info.external_attr
        zo.writestr(ni, data)
