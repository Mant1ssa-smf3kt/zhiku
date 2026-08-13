"""知库桌面版入口：在应用内部启动 FastAPI 服务，用系统原生 WebView 窗口打开。

用法：
    python -m backend.desktop            # 打开桌面窗口
    python -m backend.desktop --check    # 仅验证后端能启动（自动化测试用）
"""
import os
import socket
import sys
import threading
import time

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON_PNG = os.path.join(BASE_DIR, "assets", "icon.png")


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def _start_server(port):
    import uvicorn

    from backend.main import app

    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")
    uvicorn.Server(config).run()


def _wait_ready(port, timeout=20):
    import httpx

    url = "http://127.0.0.1:{}/api/settings".format(port)
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if httpx.get(url, timeout=2).status_code == 200:
                return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def _rename_app_menu():
    """尽力把 macOS 菜单栏里的应用名从 Python 改成知库（best-effort，失败无妨）。"""
    try:
        from Foundation import NSBundle

        bundle = NSBundle.mainBundle()
        info = bundle.localizedInfoDictionary() or bundle.infoDictionary()
        if info is not None:
            info["CFBundleName"] = "知库"
            info["CFBundleDisplayName"] = "知库"
    except Exception:
        pass


def _set_dock_icon():
    try:
        from AppKit import NSApplication, NSImage

        if os.path.exists(ICON_PNG):
            img = NSImage.alloc().initWithContentsOfFile_(ICON_PNG)
            if img:
                NSApplication.sharedApplication().setApplicationIconImage_(img)
    except Exception:
        pass


def main():
    os.chdir(BASE_DIR)
    port = int(os.environ.get("PORT") or _free_port())
    threading.Thread(target=_start_server, args=(port,), daemon=True).start()
    if not _wait_ready(port):
        sys.stderr.write("知库后端启动失败，请在终端运行 ./run.sh 查看错误\n")
        try:  # Finder 启动时没有终端，弹原生对话框提示
            import subprocess

            subprocess.run([
                "osascript", "-e",
                'display alert "知库启动失败" message '
                '"后端服务未能启动，详情见 ~/Library/Logs/zhiku.log，'
                '或在终端进入项目目录运行 ./run.sh 查看错误"',
            ], timeout=30)
        except Exception:
            pass
        os._exit(1)

    url = "http://127.0.0.1:{}".format(port)
    if "--check" in sys.argv:
        print("ok " + url)
        sys.stdout.flush()
        os._exit(0)

    import webview

    _rename_app_menu()
    webview.create_window(
        "知库",
        url,
        width=1280,
        height=840,
        min_size=(920, 620),
    )
    webview.start(_set_dock_icon)
    os._exit(0)  # 窗口关闭即整体退出，结束后台服务线程


if __name__ == "__main__":
    main()
