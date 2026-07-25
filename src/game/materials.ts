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
 * render-to-texture — and reflections that stay automatically consistent with
 * whatever sky the circuit is set in.
 *
 * The lighting model is the same everywhere: a warm directional sun, a cool
 * hemispherical sky term, and a bounce term coming back up off the ground.
 * That triple is what makes an outdoor daylight scene read as real rather than
 * as a flat ambient wash.
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
float fbm4(vec2 p){
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { v += vnoise(p) * a; p *= 2.07; a *= 0.5; }
  return v;
}
`;

/** Daylight sky. One function, used for the dome and for every reflection. */
const SKY_GLSL = /* glsl */ `
uniform vec3 uSkyTop;
uniform vec3 uSkyHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uGroundTint;

vec3 skyBase(vec3 d){
  // Zenith to horizon. The low exponent keeps a wide pale band near the
  // horizon, which is what real atmospheric depth looks like.
  float t = pow(clamp(d.y, 0.0, 1.0), 0.42);
  vec3 col = mix(uSkyHorizon, uSkyTop, t);

  // Forward scattering around the sun.
  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * pow(sd, 9.0) * 0.40;
  col += uSunColor * pow(sd, 2.5) * 0.11;

  // Below the horizon a reflection sees ground, not sky.
  col = mix(col, uGroundTint, smoothstep(0.02, -0.16, d.y));
  return col;
}

/** Sun disc and clouds — background only, so reflections never alias. */
vec3 skyDetail(vec3 d, float time){
  vec3 col = vec3(0.0);

  float sd = max(dot(d, uSunDir), 0.0);
  col += uSunColor * smoothstep(0.9990, 0.99975, sd) * 14.0;

  if (d.y > 0.008) {
    // Project the view direction onto a cloud deck. Dividing by d.y is the
    // cheap flat-plane projection: the deck compresses toward the horizon
    // exactly as a real one does.
    vec2 uv = d.xz / d.y * 0.05;
    uv += vec2(time * 0.0035, time * 0.0012);
    float n = fbm4(uv) + fbm4(uv * 2.7 + 11.3) * 0.35;
    float cover = smoothstep(0.60, 0.92, n) * smoothstep(0.008, 0.14, d.y);

    // Lit tops toward the sun, cooler shadowed bases.
    float lit = smoothstep(0.30, 0.95, n) * max(dot(d, uSunDir) * 0.5 + 0.5, 0.0);
    vec3 cloud = mix(vec3(0.62, 0.66, 0.74), vec3(1.28, 1.24, 1.16), lit);
    col = mix(col, cloud, cover * 0.88);
  }
  return col;
}

/**
 * The standard outdoor triple: sun, sky, bounce. "ao" attenuates the two
 * ambient terms but never the sun — occlusion darkens what the sky can reach,
 * not what is already in direct sunlight.
 */
vec3 daylight(vec3 albedo, vec3 n, float ao){
  float ndl = max(dot(n, uSunDir), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  float bounce = 0.5 - 0.5 * n.y;
  vec3 lit = albedo * uSunColor * ndl * 1.55;
  lit += albedo * uSkyHorizon * sky * 0.62 * ao;
  lit += albedo * uGroundTint * bounce * 0.34 * ao;
  return lit;
}
`;

/** Sky depends on the noise helpers, so the two always travel together. */
const COMMON_GLSL = `${NOISE_GLSL}\n${SKY_GLSL}`;

export interface SkyUniforms {
  uSkyTop: { value: Color };
  uSkyHorizon: { value: Color };
  uSunColor: { value: Color };
  uSunDir: { value: Vector3 };
  uGroundTint: { value: Color };
}

export function makeSkyUniforms(def: TrackDef): SkyUniforms {
  return {
    uSkyTop: { value: new Color(def.skyTop) },
    uSkyHorizon: { value: new Color(def.skyHorizon) },
    uSunColor: { value: new Color(def.sunColor) },
    uSunDir: { value: new Vector3(def.sunX, def.sunY, def.sunZ).normalize() },
    uGroundTint: { value: new Color(def.groundTint) },
  };
}

function shared(sky: SkyUniforms) {
  return { ...(sky as never as Record<string, { value: unknown }>) };
}

function fogUniforms(def: TrackDef) {
  return {
    uFogColor: { value: new Color(def.fogColor) },
    uFogDensity: { value: def.fogDensity },
  };
}

/** Aerial perspective: distant things go pale and blue, they do not go dark. */
const FOG_GLSL = /* glsl */ `
uniform vec3 uFogColor;
uniform float uFogDensity;
vec3 applyFog(vec3 col, float depth){
  float f = 1.0 - exp(-pow(depth * uFogDensity, 1.7));
  return mix(col, uFogColor, clamp(f, 0.0, 1.0));
}
`;

// ---------------------------------------------------------------------------
// Sky dome
// ---------------------------------------------------------------------------

export function makeSkyMaterial(sky: SkyUniforms): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...shared(sky), uTime: { value: 0 } },
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
      ${COMMON_GLSL}
      uniform float uTime;
      varying vec3 vDir;
      void main(){
        vec3 d = normalize(vDir);
        gl_FragColor = vec4(skyBase(d) + skyDetail(d, uTime), 1.0);
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
export function makeCarMaterial(sky: SkyUniforms, def: TrackDef): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { ...shared(sky), ...fogUniforms(def), uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      attribute float paint;
      varying float vPaint;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying vec3 vLocal;
      varying vec3 vLivery;
      varying float vDepth;

      void main(){
        vPaint = paint;
        vLocal = position;
        #ifdef USE_INSTANCING_COLOR
          vLivery = instanceColor;
        #else
          vLivery = vec3(0.75, 0.1, 0.12);
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
      ${COMMON_GLSL}
      ${FOG_GLSL}
      uniform float uTime;

      varying float vPaint;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying vec3 vLocal;
      varying vec3 vLivery;
      varying float vDepth;

      void main(){
        vec3 N = normalize(vNormalW);
        vec3 V = normalize(cameraPosition - vWorld);
        if (dot(N, V) < 0.0) N = -N;       // keep thin wings lit from both faces
        vec3 R = reflect(-V, N);

        int id = int(vPaint + 0.5);

        vec3 albedo;
        float rough, reflectivity;
        vec3 emissive = vec3(0.0);
        // Bodywork sits low; the closer to the floor, the less sky reaches it.
        float ao = clamp(0.45 + vLocal.y * 0.80, 0.38, 1.0);

        if (id == 1) {                      // livery paint
          albedo = vLivery;
          rough = 0.13; reflectivity = 0.32;
        } else if (id == 2) {               // accent stripe
          albedo = clamp(vLivery * 1.30 + 0.30, 0.0, 1.0);
          rough = 0.19; reflectivity = 0.27;
        } else if (id == 3) {               // titanium halo, rims, roll hoop
          albedo = vec3(0.52, 0.545, 0.58);
          rough = 0.22; reflectivity = 0.60;
        } else if (id == 4) {               // tyre rubber
          float tread = fbm(vWorld.xz * 30.0) * 0.035;
          albedo = vec3(0.048, 0.049, 0.053) + tread;
          rough = 0.92; reflectivity = 0.03;
        } else if (id == 5) {               // brake disc / rain light
          albedo = vec3(0.18, 0.17, 0.17);
          rough = 0.70; reflectivity = 0.06;
          emissive = vec3(0.26, 0.04, 0.008);
        } else if (id == 6) {               // visor and mirror glass
          albedo = vec3(0.03, 0.035, 0.045);
          rough = 0.05; reflectivity = 0.85;
        } else {                            // bare carbon fibre
          // A 2x2 twill reads as a fine diagonal checker at close range.
          vec2 w = vWorld.xz * 170.0;
          float weave = step(0.5, fract(floor(w.x) * 0.5 + floor(w.y) * 0.5));
          albedo = mix(vec3(0.035, 0.037, 0.042), vec3(0.070, 0.073, 0.080), weave);
          rough = 0.30; reflectivity = 0.22;
        }

        vec3 col = daylight(albedo, N, ao);

        // Clearcoat: a sky reflection lifted at grazing angles, plus a tight
        // sun highlight. This is what separates painted bodywork from plastic.
        float fres = reflectivity + (1.0 - reflectivity) * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        col = mix(col, skyBase(R) * ao, fres * (1.0 - rough * 0.55));

        vec3 H = normalize(uSunDir + V);
        float spec = pow(max(dot(N, H), 0.0), mix(320.0, 12.0, rough));
        col += uSunColor * spec * (1.0 - rough) * 1.9;

        col += emissive;
        gl_FragColor = vec4(applyFog(col, vDepth), 1.0);
      }
    `,
  });
}

// ---------------------------------------------------------------------------
// Road surface
// ---------------------------------------------------------------------------

/**
 * Attributes: `aU` lateral -1..1, `aV` metres along the lap, `aCorner` 0..1.
 * Asphalt, white edge lines, the rubbered-in racing line, sector markers and
 * the start/finish grid, in one pass.
 */
export function makeRoadMaterial(sky: SkyUniforms, def: TrackDef, lapLength: number) {
  return new ShaderMaterial({
    uniforms: {
      ...shared(sky),
      ...fogUniforms(def),
      uAccent: { value: new Color(def.accent) },
      uAccent2: { value: new Color(def.accent2) },
      uLapLength: { value: lapLength },
      uMarkerLen: { value: lapLength / Math.round(lapLength / 50) },
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      attribute float aU;
      attribute float aV;
      attribute float aCorner;
      attribute float aHalfW;
      varying float vU;
      varying float vV;
      varying float vCorner;
      varying float vHalfW;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vDepth;
      void main(){
        vU = aU; vV = aV; vCorner = aCorner; vHalfW = aHalfW;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * world;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON_GLSL}
      ${FOG_GLSL}
      uniform vec3 uAccent;
      uniform vec3 uAccent2;
      uniform float uLapLength;
      uniform float uMarkerLen;
      varying float vU;
      varying float vV;
      varying float vCorner;
      varying float vHalfW;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vDepth;

      void main(){
        // Everything on the road is dimensioned in metres from the centreline.
        // Working in normalised width would make a 34 m circuit paint a 1.3 m
        // white line and lay down an 11 m racing line.
        float latM = abs(vU) * vHalfW;

        // Asphalt: coarse aggregate plus a finer grain, both in world space so
        // the texture never stretches through a corner.
        float coarse = fbm(vWorld.xz * 1.6);
        float fine = fbm(vWorld.xz * 13.0);
        vec3 albedo = mix(vec3(0.150, 0.153, 0.163), vec3(0.243, 0.246, 0.258),
                          coarse * 0.65 + fine * 0.35);

        // Surface-repair seams: strips of newer, darker asphalt.
        float seam = smoothstep(0.84, 0.93, fbm(vWorld.xz * 0.26));
        albedo = mix(albedo, albedo * 0.80, seam * 0.6);

        // Rubbered-in racing line: a ~13 m band of worked surface, widest and
        // darkest through the corners.
        float rubber = smoothstep(6.5, 1.0, latM) * (0.30 + 0.45 * vCorner);
        albedo = mix(albedo, vec3(0.088, 0.086, 0.090), rubber);

        // White edge line: 0.2 m wide, set 0.3 m inside the boundary.
        float line = smoothstep(vHalfW - 0.55, vHalfW - 0.48, latM)
                   * (1.0 - smoothstep(vHalfW - 0.32, vHalfW - 0.25, latM));
        albedo = mix(albedo, vec3(0.80, 0.80, 0.78), line);

        // 50 m boards just inside the line, tinted by sector.
        float sector = floor(vV / (uLapLength / 3.0));
        vec3 sectorCol = sector < 1.0 ? uAccent : (sector < 2.0 ? uAccent2 : vec3(0.95, 0.80, 0.15));
        float tick = step(0.94, fract(vV / uMarkerLen))
                   * smoothstep(vHalfW - 2.9, vHalfW - 2.7, latM)
                   * (1.0 - smoothstep(vHalfW - 1.5, vHalfW - 1.3, latM));
        albedo = mix(albedo, sectorCol * 0.75, tick);

        // Start/finish: a checkered band across the full width.
        float sLine = smoothstep(6.0, 4.0,
          abs(mod(vV + uLapLength * 0.5, uLapLength) - uLapLength * 0.5));
        // 0.8 m squares, so the grid reads the same on any width of circuit.
        float checker = step(0.5, fract(vU * vHalfW / 0.8)) == step(0.5, fract(vV / 0.8))
          ? 0.055 : 0.78;
        albedo = mix(albedo, vec3(checker), sLine);

        vec3 N = normalize(vNormalW);
        vec3 col = daylight(albedo, N, 1.0);

        // Broad grazing sheen. Asphalt is rough, so this is a wide haze rather
        // than a mirror, and it is what sells hot tarmac in direct sun.
        vec3 V = normalize(cameraPosition - vWorld);
        float graze = pow(1.0 - max(dot(N, V), 0.0), 5.0);
        col += skyBase(reflect(-V, N)) * graze * 0.22;

        gl_FragColor = vec4(applyFog(col, vDepth), 1.0);
      }
    `,
  });
}

/** Run-off: paler asphalt apron, painted through the corners. */
export function makeRunoffMaterial(sky: SkyUniforms, def: TrackDef) {
  return new ShaderMaterial({
    uniforms: { ...shared(sky), ...fogUniforms(def), uAccent: { value: new Color(def.accent) } },
    vertexShader: /* glsl */ `
      attribute float aU;
      attribute float aCorner;
      varying float vU;
      varying float vCorner;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vDepth;
      void main(){
        vU = aU; vCorner = aCorner;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * world;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON_GLSL}
      ${FOG_GLSL}
      uniform vec3 uAccent;
      varying float vU;
      varying float vCorner;
      varying vec3 vWorld;
      varying vec3 vNormalW;
      varying float vDepth;
      void main(){
        float au = abs(vU);
        float grain = fbm(vWorld.xz * 2.2) * 0.6 + fbm(vWorld.xz * 10.0) * 0.4;

        // Paler and older than the racing surface.
        vec3 albedo = mix(vec3(0.196, 0.198, 0.205), vec3(0.278, 0.278, 0.282), grain);

        // Painted run-off through the corners only, as at a modern circuit.
        float paint = smoothstep(0.30, 0.62, vCorner) * (1.0 - smoothstep(0.30, 0.85, au));
        float stripe = step(0.5, fract((vWorld.x + vWorld.z) * 0.06));
        vec3 painted = mix(uAccent * 0.42, vec3(0.62, 0.62, 0.60), stripe);
        albedo = mix(albedo, painted, paint * 0.72);

        // White boundary line where the run-off begins.
        albedo = mix(albedo, vec3(0.74, 0.74, 0.72), smoothstep(0.10, 0.04, au));
        albedo *= 0.88 + grain * 0.24;

        vec3 col = daylight(albedo, normalize(vNormalW), 1.0);
        gl_FragColor = vec4(applyFog(col, vDepth), 1.0);
      }
    `,
  });
}

/** Kerbs: painted concrete, red and white, lit like everything else. */
export function makeKerbMaterial(sky: SkyUniforms, def: TrackDef) {
  return new ShaderMaterial({
    uniforms: { ...shared(sky), ...fogUniforms(def), uKerbPitch: { value: 3.2 } },
    vertexShader: /* glsl */ `
      attribute float aU;
      attribute float aV;
      varying float vU;
      varying float vV;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying float vDepth;
      void main(){
        vU = aU; vV = aV;
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vec4 mv = viewMatrix * world;
        vDepth = -mv.z;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON_GLSL}
      ${FOG_GLSL}
      uniform float uKerbPitch;
      varying float vU;
      varying float vV;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying float vDepth;
      void main(){
        // Alternating 1.6 m blocks: the standard FIA kerb pitch.
        float blk = step(0.5, fract(vV / uKerbPitch));
        vec3 albedo = mix(vec3(0.74, 0.73, 0.70), vec3(0.62, 0.075, 0.085), blk);

        // Worn, scrubbed paint and dirt in the joints.
        albedo *= 0.82 + fbm(vWorld.xz * 5.0) * 0.34;
        float joint = smoothstep(0.06, 0.0, abs(fract(vV / uKerbPitch) - 0.5) - 0.46);
        albedo *= 1.0 - joint * 0.35;

        // The outer lip sees less sky than the inner face.
        float ao = 0.55 + 0.45 * smoothstep(0.0, 0.6, vU);
        gl_FragColor = vec4(applyFog(daylight(albedo, normalize(vNormalW), ao), vDepth), 1.0);
      }
    `,
  });
}

/** Barrier: concrete wall with a red band and sponsor panels. */
export function makeBarrierMaterial(sky: SkyUniforms, def: TrackDef) {
  return new ShaderMaterial({
    uniforms: {
      ...shared(sky),
      ...fogUniforms(def),
      uAccent: { value: new Color(def.accent) },
      uAccent2: { value: new Color(def.accent2) },
      uSegLen: { value: 45 },
      uPanelLen: { value: 3 },
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
      ${COMMON_GLSL}
      ${FOG_GLSL}
      uniform vec3 uAccent;
      uniform vec3 uAccent2;
      uniform float uSegLen;
      uniform float uPanelLen;
      varying float vH;
      varying float vV;
      varying vec3 vNormalW;
      varying vec3 vWorld;
      varying float vDepth;

      void main(){
        // Concrete, cast in sections with a joint every few metres.
        float grime = fbm(vWorld.xz * 0.9) * 0.5 + fbm(vWorld.xz * 6.0) * 0.5;
        vec3 albedo = mix(vec3(0.60, 0.60, 0.585), vec3(0.72, 0.72, 0.705), grime);
        float joint = smoothstep(0.03, 0.0, abs(fract(vV / uPanelLen) - 0.5) - 0.47);
        albedo *= 1.0 - joint * 0.42;

        // Track grime kicked up along the base.
        albedo *= mix(0.62, 1.0, smoothstep(0.0, 0.42, vH));

        // A red band along the top edge, as on real barrier and pit walls.
        albedo = mix(albedo, vec3(0.58, 0.085, 0.09), smoothstep(0.80, 0.845, vH));

        // Sponsor panels below it, alternating along the lap.
        float seg = floor(vV / uSegLen);
        vec3 brand = mix(uAccent, uAccent2, step(0.5, fract(seg * 0.5)));
        float panel = smoothstep(0.24, 0.29, vH) * (1.0 - smoothstep(0.70, 0.76, vH));
        albedo = mix(albedo, brand * 0.55 + 0.06, panel * 0.82);

        gl_FragColor = vec4(applyFog(daylight(albedo, normalize(vNormalW), 0.85), vDepth), 1.0);
      }
    `,
  });
}

/** Everything beyond the barriers: mown grass. */
export function makeGroundMaterial(sky: SkyUniforms, def: TrackDef) {
  return new ShaderMaterial({
    uniforms: { ...shared(sky), ...fogUniforms(def) },
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
      ${COMMON_GLSL}
      ${FOG_GLSL}
      varying vec3 vWorld;
      varying float vDepth;

      void main(){
        // Grass: broad patchiness plus a fine blade-scale break-up.
        float clump = fbm(vWorld.xz * 0.045);
        float blades = fbm(vWorld.xz * 1.4);
        vec3 albedo = mix(vec3(0.075, 0.145, 0.055), vec3(0.135, 0.235, 0.085), clump);
        albedo = mix(albedo, albedo * 1.18, blades);

        // Mown stripes: the give-away that grass is maintained.
        float mow = step(0.5, fract(vWorld.x / 26.0 + clump * 0.3));
        albedo *= mix(0.90, 1.12, mow);

        // Dry, sandy ground showing through.
        albedo = mix(albedo, vec3(0.30, 0.27, 0.18), smoothstep(0.72, 0.92, clump) * 0.45);

        gl_FragColor = vec4(applyFog(daylight(albedo, vec3(0.0, 1.0, 0.0), 1.0), vDepth), 1.0);
      }
    `,
  });
}

/** Grandstands, hoardings, floodlights and the gantry. */
export function makePropMaterial(sky: SkyUniforms, def: TrackDef) {
  return new ShaderMaterial({
    uniforms: { ...shared(sky), ...fogUniforms(def) },
    vertexShader: /* glsl */ `
      attribute float aGlow;
      varying float vGlow;
      varying vec3 vTint;
      varying vec3 vNormalW;
      varying vec3 vLocal;
      varying float vDepth;
      void main(){
        vGlow = aGlow;
        vLocal = position;
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
      ${COMMON_GLSL}
      ${FOG_GLSL}
      varying float vGlow;
      varying vec3 vTint;
      varying vec3 vNormalW;
      varying vec3 vLocal;
      varying float vDepth;
      void main(){
        // aGlow selects the "branded" surface: a grandstand's seating, a
        // hoarding's face, a floodlight's housing.
        vec3 structure = vec3(0.52, 0.53, 0.55);
        vec3 albedo = mix(structure, clamp(vTint, 0.0, 1.0) * 0.85 + 0.05, vGlow);
        // A crowd reads as fine noise, not as flat colour.
        albedo = mix(albedo, albedo * (0.72 + fbm(vLocal.xz * 3.0) * 0.7), vGlow * 0.6);

        gl_FragColor = vec4(applyFog(daylight(albedo, normalize(vNormalW), 0.8), vDepth), 1.0);
      }
    `,
  });
}

/**
 * Contact shadow under each car. Multiplicative, hardest directly beneath the
 * floor — which is where a real ground-effect car's shadow is darkest.
 */
export function makeShadowMaterial() {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: MultiplyBlending,
    // MultiplyBlending uses (ZERO, SRC_COLOR), which needs premultiplied output.
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
        // A hard core under the floor inside a soft penumbra.
        float core = 1.0 - smoothstep(0.12, 0.72, length(d * vec2(1.32, 0.70)));
        float soft = 1.0 - smoothstep(0.0, 1.0, length(d * vec2(0.92, 0.60)));
        float a = clamp(core * 0.92 + soft * 0.42, 0.0, 1.0);
        // In direct sun a car's shadow is dark and well defined, and it is the
        // single strongest cue that the car is sitting on the road rather than
        // floating above it.
        gl_FragColor = vec4(mix(vec3(1.0), vec3(0.19, 0.22, 0.28), a), 1.0);
      }
    `,
  });
}

/** Tyre smoke, dust and sparks. One instanced quad buffer, camera-facing. */
export function makeParticleMaterial(sky: SkyUniforms, def: TrackDef) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: AdditiveBlending,
    uniforms: {
      ...shared(sky),
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
        mv.xy += position.xy * iData.x;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON_GLSL}
      varying float vLife;
      varying float vKind;
      varying vec2 vUv;
      varying vec3 vTint;
      void main(){
        vec2 d = vUv * 2.0 - 1.0;
        float r = length(d);
        if (r > 1.0) discard;
        float soft = smoothstep(1.0, 0.0, r);
        float hot  = pow(smoothstep(1.0, 0.0, r), 4.0);
        float shape = mix(soft, hot, vKind);
        float fade = vLife * vLife;
        // Daylight smoke is lit by the sky, not self-luminous.
        vec3 tint = mix(vTint * (uSkyHorizon * 1.5 + uSunColor * 0.55), vTint, vKind);
        gl_FragColor = vec4(tint * shape * fade * mix(0.85, 3.0, vKind), shape * fade);
      }
    `,
  });
}
