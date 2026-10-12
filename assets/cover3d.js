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
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(studioEnvironment(), 0.025).texture;
  pmrem.dispose();

  /* the studio takes its colours from the page background, so the cover runs into the page seamlessly */
  const bgColor = new THREE.Color();
  const studio = { uBg: { value: new THREE.Color() } };
  const syncBackground = () => {
    bgColor.setStyle(getComputedStyle(document.body).backgroundColor);
    scene.background = bgColor;
    renderer.setClearColor(bgColor, 1);
    studio.uBg.value.copy(bgColor);
    requestRender();
  };

  const camera = new THREE.PerspectiveCamera(26, 1, 0.1, 120);

  /* soft high-key light from the upper left */
  const key = new THREE.DirectionalLight(0xffffff, 1.8);
  key.position.set(-4, 7, 6);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.6);
  fill.position.set(5, 3, 4);
  scene.add(fill);

  /* a curved studio wall: a little darker where it meets the floor, a soft glow behind the monitors,
     back to the page colour at the top so it meets the header. Opaque, so the acrylic shows it. */
  const cyc = new THREE.Mesh(
    new THREE.CylinderGeometry(30, 30, 20, 96, 1, true),
    new THREE.ShaderMaterial({
      side: THREE.BackSide, toneMapped: false,
      uniforms: studio,
      vertexShader: `
        varying vec3 vWorld;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          gl_Position = projectionMatrix * viewMatrix * w;
        }`,
      fragmentShader: `
        uniform vec3 uBg;
        varying vec3 vWorld;
        void main() {
          float y = vWorld.y;
          float ang = atan(vWorld.x, -vWorld.z);
          float h = (y - 3.4) / 3.0;
          float glow = exp(-ang * ang / 0.6) * exp(-h * h) * smoothstep(0.0, 1.5, y);
          float k = mix(0.955, 1.0, smoothstep(0.0, 4.5, y)) + 0.055 * glow;
          gl_FragColor = vec4(uBg * k, 1.0);
          #include <colorspace_fragment>
        }`
    })
  );
  cyc.position.y = 10;
  scene.add(cyc);

  /* glossy studio floor, opaque so the acrylic sees it: the page colour near the viewer, darkening toward
     the wall; soft contact shadows worked out per monitor in the shader; and (on desktop) a blurred mirror
     reflection that fades away from each stand */
  const monUniform = Array.from({ length: N }, () => new THREE.Vector4(0, 0, 0, 1));
  const floorShader = withReflection => ({
    name: 'StudioFloor',
    uniforms: {
      color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null },
      uBg: studio.uBg, uMon: { value: monUniform }, uRefl: { value: 0.3 },
      uCam: { value: new THREE.Vector2() }, uFade: { value: new THREE.Vector2(6, 20) }
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
      uniform vec2 uCam;
      uniform vec2 uFade;
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
          float plinth = rbox(l, vec2(0.35, 0.17), 0.006);
          float body = rbox(l - vec2(0.05, -0.04), vec2(0.45, 0.14), 0.1);
          float contact = 0.1 * (1.0 - smoothstep(-0.03, 0.025, plinth));
          float spread = 0.1 * exp(-max(body, 0.0) / 0.17);
          shade = max(shade, contact + spread - contact * spread);
          near = max(near, exp(-max(plinth, 0.0) / 0.55));
        }
        vec3 col = uBg * (1.0 - 0.045 * smoothstep(uFade.x, uFade.y, distance(vWorld.xz, uCam)));
        ${withReflection ? `
        vec2 uv = vUv.xy / vUv.w;
        float o = mix(0.0025, 0.011, 1.0 - near);   // sharper close to the stand, softer further out
        vec3 r = texture2D(tDiffuse, uv).rgb * 0.24;
        r += (texture2D(tDiffuse, uv + vec2(o, 0.0)).rgb + texture2D(tDiffuse, uv - vec2(o, 0.0)).rgb
            + texture2D(tDiffuse, uv + vec2(0.0, o)).rgb + texture2D(tDiffuse, uv - vec2(0.0, o)).rgb) * 0.12;
        r += (texture2D(tDiffuse, uv + vec2(o, o)).rgb + texture2D(tDiffuse, uv - vec2(o, o)).rgb
            + texture2D(tDiffuse, uv + vec2(o, -o)).rgb + texture2D(tDiffuse, uv - vec2(o, -o)).rgb) * 0.07;
        col = mix(col, r, uRefl * near);` : ''}
        col *= 1.0 - shade;
        gl_FragColor = vec4(col, 1.0);
        #include <colorspace_fragment>
      }`
  });
  let floor, reflect = null;
  if (touch) {
    /* phones skip the mirror pass */
    floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShaderMaterial({ ...floorShader(false), toneMapped: false }));
  } else {
    floor = new Reflector(new THREE.PlaneGeometry(80, 80), { clipBias: 0.002, multisample: 0, textureWidth: 512, textureHeight: 512, shader: floorShader(true) });
    floor.material.toneMapped = false;
    floor.material.uniforms.uMon.value = monUniform;
    floor.material.uniforms.uBg = studio.uBg;
    /* the reflection is rendered before the frame, not inside it: a nested render during the transmission
       pass would overwrite the buffer the acrylic samples */
    reflect = floor.onBeforeRender;
    floor.onBeforeRender = () => {};
  }
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const floorU = floor.material.uniforms;

  /* ---------- materials ---------- */
  /* clear acrylic: thin refraction on the plates (so the screen lines up with the video overlay),
     more on the plinth; not tone-mapped, so what shows through keeps its true colour */
  const acrylic = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, metalness: 0, roughness: 0, transmission: 1, thickness: 0.012, ior: 1.49,
    specularIntensity: 1, envMapIntensity: 1.1, toneMapped: false,
    attenuationColor: new THREE.Color(0xd9efe9), attenuationDistance: 0.5
  });
  const acrylicThick = acrylic.clone();
  acrylicThick.thickness = 0.06;
  acrylicThick.envMapIntensity = 0.55;   // seen at a grazing angle; less sky in it reads clearer
  /* cut edges: a green-grey tint and strong refraction, which is what makes thick acrylic read as acrylic */
  const acrylicEdge = acrylic.clone();
  acrylicEdge.color = new THREE.Color(0xe3f2ee);
  acrylicEdge.emissive = new THREE.Color(0x1d2a26);   // light carried along inside the sheet brightens its edge
  acrylicEdge.thickness = 0.12;
  acrylicEdge.roughness = 0.04;
  acrylicEdge.envMapIntensity = 1.25;
  const plateMats = [acrylicEdge, acrylicEdge, acrylicEdge, acrylicEdge, acrylic, acrylic];   // BoxGeometry face order: ±x, ±y, ±z
  const plinthMats = [acrylicEdge, acrylicEdge, acrylicThick, acrylicThick, acrylicEdge, acrylicEdge];
  const CHASSIS = '#eef0f2';
  const chrome = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0.05 });
  const chassisMat = new THREE.MeshStandardMaterial({ color: CHASSIS, metalness: 0.2, roughness: 0.42 });
  const grilleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: grilleTexture(), metalness: 0.35, roughness: 0.5 });
  const sideGrilleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: grilleTexture(true), metalness: 0.35, roughness: 0.5 });
  const plateMat = new THREE.MeshStandardMaterial({ color: 0xfbfbfc, metalness: 0, roughness: 0.38 });
  const white = new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0, roughness: 0.4 });
  const black = new THREE.MeshStandardMaterial({ color: 0x0b0c0e, metalness: 0.2, roughness: 0.35 });
  const bezel = new THREE.MeshStandardMaterial({ color: 0x07080a, metalness: 0.3, roughness: 0.25 });
  const screwRing = new THREE.MeshStandardMaterial({ color: 0x45484e, metalness: 0.5, roughness: 0.4 });
  const toggleMat = new THREE.MeshStandardMaterial({ color: 0xc9ccd1, metalness: 0.8, roughness: 0.25 });
  const slot = new THREE.MeshBasicMaterial({ color: 0x34363b });
  const ledOff = new THREE.MeshStandardMaterial({ color: 0xc4352d, roughness: 0.4 });
  const ledOn = new THREE.MeshBasicMaterial({ color: 0xff2a20, toneMapped: false });

  /* ---------- one monitor (width 1, origin on the floor, screen facing +z) ----------
     two thick clear acrylic plates sandwich a white chassis carrying the display and its control rail,
     with a clear margin all round; chrome spacers and screws hold the corners; perforated bands close the
     sides. It stands on two chrome posts over a screwed acrylic plinth. */
  const PT = 0.028, CORE = 0.03;                       // plate thickness, gap between the plates
  const CM = 0.032, BORDER = 0.012;                    // clear margin, chassis border round the screen
  const SW = 1 - 2 * (CM + BORDER), SH = SW * 9 / 16, RAIL = 0.09;
  const CW = 1 - 2 * CM, CHH = BORDER + SH + RAIL;     // chassis
  const PLATE_H = 2 * CM + CHH;
  const PLINTH_H = 0.04, POST_H = 0.16, COLLAR_H = 0.022;
  const BOX_Y0 = PLINTH_H + POST_H;                   // underside of the plates
  const BOX_Y1 = BOX_Y0 + PLATE_H;
  const SCREEN_Y = BOX_Y1 - CM - BORDER - SH / 2;
  const SCREEN_Z = CORE / 2 - 0.002;                  // 2 mm behind the inner face of the front plate
  const CH_Z = SCREEN_Z - 0.0035;                     // chassis front face

  const rbox = (w, h, d, r, seg = 3) => new RoundedBoxGeometry(w, h, d, seg, r);
  const geo = {
    plate: new THREE.BoxGeometry(1, PLATE_H, PT),
    chassis: rbox(CW, CHH, 0.012, 0.004, 2),
    bandSide: new THREE.BoxGeometry(CORE, PLATE_H - 0.05, 0.004),
    sideGrille: new THREE.PlaneGeometry(CORE - 0.006, PLATE_H * 0.6),
    bezel: rbox(SW + 0.008, SH + 0.008, 0.003, 0.0015, 2),
    screen: new THREE.PlaneGeometry(SW, SH),
    ctrlPlate: rbox(0.13, 0.05, 0.004, 0.007, 2),
    knob: new THREE.CylinderGeometry(0.0118, 0.0118, 0.004, 32),
    knobRing: new THREE.RingGeometry(0.0046, 0.0064, 32),
    led: new THREE.SphereGeometry(0.0052, 20, 12).scale(1, 1, 0.5),
    tglBase: new THREE.CylinderGeometry(0.0055, 0.0055, 0.0015, 24),
    tgl: new THREE.CylinderGeometry(0.0022, 0.0028, 0.015, 16),
    grille: new THREE.PlaneGeometry(0.44, 0.03),
    label: new THREE.PlaneGeometry(0.11, 0.028),
    screwRing: new THREE.CircleGeometry(0.0128, 32),
    screwHead: new THREE.SphereGeometry(0.0112, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(1, 0.42, 1),   // domed
    screwSlot: new THREE.BoxGeometry(0.0145, 0.0013, 0.0025),
    spacer: new THREE.CylinderGeometry(0.0068, 0.0068, CORE, 20),
    post: new THREE.CylinderGeometry(0.025, 0.025, POST_H, 40),
    collarTop: new THREE.CylinderGeometry(0.031, 0.029, COLLAR_H, 40),
    collarBottom: new THREE.CylinderGeometry(0.029, 0.034, COLLAR_H, 40),
    plinth: new THREE.BoxGeometry(0.7, PLINTH_H, 0.34)
  };

  const add = (parent, geometry, material, x, y, z) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    parent.add(m);
    return m;
  };
  /* a chrome dome-head screw with a dark seat, on a surface facing +z (front), -z (back) or +y (up) */
  const screw = (parent, x, y, z, face) => {
    const s = new THREE.Group();
    const seat = add(s, geo.screwRing, screwRing, 0, 0, 0.0002);
    const head = add(s, geo.screwHead, chrome, 0, 0, 0.0004);
    head.rotation.x = Math.PI / 2;
    const sl = add(s, geo.screwSlot, slot, 0, 0, 0.0043);
    sl.rotation.z = 0.6;
    if (face === 'up') s.rotation.x = -Math.PI / 2;
    else if (face === 'back') s.rotation.y = Math.PI;
    s.position.set(x, y, z);
    parent.add(s);
    return seat;
  };

  const buildMonitor = (item, index) => {
    const g = new THREE.Group();
    const yMid = BOX_Y0 + PLATE_H / 2;
    const zF = CORE / 2 + PT / 2;

    /* the acrylic sandwich, its corner spacers and screws, and the perforated side bands */
    add(g, geo.plate, plateMats, 0, yMid, zF);
    add(g, geo.plate, plateMats, 0, yMid, -zF);
    const sx = 0.5 - 0.019, sy0 = BOX_Y0 + 0.019, sy1 = BOX_Y1 - 0.019;
    [[-sx, sy1], [sx, sy1], [-sx, sy0], [sx, sy0]].forEach(([x, y]) => {
      add(g, geo.spacer, chrome, x, y, 0).rotation.x = Math.PI / 2;
      screw(g, x, y, zF + PT / 2, 'front');
      screw(g, x, y, -zF - PT / 2, 'back');
    });
    [-1, 1].forEach(s => {
      add(g, geo.bandSide, chassisMat, s * (0.5 - 0.007), yMid, 0).rotation.y = Math.PI / 2;
      add(g, geo.sideGrille, sideGrilleMat, s * (0.5 - 0.0048), yMid, 0).rotation.y = s * Math.PI / 2;
    });

    /* chassis with the display */
    add(g, geo.chassis, chassisMat, 0, BOX_Y0 + CM + CHH / 2, CH_Z - 0.006);
    add(g, geo.bezel, bezel, 0, SCREEN_Y, SCREEN_Z - 0.0018);
    const screenMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
    const scr = add(g, geo.screen, screenMat, 0, SCREEN_Y, SCREEN_Z);

    /* control rail; everything stays within the 2 mm in front of the screen plane */
    const yRail = BOX_Y0 + CM + RAIL / 2 - 0.002;
    add(g, geo.ctrlPlate, plateMat, -0.375, yRail, CH_Z + 0.002);
    [-0.413, -0.385].forEach(x => {
      add(g, geo.knob, black, x, yRail, SCREEN_Z - 0.0002).rotation.x = Math.PI / 2;
      add(g, geo.knobRing, white, x, yRail, SCREEN_Z + 0.0019);
    });
    const led = add(g, geo.led, ledOff, -0.36, yRail, SCREEN_Z - 0.0008);
    add(g, geo.tglBase, toggleMat, -0.34, yRail - 0.007, SCREEN_Z + 0.0002).rotation.x = Math.PI / 2;
    add(g, geo.tgl, toggleMat, -0.34, yRail + 0.0005, SCREEN_Z - 0.0011);
    add(g, geo.grille, grilleMat, 0.02, yRail, CH_Z + 0.0002);
    /* opaque and lit like the chassis, so it shows through the acrylic (transparent meshes would not) */
    add(g, geo.label, new THREE.MeshStandardMaterial({ map: labelTexture('CH ' + pad(index + 1)), metalness: 0.2, roughness: 0.42 }), 0.398, yRail, CH_Z + 0.0002);

    /* stand: chrome posts with collars top and bottom, on a screwed acrylic plinth */
    [-0.16, 0.16].forEach(x => {
      add(g, geo.post, chrome, x, PLINTH_H + POST_H / 2, 0);
      add(g, geo.collarTop, chrome, x, BOX_Y0 - COLLAR_H / 2, 0);
      add(g, geo.collarBottom, chrome, x, PLINTH_H + COLLAR_H / 2, 0);
    });
    add(g, geo.plinth, plinthMats, 0, PLINTH_H / 2, 0);
    [[-0.315, 0.135], [0.315, 0.135], [-0.315, -0.135], [0.315, -0.135]].forEach(([x, z]) => screw(g, x, PLINTH_H, z, 'up'));

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
    if (reflect) floor.getRenderTarget().setSize(Math.round(w * DPR * 0.4), Math.round(h * DPR * 0.4));
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
    floorU.uCam.value.set(0, R + d);
    floorU.uFade.value.set(d * 0.85, d * 0.85 + 30);   // floor is the page colour up to the front stand, then darkens toward the wall
    camera.lookAt(0, yEye, R);
    camera.updateProjectionMatrix();
    /* lens shift (not a tilt) so the front screen stays a true rectangle for the video overlay */
    camera.projectionMatrix.elements[9] = -SHIFT;
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    requestRender();
  };

  /* ---------- state and rendering ---------- */
  let p = 0, shownK = -1, settled = false, inView = true;

  /* opening: the ring starts tiny and spins out to full size; any input skips it */
  const INTRO_MS = 3200, INTRO_K0 = 0.05, INTRO_TURNS = 1.25;
  const intro = { on: !reduce, frame: 0, t0: 0, k: reduce ? 1 : INTRO_K0, spin: reduce ? 0 : -INTRO_TURNS * Math.PI * 2 };
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  function stepIntro(now) {
    intro.frame++;
    if (intro.frame < 3) { requestRender(); return; }   // let shaders compile and textures upload first
    if (!intro.t0) intro.t0 = now;
    const t = Math.min(1, (now - intro.t0) / INTRO_MS);
    intro.k = INTRO_K0 + (1 - INTRO_K0) * easeInOut(t);
    intro.spin = -INTRO_TURNS * Math.PI * 2 * (1 - easeOut(t));
    if (t > 0.78) cover.classList.remove('is-intro');
    if (t < 1) requestRender();
    else endIntro();
  }
  function endIntro() {
    if (!intro.on) return;
    intro.on = false;
    intro.k = 1;
    intro.spin = 0;
    cover.classList.remove('is-intro');
    requestRender();
    requestAnimationFrame(() => { if (!anim && !drag) settle(); });
  }
  let anim = 0, snapT = 0, drag = null, suppressClick = false, rafR = 0;
  let liveFor = -1, livePlaying = false, liveKill = null, ytApi = null, vimeoApi = null;
  const front = () => mod(Math.round(p), N);

  const layout = () => {
    const k = intro.k;
    const pe = p - intro.spin / STEP;   // ring position including the opening spin
    ring.scale.setScalar(k);
    ring.rotation.y = -pe * STEP;
    monitors.forEach((m, i) => {
      let off = i - pe;
      off -= N * Math.round(off / N);
      const d = Math.abs(off);
      m.visible = intro.on || d <= 2.6;
      const t = Math.max(0, 1 - d);
      const s = 1 + (FRONT_SCALE - 1) * t * t * (3 - 2 * t);
      m.scale.setScalar(s);
      const a = (i - pe) * STEP;
      monUniform[i].set(Math.sin(a) * R * k, Math.cos(a) * R * k, a, m.visible ? s * k : 0.0001);
    });
    const f = front();
    if (f !== shownK) {
      shownK = f;
      ccCount.textContent = 'CH ' + pad(f + 1) + ' / ' + pad(N);
      ccTitle.textContent = items[f].title;
    }
    if (liveFor !== -1 && liveFor !== f) stopLive();
  };
  const renderNow = () => {
    rafR = 0;
    if (intro.on) stepIntro(performance.now());
    layout();
    if (reflect) {
      /* the reflection skips the acrylic (an extra transmission pass for a faint, blurred image) */
      scene.updateMatrixWorld();
      camera.updateMatrixWorld();
      acrylic.visible = acrylicThick.visible = acrylicEdge.visible = false;
      reflect(renderer, scene, camera);
      acrylic.visible = acrylicThick.visible = acrylicEdge.visible = true;
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
  const skipIntro = () => {
    if (!intro.on) return false;
    endIntro();
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 400);
    return true;
  };
  stage.addEventListener('pointerdown', e => {
    skipIntro();
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
    skipIntro();
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
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') skipIntro();
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
  if (intro.on) cover.classList.add('is-intro');
  renderNow();
  cover.classList.add('is-3d');
  cover.classList.remove('is-loading');
  site.cover3dReady = true;
  if (!intro.on) settle();
  else setHint();

  /* ---------- lighting environment: a white studio with softboxes and two dark flags ----------
     the flags give chrome its dark streaks; everything else reflects as bright white */
  function studioEnvironment() {
    const env = new THREE.Scene();
    const basic = (v, side = THREE.DoubleSide) => new THREE.MeshBasicMaterial({ color: new THREE.Color(v, v, v), side });
    const room = new THREE.Mesh(new THREE.BoxGeometry(30, 14, 30), basic(0.95, THREE.BackSide));
    room.position.y = 5;
    env.add(room);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), basic(0.62));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.9;
    env.add(floor);
    const panel = (w, h, v, x, y, z) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), basic(v));
      m.position.set(x, y, z);
      m.lookAt(0, y, 0);
      env.add(m);
    };
    const softbox = new THREE.Mesh(new THREE.PlaneGeometry(9, 6), basic(10));   // overhead key
    softbox.position.set(-2, 11.5, 1);
    softbox.rotation.x = Math.PI / 2;
    env.add(softbox);
    panel(3, 6, 5, -10, 7, -7);       // strip lights high on the back corners
    panel(3, 6, 5, 10, 7, -6);
    panel(7, 6, 0.06, -14, 1.5, 0);   // black flags at the sides, which the angled monitors' plates mirror,
    panel(7, 6, 0.06, 14, 1.5, 1);    // so their screens stay vivid
    panel(12, 4, 3, 0, 4, -13);       // rim light behind the monitors: bright acrylic top edges
    panel(9, 5, 0.12, 0, 1.5, 13);    // dark card behind the camera keeps the front plates clear
    panel(3, 11, 0.04, -8.5, 2, 9);   // negative fill flags give chrome and acrylic edges their dark lines
    panel(3, 11, 0.04, 8.5, 2, 8);
    panel(2.5, 11, 0.07, -13, 2, -6);
    panel(2.5, 11, 0.07, 13, 2, -7);
    return env;
  }

  /* ---------- procedural textures ---------- */
  function grilleTexture(vertical) {
    const c = document.createElement('canvas');
    const w = vertical ? 64 : 512, h = vertical ? 512 : 48;
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#dcdfe3';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#80858d';
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
    ctx.fillStyle = CHASSIS;   // same colour and lighting as the chassis, so only the text shows
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#7d828a';
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
