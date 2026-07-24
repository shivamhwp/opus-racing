import {
  AdditiveBlending,
  BackSide,
  Color,
  DoubleSide,
  MultiplyBlending,
  ShaderMaterial,
  Vector2,
  Vector3,
} from "three";
import type { TrackDef } from "./track";

/**
 * Every surface in the game is a hand-written shader. There is not a single
 * texture, image decode or environment map in the build.
 *
 * The trick that makes it look expensive: `skyBase()` below is an *analytic*
 * function of a direction vector. The skydome evaluates it for the background,
 * and the car shader evaluates it again along the reflection vector to get its
 * environment reflections. One function, no cubemap, no PMREM prefilter, no
 * render-to-texture — and reflections that are automatically consistent with
 * whatever sky the circuit is set in.
 */

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

const NOISE_GLSL = /* glsl */ `
float hash21(vec2 p){
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float hash31(vec3 p){
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm(vec2 p){
  return vnoise(p) * 0.6 + vnoise(p * 2.13) * 0.27 + vnoise(p * 4.7) * 0.13;
}
`;

/** The one function that defines what this world looks like. */
const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;

vec3 skyBase(vec3 d){
  float h = d.y;
  float t = pow(clamp(h * 0.5 + 0.5, 0.0, 1.0), 0.7);
  vec3 col = mix(uSkyHorizon, uSkyTop, smoothstep(0.0, 1.0, t));

  // Haze piled up along the horizon.
  col += uSkyHorizon * exp(-abs(h) * 4.5) * 1.05;

  // Below the horizon it is ground bounce, not sky.
  col = mix(col, uSkyHorizon * 0.22, smoothstep(0.0, -0.22, h));

  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * pow(sd, 7.0) * 0.42;   // broad halo
  col += uSunColor * pow(sd, 1.6) * 0.055;  // sky-wide tint
  return col;
}

// Sharp features only the background needs — kept out of reflections so they
// never alias across a curved car body.
vec3 skyDetail(vec3 d){
  vec3 col = vec3(0.0);
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * smoothstep(0.9975, 0.9995, sd) * 9.0;

  vec2 sph = vec2(atan(d.z, d.x), asin(clamp(d.y, -1.0, 1.0)));
  vec2 g = sph * 74.0;
  vec2 gi = floor(g), gf = fract(g);
  float r = hash21(gi);
  vec2 c = vec2(hash21(gi + 3.1), hash21(gi + 7.7));
  float dist = length(gf - c);
  float star = smoothstep(0.14, 0.0, dist) * smoothstep(0.972, 0.998, r);
  col += vec3(0.85, 0.9, 1.0) * star * smoothstep(-0.02, 0.3, d.y) * 1.5;
  return col;
}
`;

export interface SkyUniforms {
  uSkyTop: { value: Color };
  uSkyHorizon: { value: Color };
  uSunColor: { value: Color };
  uSunDir: { value: Vector3 };
}

export function makeSkyUniforms(def: TrackDef): SkyUniforms {
  return {
    uSkyTop: { value: new Color(def.skyTop) },
    uSkyHorizon: { value: new Color(def.skyHorizon) },
    uSunColor: { value: new Color(def.sunColor) },
    uSunDir: { value: new Vector3(-0.34, 0.1, -0.93).normalize() },
  };
}

// ---------------------------------------------------------------------------
// Sky dome
// ---------------------------------------------------------------------------

export function makeSkyMaterial(sky: SkyUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: sky as never,
    side: BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main(){
        vDir = position;
        // Strip translation so the dome is pinned to the camera, and force the
        // depth to the far plane so it never occludes anything.
        vec4 p = projectionMatrix * mat4(mat3(modelViewMatrix)) * vec4(position, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      ${SKY_GLSL}
      varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        gl_FragColor = vec4(skyBase(d) + skyDetail(d), 1.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Car
// ---------------------------------------------------------------------------

/**
 * One material for every car on the grid. The livery colour arrives per
 * instance through `instanceColor`, and the `paint` vertex attribute selects
 * which of seven surface treatments each triangle gets — so sixteen visually
 * distinct cars cost exactly one draw call.
 */
export function makeCarMaterial(sky: SkyUniforms): ShaderMaterial {
  const m = new ShaderMaterial({
    uniforms: {
      ...(sky as never as Record<string, { value: unknown }>),
      uTime: { value: 0 },
      uFogColor: { value: new Color(0x120a1c) },
      uFogDensity: { value: 0.0016 },
    },
    vertexShader: /* glsl */ `
      attribute float paint;
      varying float vPaint;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying vec3 vLivery;
      varying float vDepth;

      void main(){
        vPaint = paint;
        #ifdef USE_INSTANCING_COLOR
          vLivery = instanceColor;
        #else
          vLivery = vec3(0.8);
        #endif

        mat4 model = modelMatrix;
        #ifdef USE_INSTANCING
          model = modelMatrix * instanceMatrix;
        #endif

        vec4 world = model * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(model) * normal);

        vec4 mv = viewMatrix * world;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      ${SKY_GLSL}
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform float uTime;

      varying float vPaint;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying vec3 vLivery;
      varying float vDepth;

      void main(){
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vWorld);
        if (dot(N, V) < 0.0) N = -N;       // keep thin wings lit from both faces
        vec3 R = reflect(-V, N);

        int id = int(vPaint + 0.5);

        vec3 base;
        float rough, reflectivity, metal;
        vec3 emissive = vec3(0.0);

        if (id == 1) {                      // livery paint
          base = vLivery;
          rough = 0.20; reflectivity = 0.55; metal = 0.25;
        } else if (id == 2) {               // accent — a lifted, hotter livery
          base = clamp(vLivery * 1.5 + 0.32, 0.0, 4.0);
          rough = 0.28; reflectivity = 0.42; metal = 0.15;
          emissive = base * 0.16;
        } else if (id == 3) {               // titanium halo, rims, roll hoop
          base = vec3(0.62, 0.65, 0.70);
          rough = 0.18; reflectivity = 0.85; metal = 0.95;
        } else if (id == 4) {               // tyre rubber
          float tread = fbm(vWorld.xz * 26.0) * 0.06;
          base = vec3(0.052, 0.055, 0.062) + tread;
          rough = 0.95; reflectivity = 0.04; metal = 0.0;
        } else if (id == 5) {               // brake glow / rain light
          base = vec3(0.25, 0.03, 0.01);
          rough = 0.6; reflectivity = 0.1; metal = 0.0;
          emissive = vec3(1.6, 0.30, 0.06);
        } else if (id == 6) {               // visor + mirror glass
          base = vec3(0.02, 0.025, 0.035);
          rough = 0.04; reflectivity = 1.0; metal = 0.7;
        } else {                            // bare carbon fibre
          // A real 2x2 twill reads as a fine diagonal checker.
          vec2 w = vWorld.xz * 150.0;
          float weave = step(0.5, fract(floor(w.x) * 0.5 + floor(w.y) * 0.5));
          base = mix(vec3(0.030, 0.032, 0.038), vec3(0.062, 0.065, 0.074), weave);
          rough = 0.34; reflectivity = 0.30; metal = 0.35;
        }

        // Key light, plus a cool fill from straight up so the underside is not
        // a black hole, plus a rim in the livery colour to separate the car
        // from the night.
        float ndl = max(dot(N, uSunDir), 0.0);
        float fill = 0.5 + 0.5 * N.y;
        float fres = pow(1.0 - max(dot(N, V), 0.0), 4.0);

        vec3 env = skyBase(R);
        vec3 diffuse = base * (uSunColor * ndl * 1.3 + uSkyHorizon * fill * 1.5
                               + uSkyTop * 0.55 + 0.10);

        // Specular: sun highlight tightened by roughness, over sky reflection.
        float spec = pow(max(dot(R, uSunDir), 0.0), mix(220.0, 8.0, rough));
        vec3 specular = uSunColor * spec * (1.0 - rough) * 2.4;

        vec3 col = mix(diffuse, env * mix(vec3(1.0), base, metal), reflectivity * (0.45 + 0.55 * fres));
        col += specular;
        // Rim light in the driver's own colour — the single cheapest thing that
        // separates sixteen dark cars from a dark circuit.
        col += vLivery * fres * 0.55;
        col += emissive;

        // Exponential-squared fog, matched to the scene fog.
        float f = 1.0 - exp(-pow(vDepth * uFogDensity, 2.0));
        col = mix(col, uFogColor, clamp(f, 0.0, 1.0));

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  return m;
}

// ---------------------------------------------------------------------------
// Road surface
// ---------------------------------------------------------------------------

/**
 * Attributes: `aU` lateral -1..1, `aV` metres along the lap, `aCorner` 0..1.
 * Draws asphalt, white edge lines, rubbered-in racing line, sector markers and
 * the start/finish grid in one pass.
 */
export function makeRoadMaterial(sky: SkyUniforms, def: TrackDef, lapLength: number) {
  return new ShaderMaterial({
    uniforms: {
      ...(sky as never as Record<string, { value: unknown }>),
      uAccent: { value: new Color(def.accent) },
      uAccent2: { value: new Color(def.accent2) },
      uFogColor: { value: new Color(def.fogColor) },
      uFogDensity: { value: def.fogDensity },
      uLapLength: { value: lapLength },
      uMarkerLen: { value: lapLength / Math.round(lapLength / 50) },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aU;
      attribute float aV;
      attribute float aCorner;
      varying float vU;
      varying float vV;
      varying float vCorner;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vDepth;
      void main(){
        vU = aU; vV = aV; vCorner = aCorner;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * world;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      ${SKY_GLSL}
      uniform vec3 uAccent;
      uniform vec3 uAccent2;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform float uLapLength;
      uniform float uMarkerLen;
      varying float vU;
      varying float vV;
      varying float vCorner;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vDepth;

      void main(){
        float au = abs(vU);

        // Asphalt: coarse aggregate plus a finer grain, both in world space so
        // the texture never stretches through corners.
        float grain = fbm(vWorld.xz * 1.7) * 0.5 + fbm(vWorld.xz * 11.0) * 0.5;
        vec3 col = mix(vec3(0.098, 0.102, 0.120), vec3(0.196, 0.201, 0.228), grain);

        // Rubbered-in racing line: two darker bands either side of centre.
        float rubber = smoothstep(0.62, 0.16, au) * (0.35 + 0.4 * vCorner);
        col = mix(col, vec3(0.046, 0.045, 0.052), rubber);

        // Old surface-repair seams.
        float seam = smoothstep(0.86, 0.94, fbm(vWorld.xz * 0.30));
        col = mix(col, col * 1.35, seam * 0.5);

        // White edge lines.
        float line = smoothstep(0.885, 0.90, au) * (1.0 - smoothstep(0.945, 0.960, au));
        col = mix(col, vec3(1.05, 1.07, 1.14), line);

        // 50 m distance markers just inside the line, tinted by sector.
        float sector = floor(vV / (uLapLength / 3.0));
        vec3 sectorCol = sector < 1.0 ? uAccent : (sector < 2.0 ? uAccent2 : vec3(1.0, 0.85, 0.2));
        float tick = step(0.94, fract(vV / uMarkerLen)) * smoothstep(0.80, 0.83, au) * (1.0 - smoothstep(0.875, 0.885, au));
        col = mix(col, sectorCol * 1.4, tick);

        // Start/finish: a checkered band across the full width.
        float sLine = smoothstep(6.0, 4.0, abs(mod(vV + uLapLength * 0.5, uLapLength) - uLapLength * 0.5));
        float checker = step(0.5, fract(vU * 5.0)) == step(0.5, fract(vV * 0.5)) ? 0.06 : 0.82;
        col = mix(col, vec3(checker), sLine);

        // Lighting: asphalt is rough, so it is mostly a diffuse response to the
        // sky plus a wide grazing sheen that hints at damp tarmac.
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vWorld);
        vec3 R = reflect(-V, N);
        float ndl = max(dot(N, uSunDir), 0.0);
        float graze = pow(1.0 - max(dot(N, V), 0.0), 5.0);
        // Ambient comes from the sky itself, so a circuit set at dusk lights
        // its own tarmac differently from one set at midnight.
        vec3 ambient = uSkyHorizon * 2.4 + uSkyTop * 0.9 + 0.115;
        vec3 lit = col * (uSunColor * ndl * 0.7 + ambient);
        lit += skyBase(R) * graze * 0.75;
        // Neon spill from the kerbs and barriers onto the outer racing surface.
        lit += sectorCol * smoothstep(0.45, 1.0, au) * 0.085;
        lit += uAccent2 * smoothstep(0.75, 1.0, au) * 0.05;

        float f = 1.0 - exp(-pow(vDepth * uFogDensity, 2.0));
        lit = mix(lit, uFogColor, clamp(f, 0.0, 1.0));
        gl_FragColor = vec4(lit, 1.0);
      }
    `,
  });
}

/** Run-off apron: the same asphalt idea, flatter and drained of colour. */
export function makeRunoffMaterial(sky: SkyUniforms, def: TrackDef) {
  return new ShaderMaterial({
    uniforms: {
      ...(sky as never as Record<string, { value: unknown }>),
      uAccent: { value: new Color(def.accent) },
      uFogColor: { value: new Color(def.fogColor) },
      uFogDensity: { value: def.fogDensity },
    },
    vertexShader: /* glsl */ `
      attribute float aU;
      varying float vU;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vDepth;
      void main(){
        vU = aU;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * world;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      ${SKY_GLSL}
      uniform vec3 uAccent;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      varying float vU;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vDepth;
      void main(){
        float au = abs(vU);
        float grain = fbm(vWorld.xz * 2.4) * 0.6 + fbm(vWorld.xz * 9.0) * 0.4;

        // Painted run-off: accent-tinted asphalt fading to bare gravel.
        vec3 painted = mix(vec3(0.070, 0.064, 0.080), uAccent * 0.13, 0.45);
        vec3 gravel  = mix(vec3(0.050, 0.053, 0.059), vec3(0.096, 0.093, 0.091), grain);
        vec3 col = mix(painted, gravel, smoothstep(0.25, 0.72, au));

        // Diagonal hatching over the painted zone.
        float hatch = step(0.55, fract((vWorld.x + vWorld.z) * 0.42));
        col = mix(col, col * 1.5, hatch * (1.0 - smoothstep(0.18, 0.5, au)) * 0.5);
        col *= 0.75 + grain * 0.5;

        vec3 N = normalize(vNormalW);
        float ndl = max(dot(N, uSunDir), 0.0);
        vec3 lit = col * (uSunColor * ndl * 0.45 + uSkyHorizon * 1.6 + uSkyTop * 0.6 + 0.075);

        float f = 1.0 - exp(-pow(vDepth * uFogDensity, 2.0));
        lit = mix(lit, uFogColor, clamp(f, 0.0, 1.0));
        gl_FragColor = vec4(lit, 1.0);
      }
    `,
  });
}

/** Kerbs. Unlit and deliberately over-bright so the bloom pass catches them. */
export function makeKerbMaterial(def: TrackDef) {
  return new ShaderMaterial({
    uniforms: {
      uAccent: { value: new Color(def.accent) },
      uFogColor: { value: new Color(def.fogColor) },
      uFogDensity: { value: def.fogDensity },
      uKerbPitch: { value: 3.2 },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aU;
      attribute float aV;
      varying float vU;
      varying float vV;
      varying float vDepth;
      void main(){
        vU = aU; vV = aV;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uAccent;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform float uKerbPitch;
      uniform float uTime;
      varying float vU;
      varying float vV;
      varying float vDepth;
      void main(){
        // Alternating 1.6 m blocks, the standard FIA kerb pitch.
        float blk = step(0.5, fract(vV / uKerbPitch));
        vec3 col = mix(vec3(1.05, 1.06, 1.12), uAccent * 1.35, blk);
        // Darken the inner edge so the kerb reads as raised, not painted on.
        col *= 0.45 + 0.55 * smoothstep(0.0, 0.55, vU);
        // Slow pulse along the lap — subtle, but it makes the circuit feel live.
        col *= 1.0 + 0.10 * sin(vV * 0.06 - uTime * 2.2);

        float f = 1.0 - exp(-pow(vDepth * uFogDensity, 2.0));
        col = mix(col, uFogColor, clamp(f, 0.0, 1.0) * 0.85);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** Continuous barrier wall with a neon capping strip. */
export function makeBarrierMaterial(sky: SkyUniforms, def: TrackDef) {
  return new ShaderMaterial({
    uniforms: {
      ...(sky as never as Record<string, { value: unknown }>),
      uAccent: { value: new Color(def.accent) },
      uAccent2: { value: new Color(def.accent2) },
      uFogColor: { value: new Color(def.fogColor) },
      uFogDensity: { value: def.fogDensity },
      uSegLen: { value: 45 },
      uPanelLen: { value: 3 },
      uTime: { value: 0 },
    },
    side: DoubleSide,
    vertexShader: /* glsl */ `
      attribute float aH;
      attribute float aV;
      varying float vH;
      varying float vV;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying float vDepth;
      void main(){
        vH = aH; vV = aV;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * world;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      ${SKY_GLSL}
      uniform vec3 uAccent;
      uniform vec3 uAccent2;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      uniform float uSegLen;
      uniform float uPanelLen;
      uniform float uTime;
      varying float vH;
      varying float vV;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying float vDepth;

      void main(){
        // Alternate the neon colour every 45 m so long straights read as
        // moving even when the geometry is dead straight.
        float seg = floor(vV / uSegLen);
        vec3 neon = mix(uAccent, uAccent2, step(0.5, fract(seg * 0.5)));

        // Panel base: dark, with a seam every 3 m.
        float seam = smoothstep(0.02, 0.0, abs(fract(vV / uPanelLen) - 0.5) - 0.47);
        vec3 col = mix(vec3(0.035, 0.036, 0.044), vec3(0.012, 0.012, 0.016), seam);
        col *= 0.35 + 0.65 * vH;             // ambient occlusion toward the base

        // Neon capping strip along the top edge.
        float strip = smoothstep(0.80, 0.86, vH) * (1.0 - smoothstep(0.965, 1.0, vH));
        col += neon * strip * 2.6;

        // Its spill onto the panel below.
        col += neon * smoothstep(0.80, 0.20, vH) * 0.16;

        // Chevron hazard marks low on the wall.
        float chev = step(0.5, fract(vV / uPanelLen + vH * 1.2));
        col = mix(col, mix(col, neon * 0.5, 0.45), chev * smoothstep(0.34, 0.12, vH));

        vec3 N = normalize(vNormalW);
        float ndl = max(dot(N, uSunDir), 0.0);
        col *= 0.55 + 0.45 * ndl;
        col += uSkyHorizon * 0.22 + uSkyTop * 0.1;

        float f = 1.0 - exp(-pow(vDepth * uFogDensity, 2.0));
        col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** Everything beyond the barriers: ground plane with a fading survey grid. */
export function makeGroundMaterial(sky: SkyUniforms, def: TrackDef) {
  return new ShaderMaterial({
    uniforms: {
      ...(sky as never as Record<string, { value: unknown }>),
      uAccent: { value: new Color(def.accent) },
      uFogColor: { value: new Color(def.fogColor) },
      uFogDensity: { value: def.fogDensity },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      varying float vDepth;
      void main(){
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vec4 mv = viewMatrix * world;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      ${SKY_GLSL}
      uniform vec3 uAccent;
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      varying vec3 vWorld;
      varying float vDepth;

      void main(){
        float n = fbm(vWorld.xz * 0.05);
        vec3 col = mix(vec3(0.024, 0.027, 0.036), vec3(0.045, 0.042, 0.060), n);

        // Survey grid, thinning out with distance so it never aliases.
        vec2 g = abs(fract(vWorld.xz / 20.0 - 0.5) - 0.5) / fwidth(vWorld.xz / 20.0);
        float grid = 1.0 - min(min(g.x, g.y), 1.0);
        col += uAccent * grid * 0.10 * exp(-vDepth * 0.0022);

        col += uSkyHorizon * 0.55;

        float f = 1.0 - exp(-pow(vDepth * uFogDensity, 2.0));
        col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** Trackside light pylons and grandstand faces — instanced, emissive. */
export function makePropMaterial(sky: SkyUniforms, def: TrackDef) {
  return new ShaderMaterial({
    uniforms: {
      ...(sky as never as Record<string, { value: unknown }>),
      uFogColor: { value: new Color(def.fogColor) },
      uFogDensity: { value: def.fogDensity },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aGlow;
      varying float vGlow;
      varying vec3 vTint;
      varying vec3 vNormalW;
      varying float vDepth;
      void main(){
        vGlow = aGlow;
        #ifdef USE_INSTANCING_COLOR
          vTint = instanceColor;
        #else
          vTint = vec3(1.0);
        #endif
        mat4 model = modelMatrix;
        #ifdef USE_INSTANCING
          model = modelMatrix * instanceMatrix;
        #endif
        vec4 world = model * vec4(position, 1.0);
        vNormalW = normalize(mat3(model) * normal);
        vec4 mv = viewMatrix * world;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${NOISE_GLSL}
      ${SKY_GLSL}
      uniform vec3 uFogColor;
      uniform float uFogDensity;
      varying float vGlow;
      varying vec3 vTint;
      varying vec3 vNormalW;
      varying float vDepth;
      void main(){
        vec3 N = normalize(vNormalW);
        float ndl = max(dot(N, uSunDir), 0.0);
        vec3 body = vec3(0.030, 0.032, 0.040) * (0.4 + 0.6 * ndl) + uSkyHorizon * 0.22;
        vec3 col = mix(body, vTint * 1.75, vGlow);
        float f = 1.0 - exp(-pow(vDepth * uFogDensity, 2.0));
        col = mix(col, uFogColor, clamp(f, 0.0, 1.0));
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

/** Soft contact shadow blob under each car. Multiplicative, so it darkens. */
export function makeShadowMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: MultiplyBlending,
    // MultiplyBlending in three uses (ZERO, SRC_COLOR), which is only correct
    // for premultiplied output — the shader below writes exactly that.
    premultipliedAlpha: true,
    uniforms: {},
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main(){
        vUv = uv;
        mat4 model = modelMatrix;
        #ifdef USE_INSTANCING
          model = modelMatrix * instanceMatrix;
        #endif
        gl_Position = projectionMatrix * viewMatrix * model * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      void main(){
        vec2 d = vUv * 2.0 - 1.0;
        // Elongated along the car, with a soft edge.
        float r = length(d * vec2(1.0, 0.62));
        float a = smoothstep(1.0, 0.15, r);
        // Multiply blending: 1.0 leaves the frame alone, lower values darken.
        gl_FragColor = vec4(mix(vec3(1.0), vec3(0.16, 0.16, 0.22), a), 1.0);
      }
    `,
  });
}

/** Tyre smoke, dust and sparks. One instanced quad buffer, camera-facing. */
export function makeParticleMaterial(def: TrackDef) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      uFogColor: { value: new Color(def.fogColor) },
      uSize: { value: new Vector2(1, 1) },
    },
    vertexShader: /* glsl */ `
      attribute vec3 iPos;
      attribute vec4 iData;   // x: size, y: life 0..1, z: kind, w: seed
      attribute vec3 iColor;
      varying float vLife;
      varying float vKind;
      varying vec2 vUv;
      varying vec3 vTint;
      void main(){
        vLife = iData.y; vKind = iData.z; vUv = uv; vTint = iColor;
        // Billboard in view space so the quad always faces the camera.
        vec4 mv = viewMatrix * vec4(iPos, 1.0);
        float s = iData.x;
        mv.xy += position.xy * s;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vLife;
      varying float vKind;
      varying vec2 vUv;
      varying vec3 vTint;
      void main(){
        vec2 d = vUv * 2.0 - 1.0;
        float r = length(d);
        if (r > 1.0) discard;
        // Smoke is a soft puff; sparks are a hot core.
        float soft = smoothstep(1.0, 0.0, r);
        float hot  = pow(smoothstep(1.0, 0.0, r), 4.0);
        float shape = mix(soft, hot, vKind);
        float fade = vLife * vLife;
        gl_FragColor = vec4(vTint * shape * fade * mix(0.55, 3.0, vKind), shape * fade);
      }
    `,
  });
}
