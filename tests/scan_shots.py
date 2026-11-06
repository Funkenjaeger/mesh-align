# Open each real scan in the standalone page, time the load, screenshot it from several views.
import sys, time
from playwright.sync_api import sync_playwright

OUT = "/w/tests/out"
names = sys.argv[1:] or ["v1410", "rockit", "xb8"]
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    ctx = b.new_context(viewport={"width": 1400, "height": 900})
    page = ctx.new_page()
    errs = []
    page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto("file:///w/dist/mesh-align-standalone.html")
    page.wait_for_function("window.__meshAlign && window.__meshAlign.S.result", timeout=60000)
    for n in names:
        t = time.time()
        page.set_input_files("#file-in", f"/scans/{n}.3mf")
        page.wait_for_function(f"window.__meshAlign.S.name === '{n}.3mf' && document.getElementById('busy').hidden", timeout=180000)
        print(f"{n}: loaded in browser in {time.time() - t:.1f} s, tris {page.evaluate('window.__meshAlign.S.mesh.nT')}", flush=True)
        page.click("[data-frame=original]")
        for v in ["iso", "top", "front", "right"]:
            page.click(f"[data-view={v}]")
            page.wait_for_timeout(700)
            page.locator("#view").screenshot(path=f"{OUT}/{n}-{v}.png")
    print("errors:", errs)
    b.close()
