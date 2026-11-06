# Run inside mcr.microsoft.com/playwright/python with the repo mounted at /w.
import http.server, io, json, re, struct, sys, threading, zipfile, functools
from playwright.sync_api import sync_playwright

OUT = "/w/tests/out"
fails = []
def check(ok, msg):
    print(("PASS  " if ok else "FAIL  ") + msg, flush=True)
    if not ok: fails.append(msg)

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory="/w/dist")
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 8765), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])
    ctx = b.new_context(viewport={"width": 1400, "height": 860}, accept_downloads=True)
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto("http://127.0.0.1:8765/mesh-align-standalone.html")
    page.wait_for_function("window.__meshAlign && window.__meshAlign.S.result && window.__meshAlign.S.result.ok", timeout=60000)
    page.wait_for_timeout(800)
    n = page.evaluate("window.__meshAlign.S.features.length")
    check(n == 4, f"example opens aligned with 4 features ({n})")
    page.screenshot(path=f"{OUT}/desktop-light.png")

    # Real click on the aligned top face (100,70,25) with the plane tool.
    page.keyboard.press("p")
    xy = page.evaluate("""() => { const {camera, THREE} = window.__meshAlign;
        const v = new THREE.Vector3(100, 70, 25).project(camera);
        const r = document.getElementById('gl').getBoundingClientRect();
        return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }""")
    page.mouse.click(xy[0], xy[1])
    page.wait_for_function("window.__meshAlign.S.features.length === 5", timeout=20000)
    f = page.evaluate("(() => { const f = window.__meshAlign.S.features[4]; return {type: f.type, n: f.stats.n, nz: f.fit.normal}; })()")
    check(f["type"] == "plane" and f["n"] > 2000, f"click on top face fits a plane ({f['n']} pts)")
    page.keyboard.press("Escape")
    # Fit view top and screenshot
    page.click("[data-view=top]")
    page.wait_for_timeout(400)
    page.screenshot(path=f"{OUT}/desktop-top.png")

    # Export (standalone mode saves two files)
    with page.expect_download() as d1:
        page.click("#export-btn")
    dl = d1.value
    path3mf = f"{OUT}/{dl.suggested_filename}"
    dl.save_as(path3mf)
    z = zipfile.ZipFile(path3mf)
    model = z.read("3D/3dmodel.model").decode()
    check('unit="millimeter"' in model, "exported 3MF declares millimeters")
    xs = [tuple(map(float, m)) for m in re.findall(r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"', model)]
    mn = [min(v[k] for v in xs) for k in range(3)]
    mx = [max(v[k] for v in xs) for k in range(3)]
    print("   bbox", [round(x, 3) for x in mn], [round(x, 3) for x in mx])
    check(all(abs(a - b) < 0.15 for a, b in zip(mn, [0, 0, 0])) and abs(mx[0] - 120) < 0.15 and abs(mx[1] - 80) < 0.15 and abs(mx[2] - 37.7) < 0.2,
          "exported mesh sits at 0..120 × 0..80 × 0..37.7 mm")
    page.wait_for_timeout(1500)
    jpath = f"{OUT}/example-block-aligned.transform.json"
    # second download may have fired already; collect via the downloads directory is not exposed, so re-trigger JSON via evaluate
    tj = page.evaluate("(() => { const r = window.__meshAlign.S.result; return r.matrix; })()")
    json.dump({"matrix_row_major": tj}, open(jpath, "w"))

    # Re-open the exported 3MF: it should come back already aligned and with the same triangle count.
    ntri = page.evaluate("window.__meshAlign.S.mesh.nT")
    page.set_input_files("#file-in", path3mf)
    page.wait_for_function("window.__meshAlign.S.name.endsWith('aligned.3mf') && window.__meshAlign.S.features.length === 0", timeout=30000)
    check(page.evaluate("window.__meshAlign.S.mesh.nT") == ntri, "re-opened 3MF has the same triangles")

    # STL in inches: write the aligned mesh as binary STL scaled to inches, open it, pick inches.
    tris = re.findall(r'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"', model)
    buf = io.BytesIO(); buf.write(b"\0" * 80); buf.write(struct.pack("<I", len(tris)))
    for t in tris:
        buf.write(struct.pack("<3f", 0, 0, 0))
        for i in t: buf.write(struct.pack("<3f", *[c / 25.4 for c in xs[int(i)]]))
        buf.write(b"\0\0")
    open(f"{OUT}/part-in.stl", "wb").write(buf.getvalue())
    page.set_input_files("#file-in", f"{OUT}/part-in.stl")
    page.wait_for_function("window.__meshAlign.S.name === 'part-in.stl'", timeout=30000)
    page.select_option("#unit-sel", "inch")
    page.wait_for_timeout(1500)
    size = page.evaluate("(() => { const b = window.__meshAlign.S.mesh.bbox; return [0,1,2].map(k => b.max[k]-b.min[k]); })()")
    nv = page.evaluate("window.__meshAlign.S.mesh.nV")
    check(abs(size[0] - 120) < 0.2 and abs(size[1] - 80) < 0.2, f"STL in inches opens at {[round(s, 2) for s in size]} mm, {nv} welded verts")

    # Saved transform on a fresh example
    page.click("#example-btn")
    page.wait_for_function("window.__meshAlign.S.example && window.__meshAlign.S.features.length === 4", timeout=30000)
    page.set_input_files("#tf-in", jpath)
    page.wait_for_function("!!window.__meshAlign.S.override", timeout=10000)
    check("saved transform" in page.inner_text("#align-status").lower(), "saved transform applies")
    page.click("#clear-override")
    # The exported 3MF carries its transform: apply it straight from the .3mf.
    page.set_input_files("#tf-in", path3mf)
    page.wait_for_function("!!window.__meshAlign.S.override", timeout=20000)
    check("saved transform" in page.inner_text("#align-status").lower(), "transform applies straight from an exported .3mf")
    page.click("#clear-override")
    check('meshalign:transform' in model and 'xmlns:meshalign=' in model, "exported 3MF embeds the transform as namespaced metadata")

    # Symmetry: automatic, then two clicks (front face, then a point near the back).
    page.click("#auto-sym")
    page.wait_for_function("window.__meshAlign.S.features.some(f => f.type === 'symmetry')", timeout=60000)
    sym = page.evaluate("(() => { const f = window.__meshAlign.S.features.find(f => f.type === 'symmetry'); return {m: f.stats.mirrored}; })()")
    check(sym["m"] > 0.85, f"automatic symmetry on the example mirrors {sym['m']*100:.1f}%")
    page.keyboard.press("m")
    page.click("[data-view=iso]")
    page.wait_for_timeout(300)
    PROJ = '''(p) => { const {camera, THREE} = window.__meshAlign;
        const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
        const r = document.getElementById('gl').getBoundingClientRect();
        return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }'''
    nsym = page.evaluate("window.__meshAlign.S.features.filter(f => f.type === 'symmetry').length")
    page.mouse.click(*page.evaluate(PROJ, [60, 0.0, 12]))
    page.wait_for_timeout(300)
    check("matching point" in page.inner_text("#tool-hint"), "first mirror click asks for the matching point")
    page.mouse.click(*page.evaluate(PROJ, [60, 79.0, 25]))
    page.wait_for_function(f"window.__meshAlign.S.features.filter(f => f.type === 'symmetry').length === {nsym + 1}", timeout=60000)
    m2 = page.evaluate("(() => { const fs = window.__meshAlign.S.features.filter(f => f.type === 'symmetry'); return fs[fs.length - 1].stats.mirrored; })()")
    check(m2 > 0.85, f"two-click symmetry mirrors {m2*100:.1f}%")
    page.keyboard.press("Escape")

    # Perpendicular constraint: auto search perpendicular to the bottom plane P1 (feature f1).
    page.select_option("#perp-ref", "f1")
    check("perpendicular to P1" in page.inner_text("#auto-sym"), "auto button names the reference plane")
    nsym = page.evaluate("window.__meshAlign.S.features.filter(f => f.type === 'symmetry').length")
    page.click("#auto-sym")
    page.wait_for_function(f"window.__meshAlign.S.features.filter(f => f.type === 'symmetry').length === {nsym + 1}", timeout=60000)
    perp = page.evaluate("""(() => { const S = window.__meshAlign.S; const fs = S.features.filter(f => f.type === 'symmetry');
        const f = fs[fs.length - 1], b = S.features.find(x => x.id === 'f1').fit.normal, n = f.fit.normal;
        return {dot: Math.abs(n[0]*b[0] + n[1]*b[1] + n[2]*b[2]), m: f.stats.mirrored, tag: document.getElementById('feat-list').innerText.includes('⊥ P1')}; })()""")
    check(perp["dot"] < 1e-9 and perp["m"] > 0.8 and perp["tag"], f"perpendicular auto search: |n·n_P1| = {perp['dot']:.1e}, mirrors {perp['m']*100:.1f}%, tagged ⊥ P1")
    page.select_option("#perp-ref", "")

    # Orthographic view: switch, check the camera, place a point precisely in the front view.
    page.click("[data-proj=ortho]")
    page.click("[data-view=front]")
    page.wait_for_timeout(400)
    check(page.evaluate("window.__meshAlign.camera.isOrthographicCamera === true"), "Ortho switches to an orthographic camera")
    page.screenshot(path=f"{OUT}/ortho-front.png")
    page.keyboard.press("t")
    target = [100.0, 0.0, 20.0]
    page.mouse.click(*page.evaluate(PROJ, target))
    page.wait_for_function("window.__meshAlign.S.features.some(f => f.type === 'point')", timeout=20000)
    got = page.evaluate("""(() => { const S = window.__meshAlign.S, f = S.features.filter(f => f.type === 'point').pop();
        const M = S.result.matrix, p = f.fit.position;
        return [0,1,2].map(r => M[r][0]*p[0] + M[r][1]*p[1] + M[r][2]*p[2] + M[r][3]); })()""")
    err = max(abs(g - t) for g, t in zip(got, target))
    check(err < 0.4, f"ortho front-view point lands within {err:.3f} mm of the target (at {[round(x, 3) for x in got]})")
    page.keyboard.press("Escape")
    page.click("[data-proj=persp]")
    page.wait_for_timeout(200)
    check(page.evaluate("window.__meshAlign.camera.isPerspectiveCamera === true"), "Persp switches back")

    # Error message path: cylinder on the flat top face
    page.keyboard.press("c")
    page.wait_for_timeout(200)
    page.click("[data-view=iso]"); page.wait_for_timeout(300)
    xy = page.evaluate("""() => { const {camera, THREE} = window.__meshAlign;
        const v = new THREE.Vector3(100, 70, 25).project(camera);
        const r = document.getElementById('gl').getBoundingClientRect();
        return [r.left + (v.x + 1) / 2 * r.width, r.top + (1 - v.y) / 2 * r.height]; }""")
    page.mouse.click(xy[0], xy[1]); page.wait_for_timeout(800)
    check("too flat" in page.inner_text("#toast"), "cylinder on a flat face shows the 'too flat' message")
    page.keyboard.press("Escape")

    # Offline: open the standalone file from disk with every network request blocked.
    off = b.new_context(viewport={"width": 1200, "height": 800}, accept_downloads=True)
    blocked = []
    off.route("**/*", lambda route: (route.continue_() if route.request.url.startswith("file:") else (blocked.append(route.request.url), route.abort())))
    op = off.new_page()
    oerr = []
    op.on("pageerror", lambda e: oerr.append(str(e)))
    op.goto("file:///w/dist/mesh-align-standalone.html")
    op.wait_for_function("window.__meshAlign && window.__meshAlign.S.result && window.__meshAlign.S.result.ok", timeout=60000)
    with op.expect_download() as od:
        op.click("#export-btn")
    check(od.value.suggested_filename.endswith(".3mf") and not oerr,
          f"offline from file:// renders, aligns and saves (blocked only: {sorted(set(u.split('/')[2] for u in blocked))})")
    check(all("fonts.g" in u for u in blocked), "the only network attempts offline are the optional fonts")
    op.screenshot(path=f"{OUT}/offline.png")
    off.close()

    # Dark + phone
    page.emulate_media(color_scheme="dark"); page.wait_for_timeout(500)
    page.screenshot(path=f"{OUT}/desktop-dark.png")
    ph = b.new_context(viewport={"width": 400, "height": 860}, color_scheme="light")
    pp = ph.new_page(); pp.goto("http://127.0.0.1:8765/mesh-align-standalone.html")
    pp.wait_for_function("window.__meshAlign && window.__meshAlign.S.result && window.__meshAlign.S.result.ok", timeout=60000)
    pp.wait_for_timeout(600)
    sw = pp.evaluate("document.documentElement.scrollWidth")
    check(sw <= 400, f"phone width has no sideways scroll (scrollWidth {sw})")
    pp.screenshot(path=f"{OUT}/phone.png", full_page=True)

    check(not errors, "no console errors" + ("" if not errors else ": " + " | ".join(errors[:5])))
    b.close()
print("FAILED: %d" % len(fails) if fails else "all passed")
sys.exit(1 if fails else 0)
