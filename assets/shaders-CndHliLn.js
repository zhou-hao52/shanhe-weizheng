const f=`
precision highp float;

attribute vec2 aSeed;
attribute float aKind;

uniform float uTime;
uniform float uPx;
uniform float uScale;
uniform float uMaxPx;
uniform float uDof;
uniform float uFade;
uniform float uFocus;
uniform float uVel;
uniform float uPeak;
uniform float uShoreZ;
uniform float uWaterD;
uniform float uWaterY;
uniform vec2  uRes;
uniform vec2  uMouse;
uniform vec2  uMouseV;
uniform vec3  uFar;
uniform vec3  uNear;
uniform vec3  uHot;
uniform vec3  uRed;
uniform vec3  uWFar;
uniform vec3  uWNear;

varying float vA;
varying vec3  vCol;
varying float vSoft;

const float PX_REF = 130.0;

vec3 flow(vec3 p, float t) {
  return vec3(
    sin(p.y * .21 + t * .7 ) + sin(p.z * .17 - t * .5 ) + sin(p.x * .09 + t * .3 ),
    sin(p.z * .19 + t * .6 ) + sin(p.x * .23 + t * .4 ) + sin(p.y * .08 - t * .35),
    sin(p.x * .18 - t * .55) + sin(p.y * .15 + t * .65) + sin(p.z * .07 + t * .25));
}

void main() {
  float s   = aSeed.x;
  float isW = step(0.5, aKind) * (1.0 - step(1.5, aKind));
  float isS = step(1.5, aKind) * (1.0 - step(2.5, aKind));
  float isD = step(2.5, aKind);

  vec3 p = position;

  // ① 水面：横向长涌（参考站 w4 项，只对水生效）
  float wv = sin(p.x * .16 + p.z * .05 + uTime * .55) * 0.95
           + sin(p.z * .31 - uTime * .80 + p.x * .04) * 0.48
           + sin((p.x + p.z) * .5 + uTime * 1.3) * 0.15;
  p.y += wv * isW;

  // ② 三维流场：时标与幅度都用参考站原值（.35 / .07），山慢水快只体现在 mix 上
  float t = uTime * 0.35 + s * 6.2831;
  p += flow(p * 0.55 + s * 3.0, t)
       * (0.07 + 0.05 * aSeed.y)
       * mix(0.55, 1.0, isW)
       * (1.0 + uVel * 0.8);

  vec4 mv   = modelViewMatrix * vec4(p, 1.0);
  vec4 clip = projectionMatrix * mv;

  // ③ 鼠标像手伸进水里：斥力 + 切向涡旋 + 尾流，半径逐点不同
  vec2  ndc = clip.xy / clip.w;
  float asp = uRes.x / max(uRes.y, 1.0);
  vec2  dm  = ndc - uMouse;
  dm.x *= asp;
  float md  = length(dm);
  float spd = min(length(uMouseV), 3.0);
  float rad = (0.10 + 0.09 * aSeed.y) * (1.0 + spd * 0.25) + 0.02 * sin(uTime * 1.7 + s * 30.0);
  float fl  = exp(-md * md / (rad * rad));
  vec2  dir = dm / (md + 1e-4);
  vec2  tng = vec2(-dir.y, dir.x);
  vec2  off = dir * fl * (0.030 + 0.055 * s) * (0.65 + 0.35 * sin(uTime * .9 + s * 12.0))
            + tng * fl * 0.032 * (s - 0.5) * (1.0 + spd)
            + uMouseV * fl * (0.010 + 0.026 * aSeed.y);
  off.x /= asp;
  clip.xy += off * clip.w;
  gl_Position = clip;

  // ④ 景深：焦点在相机到 target 的距离上
  float d   = -mv.z;
  float coc = abs(d - uFocus) / uFocus;
  float big = pow(aSeed.y, 6.0) * 2.2;
  float size = uPx * uScale * (1.1 + big + coc * 7.0 * uDof) * (PX_REF / max(d, 1.0));
  size = clamp(size, 1.0, uMaxPx);
  gl_PointSize = size;
  // 能量守恒：点越大越淡，避免近水大点叠成死白
  float energy = clamp(6.0 / (size / uPx), 0.30, 1.0);
  vSoft = clamp(coc * 3.0 * uDof, 0.0, 1.0);

  // ⑤ 颜色：按高度 / 距岸距离分流
  float hN = clamp((position.y - uWaterY) / uPeak, 0.0, 1.0);
  float zN = clamp((position.z - uShoreZ) / uWaterD, 0.0, 1.0);
  float tw = 0.86 + 0.14 * sin(uTime * (1.4 + s * 2.8) + s * 40.0);

  vec3 col;
  float a;
  if (isD > 0.5) {
    col = uHot;
    a = 0.10 * (0.6 + 0.4 * s);
  } else if (isW > 0.5) {
    col = mix(uWFar, uWNear, pow(zN, 0.85));
    col = mix(col, uHot, 0.30 * smoothstep(0.55, 1.4, wv));
    // 远端（贴山脚那几行）补亮，近端保持虚化后的通透
    a = 0.40 * (0.9 + 0.1 * zN) * (1.35 - 0.35 * zN);
  } else if (isS > 0.5) {
    col = mix(uNear, uHot, 0.6);
    a = 0.08;
  } else {
    col = mix(uFar, uNear, pow(hN, 1.25));
    col = mix(col, uHot, smoothstep(0.88, 1.0, hN) * 0.3);
    col = mix(col, uRed, step(0.99, aSeed.y) * 0.6);
    a = 0.28 * (0.75 + 0.25 * clamp(hN * 1.8, 0.0, 1.0));
  }
  a *= tw * energy / (1.0 + coc * coc * 2.0);
  a *= uFade;

  vA  = a;
  vCol = col;
}
`,c=`
precision mediump float;

varying float vA;
varying vec3  vCol;
varying float vSoft;

void main() {
  vec2  c = gl_PointCoord - 0.5;
  float r = length(c);
  if (r > 0.5) discard;
  float sharp = smoothstep(0.5, 0.32, r);
  float soft  = smoothstep(0.5, 0.0,  r) * 0.8;
  float a = mix(sharp, soft, vSoft);
  gl_FragColor = vec4(vCol, vA * a);
}
`;function u(a,i){const o=a.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i);if(o)return new Float32Array([Number(o[1])/255,Number(o[2])/255,Number(o[3])/255]);const e=a.match(/^#([0-9a-f]{6})$/i);if(e){const t=parseInt(e[1],16);return new Float32Array([(t>>16&255)/255,(t>>8&255)/255,(t&255)/255])}return new Float32Array(i)}function m(a){const i=getComputedStyle(a),o=document.createElement("span");o.style.display="none",document.body.appendChild(o);const e=(n,l)=>{const r=i.getPropertyValue(n).trim();if(!r)return new Float32Array(l);o.style.color="",o.style.color=r;const s=getComputedStyle(o).color;return u(s||r,l)},t={far:e("--land-far",[.18,.227,.235]),near:e("--land-near",[.478,.353,.188]),hot:e("--land-hot",[.847,.753,.569]),red:e("--land-red",[.722,.271,.173]),waterFar:e("--land-w-far",[.227,.29,.322]),waterNear:e("--land-w-near",[.541,.435,.271])};return o.remove(),t}export{c as LAND_FS,f as LAND_VS,m as readPalette};
