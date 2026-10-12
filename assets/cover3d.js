/* Cover in WebGL: nine glass-and-aluminium desktop monitors on a looping ring.
   Swipe/drag, sideways trackpad scroll, the ‹ › buttons or arrow keys turn it; the monitor that comes to
   the front grows. When the ring rests, the front screen plays its video muted in a player laid flat
   over that screen (video iframes cannot be WebGL textures). Falls back to the CSS ring on any failure. */
import * as THREE from './vendor/three/three.module.min.js';
import { RoomEnvironment } from './vendor/three/RoomEnvironment.js';
import { RoundedBoxGeometry } from './vendor/three/RoundedBoxGeometry.js';

const site = window.__site;
const cover = document.getElementById('cover');

if (site && cover) {
  try {
    start();
  } catch (err) {
    console.error('3D cover failed, using the CSS cover', err);
    cover.querySelectorAll('.cover-canvas').forEach(c => c.remove());
    cover.classList.remove('is-3d');
    site.initCssCover();
  }
}

function start() {
  const stage = document.getElementById('stage');
  const live = document.getElementById('cover-live');
  const caption = document.getElementById('cover-caption');
  const ccCount = document.getElementById('cc-count');
  const ccTitle = document.getElementById('cc-title');
  const ccHint = document.getElementById('cc-hint');
  const header = document.querySelector('.site-header');
  const { reduce, canHover, player, openPlayer } = site;

  /* data comes from the fallback markup */
  const items = [...cover.querySelectorAll('.mon')].map(m => {
    const img = m.querySelector('img');
    return {
      el: m,
      id: m.dataset.id,
      provider: m.dataset.provider,
      title: m.dataset.title,
      contain: img.classList.contains('contain'),
      src: proxied(img.getAttribute('src')),
      fallback: img.dataset.fallback ? proxied(img.dataset.fallback) : null
    };
  });
  const N = items.length;
  const STEP = (Math.PI * 2) / N;
  const pad = n => String(n).padStart(2, '0');
  const mod = (n, m) => ((n % m) + m) % m;

  /* ---------- renderer, scene, camera ---------- */
  const canvas = document.createElement('canvas');
  canvas.className = 'cover-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  stage.prepend(canvas);
  const touch = !canHover.matches;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, touch ? 1.75 : 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.VSMShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);

  /* low key light from the upper left throws long soft shadows across the floor */
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(-5, 5.5, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(touch ? 1024 : 2048, touch ? 1024 : 2048);
  Object.assign(key.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 25 });
  key.shadow.bias = -0.0006;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 9;
  key.shadow.blurSamples = 16;
  scene.add(key);
  scene.add(key.target);
  key.target.position.set(0, 0, 1.2);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.17 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  /* ---------- materials ---------- */
  const grain = grainTexture();
  /* bead-blasted aluminium: bright, satin, with a fine grain */
  const alu = new THREE.MeshStandardMaterial({ color: 0xeceef0, metalness: 0.88, roughness: 0.52, roughnessMap: grain, bumpMap: grain, bumpScale: 0.0009, envMapIntensity: 1.25 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.05, transparent: true, opacity: 0.14,
    clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.5, depthWrite: false, side: THREE.DoubleSide
  });
  /* the pane in front of the display reflects only faintly, so the picture stays deep */
  const frontGlass = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0.02, transparent: true, opacity: 0.05,
    clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 0.55, depthWrite: false
  });
  /* acrylic plinth: a faint green-grey edge tint so it reads against a light floor */
  const acrylic = new THREE.MeshPhysicalMaterial({
    color: 0xd6e9e6, metalness: 0, roughness: 0.04, transparent: true, opacity: 0.38,
    clearcoat: 1, clearcoatRoughness: 0.03, envMapIntensity: 1.3, depthWrite: false
  });
  const black = new THREE.MeshStandardMaterial({ color: 0x101114, metalness: 0.35, roughness: 0.42 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x08090b, metalness: 0.4, roughness: 0.28 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.16 });
  const ledOff = new THREE.MeshStandardMaterial({ color: 0x8d9198, metalness: 0.2, roughness: 0.4 });
  const ledOn = new THREE.MeshBasicMaterial({ color: 0xff3b30, toneMapped: false });

  /* ---------- one monitor (width 1, origin on the floor, screen facing +z) ---------- */
  const D = 0.17, FW = 0.03, BASE_H = 0.11, GAP = 0.03;
  const SW = 0.88, SH = SW * 9 / 16;
  const FEET = 0.064, PLINTH_Y = 0.045, POST_H = 0.2;
  const BOX_Y0 = PLINTH_Y + 0.007 + POST_H;              // underside of the base
  const BOX_H = BASE_H + GAP + SH + GAP + FW;
  const BOX_Y1 = BOX_Y0 + BOX_H;
  const SCREEN_Y = BOX_Y0 + BASE_H + GAP + SH / 2;
  const SCREEN_Z = 0.026;

  const rbox = (w, h, d, r) => new RoundedBoxGeometry(w, h, d, 2, r);
  const geo = {
    base: rbox(1, BASE_H, D, 0.006),
    vbar: rbox(FW, BOX_H - BASE_H, FW, 0.004),
    hbar: rbox(1, FW, FW, 0.004),
    dbar: rbox(FW, FW, D, 0.004),
    paneFB: new THREE.BoxGeometry(1 - 2 * FW, BOX_H - BASE_H - FW, 0.004),
    paneSide: new THREE.BoxGeometry(0.004, BOX_H - BASE_H - FW, D - 2 * FW),
    paneTop: new THREE.BoxGeometry(1 - 2 * FW, 0.004, D - 2 * FW),
    panel: rbox(SW + 0.024, SH + 0.024, 0.014, 0.004),
    screen: new THREE.PlaneGeometry(SW, SH),
    standoff: new THREE.CylinderGeometry(0.007, 0.007, 1, 16),
    post: new THREE.CylinderGeometry(0.019, 0.019, POST_H, 32),
    foot: new THREE.CylinderGeometry(0.016, 0.016, FEET, 32),
    plinth: rbox(0.64, 0.014, 0.34, 0.005),
    knob: new THREE.CylinderGeometry(0.017, 0.017, 0.022, 36),
    knurl: new THREE.CylinderGeometry(0.0175, 0.0175, 0.012, 36, 1, true),
    jack: new THREE.TorusGeometry(0.01, 0.0035, 12, 32),
    hole: new THREE.CircleGeometry(0.0085, 24),
    tglBase: new THREE.CylinderGeometry(0.009, 0.009, 0.01, 24),
    tglLever: new THREE.CylinderGeometry(0.0028, 0.002, 0.03, 12),
    led: new THREE.SphereGeometry(0.0065, 16, 12),
    label: new THREE.PlaneGeometry(0.14, 0.035)
  };
  const knurlMat = new THREE.MeshStandardMaterial({ color: 0xe8e9eb, metalness: 1, roughness: 0.3, map: knurlTexture() });

  const add = (parent, geometry, material, x, y, z, shadow = true) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.castShadow = shadow;
    parent.add(m);
    return m;
  };

  const buildMonitor = (item, index) => {
    const g = new THREE.Group();
    const zF = D / 2 - FW / 2, zB = -zF, xE = 0.5 - FW / 2;
    const yBar = BOX_Y0 + BASE_H + (BOX_H - BASE_H) / 2;

    /* aluminium: solid base, four uprights, top rails front/back and two depth rails */
    add(g, geo.base, alu, 0, BOX_Y0 + BASE_H / 2, 0);
    [[-xE, zF], [xE, zF], [-xE, zB], [xE, zB]].forEach(([x, z]) => add(g, geo.vbar, alu, x, yBar, z));
    add(g, geo.hbar, alu, 0, BOX_Y1 - FW / 2, zF);
    add(g, geo.hbar, alu, 0, BOX_Y1 - FW / 2, zB);
    add(g, geo.dbar, alu, -xE, BOX_Y1 - FW / 2, 0);
    add(g, geo.dbar, alu, xE, BOX_Y1 - FW / 2, 0);

    /* glass panes */
    const paneY = BOX_Y0 + BASE_H + (BOX_H - BASE_H - FW) / 2;
    add(g, geo.paneFB, frontGlass, 0, paneY, zF, false).renderOrder = 2;
    add(g, geo.paneFB, glass, 0, paneY, zB, false).renderOrder = 2;
    add(g, geo.paneSide, glass, -xE, paneY, 0, false).renderOrder = 2;
    add(g, geo.paneSide, glass, xE, paneY, 0, false).renderOrder = 2;
    add(g, geo.paneTop, glass, 0, BOX_Y1 - FW / 2, 0, false).renderOrder = 2;

    /* the display floats inside on four chrome standoffs to the back pane */
    add(g, geo.panel, panel, 0, SCREEN_Y, SCREEN_Z - 0.008);
    const screenMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const scr = add(g, geo.screen, screenMat, 0, SCREEN_Y, SCREEN_Z, false);
    const soLen = (SCREEN_Z - 0.015) - (zB + 0.002);
    [[-0.4, 0.2], [0.4, 0.2], [-0.4, -0.2], [0.4, -0.2]].forEach(([x, y]) => {
      const so = add(g, geo.standoff, chrome, x, SCREEN_Y + y, (SCREEN_Z - 0.015 + zB + 0.002) / 2);
      so.rotation.x = Math.PI / 2;
      so.scale.y = soLen;
    });
    /* a cable from the back of the display down into the base */
    const cable = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.28, SCREEN_Y - SH / 2 + 0.05, SCREEN_Z - 0.02),
      new THREE.Vector3(0.31, SCREEN_Y - SH / 2 - 0.0, -0.03),
      new THREE.Vector3(0.36, BOX_Y0 + BASE_H + 0.02, -0.05),
      new THREE.Vector3(0.37, BOX_Y0 + BASE_H - 0.01, -0.05)
    ]);
    add(g, new THREE.TubeGeometry(cable, 32, 0.0045, 10), black, 0, 0, 0);

    /* controls on the face of the base: jack, knurled knob, toggle, status LED, and the channel mark */
    const yC = BOX_Y0 + BASE_H / 2, zC = D / 2;
    const jack = add(g, geo.jack, chrome, 0.2, yC, zC + 0.002);
    add(g, geo.hole, black, 0.2, yC, zC + 0.0015, false);
    const knob = add(g, geo.knob, chrome, 0.265, yC, zC + 0.011); knob.rotation.x = Math.PI / 2;
    const knurl = add(g, geo.knurl, knurlMat, 0.265, yC, zC + 0.009); knurl.rotation.x = Math.PI / 2;
    const tb = add(g, geo.tglBase, chrome, 0.33, yC, zC + 0.005); tb.rotation.x = Math.PI / 2;
    const tl = add(g, geo.tglLever, chrome, 0.33, yC + 0.006, zC + 0.02); tl.rotation.x = Math.PI / 2 - 0.5;
    const led = add(g, geo.led, ledOff, 0.39, yC, zC + 0.001, false);
    const lbl = add(g, geo.label, new THREE.MeshBasicMaterial({ map: labelTexture('CH ' + pad(index + 1)), transparent: true, toneMapped: false }), -0.33, yC, zC + 0.0012, false);
    lbl.renderOrder = 1;
    void jack;

    /* stand: two black posts on a clear glass plinth, with four posts through its corners */
    [-0.17, 0.17].forEach(x => add(g, geo.post, black, x, PLINTH_Y + 0.007 + POST_H / 2, 0));
    add(g, geo.plinth, acrylic, 0, PLINTH_Y, 0, false).renderOrder = 2;
    [[-0.28, 0.135], [0.28, 0.135], [-0.28, -0.135], [0.28, -0.135]].forEach(([x, z]) => add(g, geo.foot, black, x, FEET / 2, z));

    g.userData = { index, screenMat, scr, led };
    g.traverse(o => { o.userData.monitor = index; });
    loadScreen(item, screenMat);
    return g;
  };

  /* screens: draw the thumbnail into a 16:9 canvas (cover, or pillarbox for non-16:9 films) */
  const loadScreen = (item, mat) => {
    const c = document.createElement('canvas');
    c.width = 1280; c.height = 720;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#050608';
    ctx.fillRect(0, 0, c.width, c.height);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    mat.map = tex;
    mat.needsUpdate = true;
    const draw = img => {
      const s = item.contain ? Math.min(c.width / img.naturalWidth, c.height / img.naturalHeight) : Math.max(c.width / img.naturalWidth, c.height / img.naturalHeight);
      const w = img.naturalWidth * s, h = img.naturalHeight * s;
      ctx.fillStyle = '#050608';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
      tex.needsUpdate = true;
      requestRender();
    };
    const tryLoad = (src, next) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => { if (img.naturalWidth <= 120 && next) tryLoad(next, null); else draw(img); };
      img.onerror = () => { if (next) tryLoad(next, null); };
      img.src = src;
    };
    tryLoad(item.src, item.fallback);
  };

  const ring = new THREE.Group();
  scene.add(ring);
  const R = 1.95;
  const monitors = items.map((item, i) => {
    const m = buildMonitor(item, i);
    m.position.set(Math.sin(i * STEP) * R, 0, Math.cos(i * STEP) * R);
    m.rotation.y = i * STEP;
    ring.add(m);
    return m;
  });

  /* ---------- layout: the front screen sits at a fixed spot; lens shift keeps verticals straight ---------- */
  const FRONT_SCALE = 1.32;
  const view = { w: 1, h: 1 };
  const frame = () => {
    const w = stage.clientWidth, h = stage.clientHeight;
    view.w = w; view.h = h;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tanH = tanV * camera.aspect;
    const frontW = FRONT_SCALE * 1.0, frontH = FRONT_SCALE * BOX_Y1;
    const yEye = SCREEN_Y * FRONT_SCALE;
    const portrait = w / h < 0.8;
    const SHIFT = portrait ? 0.12 : 0.28;      // front screen centre: 44% (phones) or 36% from the top
    const share = w < 700 ? 0.84 : Math.min(0.46, 720 / w);
    const dW = frontW / (2 * share * tanH);
    const dBottom = (yEye - 0.07 * FRONT_SCALE) / (tanV * (SHIFT + 0.5));   // plinth above the caption
    const dTop = (frontH - yEye) / (tanV * (0.92 - SHIFT));
    const d = Math.max(dW, dBottom, dTop);
    camera.position.set(0, yEye, R + d);
    camera.lookAt(0, yEye, R);
    camera.updateProjectionMatrix();
    /* lens shift (not a tilt) so the front screen stays a true rectangle for the video overlay */
    camera.projectionMatrix.elements[9] = -SHIFT;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    requestRender();
  };

  /* ---------- state and rendering ---------- */
  let p = 0, shownK = -1, settled = false, inView = true;
  let anim = 0, snapT = 0, drag = null, suppressClick = false, rafR = 0;
  let liveFor = -1, livePlaying = false, liveKill = null, ytApi = null, vimeoApi = null;
  const front = () => mod(Math.round(p), N);

  const layout = () => {
    ring.rotation.y = -p * STEP;
    monitors.forEach((m, i) => {
      let off = i - p;
      off -= N * Math.round(off / N);
      const d = Math.abs(off);
      m.visible = d <= 2.6;
      const t = Math.max(0, 1 - d);
      const s = 1 + (FRONT_SCALE - 1) * t * t * (3 - 2 * t);
      m.scale.setScalar(s);
    });
    const k = front();
    if (k !== shownK) {
      shownK = k;
      ccCount.textContent = 'CH ' + pad(k + 1) + ' / ' + pad(N);
      ccTitle.textContent = items[k].title;
    }
    if (liveFor !== -1 && liveFor !== k) stopLive();
  };
  const renderNow = () => { rafR = 0; layout(); renderer.render(scene, camera); };
  function requestRender() { if (!rafR) rafR = requestAnimationFrame(renderNow); }

  /* ---------- live player over the front screen ---------- */
  const v3 = new THREE.Vector3();
  const place = k => {
    layout();
    ring.updateMatrixWorld(true);
    const scr = monitors[k].userData.scr;
    const pts = [[-SW / 2, -SH / 2], [SW / 2, -SH / 2], [-SW / 2, SH / 2], [SW / 2, SH / 2]].map(([x, y]) => {
      v3.set(x, y, 0);
      scr.localToWorld(v3);
      v3.project(camera);
      return [(v3.x + 1) / 2 * view.w, (1 - v3.y) / 2 * view.h];
    });
    const xs = pts.map(q => q[0]), ys = pts.map(q => q[1]);
    const l = Math.min(...xs), t = Math.min(...ys);
    const bleed = 1.5;   // cover the screen edge fully; the overlap lands on the black bezel
    live.style.left = (l - bleed) + 'px';
    live.style.top = (t - bleed) + 'px';
    live.style.width = (Math.max(...xs) - l + bleed * 2) + 'px';
    live.style.height = (Math.max(...ys) - t + bleed * 2) + 'px';
  };
  const setLed = (k, on) => { if (k >= 0) { monitors[k].userData.led.material = on ? ledOn : ledOff; requestRender(); } };
  const hideLive = () => { live.classList.remove('is-shown'); caption.classList.remove('is-live'); monitors.forEach((m, i) => setLed(i, false)); };
  const stopLive = () => {
    hideLive();
    if (liveKill) { try { liveKill(); } catch (err) { /* already gone */ } }
    liveKill = null; liveFor = -1; livePlaying = false;
    live.replaceChildren();
  };
  const showIfReady = () => {
    if (!settled || !inView || liveFor !== front() || !livePlaying || !player.hidden) return;
    place(liveFor);
    live.classList.add('is-shown');
    caption.classList.add('is-live');
    setLed(liveFor, true);
  };
  const onPlaying = k => { if (liveFor === k) { livePlaying = true; showIfReady(); } };
  const loadScript = (src, ready) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => { if (!ready) resolve(); };
    s.onerror = () => reject(new Error('Failed to load ' + src));
    if (ready) ready(resolve);
    document.head.appendChild(s);
  });
  const loadYT = () => ytApi || (ytApi = (window.YT && window.YT.Player)
    ? Promise.resolve(window.YT)
    : loadScript('https://www.youtube.com/iframe_api', done => {
        const prev = window.onYouTubeIframeAPIReady;
        window.onYouTubeIframeAPIReady = () => { if (prev) prev(); done(); };
      }).then(() => window.YT).catch(err => { ytApi = null; throw err; }));
  const loadVimeo = () => vimeoApi || (vimeoApi = (window.Vimeo && window.Vimeo.Player)
    ? Promise.resolve(window.Vimeo)
    : loadScript('https://player.vimeo.com/api/player.js').then(() => window.Vimeo).catch(err => { vimeoApi = null; throw err; }));

  const startLive = k => {
    if (reduce) return;
    if (liveFor === k) { showIfReady(); return; }
    stopLive();
    liveFor = k;
    place(k);
    const it = items[k];
    if (it.provider === 'vimeo') {
      const f = document.createElement('iframe');
      f.src = 'https://player.vimeo.com/video/' + it.id + '?autoplay=1&muted=1&loop=1&autopause=0&controls=0&title=0&byline=0&portrait=0&dnt=1&playsinline=1';
      f.allow = 'autoplay; fullscreen; picture-in-picture';
      f.title = it.title;
      live.replaceChildren(f);
      loadVimeo().then(Vimeo => {
        if (liveFor !== k) return;
        const vp = new Vimeo.Player(f);
        liveKill = () => vp.destroy();
        vp.on('playing', () => onPlaying(k));
        vp.setVolume(0).catch(() => {});
        vp.play().catch(() => {});
      }).catch(() => setTimeout(() => onPlaying(k), 1500));
      return;
    }
    const host = document.createElement('div');
    live.replaceChildren(host);
    loadYT().then(YT => {
      if (liveFor !== k) return;
      const yp = new YT.Player(host, {
        videoId: it.id, width: '100%', height: '100%', host: 'https://www.youtube-nocookie.com',
        playerVars: { autoplay: 1, mute: 1, controls: 0, loop: 1, playlist: it.id, playsinline: 1, rel: 0, iv_load_policy: 3, disablekb: 1, fs: 0, modestbranding: 1 },
        events: {
          onReady: e => { e.target.mute(); e.target.playVideo(); },
          onStateChange: e => { if (e.data === 1) onPlaying(k); },
          onError: () => { if (liveFor === k) stopLive(); }
        }
      });
      liveKill = () => yp.destroy();
    }).catch(() => {});
  };

  /* ---------- motion ---------- */
  const setHint = () => {
    ccHint.textContent = settled && !reduce
      ? (touch ? 'Swipe to switch · Tap the screen for sound' : 'Drag or scroll sideways · Click the screen for sound')
      : (touch ? 'Swipe sideways to switch' : 'Drag or scroll sideways to switch');
  };
  const unsettle = () => { if (settled) { settled = false; hideLive(); setHint(); } };
  const settle = () => { settled = true; setHint(); if (inView && player.hidden) startLive(front()); };
  const cancelAnim = () => { if (anim) { cancelAnimationFrame(anim); anim = 0; } clearTimeout(snapT); };
  const animateTo = target => {
    cancelAnim();
    unsettle();
    const from = p, dist = target - from;
    if (Math.abs(dist) < 0.001) { p = target; requestRender(); settle(); return; }
    const dur = reduce ? 0 : Math.min(1000, 450 + Math.abs(dist) * 160);
    const t0 = performance.now();
    const tick = now => {
      const t = dur ? Math.min(1, (now - t0) / dur) : 1;
      p = from + dist * (1 - Math.pow(1 - t, 3));
      requestRender();
      if (t < 1) anim = requestAnimationFrame(tick);
      else { anim = 0; p = target; requestRender(); requestAnimationFrame(settle); }
    };
    anim = requestAnimationFrame(tick);
  };
  const go = delta => animateTo(Math.round(p) + delta);
  const goTo = i => { let off = i - p; off -= N * Math.round(off / N); animateTo(Math.round(p + off)); };
  const stepPx = () => Math.max(140, view.w * (touch ? 0.55 : 0.32));

  /* ---------- picking ---------- */
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const pick = (cx, cy) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(monitors.filter(m => m.visible), true)[0];
    return hit ? hit.object.userData.monitor : -1;
  };

  /* ---------- input ---------- */
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.target.closest('.cc-nav')) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, p0: p, moved: false, vx: 0, lx: e.clientX, lt: performance.now() };
  });
  stage.addEventListener('pointermove', e => {
    if (!drag) {
      if (!touch && e.target === canvas) canvas.style.cursor = pick(e.clientX, e.clientY) >= 0 ? 'pointer' : '';
      return;
    }
    if (e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.moved) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
      if (Math.abs(dx) < 6) return;
      drag.moved = true;
      try { stage.setPointerCapture(e.pointerId); } catch (err) { /* released */ }
      cancelAnim();
      unsettle();
      stage.classList.add('is-dragging');
    }
    const now = performance.now();
    const v = (e.clientX - drag.lx) / Math.max(1, now - drag.lt);
    drag.vx = drag.vx * 0.6 + v * 0.4;
    drag.lx = e.clientX; drag.lt = now;
    p = drag.p0 - dx / stepPx();
    requestRender();
  });
  const endDrag = e => {
    if (!drag || e.pointerId !== drag.id) return;
    if (drag.moved) {
      suppressClick = true;
      setTimeout(() => { suppressClick = false; }, 60);
      stage.classList.remove('is-dragging');
      const fling = Math.max(-2, Math.min(2, -drag.vx * 260 / stepPx()));
      animateTo(Math.round(p + fling));
    }
    drag = null;
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('wheel', e => {
    const sideways = Math.abs(e.deltaX) > Math.abs(e.deltaY);
    const dx = sideways ? e.deltaX : (e.shiftKey ? e.deltaY : 0);
    if (!dx) return;
    e.preventDefault();
    cancelAnim();
    unsettle();
    p += dx / (stepPx() * 0.9);
    requestRender();
    snapT = setTimeout(() => animateTo(Math.round(p)), 140);
  }, { passive: false });
  canvas.addEventListener('click', e => {
    if (suppressClick) return;
    const i = pick(e.clientX, e.clientY);
    if (i < 0) return;
    if (i !== front() || anim) { goTo(i); return; }
    const card = document.querySelector('.work[data-id="' + items[i].id + '"]');
    if (!card) return;
    stopLive();
    openPlayer(card);
    site.setLastFocus(items[i].el);
  });
  document.getElementById('cc-prev').addEventListener('click', () => go(-1));
  document.getElementById('cc-next').addEventListener('click', () => go(1));
  cover.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
  });
  site.setOnPlayerClose(() => { if (settled) setTimeout(settle, 60); });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      entries.forEach(en => {
        inView = en.isIntersecting;
        if (!inView) stopLive();
        else if (settled) settle();
      });
    }, { threshold: 0.45 }).observe(stage);
  }
  const setHdr = () => cover.style.setProperty('--hdr', header.offsetHeight + 'px');
  const relayout = () => { setHdr(); frame(); if (live.classList.contains('is-shown') && liveFor !== -1) place(liveFor); };
  if ('ResizeObserver' in window) new ResizeObserver(relayout).observe(stage);
  else window.addEventListener('resize', relayout);

  /* the CSS ring's monitors stay in the page as focusable links (keyboard and screen readers) */
  items.forEach((it, i) => it.el.addEventListener('click', e => {
    e.preventDefault();
    if (i !== front()) { goTo(i); return; }
    const card = document.querySelector('.work[data-id="' + it.id + '"]');
    if (card) { stopLive(); openPlayer(card); site.setLastFocus(it.el); }
  }));
  items.forEach((it, i) => it.el.addEventListener('focus', () => { if (i !== front()) goTo(i); }));

  setHdr();
  frame();
  renderNow();
  cover.classList.add('is-3d');
  cover.classList.remove('is-loading');
  site.cover3dReady = true;
  settle();

  /* ---------- procedural textures ---------- */
  function grainTexture() {
    const s = 256, c = document.createElement('canvas');
    c.width = c.height = s;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(s, s);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 150 + Math.random() * 105;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(3, 3);
    return t;
  }
  function knurlTexture() {
    const c = document.createElement('canvas');
    c.width = 128; c.height = 8;
    const ctx = c.getContext('2d');
    for (let x = 0; x < 128; x += 4) { ctx.fillStyle = '#f2f3f5'; ctx.fillRect(x, 0, 2, 8); ctx.fillStyle = '#9a9ea5'; ctx.fillRect(x + 2, 0, 2, 8); }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    return t;
  }
  function labelTexture(text) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(70,74,80,0.85)';
    ctx.font = '500 34px "IBM Plex Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(text.split('').join(String.fromCharCode(8202)), 4, 34);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }
}

/* thumbnails are fetched through this site (see _redirects) so WebGL may use them */
function proxied(src) {
  if (!src) return src;
  if (src.startsWith('https://i.ytimg.com/vi/')) return '/thumb/yt/' + src.slice('https://i.ytimg.com/vi/'.length);
  if (src.startsWith('https://i.vimeocdn.com/video/')) return '/thumb/vimeo/' + src.slice('https://i.vimeocdn.com/video/'.length);
  return src;
}
