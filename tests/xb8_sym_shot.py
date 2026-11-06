import time
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    page = b.new_context(viewport={"width": 1400, "height": 900}).new_page()
    errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto("file:///w/dist/mesh-align-standalone.html")
    page.wait_for_function("window.__meshAlign && window.__meshAlign.S.result", timeout=60000)
    page.set_input_files("#file-in", "/scans/xb8.3mf")
    page.wait_for_function("window.__meshAlign.S.name === 'xb8.3mf' && document.getElementById('busy').hidden", timeout=180000)
    t = time.time()
    page.click("#auto-sym")
    page.wait_for_function("window.__meshAlign.S.features.length === 1 && document.getElementById('busy').hidden", timeout=120000)
    print(f"auto symmetry in browser: {time.time() - t:.1f} s; toast: {page.inner_text('#toast')}")
    page.click("[data-view=iso]"); page.wait_for_timeout(600)
    page.screenshot(path="/w/tests/out/xb8-sym.png")
    print("errors:", errs)
    b.close()
