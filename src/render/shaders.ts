/** WebGL2 用到的三段 GLSL ES 3.00 着色器。 */

const TRANSFORM = `
  gl_Position = vec4(p.x / u_world.x * 2.0 - 1.0, 1.0 - p.y / u_world.y * 2.0, 0.0, 1.0);
`;

/** 纯位置顶点（可见多边形扇形） */
export const POS_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
uniform vec2 u_world;
out vec2 v_world;
void main() {
  vec2 p = a_pos;
  v_world = p;
${TRANSFORM}}
`;

/**
 * 背景层：参考图里「没有光线追踪」的那层辉光。
 * v(d) = bgFar + glowAmp * ambShare * (1 - d/R)^p
 * 加一点抖动，避免大面积暗部渐变出现色带（参考图里其实能看到色带）。
 */
export const BG_FRAG = `#version 300 es
precision highp float;
in vec2 v_world;
uniform vec2 u_world;
uniform vec2 u_light;
uniform float u_bgFar;
uniform float u_glowAmp;
uniform float u_glowRadius;
uniform float u_glowPower;
uniform float u_ambShare;
out vec4 outColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  float d = distance(v_world, u_light);
  float f = pow(max(0.0, 1.0 - d / u_glowRadius), u_glowPower);
  float v = u_bgFar + u_glowAmp * u_ambShare * f;
  v += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  outColor = vec4(vec3(v), 1.0);
}
`;

/**
 * 直接光：只画在可见多边形里（像素级按距离衰减），用叠加混合加到背景上。
 * 阴影区域拿不到这一层 —— 硬阴影就是这么来的。
 */
export const LIT_FRAG = `#version 300 es
precision highp float;
in vec2 v_world;
uniform vec2 u_light;
uniform float u_glowAmp;
uniform float u_glowRadius;
uniform float u_glowPower;
uniform float u_directShare;
out vec4 outColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  float d = distance(v_world, u_light);
  float f = pow(max(0.0, 1.0 - d / u_glowRadius), u_glowPower);
  float v = u_glowAmp * u_directShare * f;
  v += (hash(gl_FragCoord.xy + 7.13) - 0.5) / 255.0;
  outColor = vec4(vec3(v), 1.0);
}
`;

/** 叠加层：方块、棱边高光、调试射线、灯泡，全部是带颜色的三角形 */
export const FLAT_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec4 a_color;
uniform vec2 u_world;
out vec4 v_color;
void main() {
  vec2 p = a_pos;
  v_color = a_color;
${TRANSFORM}}
`;

export const FLAT_FRAG = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 outColor;
void main() {
  outColor = v_color;
}
`;

/**
 * 多重阴影修正：把「被 n 个方块挡住」的区域再压暗。
 *
 * 底层渲染给出的是「1 个遮挡物」的亮度（环境光那份就是按 ds = 1-directShare 算的），
 * 所以这里只需要补上「多出来的 n-1 个遮挡物」那部分：
 *     目标 = bgFar + amp·f·dsⁿ ，当前 = bgFar + amp·f·ds
 *     修正 = -(amp·ds·f·(1 - ds^(n-1)))         （n ≤ 1 时不修正）
 * n 从离屏计数纹理读（每个本影 +1/16）。
 *
 * 注意不能直接输出负值：OpenGL ES 对定点（RGBA8）帧缓冲会**在混合前把源色钳到 [0,1]**，
 * 负值会被吃掉。所以改成等价的乘法式衰减：
 *     src = 需要减掉的量 / 当前值      dst ← dst·(1 - src)
 * 当前值正好是背景层 bgFar + amp·ds·f（亮区被扇形盖住，不参与这一步），着色器自己就能算出来。
 */
export const SHADOW_FRAG = `#version 300 es
precision highp float;
in vec2 v_world;
uniform vec2 u_world;
uniform vec2 u_light;
uniform sampler2D u_count;
uniform float u_glowAmp;
uniform float u_glowRadius;
uniform float u_glowPower;
uniform float u_directShare;
uniform float u_bgFar;
out vec4 outColor;

void main() {
  vec2 uv = vec2(v_world.x / u_world.x, 1.0 - v_world.y / u_world.y);
  float n = floor(texture(u_count, uv).r * 16.0 + 0.5);
  if (n < 2.0) {
    outColor = vec4(0.0);
    return;
  }
  float d = distance(v_world, u_light);
  float f = pow(max(0.0, 1.0 - d / u_glowRadius), u_glowPower);
  float ds = 1.0 - u_directShare;
  float glow = u_glowAmp * ds * f;
  float base = u_bgFar + glow;                       // 这一步时像素的当前值
  float amount = glow * (1.0 - pow(ds, n - 1.0));    // 要减掉的量
  float src = base > 1e-5 ? clamp(amount / base, 0.0, 1.0) : 0.0;
  outColor = vec4(src, src, src, 0.0);
}
`;
