# Cutting plane: typed position, drag, red count, remove, undo; then a look at the aligned XB8.
from playwright.sync_api import sync_playwright
fails = []
def check(ok, msg):
    print(("PASS  " if ok else "FAIL  ") + msg, flush=True)
    if not ok: fails.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    page = b.new_context(viewport={"width": 1400, "height": 900}).new_page()
    errs = []; page.on("pageerror", lambda e: errs.append(str(e)))
    page.goto("file:///w/dist/mesh-align-standalone.html")
    page.wait_for_function("window.__meshAlign && window.__meshAlign.S.result && window.__meshAlign.S.result.ok", timeout=60000)
    nT0 = page.evaluate("window.__meshAlign.S.mesh.nT")
    page.click("#trim-toggle")
    page.wait_for_timeout(300)
    check(page.evaluate("!!window.__meshAlign.T.on"), "cutting plane turns on")
    page.fill("#trim-at", "25.2"); page.press("#trim-at", "Enter")
    page.wait_for_timeout(300)
    t = page.evaluate("(() => { const T = window.__meshAlign.T; return {at: T.at, n: T.nCut}; })()")
    check(abs(t["at"] - 25.2) < 1e-9 and t["n"] > 10000, f"typed position 25.2 mm marks {t['n']} triangles red")
    print("   count text:", page.inner_text("#trim-count"))
    page.click("[data-view=front]"); page.wait_for_timeout(400)
    page.screenshot(path="/w/tests/out/trim-example.png")
    # Drag the plane: from its center on screen, 60 px up should raise it.
    PROJ = '''(p) => { const {camera, THREE} = window.__meshAlign;
        const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
        const r = document.getElementById('gl').getBoundingClientRect();
        return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }'''
    x, y = page.evaluate(PROJ, [60, 40, 25.2])
    before = page.evaluate("window.__meshAlign.T.at")
    page.mouse.move(x + 150, y); page.mouse.down(); page.mouse.move(x + 150, y - 30, steps=6); page.mouse.move(x + 150, y - 60, steps=6); page.mouse.up()
    page.wait_for_timeout(300)
    after = page.evaluate("window.__meshAlign.T.at")
    cam_moved = page.evaluate("(() => { const c = window.__meshAlign.camera.position; return [c.x, c.y, c.z]; })()")
    check(after > before + 1, f"dragging the plane up moves it from {before:.2f} to {after:.2f} mm")
    page.fill("#trim-at", "25.2"); page.press("#trim-at", "Enter"); page.wait_for_timeout(300)
    n = page.evaluate("window.__meshAlign.T.nCut")
    page.click("#trim-apply")
    page.wait_for_function(f"window.__meshAlign.S.mesh.nT === {nT0 - n}", timeout=20000)
    zmin = page.evaluate("""(() => { const S = window.__meshAlign.S, M = S.result.matrix, P = S.mesh.positions; let lo = Infinity;
        for (let i = 0; i < P.length; i += 3) lo = Math.min(lo, M[2][0]*P[i] + M[2][1]*P[i+1] + M[2][2]*P[i+2] + M[2][3]); return lo; })()""")
    check(zmin >= 25.2 - 1e-6, f"after Remove: {nT0 - n} triangles left, lowest point z = {zmin:.3f} mm")
    check(page.is_visible("#trim-undo") and not page.evaluate("window.__meshAlign.T.on"), "Undo appears and the plane hides after removing")
    page.click("#trim-undo")
    page.wait_for_function(f"window.__meshAlign.S.mesh.nT === {nT0}", timeout=20000)
    check(True, "Undo restores all triangles")
    # Chained transforms: save the aligned example, reopen it, align it again from the same faces,
    # and the embedded matrix must still map the ORIGINAL scan (equal to the first save's matrix).
    import zipfile, json, re
    with page.expect_download() as d1:
        page.click("#export-btn")
    p1 = "/w/tests/out/chain1.3mf"; d1.value.save_as(p1)
    j1 = json.loads(re.search(r'name="meshalign:transform"[^>]*>(.*?)</metadata>', zipfile.ZipFile(p1).read("3D/3dmodel.model").decode(), re.S).group(1)
        .replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
    page.set_input_files("#file-in", p1)
    page.wait_for_function("window.__meshAlign.S.name === 'chain1.3mf' && document.getElementById('busy').hidden", timeout=60000)
    check("aligned by Mesh Align" in page.inner_text("#fi-unit"), "reopened file says it was aligned by Mesh Align")
    page.click("[data-proj=persp]"); page.click("[data-frame=original]"); page.wait_for_timeout(400)
    page.keyboard.press("p")
    for pt, nrm in (([60, 40, 0.0], [0.15, 0.1, -1]), ([0.0, 40, 12], [-1, 0.1, 0.15]), ([60, 0.0, 12], [0.1, -1, 0.15])):
        n0 = page.evaluate("window.__meshAlign.S.features.length")
        page.evaluate("""([p, n]) => { const m = window.__meshAlign, c = m.camera;
            m.controls.enableDamping = false; c.position.set(p[0] + 220 * n[0], p[1] + 220 * n[1], p[2] + 220 * n[2]); m.controls.target.set(p[0], p[1], p[2]); m.controls.update(); c.updateMatrixWorld(); }""", [pt, nrm])
        page.wait_for_timeout(100)
        page.mouse.click(*page.evaluate(PROJ, pt))
        page.wait_for_function(f"window.__meshAlign.S.features.length === {n0 + 1}", timeout=20000)
        print("   clicked", pt, page.evaluate("(() => { const f = window.__meshAlign.S.features.at(-1); return JSON.stringify({seed: f.seedPoint.map(x => +x.toFixed(2)), n: f.stats.n, ext: [f.fit.extent.w.toFixed(1), f.fit.extent.h.toFixed(1)], cam: window.__meshAlign.camera.position.toArray().map(x => +x.toFixed(1))}); })()"))
    page.keyboard.press("Escape")
    page.click("[data-frame=aligned]")
    page.click("#p-flip"); page.click("#s-flip")
    page.select_option("#o-x", "f:f2"); page.select_option("#o-y", "f:f3"); page.select_option("#o-z", "f:f1")
    page.wait_for_timeout(300)
    st = page.inner_text("#align-status")
    info = page.evaluate("JSON.stringify({f: window.__meshAlign.S.features.map(f => [f.id, f.name, f.type, f.fit && f.fit.normal && f.fit.normal.map(x => +x.toFixed(3))]), spec: window.__meshAlign.S.spec})")
    check("aligned" in st.lower() and "needs" not in st.lower(), f"second alignment solves ({st.strip()[:120]!r}; {info})")
    with page.expect_download() as d2:
        page.click("#export-btn")
    p2 = "/w/tests/out/chain2.3mf"; d2.value.save_as(p2)
    j2 = json.loads(re.search(r'name="meshalign:transform"[^>]*>(.*?)</metadata>', zipfile.ZipFile(p2).read("3D/3dmodel.model").decode(), re.S).group(1)
        .replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
    dm = max(abs(a - b) * (100 if c < 3 else 1) for r1, r2 in zip(j1["matrix_row_major"], j2["matrix_row_major"]) for c, (a, b) in enumerate(zip(r1, r2)))
    check(not j2["alignment"].get("saved_as_is"), "second save carries a real alignment")
    check(dm < 0.05 and j2["source"] == "example-block.3mf" and j2["previous"]["file"] == "chain1.3mf",
          f"chained transform still maps the original scan (score {dm:.4f}, source {j2['source']})")

    # A look at the aligned XB8 with the plane near its base.
    page.set_input_files("#file-in", "/scans/xb8-aligned.3mf")
    page.wait_for_function("window.__meshAlign.S.name === 'xb8-aligned.3mf' && document.getElementById('busy').hidden", timeout=180000)
    page.click("#trim-toggle"); page.wait_for_timeout(500)
    page.fill("#trim-at", "4"); page.press("#trim-at", "Enter"); page.wait_for_timeout(600)
    print("   xb8:", page.inner_text("#trim-count"))
    page.click("[data-proj=ortho]"); page.click("[data-view=front]"); page.wait_for_timeout(600)
    page.screenshot(path="/w/tests/out/trim-xb8.png")
    n_before = page.evaluate("window.__meshAlign.S.mesh.nT")
    page.click("#trim-apply"); page.wait_for_timeout(1500)
    check(page.inner_text("#export-btn") == "Save 3MF as is" and not page.is_disabled("#export-btn"), "trimmed file without a new alignment can be saved as is")
    with page.expect_download() as d3:
        page.click("#export-btn")
    p3 = "/w/tests/out/xb8-trimmed.3mf"; d3.value.save_as(p3)
    model3 = zipfile.ZipFile(p3).read("3D/3dmodel.model").decode()
    j3 = json.loads(re.search(r'name="meshalign:transform"[^>]*>(.*?)</metadata>', model3[:200000], re.S).group(1)
        .replace("&quot;", '"').replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
    ntri = model3.count("<triangle ")
    check(j3["source"] == "xb8.3mf" and j3.get("trims") == 1 and ntri < n_before, f"saved as is: {ntri} triangles (was {n_before}), transform still from xb8.3mf")
    check(not errs, "no page errors" + ("" if not errs else ": " + " | ".join(errs[:3])))
    b.close()
print("FAILED: %d" % len(fails) if fails else "all passed")
