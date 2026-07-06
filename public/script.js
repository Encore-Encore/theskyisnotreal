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
