import {
  BufferAttribute,
  BufferGeometry,
  Camera,
  HalfFloatType,
  LinearFilter,
  Mesh,
  NoBlending,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  WebGLRenderer,
  ClampToEdgeWrapping,
} from "three";

/**
 * Post pipeline: bright-pass, two-level separable bloom, then a composite that
 * does tonemapping, speed streaks, chromatic aberration, vignette and grain in
 * a single pass.
 *
 * The bloom chain runs at 1/4 and 1/8 of the (already scaled) render
 * resolution, so the whole thing costs about 1.4 extra full-resolution pixels
 * of bandwidth. All five passes together are cheaper than the scene's own
 * overdraw.
 */

/** A fullscreen triangle. Cheaper than a quad: no diagonal seam, one less vertex. */
function fullscreenTriangle(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  );
  g.setAttribute("uv", new BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  g.boundingSphere = null;
  return g;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

function makeRT(w: number, h: number) {
  const rt = new WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    wrapS: ClampToEdgeWrapping,
    wrapT: ClampToEdgeWrapping,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  });
  rt.texture.generateMipmaps = false;
  return rt;
}

export interface PostState {
  /** 0..1, drives streaks + aberration. */
  speed: number;
  /** Screen shake magnitude in pixels. */
  shake: number;
  /** 0..1 extra bloom, used for the countdown and finish flash. */
  flash: number;
  flashColor: [number, number, number];
  time: number;
  /** 0 disables bloom entirely for the lowest quality tier. */
  bloom: number;
  vignette: number;
  grain: number;
}

export class Post {
  private readonly renderer: WebGLRenderer;
  private readonly quad: Mesh;
  private readonly cam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly scene = new Scene();

  scene0!: WebGLRenderTarget;
  private rtA!: WebGLRenderTarget;
  private rtB!: WebGLRenderTarget;
  private rtC!: WebGLRenderTarget;
  private rtD!: WebGLRenderTarget;

  private readonly bright: ShaderMaterial;
  private readonly blur: ShaderMaterial;
  private readonly composite: ShaderMaterial;

  private width = 1;
  private height = 1;

  constructor(renderer: WebGLRenderer) {
    this.renderer = renderer;
    const geo = fullscreenTriangle();
    this.quad = new Mesh(geo, undefined as never);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);

    this.bright = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      uniforms: {
        tSrc: { value: null },
        // Daylight sits near 1.0 across most of the frame, so the knee has to
        // start above it or the whole scene blooms into mush.
        uThreshold: { value: 1.02 },
        uKnee: { value: 0.35 },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc;
        uniform float uThreshold;
        uniform float uKnee;
        varying vec2 vUv;
        void main(){
          vec3 c = texture2D(tSrc, vUv).rgb;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          // Soft knee so highlights ramp into the bloom instead of popping.
          float s = clamp((l - uThreshold + uKnee) / (2.0 * uKnee), 0.0, 1.0);
          float w = max(l - uThreshold, s * s * uKnee) / max(l, 1e-4);
          gl_FragColor = vec4(c * w, 1.0);
        }
      `,
    });

    this.blur = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      uniforms: {
        tSrc: { value: null },
        uDir: { value: new Vector2(1, 0) },
        uTexel: { value: new Vector2(1, 1) },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tSrc;
        uniform vec2 uDir;
        uniform vec2 uTexel;
        varying vec2 vUv;
        void main(){
          // 9-tap Gaussian folded into 5 bilinear fetches.
          vec2 o1 = uDir * uTexel * 1.3846153846;
          vec2 o2 = uDir * uTexel * 3.2307692308;
          vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270270;
          c += texture2D(tSrc, vUv + o1).rgb * 0.3162162162;
          c += texture2D(tSrc, vUv - o1).rgb * 0.3162162162;
          c += texture2D(tSrc, vUv + o2).rgb * 0.0702702703;
          c += texture2D(tSrc, vUv - o2).rgb * 0.0702702703;
          gl_FragColor = vec4(c, 1.0);
        }
      `,
    });

    this.composite = new ShaderMaterial({
      depthTest: false,
      depthWrite: false,
      blending: NoBlending,
      uniforms: {
        tScene: { value: null },
        tBloom1: { value: null },
        tBloom2: { value: null },
        uBloom: { value: 1 },
        uSpeed: { value: 0 },
        uShake: { value: 0 },
        uFlash: { value: 0 },
        uFlashRGB: { value: [1, 1, 1] },
        uTime: { value: 0 },
        uVignette: { value: 1 },
        uGrain: { value: 1 },
        uResolution: { value: new Vector2(1, 1) },
      },
      vertexShader: VERT,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene;
        uniform sampler2D tBloom1;
        uniform sampler2D tBloom2;
        uniform float uBloom;
        uniform float uSpeed;
        uniform float uShake;
        uniform float uFlash;
        uniform vec3  uFlashRGB;
        uniform float uTime;
        uniform float uVignette;
        uniform float uGrain;
        uniform vec2  uResolution;
        varying vec2 vUv;

        // ACES filmic, Narkowicz's fit. Cheap, and holds saturation in
        // highlights far better than Reinhard.
        vec3 aces(vec3 x){
          const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
          return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
        }

        float hash12(vec2 p){
          vec3 p3 = fract(vec3(p.xyx) * 0.1031);
          p3 += dot(p3, p3.yzx + 33.33);
          return fract((p3.x + p3.y) * p3.z);
        }

        void main(){
          vec2 uv = vUv;
          vec2 centred = uv - 0.5;
          float r = length(centred);

          // Camera shake, in pixels, applied as a uv offset.
          if (uShake > 0.0) {
            float t = uTime * 47.0;
            uv += vec2(sin(t) * 0.6 + sin(t * 2.7), cos(t * 1.3) + sin(t * 3.1) * 0.5)
                  * uShake / uResolution;
          }

          // Radial streaks: sample back toward the centre, weighted so the
          // effect only bites at the edges and only at speed.
          float streak = uSpeed * smoothstep(0.12, 0.75, r);
          vec3 col = vec3(0.0);
          if (streak > 0.003) {
            float w = 0.0;
            for (int i = 0; i < 6; i++) {
              float t = float(i) / 5.0;
              float scale = 1.0 - t * streak * 0.09;
              float wi = 1.0 - t * 0.72;
              col += texture2D(tScene, centred * scale + 0.5).rgb * wi;
              w += wi;
            }
            col /= w;
          } else {
            col = texture2D(tScene, uv).rgb;
          }

          // Chromatic aberration, also scaled by speed and radius.
          float ca = (0.0009 + uSpeed * 0.0042) * r;
          if (ca > 0.0005) {
            col.r = texture2D(tScene, uv + centred * ca).r;
            col.b = texture2D(tScene, uv - centred * ca).b;
          }

          vec3 bloom = texture2D(tBloom1, uv).rgb * 0.55
                     + texture2D(tBloom2, uv).rgb * 0.80;
          col += bloom * uBloom;
          col += uFlashRGB * uFlash;

          col = aces(col * 0.92);

          // Vignette.
          col *= mix(1.0, smoothstep(1.25, 0.34, r), uVignette);

          // Grain, slightly stronger in the shadows where banding would show.
          float g = hash12(gl_FragCoord.xy + fract(uTime) * 913.0) - 0.5;
          col += g * uGrain * 0.014 * (1.0 - 0.7 * dot(col, vec3(0.333)));

          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
  }

  /** Allocate targets. `w`/`h` are the *scaled* render dimensions. */
  setSize(w: number, h: number) {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;

    this.scene0?.dispose();
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtC?.dispose();
    this.rtD?.dispose();

    // The scene target is the only one that needs a depth buffer.
    this.scene0 = new WebGLRenderTarget(w, h, {
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: true,
      stencilBuffer: false,
      generateMipmaps: false,
      samples: 0,
    });

    this.rtA = makeRT(w >> 2, h >> 2);
    this.rtB = makeRT(w >> 2, h >> 2);
    this.rtC = makeRT(w >> 3, h >> 3);
    this.rtD = makeRT(w >> 3, h >> 3);
  }

  private pass(mat: ShaderMaterial, target: WebGLRenderTarget | null) {
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.cam);
  }

  private blurInto(
    src: WebGLRenderTarget,
    tmp: WebGLRenderTarget,
    dst: WebGLRenderTarget,
    w: number,
    h: number,
  ) {
    const u = this.blur.uniforms;
    u.tSrc.value = src.texture;
    (u.uTexel.value as Vector2).set(1 / w, 1 / h);
    (u.uDir.value as Vector2).set(1, 0);
    this.pass(this.blur, tmp);
    u.tSrc.value = tmp.texture;
    (u.uDir.value as Vector2).set(0, 1);
    this.pass(this.blur, dst);
  }

  /** Run bright-pass + bloom + composite. The scene must already be in scene0. */
  render(state: PostState, outWidth: number, outHeight: number) {
    const r = this.renderer;
    const prevAutoClear = r.autoClear;
    r.autoClear = false;

    if (state.bloom > 0) {
      this.bright.uniforms.tSrc.value = this.scene0.texture;
      this.pass(this.bright, this.rtA);
      this.blurInto(this.rtA, this.rtB, this.rtA, this.width >> 2, this.height >> 2);

      // Second, wider level: downsample the first result and blur again.
      this.blur.uniforms.tSrc.value = this.rtA.texture;
      (this.blur.uniforms.uTexel.value as Vector2).set(2 / (this.width >> 2), 0);
      (this.blur.uniforms.uDir.value as Vector2).set(1, 0);
      this.pass(this.blur, this.rtC);
      this.blur.uniforms.tSrc.value = this.rtC.texture;
      (this.blur.uniforms.uTexel.value as Vector2).set(0, 2 / (this.height >> 2));
      (this.blur.uniforms.uDir.value as Vector2).set(0, 1);
      this.pass(this.blur, this.rtD);
    }

    const u = this.composite.uniforms;
    u.tScene.value = this.scene0.texture;
    u.tBloom1.value = this.rtA.texture;
    u.tBloom2.value = this.rtD.texture;
    u.uBloom.value = state.bloom;
    u.uSpeed.value = state.speed;
    u.uShake.value = state.shake;
    u.uFlash.value = state.flash;
    u.uFlashRGB.value = state.flashColor;
    u.uTime.value = state.time;
    u.uVignette.value = state.vignette;
    u.uGrain.value = state.grain;
    (u.uResolution.value as Vector2).set(outWidth, outHeight);

    this.pass(this.composite, null);
    r.autoClear = prevAutoClear;
  }

  /** Bind the scene target and clear it, ready for the world render. */
  beginScene() {
    this.renderer.setRenderTarget(this.scene0);
    this.renderer.clear(true, true, true);
  }

  renderScene(scene: Scene, camera: Camera) {
    this.renderer.render(scene, camera);
  }

  dispose() {
    this.scene0?.dispose();
    this.rtA?.dispose();
    this.rtB?.dispose();
    this.rtC?.dispose();
    this.rtD?.dispose();
    this.bright.dispose();
    this.blur.dispose();
    this.composite.dispose();
    this.quad.geometry.dispose();
  }
}
