(() => {
  const gate = document.getElementById("gate");
  const app = document.getElementById("app");
  const joinForm = document.getElementById("joinForm");
  const nameInput = document.getElementById("nameInput");
  const roomInput = document.getElementById("roomInput");
  const newRoomBtn = document.getElementById("newRoomBtn");

  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d");
  const preview = document.getElementById("preview");
  const pctx = preview.getContext("2d");
  const cursorLayer = document.getElementById("cursorLayer");
  const toast = document.getElementById("toast");
  const roomCodeBtn = document.getElementById("roomCodeBtn");
  const presenceList = document.getElementById("presenceList");
  const toolsEl = document.getElementById("tools");
  const swatchesEl = document.getElementById("swatches");
  const sizeRange = document.getElementById("sizeRange");
  const sizePreview = document.getElementById("sizePreview");
  const undoBtn = document.getElementById("undoBtn");
  const clearBtn = document.getElementById("clearBtn");
  const saveBtn = document.getElementById("saveBtn");

  const PALETTE = ["#21243D", "#E8637C", "#DFAE49", "#7BA6A0", "#9C8AD9", "#FBF6EC"];

  let room = "";
  let myName = "";
  let myColor = PALETTE[1];
  let tool = "brush"; // brush | eraser | blur | line | rect | circle | fill
  let brushSize = 6;
  let strokes = []; // historial completo para poder redibujar
  let current = null; // trazo libre en curso (pincel/goma/difuminado)
  let shapeStart = null; // punto inicial de una figura en curso
  let drawing = false;
  let lastKnownPoint = null;

  const cursorEls = {}; // socketId -> DOM element

  // ---------- Entrada / sala ----------

  function randomRoomCode() {
    const words = ["luna", "sol", "mar", "flor", "nube", "rio", "faro", "brisa", "cielo", "nido"];
    const a = words[Math.floor(Math.random() * words.length)];
    const b = words[Math.floor(Math.random() * words.length)];
    return `${a}-${b}-${Math.floor(Math.random() * 90 + 10)}`;
  }

  newRoomBtn.addEventListener("click", () => {
    roomInput.value = randomRoomCode();
  });

  joinForm.addEventListener("submit", (e) => {
    e.preventDefault();
    myName = nameInput.value.trim().slice(0, 20) || "Alguien";
    room = roomInput.value.trim().toLowerCase().replace(/\s+/g, "-") || randomRoomCode();
    enterApp();
  });

  function enterApp() {
    gate.classList.add("hidden");
    app.classList.remove("hidden");
    roomCodeBtn.textContent = room;
    resizeCanvas();
    connectSocket();
  }

  roomCodeBtn.addEventListener("click", () => {
    navigator.clipboard?.writeText(room).then(() => showToast("Código copiado — compártelo con tu pareja"));
  });

  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  // ---------- Lienzo: tamaño y utilidades ----------

  function sizeCanvasEl(el, c, rect, ratio) {
    el.width = rect.width * ratio;
    el.height = rect.height * ratio;
    el.style.width = rect.width + "px";
    el.style.height = rect.height + "px";
    c.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function resizeCanvas() {
    const rect = canvas.parentElement.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    sizeCanvasEl(canvas, ctx, rect, ratio);
    sizeCanvasEl(preview, pctx, rect, ratio);
    redrawAll();
  }
  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("orientationchange", () => setTimeout(resizeCanvas, 200));

  function pointFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function hexToRgb(hex) {
    const n = parseInt(hex.replace("#", ""), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // ---------- Dibujo: trazo libre (pincel / goma) ----------

  function drawSegment(c, seg) {
    c.beginPath();
    c.moveTo(seg.x0, seg.y0);
    c.lineTo(seg.x1, seg.y1);
    c.strokeStyle = seg.color;
    c.lineWidth = seg.size;
    c.lineCap = "round";
    c.lineJoin = "round";
    c.globalCompositeOperation = seg.erase ? "destination-out" : "source-over";
    c.stroke();
    c.globalCompositeOperation = "source-over";
  }

  // ---------- Dibujo: figuras (línea / rectángulo / círculo) ----------

  function drawShape(c, s) {
    c.beginPath();
    c.strokeStyle = s.color;
    c.lineWidth = s.size;
    c.lineCap = "round";
    c.lineJoin = "round";
    if (s.shape === "line") {
      c.moveTo(s.x0, s.y0);
      c.lineTo(s.x1, s.y1);
    } else if (s.shape === "rect") {
      c.rect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
    } else if (s.shape === "circle") {
      const rx = Math.abs(s.x1 - s.x0) / 2;
      const ry = Math.abs(s.y1 - s.y0) / 2;
      const cx = Math.min(s.x0, s.x1) + rx;
      const cy = Math.min(s.y0, s.y1) + ry;
      c.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
    }
    c.stroke();
  }

  // ---------- Dibujo: difuminado (blur local sobre lo ya pintado) ----------

  function blurAt(cssX, cssY, radius) {
    const ratio = window.devicePixelRatio || 1;
    const size = radius * 2;
    const dx = cssX - radius;
    const dy = cssY - radius;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = `blur(${Math.max(2, radius / 3)}px)`;
    ctx.drawImage(
      canvas,
      dx * ratio, dy * ratio, size * ratio, size * ratio,
      dx * ratio, dy * ratio, size * ratio, size * ratio
    );
    ctx.restore();
  }

  // ---------- Dibujo: balde de relleno ----------

  function floodFill(cssX, cssY, fillHex) {
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.width, h = canvas.height;
    const x = Math.floor(cssX * ratio), y = Math.floor(cssY * ratio);
    if (x < 0 || y < 0 || x >= w || y >= h) return;

    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;
    const idx = (y * w + x) * 4;
    const startR = data[idx], startG = data[idx + 1], startB = data[idx + 2], startA = data[idx + 3];
    const [fr, fg, fb] = hexToRgb(fillHex);
    if (startR === fr && startG === fg && startB === fb && startA === 255) return;

    const tolerance = 45;
    const tol2 = tolerance * tolerance * 3;
    function matches(i) {
      const dr = data[i] - startR, dg = data[i + 1] - startG, db = data[i + 2] - startB;
      return dr * dr + dg * dg + db * db <= tol2 && Math.abs(data[i + 3] - startA) <= tolerance;
    }

    const stack = [[x, y]];
    const visited = new Uint8Array(w * h);
    while (stack.length) {
      const [cx, cy] = stack.pop();
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
      const vIdx = cy * w + cx;
      if (visited[vIdx]) continue;
      const i = vIdx * 4;
      if (!matches(i)) continue;
      visited[vIdx] = 1;
      data[i] = fr; data[i + 1] = fg; data[i + 2] = fb; data[i + 3] = 255;
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
    }
    ctx.putImageData(img, 0, 0);
  }

  // ---------- Reproducir historial completo ----------

  function drawStroke(c, stroke) {
    if (stroke.type === "shape") drawShape(c, stroke);
    else if (stroke.type === "fill") floodFill(stroke.x, stroke.y, stroke.color);
    else if (stroke.type === "blur") stroke.points.forEach((p) => blurAt(p.x, p.y, stroke.radius));
    else stroke.segments.forEach((seg) => drawSegment(c, seg));
  }

  function redrawAll() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    strokes.forEach((s) => drawStroke(ctx, s));
  }

  // ---------- Interacción de dibujo ----------

  function startInteraction(point) {
    if (tool === "fill") {
      const stroke = { type: "fill", owner: socket.id, x: point.x, y: point.y, color: myColor };
      floodFill(point.x, point.y, myColor);
      strokes.push(stroke);
      socket.emit("draw", stroke);
      return;
    }
    if (tool === "line" || tool === "rect" || tool === "circle") {
      shapeStart = point;
      return;
    }
    current = {
      type: "freehand",
      owner: socket.id,
      color: myColor,
      size: brushSize,
      erase: tool === "eraser",
      segments: [],
      points: tool === "blur" ? [point] : undefined,
      last: point,
    };
    if (tool === "blur") {
      blurAt(point.x, point.y, brushSize);
    } else {
      // Un punto inicial: así un solo click ya deja marca, sin necesidad de arrastrar
      const dot = { x0: point.x, y0: point.y, x1: point.x, y1: point.y, color: myColor, size: brushSize, erase: tool === "eraser" };
      current.segments.push(dot);
      drawSegment(ctx, dot);
    }
  }

  function moveInteraction(point) {
    lastKnownPoint = point;
    if ((tool === "line" || tool === "rect" || tool === "circle") && shapeStart) {
      pctx.clearRect(0, 0, preview.width, preview.height);
      drawShape(pctx, { shape: tool, color: myColor, size: brushSize, x0: shapeStart.x, y0: shapeStart.y, x1: point.x, y1: point.y });
      return;
    }
    if (!current) return;
    if (tool === "blur") {
      blurAt(point.x, point.y, brushSize);
      current.points.push(point);
      current.last = point;
      return;
    }
    const seg = {
      x0: current.last.x, y0: current.last.y,
      x1: point.x, y1: point.y,
      color: current.color, size: current.size, erase: current.erase,
    };
    current.segments.push(seg);
    drawSegment(ctx, seg);
    current.last = point;
  }

  function endInteraction(point) {
    point = point || lastKnownPoint;
    if ((tool === "line" || tool === "rect" || tool === "circle") && shapeStart) {
      pctx.clearRect(0, 0, preview.width, preview.height);
      if (point) {
        const stroke = { type: "shape", owner: socket.id, shape: tool, color: myColor, size: brushSize, x0: shapeStart.x, y0: shapeStart.y, x1: point.x, y1: point.y };
        drawShape(ctx, stroke);
        strokes.push(stroke);
        socket.emit("draw", stroke);
      }
      shapeStart = null;
      return;
    }
    if (!current) return;
    if (tool === "blur") {
      if (current.points.length) {
        const stroke = { type: "blur", owner: socket.id, radius: brushSize, points: current.points };
        strokes.push(stroke);
        socket.emit("draw", stroke);
      }
    } else if (current.segments.length) {
      strokes.push(current);
      socket.emit("draw", current);
    }
    current = null;
  }

  canvas.addEventListener("pointerdown", (e) => {
    drawing = true;
    lastKnownPoint = pointFromEvent(e);
    canvas.setPointerCapture(e.pointerId);
    startInteraction(lastKnownPoint);
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = pointFromEvent(e);
    socket?.emit("cursor", { x: p.x / canvas.clientWidth, y: p.y / canvas.clientHeight });
    if (drawing) moveInteraction(p);
  });
  canvas.addEventListener("pointerup", (e) => { drawing = false; endInteraction(pointFromEvent(e)); });
  canvas.addEventListener("pointercancel", () => { drawing = false; endInteraction(lastKnownPoint); });

  // Evita que el navegador haga scroll/zoom al dibujar con el dedo en celular
  canvas.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  canvas.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });

  // ---------- Herramientas ----------

  function setTool(name) {
    tool = name;
    [...toolsEl.children].forEach((b) => b.classList.toggle("active", b.dataset.tool === name));
    canvas.style.cursor = name === "fill" ? "pointer" : "crosshair";
    updateSizePreview();
  }
  toolsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tool]");
    if (btn) setTool(btn.dataset.tool);
  });

  function buildSwatches() {
    swatchesEl.innerHTML = "";
    PALETTE.forEach((c) => {
      const b = document.createElement("button");
      b.className = "swatch";
      b.style.background = c;
      b.addEventListener("click", () => {
        myColor = c;
        [...swatchesEl.children].forEach((el) => el.classList.remove("active"));
        b.classList.add("active");
        updateSizePreview();
      });
      swatchesEl.appendChild(b);
    });
  }
  buildSwatches();

  function selectDefaultSwatch(color) {
    const idx = PALETTE.indexOf(color);
    const btn = swatchesEl.children[idx >= 0 ? idx : 1];
    btn?.click();
  }

  function updateSizePreview() {
    sizePreview.innerHTML = "";
    const inner = document.createElement("span");
    const d = Math.min(brushSize, 20);
    inner.style.width = d + "px";
    inner.style.height = d + "px";
    inner.style.borderRadius = "50%";
    inner.style.background = tool === "eraser" ? "#FBF6EC" : myColor;
    inner.style.display = "block";
    sizePreview.appendChild(inner);
  }
  sizeRange.addEventListener("input", () => {
    brushSize = Number(sizeRange.value);
    updateSizePreview();
  });

  undoBtn.addEventListener("click", () => socket.emit("undo-last-mine"));

  clearBtn.addEventListener("click", () => {
    if (confirm("¿Borrar todo el lienzo para los dos?")) socket.emit("clear");
  });

  saveBtn.addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = `dibujo-${room}.png`;
    const off = document.createElement("canvas");
    off.width = canvas.width;
    off.height = canvas.height;
    const octx = off.getContext("2d");
    octx.fillStyle = "#FBF6EC";
    octx.fillRect(0, 0, off.width, off.height);
    octx.drawImage(canvas, 0, 0);
    link.href = off.toDataURL("image/png");
    link.click();
    showToast("Dibujo guardado");
  });

  // ---------- Socket.io ----------

  let socket;

  function connectSocket() {
    if (typeof io === "undefined") {
      showToast("No se pudo conectar al servidor — revisa que la app esté corriendo con npm start");
      return;
    }
    socket = io();

    socket.on("connect", () => socket.emit("join", { room, name: myName }));

    socket.on("joined", ({ color, history, partners }) => {
      strokes = history || [];
      redrawAll();
      selectDefaultSwatch(color);
      renderPresence(partners.concat([{ name: myName, color }]));
      if (partners.length) showToast(`${partners.map((p) => p.name).join(", ")} ya está en el lienzo`);
    });

    socket.on("partner-joined", ({ name }) => showToast(`${name} se unió al lienzo 💌`));
    socket.on("partner-left", ({ name }) => showToast(`${name} salió del lienzo`));
    socket.on("presence", (users) => renderPresence(users));

    socket.on("draw", (stroke) => {
      strokes.push(stroke);
      drawStroke(ctx, stroke);
    });

    socket.on("redraw", (history) => {
      strokes = history;
      redrawAll();
    });

    socket.on("clear", () => {
      strokes = [];
      redrawAll();
      showToast("El lienzo se limpió");
    });

    socket.on("cursor", ({ id, x, y, name, color }) => {
      let el = cursorEls[id];
      if (!el) {
        el = document.createElement("div");
        el.className = "partner-cursor";
        el.innerHTML = `<span class="cursor-heart">♥</span><span class="cursor-name"></span>`;
        cursorLayer.appendChild(el);
        cursorEls[id] = el;
      }
      const nameEl = el.querySelector(".cursor-name");
      const heartEl = el.querySelector(".cursor-heart");
      if (name) nameEl.textContent = name;
      if (color) { nameEl.style.background = color; heartEl.style.color = color; }
      el.style.opacity = "1";
      el.style.left = x * canvas.clientWidth + "px";
      el.style.top = y * canvas.clientHeight + "px";
      clearTimeout(el._hideT);
      el._hideT = setTimeout(() => (el.style.opacity = "0"), 2000);
    });

    socket.on("connect_error", () => showToast("Sin conexión con el servidor — intenta recargar la página"));
  }

  function renderPresence(users) {
    presenceList.innerHTML = "";
    users.forEach((u) => {
      const dot = document.createElement("span");
      dot.className = "presence-dot";
      dot.style.background = u.color;
      dot.title = u.name;
      presenceList.appendChild(dot);
    });
  }
})();
