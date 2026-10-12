/* Cover in WebGL: nine clear-acrylic desktop monitors on a looping ring over a glossy studio floor.
   Swipe/drag, sideways trackpad scroll, the ‹ › buttons or arrow keys turn it; the monitor that comes to
   the front grows. When the ring rests, the front screen plays its video muted in a player laid flat
   over that screen (video iframes cannot be WebGL textures). Falls back to the CSS ring on any failure. */
import * as THREE from './vendor/three/three.module.min.js';
import { RoundedBoxGeometry } from './vendor/three/RoundedBoxGeometry.js';
import { Reflector } from './vendor/three/Reflector.js';

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
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  const DPR = Math.min(window.devicePixelRatio || 1, touch ? 1.75 : 2);
  renderer.setPixelRatio(DPR);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.12;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(studioEnvironment(), 0.03).texture;
  pmrem.dispose();

  /* the canvas is opaque (clear acrylic needs something to refract), so it takes the page colour */
  const bgColor = new THREE.Color();
  const syncBackground = () => {
    bgColor.setStyle(getComputedStyle(document.body).backgroundColor);
    scene.background = bgColor;
    renderer.setClearColor(bgColor, 1);   // the transmission pass clears to this, so acrylic shows the page behind it
    floor.material.uniforms.uBg.value.copy(bgColor);
    requestRender();
  };

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 100);

  /* soft high-key light from the upper left */
  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(-4, 7, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(5, 3, 4);
  scene.add(fill);

  /* glossy studio floor, opaque so the acrylic sees it: the page colour, soft contact shadows worked out
     per monitor in the shader, and (on desktop) a mirror reflection that fades away from each stand */
  const monUniform = Array.from({ length: N }, () => new THREE.Vector4(0, 0, 0, 1));
  const floorShader = withReflection => ({
    name: 'StudioFloor',
    uniforms: {
      color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
      uBg: { value: new THREE.Color() }, uMon: { value: monUniform }, uRefl: { value: 0.24 }, uShade: { value: 1 }
    },
    vertexShader: `
      uniform mat4 textureMatrix;
      varying vec4 vUv;
      varying vec3 vWorld;
      void main() {
        ${withReflection ? 'vUv = textureMatrix * vec4(position, 1.0);' : 'vUv = vec4(0.0);'}
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: `
      uniform sampler2D tDiffuse;
      uniform vec3 uBg;
      uniform vec4 uMon[${N}];
      uniform float uRefl;
      uniform float uShade;
      varying vec4 vUv;
      varying vec3 vWorld;
      float rbox(vec2 p, vec2 b, float r) {
        vec2 q = abs(p) - b + r;
        return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
      }
      void main() {
        float shade = 0.0, near = 0.0;
        for (int i = 0; i < ${N}; i++) {
          vec4 m = uMon[i];                       // x, z, facing angle, scale
          vec2 d = vWorld.xz - m.xy;
          float c = cos(m.z), s = sin(m.z);
          vec2 l = vec2(d.x * c - d.y * s, d.x * s + d.y * c) / m.w;
          float plinth = rbox(l, vec2(0.34, 0.15), 0.012);
          float body = rbox(l - vec2(0.05, -0.04), vec2(0.44, 0.13), 0.1);
          float contact = 0.1 * (1.0 - smoothstep(-0.03, 0.025, plinth));
          float spread = 0.09 * exp(-max(body, 0.0) / 0.16);
          shade = max(shade, contact + spread - contact * spread);
          near = max(near, exp(-max(plinth, 0.0) / 0.42));
        }
        vec3 col = uBg;
        ${withReflection ? 'col = mix(col, texture2DProj(tDiffuse, vUv).rgb, uRefl * near);' : ''}
        col *= 1.0 - shade * uShade;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`
  });
  let floor, reflect = null;
  if (touch) {
    /* phones skip the mirror pass */
    const sh = floorShader(false);
    floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShaderMaterial({ ...sh, toneMapped: false }));
  } else {
    floor = new Reflector(new THREE.PlaneGeometry(40, 40), { clipBias: 0.002, multisample: 0, textureWidth: 512, textureHeight: 512, shader: floorShader(true) });
    floor.material.toneMapped = false;
    floor.material.uniforms.uMon.value = monUniform;
    /* the reflection is rendered before the frame, not inside it: a nested render during the transmission
       pass would overwrite the buffer the acrylic samples */
    reflect = floor.onBeforeRender;
    floor.onBeforeRender = () => {};
  }
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  /* ---------- materials ---------- */
  /* clear acrylic: thin refraction on the plates (so the screen lines up with the video overlay),
     more on the plinth; not tone-mapped, so what shows through keeps its true colour */
  const acrylic = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0, transmission: 1, thickness: 0.01, ior: 1.49,
    specularIntensity: 1, envMapIntensity: 1, toneMapped: false,
    attenuationColor: new THREE.Color(0xe4f2ef), attenuationDistance: 0.6
  });
  const acrylicThick = acrylic.clone();
  acrylicThick.thickness = 0.05;
  const chrome = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.06, envMapIntensity: 1 });
  const satin = new THREE.MeshStandardMaterial({ color: 0xe9ebee, metalness: 0.6, roughness: 0.35 });
  const grilleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: grilleTexture(), metalness: 0.5, roughness: 0.45 });
  const sideGrilleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: grilleTexture(true), metalness: 0.5, roughness: 0.45 });
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xf7f7f8, metalness: 0, roughness: 0.45 });
  const boardMat = new THREE.MeshStandardMaterial({ color: 0xf1f2f4, metalness: 0.1, roughness: 0.5 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0d0e10, metalness: 0.2, roughness: 0.38 });
  const panel = new THREE.MeshStandardMaterial({ color: 0x07080a, metalness: 0.3, roughness: 0.25 });
  const slot = new THREE.MeshBasicMaterial({ color: 0x3a3c40 });
  const ledOff = new THREE.MeshStandardMaterial({ color: 0xc4352d, roughness: 0.4 });
  const ledOn = new THREE.MeshBasicMaterial({ color: 0xff2a20, toneMapped: false });

  /* ---------- one monitor (width 1, origin on the floor, screen facing +z) ----------
     two clear acrylic plates sandwich the display and a light rail; a perforated band closes the sides;
     chrome screws pin the corners. It stands on two chrome posts over a screwed acrylic plinth. */
  const PT = 0.024, D = 0.074, CORE = D - 2 * PT;     // plate thickness, total depth, gap between plates
  const M = 0.03, SW = 1 - 2 * M, SH = SW * 9 / 16, RAIL = 0.1;
  const PLATE_H = M + SH + RAIL;
  const PLINTH_H = 0.032, POST_H = 0.15, COLLAR_H = 0.02;
  const BOX_Y0 = PLINTH_H + POST_H;                   // underside of the plates
  const BOX_Y1 = BOX_Y0 + PLATE_H;
  const SCREEN_Y = BOX_Y1 - M - SH / 2;
  const SCREEN_Z = CORE / 2 - 0.002;

  const rbox = (w, h, d, r, seg = 4) => new RoundedBoxGeometry(w, h, d, seg, r);
  const geo = {
    plate: rbox(1, PLATE_H, PT, 0.012),
    bandSide: new THREE.BoxGeometry(CORE, PLATE_H - 0.016, 0.006),
    bandTop: new THREE.BoxGeometry(1 - 0.016, CORE, 0.006),
    panel: rbox(SW + 0.012, SH + 0.012, 0.012, 0.003, 2),
    screen: new THREE.PlaneGeometry(SW, SH),
    board: new THREE.PlaneGeometry(SW, RAIL - 0.026),
    ctrlPlate: rbox(0.13, 0.052, 0.006, 0.006, 2),
    knob: new THREE.CylinderGeometry(0.0135, 0.0135, 0.005, 32),
    knobRing: new THREE.TorusGeometry(0.0072, 0.0018, 10, 28),
    tgl: new THREE.CylinderGeometry(0.0028, 0.0034, 0.016, 16),
    tglBase: new THREE.CylinderGeometry(0.0065, 0.0065, 0.002, 24),
    led: new THREE.SphereGeometry(0.0062, 20, 12).scale(1, 1, 0.5),
    grille: new THREE.PlaneGeometry(0.42, 0.034),
    label: new THREE.PlaneGeometry(0.11, 0.028),
    screwHead: new THREE.SphereGeometry(0.0105, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.42, 1),   // domed
    screwSlot: new THREE.BoxGeometry(0.014, 0.0012, 0.0025),
    post: new THREE.CylinderGeometry(0.021, 0.021, POST_H, 40),
    collar: new THREE.CylinderGeometry(0.032, 0.032, COLLAR_H, 40),
    plinth: rbox(0.68, PLINTH_H, 0.3, 0.012),
    sideGrille: new THREE.PlaneGeometry(CORE - 0.004, PLATE_H * 0.55)
  };

  const add = (parent, geometry, material, x, y, z) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  /* a chrome screw head facing +z (front) or +y (up) */
  const screw = (parent, x, y, z, up = false) => {
    const s = new THREE.Group();
    const head = add(s, geo.screwHead, chrome, 0, 0, 0);
    const sl = add(s, geo.screwSlot, slot, 0, 0, 0);
    if (up) { sl.position.y = 0.0038; sl.rotation.y = 0.6; }
    else { head.rotation.x = Math.PI / 2; sl.position.z = 0.0038; sl.rotation.z = 0.6; }
    s.position.set(x, y, z);
    parent.add(s);
  };

  const buildMonitor = (item, index) => {
    const g = new THREE.Group();
    const yMid = BOX_Y0 + PLATE_H / 2;
    const zF = CORE / 2 + PT / 2, zB = -zF;

    /* the acrylic sandwich */
    add(g, geo.plate, acrylic, 0, yMid, zF);
    add(g, geo.plate, acrylic, 0, yMid, zB);
    /* perforated band between the plates: grilles on the sides, plain satin top and bottom */
    [-1, 1].forEach(sx => {
      const b = add(g, geo.bandSide, satin, sx * (0.5 - 0.011), yMid, 0);
      b.rotation.y = Math.PI / 2;
      const gr = add(g, geo.sideGrille, sideGrilleMat, sx * (0.5 - 0.0075), yMid + 0.02, 0);
      gr.rotation.y = sx * Math.PI / 2;
    });
    [BOX_Y1 - 0.011, BOX_Y0 + 0.011].forEach(y => {
      const b = add(g, geo.bandTop, satin, 0, y, 0);
      b.rotation.x = Math.PI / 2;
    });

    /* display and rail between the plates */
    add(g, geo.panel, panel, 0, SCREEN_Y, SCREEN_Z - 0.007);
    const screenMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const scr = add(g, geo.screen, screenMat, 0, SCREEN_Y, SCREEN_Z);
    const yRail = BOX_Y0 + RAIL / 2 - 0.004;
    add(g, geo.board, boardMat, 0, yRail, SCREEN_Z - 0.006);
    add(g, geo.ctrlPlate, plateMat, -0.36, yRail, SCREEN_Z - 0.002);
    [-0.395, -0.36].forEach(x => {
      const k = add(g, geo.knob, black, x, yRail, SCREEN_Z - 0.0015); k.rotation.x = Math.PI / 2;
      add(g, geo.knobRing, plateMat, x, yRail, SCREEN_Z + 0.0012);
    });
    /* everything in here stays within the 2 mm in front of the screen, behind the front plate */
    const led = add(g, geo.led, ledOff, -0.333, yRail + 0.008, SCREEN_Z - 0.0012);
    const tb = add(g, geo.tglBase, chrome, -0.313, yRail - 0.006, SCREEN_Z); tb.rotation.x = Math.PI / 2;
    add(g, geo.tgl, chrome, -0.313, yRail + 0.002, SCREEN_Z - 0.0016);
    add(g, geo.grille, grilleMat, 0.02, yRail, SCREEN_Z - 0.003);
    /* opaque, lit like the board, so it shows through the acrylic (transparent meshes would not) */
    add(g, geo.label, new THREE.MeshStandardMaterial({ map: labelTexture('CH ' + pad(index + 1)), metalness: 0.1, roughness: 0.5 }), 0.4, yRail, SCREEN_Z - 0.003);

    /* chrome screws through the plates at the four corners */
    [[-0.47, BOX_Y1 - 0.03], [0.47, BOX_Y1 - 0.03], [-0.47, BOX_Y0 + 0.03], [0.47, BOX_Y0 + 0.03]].forEach(([x, y]) => {
      screw(g, x, y, zF + PT / 2);
    });

    /* stand: chrome posts with collars top and bottom, on a screwed acrylic plinth */
    [-0.17, 0.17].forEach(x => {
      add(g, geo.post, chrome, x, PLINTH_H + POST_H / 2, 0);
      add(g, geo.collar, chrome, x, BOX_Y0 - COLLAR_H / 2, 0);
      add(g, geo.collar, chrome, x, PLINTH_H + COLLAR_H / 2, 0);
    });
    add(g, geo.plinth, acrylicThick, 0, PLINTH_H / 2, 0);
    [[-0.3, 0.115], [0.3, 0.115], [-0.3, -0.115], [0.3, -0.115]].forEach(([x, z]) => screw(g, x, PLINTH_H, z, true));

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
    if (reflect) floor.getRenderTarget().setSize(Math.round(w * DPR * 0.35), Math.round(h * DPR * 0.35));   // low-res reads as a soft reflection
    camera.aspect = w / h;
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const tanH = tanV * camera.aspect;
    const frontW = FRONT_SCALE * 1.0, frontH = FRONT_SCALE * BOX_Y1;
    const yEye = SCREEN_Y * FRONT_SCALE;
    const portrait = w / h < 0.8;
    const SHIFT = portrait ? 0.12 : 0.28;      // front screen centre: 44% (phones) or 36% from the top
    const share = w < 700 ? 0.74 : Math.min(0.46, 720 / w);   // phones: neighbours peek in at the edges
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
      const a = (i - p) * STEP;
      monUniform[i].set(Math.sin(a) * R, Math.cos(a) * R, a, m.visible ? s : 0.0001);
    });
    const k = front();
    if (k !== shownK) {
      shownK = k;
      ccCount.textContent = 'CH ' + pad(k + 1) + ' / ' + pad(N);
      ccTitle.textContent = items[k].title;
    }
    if (liveFor !== -1 && liveFor !== k) stopLive();
  };
  const renderNow = () => {
    rafR = 0;
    layout();
    if (reflect) {
      /* the reflection skips the acrylic (an extra transmission pass for a faint, blurred image) */
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      acrylic.visible = acrylicThick.visible = false;
      reflect(renderer, scene, camera);
      acrylic.visible = acrylicThick.visible = true;
    }
    renderer.render(scene, camera);
  };
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

  syncBackground();
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => setTimeout(syncBackground, 50));
  setHdr();
  frame();
  renderNow();
  cover.classList.add('is-3d');
  cover.classList.remove('is-loading');
  site.cover3dReady = true;
  settle();

  /* ---------- lighting environment: a white studio with softboxes and two dark flags ----------
     the flags give chrome its dark streaks; everything else reflects as bright white */
  function studioEnvironment() {
    const env = new THREE.Scene();
    const basic = (v, side = THREE.DoubleSide) => new THREE.MeshBasicMaterial({ color: new THREE.Color(v, v, v), side });
    const room = new THREE.Mesh(new THREE.BoxGeometry(24, 12, 24), basic(0.85, THREE.BackSide));
    room.position.y = 4;
    env.add(room);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(24, 24), basic(0.5));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.9;
    env.add(floor);
    const panel = (w, h, v, x, y, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), basic(v));
      m.position.set(x, y, z);
      m.lookAt(0, y, 0);
      env.add(m);
    };
    const softbox = new THREE.Mesh(new THREE.PlaneGeometry(8, 5), basic(8));   // overhead key
    softbox.position.set(-3, 9.5, 2);
    softbox.rotation.x = Math.PI / 2;
    env.add(softbox);
    panel(3, 8, 4, 9, 2, 3);          // strip lights left and right
    panel(3, 8, 4, -9, 2, -2);
    panel(5, 3, 2, 0, 3, 10);         // front fill behind the camera
    panel(3.5, 9, 0.03, -5.5, 2.4, 8.5);   // negative fill flags, floor to ceiling
    panel(3.5, 9, 0.03, 7, 2.4, 7.5);
    panel(3, 9, 0.05, 10, 2.4, -6);
    panel(3, 9, 0.05, -10, 2.4, 5);
    return env;
  }

  /* ---------- procedural textures ---------- */
  function grilleTexture(vertical) {
    const c = document.createElement('canvas');
    const w = vertical ? 64 : 512, h = vertical ? 512 : 48;
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#d9dbdf';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#5d6168';
    const step = 6;
    for (let y = step / 2; y < h; y += step) {
      for (let x = (y / step) % 2 ? step : step / 2; x < w; x += step) {
        ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2); ctx.fill();
      }
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
  function labelTexture(text) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#f1f2f4';   // the rail board's colour
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#4a4e55';
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
