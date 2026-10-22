"""Browser tests (Playwright, Python). Run: python3 test/browser_test.py [--screenshots]
Starts the server on a temp port with a temp applications file. Optional: AXE_PATH=/path/to/axe.min.js."""
import json, os, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 3917
BASE = f"http://localhost:{PORT}/"
results = []
def check(name, cond, detail=""):
    results.append((name, bool(cond), detail)); print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))

env = dict(os.environ, PORT=str(PORT), APPLICATIONS_FILE=os.path.join(tempfile.mkdtemp(), "apps.json"))
srv = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for _ in range(40):
    try: urllib.request.urlopen(BASE); break
    except Exception: time.sleep(0.1)

def cards(page): return page.locator("#list > li").count()
def count_text(page): return page.locator("#result-count").inner_text()

try:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        newp = lambda **kw: browser.new_context(bypass_csp=True, **kw).new_page()  # Playwright evaluates strings, which the app CSP forbids
        page = newp(viewport={"width": 1280, "height": 900})
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" and "409" not in m.text else None)
        bad_responses = []
        page.on("response", lambda r: bad_responses.append(r.url) if r.status >= 400 and not (r.url.endswith("/api/applications") and r.status in (409, 422)) else None)

        # --- data / list
        page.goto(BASE); page.wait_for_selector("#list > li")
        check("5 seed records render", cards(page) == 5, str(cards(page)))
        check("count text accurate", count_text(page) == "5 internships found", count_text(page))
        check("domain options from data", page.locator("#domain option").all_inner_texts() == ["All domains", "Cyber Security", "Data Analytics", "Full Stack Development", "UI/UX"])
        check("mode options from data", page.locator("#mode option").all_inner_texts() == ["All modes", "Hybrid", "On-site", "Remote"])

        # --- search
        page.fill("#search", "  FRONT  "); page.wait_for_function("document.querySelectorAll('#list > li').length===1")
        check("search case-insens/partial/trimmed", page.locator("#list h3").inner_text() == "Frontend Intern")
        check("count singular", count_text(page) == "1 internship found", count_text(page))
        page.fill("#search", "zzzz"); page.wait_for_selector("#state:not([hidden])")
        check("empty-results message", "No internships match" in page.locator("#state").inner_text())
        check("empty result is not an error", "error" not in (page.locator("#state").get_attribute("class") or ""))
        check("count zero", count_text(page) == "0 internships found")
        page.fill("#search", ""); page.wait_for_function("document.querySelectorAll('#list > li').length===5")
        check("clearing search restores list", cards(page) == 5)

        # --- filters
        for d, n in [("Full Stack Development", 2), ("UI/UX", 1), ("Data Analytics", 1), ("Cyber Security", 1)]:
            page.select_option("#domain", d); page.wait_for_function(f"document.querySelectorAll('#list > li').length=={n}")
            check(f"domain filter {d}", cards(page) == n)
        page.select_option("#domain", ""); page.wait_for_function("document.querySelectorAll('#list > li').length==5")
        check("all-domains option restores", cards(page) == 5)
        page.select_option("#domain", "Full Stack Development"); page.select_option("#mode", "Hybrid")
        page.wait_for_function("document.querySelectorAll('#list > li').length==1")
        check("domain+mode combine", page.locator("#list h3").inner_text() == "API Engineering Intern")
        page.fill("#search", "figma"); page.wait_for_selector("#state:not([hidden])")
        check("search+filters combine (no match)", cards(page) == 0)
        page.click("#reset"); page.wait_for_function("document.querySelectorAll('#list > li').length==5")
        check("reset restores everything", cards(page) == 5 and page.input_value("#search") == "" and page.input_value("#domain") == "" and page.input_value("#mode") == "")
        check("reset moves focus to search", page.evaluate("document.activeElement.id") == "search")

        # --- dialog + application (keyboard-only)
        page.focus("#list > li:first-child button")
        page.keyboard.press("Enter")
        page.wait_for_selector("dialog[open]")
        check("dialog opens via keyboard", page.locator("#detail-title").inner_text() == "Frontend Intern")
        check("focus inside dialog", page.evaluate("document.querySelector('dialog').contains(document.activeElement)"))
        page.keyboard.press("Escape")
        check("Escape closes dialog", page.locator("dialog[open]").count() == 0)
        check("focus returns to trigger", page.evaluate("document.activeElement.textContent.startsWith('View details')"))
        page.keyboard.press("Enter"); page.wait_for_selector("dialog[open]")
        page.click("#apply-submit")
        check("client validation shows errors", page.locator("#a-name-err").is_visible() and page.locator("#a-email-err").is_visible())
        check("invalid fields flagged aria-invalid", page.get_attribute("#a-name", "aria-invalid") == "true")
        check("focus moves to first invalid field", page.evaluate("document.activeElement.id") == "a-name")
        page.fill("#a-name", "Asha Rao"); page.fill("#a-email", "asha@example.com"); page.fill("#a-url", "javascript:alert(1)")
        page.click("#apply-submit")
        check("unsafe URL rejected client-side", page.locator("#a-url-err").is_visible())
        page.fill("#a-url", "https://example.com")
        page.click("#apply-submit"); page.wait_for_selector("#apply-msg.ok")
        check("successful application message", "Application submitted" in page.locator("#apply-msg").inner_text())
        page.fill("#a-name", "Asha Rao"); page.fill("#a-email", "ASHA@example.com"); page.click("#apply-submit")
        page.wait_for_selector("#apply-msg.err")
        check("duplicate application shows server error", "already applied" in page.locator("#apply-msg").inner_text())
        # server-side field errors surface in the UI even if client checks are bypassed
        page.evaluate("document.getElementById('a-email').type='text'")
        page.fill("#a-name", "Asha Rao"); page.fill("#a-email", "a@b"); page.evaluate("document.getElementById('apply-form').noValidate=true")
        page.click("#apply-submit")
        check("invalid email rejected", page.locator("#a-email-err").is_visible())
        page.click("#detail-close")

        # --- keyboard order / labels / headings
        labels = page.evaluate("""[...document.querySelectorAll('input,select')].filter(e=>e.closest('dialog')==null).map(e=>!!(e.labels&&e.labels.length))""")
        check("all page form controls labelled", all(labels) and len(labels) == 3)
        dlabels = page.evaluate("""[...document.querySelectorAll('dialog input')].map(e=>!!(e.labels&&e.labels.length))""")
        check("all dialog controls labelled", all(dlabels) and len(dlabels) == 3)
        order = []
        page.goto(BASE); page.wait_for_selector("#list > li")
        for _ in range(9):
            page.keyboard.press("Tab"); order.append(page.evaluate("document.activeElement.id||document.activeElement.tagName+':'+document.activeElement.textContent.slice(0,12)"))
        check("tab order: skip link, search, domain, mode, reset, cards", order[:5] == ["A:Skip to inte", "search", "domain", "mode", "reset"] and order[5].startswith("BUTTON:View"), str(order))
        page.focus("#search")
        outline = page.evaluate("getComputedStyle(document.activeElement).outlineStyle+' '+getComputedStyle(document.activeElement).outlineWidth")
        check("visible focus indicator", outline.startswith("solid") and not outline.endswith(" 0px"), outline)
        hs = page.evaluate("[...document.querySelectorAll('h1,h2,h3')].map(h=>h.tagName)")
        check("heading order logical (h1 first, no skips)", hs[0] == "H1" and all(int(b[1]) - int(a[1]) <= 1 for a, b in zip(hs, hs[1:])), str(hs))
        check("landmarks present", all(page.locator(s).count() >= 1 for s in ["header", "main", "footer"]))
        check("result count is polite live region", page.get_attribute("#result-count", "role") == "status")

        # --- pagination
        page.evaluate("1")
        page2 = newp(viewport={"width": 1280, "height": 900})
        page2.goto(BASE); page2.wait_for_selector("#list > li")
        check("pager hidden when one page (5 items, limit 6)", page2.locator("#pager").is_hidden())
        page2.close()

        # --- error / retry / empty dataset / malformed / XSS via mocked responses
        ep = newp(viewport={"width": 375, "height": 800}); fail = {"on": True}
        ep.route("**/api/internships*", lambda r: r.abort() if fail["on"] else r.continue_())
        ep.goto(BASE); ep.wait_for_selector("#state.error")
        check("error state shown on network failure", "Could not load" in ep.locator("#state").inner_text())
        check("error offers retry", ep.get_by_role("button", name="Retry").count() == 1)
        check("no fabricated cards on error", cards(ep) == 0)
        fail["on"] = False; ep.get_by_role("button", name="Retry").click(); ep.wait_for_function("document.querySelectorAll('#list > li').length==5")
        check("retry recovers", cards(ep) == 5)
        ep.close()

        mp = newp(viewport={"width": 375, "height": 800}); payload = {}
        def fulfil(route):
            route.fulfill(status=200, content_type="application/json", body=json.dumps(payload["b"]))
        mp.route("**/api/internships*", fulfil)
        payload["b"] = {"status": "success", "data": [], "pagination": {"page": 1, "limit": 6, "total": 0, "totalPages": 1}}
        mp.goto(BASE); mp.wait_for_selector("#state:not([hidden])")
        check("empty dataset message", "No internships are available" in mp.locator("#state").inner_text())
        xss = '<img src=x onerror="window.__x=1"><script>window.__x=1</script>'
        payload["b"] = {"status": "success", "data": [
            {"id": "X1", "title": xss, "domain": xss, "mode": "Remote", "location": xss, "skills": [xss, 5, None], "openings": "many"},
            {"id": "X2", "title": "Sparse record"}],
            "pagination": {"page": 1, "limit": 6, "total": 2, "totalPages": 1}}
        mp.goto(BASE); mp.wait_for_selector("#list > li")
        check("XSS strings rendered as text, not executed", mp.evaluate("window.__x") is None and mp.locator("#list img").count() == 0 and "<img" in mp.locator("#list h3").first.inner_text())
        check("sparse/malformed fields don't break cards", cards(mp) == 2 and mp.locator("#list h3").nth(1).inner_text() == "Sparse record")
        mp.close()

        # --- responsiveness + no overflow + axe
        axe_path = os.environ.get("AXE_PATH")
        for w in [320, 360, 375, 480, 768, 1024, 1440]:
            vp = newp(viewport={"width": w, "height": 900}); vp.goto(BASE); vp.wait_for_selector("#list > li")
            over = vp.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            cols = vp.evaluate("getComputedStyle(document.getElementById('list')).gridTemplateColumns.split(' ').length")
            check(f"{w}px: no horizontal overflow", over <= 0, f"overflow {over}px")
            small = vp.evaluate("[...document.querySelectorAll('button,input,select')].filter(e=>e.offsetParent&&e.getBoundingClientRect().height<44).length")
            check(f"{w}px: touch targets >= 44px high", small == 0, str(small))
            vp.click("#list > li:first-child button"); vp.wait_for_selector("dialog[open]")
            dover = vp.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            dfit = vp.evaluate("(()=>{const r=document.querySelector('dialog').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth})()")
            check(f"{w}px: dialog fits viewport", dover <= 0 and dfit)
            vp.keyboard.press("Escape")
            print(f"     {w}px grid columns: {cols}")
            if w == 360 and axe_path:
                vp.add_script_tag(path=axe_path)
                r = vp.evaluate("axe.run().then(r=>r.violations.map(v=>v.id+': '+v.nodes.length))")
                check("axe-core: 0 violations (list view)", r == [], str(r))
                vp.click("#list > li:first-child button"); vp.wait_for_selector("dialog[open]")
                r = vp.evaluate("axe.run().then(r=>r.violations.map(v=>v.id+': '+v.nodes.length))")
                check("axe-core: 0 violations (dialog open)", r == [], str(r))
            if "--screenshots" in sys.argv and w in (1440, 375):
                vp.close(); vp = newp(viewport={"width": w, "height": 900}); vp.goto(BASE); vp.wait_for_selector("#list > li")
                vp.screenshot(path=os.path.join(ROOT, "screenshots", "desktop.png" if w == 1440 else "mobile.png"), full_page=True)
            vp.close()


        # --- GitHub-Pages-style static hosting under a sub-path (no API available)
        import shutil
        site = tempfile.mkdtemp(); shutil.copytree(os.path.join(ROOT, "docs"), os.path.join(site, "responsive-internship-board"))
        st = subprocess.Popen([sys.executable, "-m", "http.server", "3918"], cwd=site, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1)
        try:
            SB = "http://localhost:3918/responsive-internship-board/"
            for w in [320, 375, 768, 1024, 1440]:
                sp = newp(viewport={"width": w, "height": 900}); sp.goto(SB); sp.wait_for_selector("#list > li")
                check(f"static host {w}px: 5 cards, no overflow", cards(sp) == 5 and sp.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth") <= 0)
                sp.close()
            sp = newp(viewport={"width": 1280, "height": 900}); sp_err = []
            sp.on("pageerror", lambda e: sp_err.append(str(e)))
            sp.goto(SB); sp.wait_for_selector("#list > li")
            check("static host: filter options from data", sp.locator("#domain option").count() == 5 and sp.locator("#mode option").count() == 4)
            sp.fill("#search", "  FRONT "); sp.wait_for_function("document.querySelectorAll('#list > li').length===1")
            check("static host: search case/partial/trim", sp.locator("#list h3").inner_text() == "Frontend Intern" and count_text(sp) == "1 internship found")
            sp.fill("#search", ""); sp.select_option("#domain", "Full Stack Development"); sp.select_option("#mode", "Hybrid")
            sp.wait_for_function("document.querySelectorAll('#list > li').length===1")
            check("static host: domain+mode combine", sp.locator("#list h3").inner_text() == "API Engineering Intern")
            sp.fill("#search", "figma"); sp.wait_for_selector("#state:not([hidden])")
            check("static host: empty message", "No internships match" in sp.locator("#state").inner_text())
            sp.click("#reset"); sp.wait_for_function("document.querySelectorAll('#list > li').length==5")
            check("static host: reset restores all", cards(sp) == 5)
            sp.click("#list > li:first-child button"); sp.wait_for_selector("dialog[open]")
            check("static host: form disabled with honest message", sp.is_disabled("#apply-submit") and "browse-only" in sp.locator("#apply-msg").inner_text())
            check("static host: no JS errors", not sp_err, str(sp_err))
            sp.close()
        finally:
            st.terminate()

        check("no uncaught JS/console errors", not errors, str(errors))
        check("no broken asset/API responses (4xx/5xx) on happy path", not bad_responses, str(bad_responses))
        browser.close()
finally:
    srv.terminate()

failed = [r for r in results if not r[1]]
print(f"\n{len(results)-len(failed)}/{len(results)} browser checks passed")
sys.exit(1 if failed else 0)
