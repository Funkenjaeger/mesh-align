from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    page = b.new_context(viewport={"width": 1400, "height": 900}).new_page()
    errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto("file:///w/dist/mesh-align-standalone.html")
    page.wait_for_function("window.__meshAlign && window.__meshAlign.S.result", timeout=60000)
    page.set_input_files("#file-in", "/scans/xb8.3mf")
    page.wait_for_function("window.__meshAlign.S.name === 'xb8.3mf' && document.getElementById('busy').hidden", timeout=180000)
    page.click("[data-view=iso]"); page.wait_for_timeout(500)
    page.keyboard.press("p")
    xy = page.evaluate("""() => { const {camera, THREE, S} = window.__meshAlign; const P = S.mesh.positions, v = 1285921;
        const q = new THREE.Vector3(P[3*v], P[3*v+1], P[3*v+2]).project(camera);
        const r = document.getElementById('gl').getBoundingClientRect();
        return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height]; }""")
    page.mouse.click(*xy)
    page.wait_for_function("window.__meshAlign.S.features.length === 1", timeout=60000)
    page.wait_for_timeout(500)
    print("toast:", page.inner_text("#toast"))
    print("row:", page.inner_text("#feat-list"))
    print("curved class:", page.locator(".feat.is-curved").count())
    page.locator("#view").screenshot(path="/w/tests/out/xb8-curved.png")
    print("errors:", errs)
    b.close()
