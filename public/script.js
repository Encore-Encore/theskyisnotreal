/* ============================================================
   theskyisnotreal.com — interactions
   - animated starfield (canvas)
   - scroll reveals (IntersectionObserver)
   - count-up stats
   All degrade gracefully and respect prefers-reduced-motion.
   ============================================================ */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------- Current year in footer ---------- */
  var yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  /* ---------- Scroll reveals ---------- */
  var revealEls = document.querySelectorAll(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealEls.forEach(function (el) { el.classList.add("is-visible"); });
  } else {
    var io = new IntersectionObserver(
      function (entries, obs) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            if (entry.target.classList.contains("stat")) countUp(entry.target);
            obs.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15, rootMargin: "0px 0px -8% 0px" }
    );
    revealEls.forEach(function (el) { io.observe(el); });
  }

  /* ---------- Count-up numbers ---------- */
  function countUp(statEl) {
    var numEl = statEl.querySelector(".stat__num");
    if (!numEl) return;
    var target = parseFloat(numEl.getAttribute("data-count"));
    if (isNaN(target)) return;
    var suffix = numEl.getAttribute("data-suffix") || "";
    if (reduceMotion || target === 0) { numEl.textContent = target + suffix; return; }

    var start = null;
    var duration = 1100;
    function step(ts) {
      if (start === null) start = ts;
      var p = Math.min((ts - start) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      numEl.textContent = Math.round(target * eased) + suffix;
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ---------- Starfield ---------- */
  var canvas = document.getElementById("starfield");
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext("2d");
  var stars = [];
  var w = 0, h = 0, dpr = Math.min(window.devicePixelRatio || 1, 2);
  var pointer = { x: 0, y: 0, tx: 0, ty: 0 };

  function resize() {
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
  }

  function seed() {
    // Density scales with viewport area, capped for perf.
    var count = Math.min(Math.round((w * h) / 6500), 320);
    stars = [];
    for (var i = 0; i < count; i++) {
      stars.push({
        x: Math.random() * w,
        y: Math.random() * h,
        z: Math.random() * 0.8 + 0.2,          // depth → size/parallax
        r: Math.random() * 1.3 + 0.2,
        tw: Math.random() * Math.PI * 2,        // twinkle phase
        tws: Math.random() * 0.02 + 0.005,      // twinkle speed
        drift: Math.random() * 0.12 + 0.02      // upward drift speed
      });
    }
  }

  var COLORS = ["#ffffff", "#cdd6ff", "#9fe8ff", "#c9b6ff"];
  function colorFor(i) { return COLORS[i % COLORS.length]; }

  function frame() {
    ctx.clearRect(0, 0, w, h);
    // ease pointer parallax
    pointer.x += (pointer.tx - pointer.x) * 0.05;
    pointer.y += (pointer.ty - pointer.y) * 0.05;

    for (var i = 0; i < stars.length; i++) {
      var s = stars[i];
      s.tw += s.tws;
      s.y -= s.drift * s.z;                     // slow upward drift
      if (s.y < -2) { s.y = h + 2; s.x = Math.random() * w; }

      var px = s.x + pointer.x * s.z * 22;
      var py = s.y + pointer.y * s.z * 22;
      var alpha = 0.35 + Math.sin(s.tw) * 0.35 + 0.3;

      ctx.globalAlpha = Math.max(0, Math.min(1, alpha)) * s.z;
      ctx.fillStyle = colorFor(i);
      ctx.beginPath();
      ctx.arc(px, py, s.r * s.z + 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (running) requestAnimationFrame(frame);
  }

  var running = false;
  function start() { if (!running) { running = true; requestAnimationFrame(frame); } }
  function stop() { running = false; }

  window.addEventListener("resize", resize, { passive: true });

  // Parallax from pointer (skipped under reduced motion)
  if (!reduceMotion) {
    window.addEventListener("mousemove", function (e) {
      pointer.tx = (e.clientX / window.innerWidth - 0.5) * 2;
      pointer.ty = (e.clientY / window.innerHeight - 0.5) * 2;
    }, { passive: true });
  }

  // Pause the loop when the tab is hidden to save battery.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) stop(); else if (!reduceMotion) start();
  });

  resize();
  if (reduceMotion) {
    // Draw a single static frame, no animation loop.
    ctx.clearRect(0, 0, w, h);
    for (var j = 0; j < stars.length; j++) {
      var st = stars[j];
      ctx.globalAlpha = 0.5 * st.z;
      ctx.fillStyle = colorFor(j);
      ctx.beginPath();
      ctx.arc(st.x, st.y, st.r * st.z + 0.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  } else {
    start();
  }
})();

/* ============================================================
   Sky scanner — fake "is the sky real?" analysis + shareable verdict
   ============================================================ */
(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var vp = document.getElementById("skyVp");
  var statEl = document.getElementById("skyStat");
  var logEl = document.getElementById("skyLog");
  var btn = document.getElementById("skyScan");
  var resEl = document.getElementById("skyRes");
  var toast = document.getElementById("skyToast");
  if (!vp || !btn) return;

  // Stars inside the scanner viewport.
  for (var i = 0; i < 26; i++) {
    var s = document.createElement("span");
    s.className = "scanner__star";
    s.style.left = (Math.random() * 100) + "%";
    s.style.top = (Math.random() * 100) + "%";
    s.style.opacity = (0.3 + Math.random() * 0.6).toFixed(2);
    vp.appendChild(s);
  }

  // STEPS are cosmetic log flavor (drawn with Math.random, NOT the seed), so the pool
  // can grow freely without affecting shareable results.
  var STEPS = [
    "Initializing atmospheric probe",
    "Calibrating spectral analyzer",
    "Cross-referencing 14,302 known clouds",
    "Scanning for render artifacts",
    "Measuring pixel density of the color blue",
    "Detecting hard-coded star positions",
    "Analyzing sun texture resolution",
    "Checking the horizon for infinite loops",
    "Decompiling cloud shaders",
    "Auditing daylight ray-tracing",
    "Pinging the firmament",
    "Reverse-engineering the sunset gradient",
    "Counting polygons in the moon",
    "Sniffing clouds for JPEG artifacts",
    "Requesting sky source code (403 Forbidden)",
    "Comparing against the 1998 screensaver archive",
    "Bruteforcing the horizon seed",
    "Scanning for green-screen residue",
    "Measuring the refresh rate of the sun",
    "Checking daylight for compression banding"
  ];
  // Seeded pools — appending re-maps only this dimension (pick() is a fixed 1 draw).
  var DIAGS = [
    "Elaborate hologram", "Painted ceiling", "Simulation layer 7", "Giant screensaver",
    "Recycled stock footage", "Low-res dome projection", "Green-screen backdrop",
    "Municipal projection dome", "Decommissioned planetarium", "AI-upscaled void",
    "Government-issued ceiling", "Unrendered skybox", "Placeholder texture (forgot to swap)",
    "Reused desktop wallpaper", "Lens flare, all the way down", "Off-the-shelf weather asset pack"
  ];
  var TEXES = ["240p", "potato", "480i", "16-bit", "blurry", "144p", "8-bit", "dial-up", "N64-era", "VHS", "compressed to oblivion"];
  var RECS = [
    "Advisory: do not make eye contact with the horizon.",
    "Next step: tell three people, trust none of them.",
    "Suggested response: act natural.",
    "Protocol: blink twice if you can read this.",
    "Guidance: the ceiling is load-bearing. Do not touch.",
    "Reminder: clouds are just buffering.",
    "Note: the warranty on reality has expired.",
    "Directive: question everything above eye level.",
    "Status: you were not supposed to see this."
  ];

  // Seeded PRNG so a short id fully reproduces a scan result (stateless — no backend).
  function xmur3(str) {
    var h = 1779033703 ^ str.length;
    for (var i = 0; i < str.length; i++) {
      h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return function () {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      return (h ^= h >>> 16) >>> 0;
    };
  }
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function seedRng(seed) { return mulberry32(xmur3(seed)()); }

  var rng = Math.random;   // swapped for a seeded generator at the start of each scan
  var currentSeed = null;

  function pick(a) { return a[Math.floor(rng() * a.length)]; }
  function rand(a, b) { return Math.floor(a + rng() * (b - a + 1)); }
  // Cosmetic step picker — uses Math.random (NOT the seed) so step count never shifts results.
  function sampleN(a, n) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a.slice(0, n); }

  var busy = false;
  btn.addEventListener("click", function () { runScan(false); });

  function runScan(instant, seed) {
    if (busy) return;
    busy = true;
    if (!seed) seed = Math.floor(Math.random() * Math.pow(36, 5)).toString(36);
    currentSeed = seed;
    rng = seedRng(seed);
    try { history.replaceState(null, "", "/s/" + seed); } catch (e) { /* ignore */ }
    resEl.innerHTML = "";
    logEl.innerHTML = "";
    btn.disabled = true;
    btn.textContent = "Scanning…";
    var chosen = sampleN(STEPS, 5);

    if (instant || reduceMotion) {
      chosen.forEach(addLine);
      finish();
      return;
    }
    vp.classList.add("is-scanning");
    statEl.textContent = "scanning…";
    var i = 0;
    var t = setInterval(function () {
      if (i < chosen.length) { addLine(chosen[i]); i++; }
      else { clearInterval(t); finish(); }
    }, 430);
  }

  function addLine(txt) {
    var d = document.createElement("div");
    d.textContent = "> " + txt + "…";
    logEl.appendChild(d);
  }

  function finish() {
    vp.classList.remove("is-scanning");
    statEl.textContent = "analysis complete";
    busy = false;
    btn.disabled = false;
    btn.textContent = "Scan again";

    // Seeded result — LOCKED draw order so a seed reproduces identically and future pool
    // additions only re-map their own dimension (each pick/rand is a fixed 1 draw). Order:
    // fake-out -> confidence -> diagnosis -> render-artifacts -> texture -> recommendation.
    // The fake-out roll always consumes its draw (even under reduced motion) — only the
    // animation is gated — so the stream stays identical across motion settings.
    var fakeoutRoll = rng() < 0.02;
    var conf = (97 + rng() * 2.9).toFixed(1);
    var diag = pick(DIAGS);
    var artifacts = rand(800, 2100).toLocaleString("en-US");
    var tex = pick(TEXES);
    var rec = pick(RECS);
    var fakeout = fakeoutRoll && !reduceMotion;

    resEl.innerHTML =
      '<div class="scanner__result' + (fakeout ? " scanner__result--real" : "") + '">' +
        '<div class="scanner__label">Verdict</div>' +
        '<div class="scanner__verdict" id="skyVerdict">' + (fakeout ? "REAL?!" : "FAKE") + "</div>" +
        '<div class="scanner__diag">Diagnosis: ' + diag + "</div>" +
        '<div class="scanner__metrics">' +
          '<div class="scanner__metric"><b>' + conf + '%</b><span>artificial (confidence)</span></div>' +
          '<div class="scanner__metric"><b>' + artifacts + '</b><span>render artifacts</span></div>' +
          '<div class="scanner__metric"><b>0</b><span>real clouds found</span></div>' +
          '<div class="scanner__metric"><b>' + tex + '</b><span>sky texture res</span></div>' +
        "</div>" +
        '<p class="scanner__rec">' + rec + "</p>" +
        '<div class="scanner__controls" style="margin-top:16px">' +
          '<button class="btn btn--ghost" id="skyShare" type="button">Share the truth</button>' +
        "</div>" +
      "</div>";

    if (fakeout) {
      var wrap = resEl.firstChild;
      var v = document.getElementById("skyVerdict");
      setTimeout(function () {
        wrap.classList.remove("scanner__result--real");
        v.classList.add("scanner__glitch");
        v.textContent = "FAKE";
        setTimeout(function () { v.classList.remove("scanner__glitch"); }, 600);
      }, 1100);
    }

    document.getElementById("skyShare").addEventListener("click", share);
  }

  function share() {
    var url = location.origin + "/s/" + currentSeed;
    var payload = { title: "the sky is not real", text: "I ran the sky through the detector. See what it found:", url: url };
    if (navigator.share) {
      navigator.share(payload).catch(function () {});
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(showToast, showToast);
    } else {
      showToast();
    }
  }

  function showToast() {
    toast.classList.add("is-visible");
    setTimeout(function () { toast.classList.remove("is-visible"); }, 1900);
  }

  // Shared links land on a pre-scanned result. New: /s/<id> reproduces the exact
  // scan; old ?scanned=fake links still work (random scan).
  function afterDeepLink() {
    var sec = document.getElementById("scan");
    if (sec) {
      setTimeout(function () {
        sec.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      }, 300);
    }
  }
  var seedMatch = location.pathname.match(/^\/s\/([a-z0-9]+)$/i);
  if (seedMatch) {
    runScan(true, seedMatch[1]);
    afterDeepLink();
  } else if (/[?&]scanned=fake\b/.test(location.search)) {
    runScan(true);
    afterDeepLink();
  }
})();

/* ============================================================
   Email signup — POST /api/subscribe, with visible feedback on every outcome
   (success, duplicate, invalid email, and server/network errors). Never fails
   silently.
   ============================================================ */
(function () {
  "use strict";

  var form = document.getElementById("signup");
  var input = document.getElementById("signupEmail");
  var btn = document.getElementById("signupBtn");
  var msg = document.getElementById("signupMsg");
  if (!form || !input || !btn || !msg) return;

  // Same liberal shape check the Worker uses — reject obvious junk, not edge cases.
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  var INVALID_TEXT = "That doesn't look like a valid email — try again.";

  function setMsg(text, kind) {
    msg.textContent = text;
    msg.classList.remove("is-ok", "is-error");
    if (kind) msg.classList.add(kind);
  }

  function markInvalid() {
    input.setAttribute("aria-invalid", "true");
    setMsg(INVALID_TEXT, "is-error");
    input.focus();
  }

  function clearInvalid() {
    input.removeAttribute("aria-invalid");
  }

  // Clear the error state as soon as the user starts fixing the field.
  input.addEventListener("input", function () {
    if (input.getAttribute("aria-invalid") === "true") {
      clearInvalid();
      setMsg("", null);
    }
  });

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    var email = input.value.trim().toLowerCase();

    // Client-side guard: show a visible error, don't submit.
    if (!EMAIL_RE.test(email) || email.length > 254) {
      markInvalid();
      return;
    }

    clearInvalid();
    btn.disabled = true;
    var originalLabel = btn.textContent;
    btn.textContent = "Signing you up…";
    setMsg("", null);

    fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email })
    })
      .then(function (res) {
        return res
          .json()
          .catch(function () { return {}; })
          .then(function (data) { return { status: res.status, data: data }; });
      })
      .then(function (r) {
        if (r.status === 200 && r.data && r.data.ok) {
          form.reset();
          setMsg("You're on the list — welcome to the resistance.", "is-ok");
        } else if (r.status === 400 && r.data && r.data.error === "invalid_email") {
          // Server rejected something the client let through — surface it, don't drop.
          markInvalid();
        } else {
          setMsg("Something went wrong on our end — please try again.", "is-error");
        }
      })
      .catch(function () {
        setMsg("Couldn't reach the mothership — check your connection and try again.", "is-error");
      })
      .then(function () {
        btn.disabled = false;
        btn.textContent = originalLabel;
      });
  });
})();

/* ============================================================
   Ad slots — only occupy space when an ad actually fills. AdSense sets
   data-ad-status="filled" | "unfilled" on the <ins> once it resolves (async);
   mirror that onto the .ad-slot so unfilled slots collapse to nothing.
   ============================================================ */
(function () {
  "use strict";

  function sync(ins) {
    var slot = ins.closest(".ad-slot");
    if (!slot) return;
    var status = ins.getAttribute("data-ad-status");
    if (status === "unfilled") slot.classList.add("ad-slot--empty");
    else if (status === "filled") slot.classList.remove("ad-slot--empty");
  }

  var units = document.querySelectorAll(".ad-slot ins.adsbygoogle");
  units.forEach(function (ins) {
    sync(ins); // in case status is already set by the time we run
    new MutationObserver(function () { sync(ins); }).observe(ins, {
      attributes: true,
      attributeFilter: ["data-ad-status"]
    });
  });
})();

