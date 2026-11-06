#!/usr/bin/env python3
"""Bundle src/app.js (with src/core.js and three.js) into one inline script.

dist/mesh-align.html             page body for the claude.ai artifact (wrapped at publish)
dist/mesh-align-standalone.html  complete offline file: no network needed except optional fonts
Needs `npm install` once (three + esbuild in node_modules).
"""
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parent
esbuild = root / "node_modules/.bin/esbuild"
bundle = subprocess.run(
    [str(esbuild), "src/app.js", "--bundle", "--format=iife", "--minify", "--target=es2020",
     "--legal-comments=inline", "--log-level=warning"],
    cwd=root, check=True, capture_output=True, text=True).stdout
assert "https://cdn" not in bundle, "bundle still references a CDN"
page = (root / "src/page.html").read_text()
assert page.count("/*BUNDLE*/") == 1 and "importmap" not in page
out = page.replace("/*BUNDLE*/", bundle.replace("</script", "<\\/script"))
(root / "dist").mkdir(exist_ok=True)
(root / "dist/mesh-align.html").write_text(out)
head = ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
        '</head><body>')
(root / "dist/mesh-align-standalone.html").write_text(head + out + "</body></html>")
(root / "dist/bundle.mjs").unlink(missing_ok=True)
print(f"dist/mesh-align.html {len(out) / 1024:.0f} KiB (+ standalone), bundle {len(bundle) / 1024:.0f} KiB")
