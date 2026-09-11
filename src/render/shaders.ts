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
