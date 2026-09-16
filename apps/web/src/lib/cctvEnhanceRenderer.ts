/**
 * cctvEnhanceRenderer.ts — WebGL2 pipeline behind the CCTV console's enhanced view.
 *
 * Passes: (1) crop the zoomed region and resample it with Catmull-Rom bicubic filtering, (2) bilateral
 * denoise, (3) low-resolution Gaussian luminance blur, (4) compose: white balance, levels, local contrast,
 * gamma, unsharp mask, saturation, manual overrides. The source texture is never written back anywhere.
 */

import type { EnhancementPlan, ManualAdjustments, Roi } from './cctvEnhance';

export type EnhancementSource = HTMLVideoElement | HTMLCanvasElement | HTMLImageElement;

export type RenderInput = {
  plan: EnhancementPlan;
  manual: ManualAdjustments;
  roi: Roi;
  sourceWidth: number;
  sourceHeight: number;
};

export type EnhancementRenderer = {
  render: (source: EnhancementSource, input: RenderInput) => boolean;
  isLost: () => boolean;
  dispose: () => void;
};

const VERTEX = `#version 300 es
in vec2 position;
out vec2 vUv;
void main() {
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const CROP_UPSCALE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSource;
uniform vec4 uRoi;
uniform vec2 uSourceSize;
vec3 fetch(vec2 texel) {
  vec2 clamped = clamp(texel, vec2(0.5), uSourceSize - 0.5);
  return texture(uSource, clamped / uSourceSize).rgb;
}
float catmullRom(float x) {
  x = abs(x);
  if (x < 1.0) return 1.5 * x * x * x - 2.5 * x * x + 1.0;
  if (x < 2.0) return -0.5 * x * x * x + 2.5 * x * x - 4.0 * x + 2.0;
  return 0.0;
}
void main() {
  vec2 sourceUv = vec2(uRoi.x + vUv.x * uRoi.z, uRoi.y + (1.0 - vUv.y) * uRoi.w);
  vec2 texel = sourceUv * uSourceSize - 0.5;
  vec2 base = floor(texel);
  vec2 frac = texel - base;
  vec3 sum = vec3(0.0);
  float weightSum = 0.0;
  for (int y = -1; y <= 2; y++) {
    float wy = catmullRom(float(y) - frac.y);
    for (int x = -1; x <= 2; x++) {
      float w = wy * catmullRom(float(x) - frac.x);
      sum += fetch(base + vec2(float(x), float(y)) + 0.5) * w;
      weightSum += w;
    }
  }
  outColor = vec4(clamp(sum / max(weightSum, 1e-4), 0.0, 1.0), 1.0);
}`;

const DENOISE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImage;
uniform vec2 uTexel;
uniform float uDenoise;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
void main() {
  vec3 centre = texture(uImage, vUv).rgb;
  if (uDenoise < 0.01) { outColor = vec4(centre, 1.0); return; }
  float sigmaRange = 0.015 + 0.13 * uDenoise;
  float centreLuma = luma(centre);
  vec3 sum = vec3(0.0);
  float weightSum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      vec3 tap = texture(uImage, vUv + vec2(float(x), float(y)) * uTexel).rgb;
      float spatial = exp(-float(x * x + y * y) / 6.0);
      float range = exp(-pow(luma(tap) - centreLuma, 2.0) / (2.0 * sigmaRange * sigmaRange));
      float w = spatial * range;
      sum += tap * w;
      weightSum += w;
    }
  }
  outColor = vec4(sum / max(weightSum, 1e-4), 1.0);
}`;

const BLUR = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImage;
uniform vec2 uStep;
uniform bool uFromColour;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
const float weights[8] = float[8](0.1155, 0.1113, 0.0994, 0.0823, 0.0632, 0.0450, 0.0297, 0.0182);
void main() {
  float total = 0.0;
  float weightSum = 0.0;
  for (int i = -7; i <= 7; i++) {
    vec4 tap = texture(uImage, vUv + float(i) * uStep);
    float value = uFromColour ? luma(tap.rgb) : tap.r;
    float w = weights[abs(i)];
    total += value * w;
    weightSum += w;
  }
  outColor = vec4(vec3(total / weightSum), 1.0);
}`;

const COMPOSE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uImage;
uniform sampler2D uBlurredLuma;
uniform vec2 uTexel;
uniform float uBlackPoint;
uniform float uWhitePoint;
uniform float uGamma;
uniform vec3 uGains;
uniform float uSaturation;
uniform float uLocalContrast;
uniform float uSharpen;
uniform float uBrightness;
uniform float uContrast;
uniform float uManualSaturation;
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float levels(float value) { return clamp((value - uBlackPoint) / max(uWhitePoint - uBlackPoint, 0.02), 0.0, 1.0); }
void main() {
  vec3 colour = texture(uImage, vUv).rgb * uGains;
  float baseLuma = levels(texture(uBlurredLuma, vUv).r);
  float lumaIn = luma(colour);
  float neighbourhood = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      neighbourhood += luma(texture(uImage, vUv + vec2(float(x), float(y)) * uTexel).rgb * uGains);
    }
  }
  neighbourhood /= 9.0;
  float stretched = levels(lumaIn);
  float detail = stretched - baseLuma;
  float base = mix(baseLuma, 0.5, 0.3 * uLocalContrast);
  float lumaOut = base + detail * (1.0 + 1.6 * uLocalContrast);
  lumaOut += uSharpen * (lumaIn - neighbourhood) / max(uWhitePoint - uBlackPoint, 0.02);
  lumaOut = pow(clamp(lumaOut, 0.0, 1.0), uGamma);
  vec3 stretchedColour = vec3(levels(colour.r), levels(colour.g), levels(colour.b));
  vec3 scaled = stretchedColour * (lumaOut / max(stretched, 0.002));
  vec3 graded = mix(vec3(lumaOut), scaled, clamp(uSaturation * uManualSaturation, 0.0, 2.0));
  graded = (graded - 0.5) * uContrast + 0.5;
  graded *= uBrightness;
  outColor = vec4(clamp(graded, 0.0, 1.0), 1.0);
}`;

type Program = { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> };
type Target = { framebuffer: WebGLFramebuffer; texture: WebGLTexture; width: number; height: number };

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('shader allocation failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? 'unknown shader error';
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function link(gl: WebGL2RenderingContext, fragment: string, uniformNames: string[]): Program {
  const program = gl.createProgram();
  if (!program) throw new Error('program allocation failed');
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(program, vertex);
  gl.attachShader(program, frag);
  gl.bindAttribLocation(program, 0, 'position');
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(frag);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? 'unknown link error';
    gl.deleteProgram(program);
    throw new Error(log);
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
}

function createTexture(gl: WebGL2RenderingContext, filter: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('texture allocation failed');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

function createTarget(gl: WebGL2RenderingContext, width: number, height: number): Target {
  const texture = createTexture(gl, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const framebuffer = gl.createFramebuffer();
  if (!framebuffer) throw new Error('framebuffer allocation failed');
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { framebuffer, texture, width, height };
}

function deleteTarget(gl: WebGL2RenderingContext, target: Target | null) {
  if (!target) return;
  gl.deleteFramebuffer(target.framebuffer);
  gl.deleteTexture(target.texture);
}

export const ENHANCEMENT_SHADERS = { VERTEX, CROP_UPSCALE, DENOISE, BLUR, COMPOSE };

export function createEnhancementRenderer(canvas: HTMLCanvasElement): EnhancementRenderer | null {
  const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  if (!gl) return null;
  let lost = false;
  const onLost = (event: Event) => { event.preventDefault(); lost = true; };
  canvas.addEventListener('webglcontextlost', onLost);

  const quad = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const programs = {
    crop: link(gl, CROP_UPSCALE, ['uSource', 'uRoi', 'uSourceSize']),
    denoise: link(gl, DENOISE, ['uImage', 'uTexel', 'uDenoise']),
    blur: link(gl, BLUR, ['uImage', 'uStep', 'uFromColour']),
    compose: link(gl, COMPOSE, ['uImage', 'uBlurredLuma', 'uTexel', 'uBlackPoint', 'uWhitePoint', 'uGamma', 'uGains', 'uSaturation', 'uLocalContrast', 'uSharpen', 'uBrightness', 'uContrast', 'uManualSaturation']),
  };
  const sourceTexture = createTexture(gl, gl.NEAREST);
  let full: Target | null = null;
  let denoised: Target | null = null;
  let blurA: Target | null = null;
  let blurB: Target | null = null;
  let targetWidth = 0;
  let targetHeight = 0;

  const ensureTargets = (width: number, height: number) => {
    if (width === targetWidth && height === targetHeight && full) return;
    for (const target of [full, denoised, blurA, blurB]) deleteTarget(gl, target);
    full = createTarget(gl, width, height);
    denoised = createTarget(gl, width, height);
    const smallWidth = Math.max(8, Math.round(width / 8));
    const smallHeight = Math.max(8, Math.round(height / 8));
    blurA = createTarget(gl, smallWidth, smallHeight);
    blurB = createTarget(gl, smallWidth, smallHeight);
    targetWidth = width;
    targetHeight = height;
  };

  const draw = (target: Target | null, width: number, height: number) => {
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.framebuffer : null);
    gl.viewport(0, 0, width, height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  const bind = (unit: number, texture: WebGLTexture, location: WebGLUniformLocation | null) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  };

  const render = (source: EnhancementSource, input: RenderInput): boolean => {
    if (lost || gl.isContextLost()) return false;
    const { plan, manual, roi, sourceWidth, sourceHeight } = input;
    if (sourceWidth <= 0 || sourceHeight <= 0 || canvas.width <= 0 || canvas.height <= 0) return false;
    // Letterbox exactly as object-fit: contain does for the video underneath.
    const scale = Math.min(canvas.width / sourceWidth, canvas.height / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const offsetX = Math.floor((canvas.width - width) / 2);
    const offsetY = Math.floor((canvas.height - height) / 2);
    ensureTargets(width, height);
    if (!full || !denoised || !blurA || !blurB) return false;

    gl.bindVertexArray(vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTexture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      return false;
    }

    gl.useProgram(programs.crop.program);
    bind(0, sourceTexture, programs.crop.uniforms.uSource);
    gl.uniform4f(programs.crop.uniforms.uRoi, roi.x, roi.y, roi.width, roi.height);
    gl.uniform2f(programs.crop.uniforms.uSourceSize, sourceWidth, sourceHeight);
    draw(full, width, height);

    gl.useProgram(programs.denoise.program);
    bind(0, full.texture, programs.denoise.uniforms.uImage);
    gl.uniform2f(programs.denoise.uniforms.uTexel, 1 / width, 1 / height);
    gl.uniform1f(programs.denoise.uniforms.uDenoise, plan.denoise);
    draw(denoised, width, height);

    gl.useProgram(programs.blur.program);
    bind(0, denoised.texture, programs.blur.uniforms.uImage);
    gl.uniform2f(programs.blur.uniforms.uStep, 1 / blurA.width, 0);
    gl.uniform1i(programs.blur.uniforms.uFromColour, 1);
    draw(blurA, blurA.width, blurA.height);
    bind(0, blurA.texture, programs.blur.uniforms.uImage);
    gl.uniform2f(programs.blur.uniforms.uStep, 0, 1 / blurA.height);
    gl.uniform1i(programs.blur.uniforms.uFromColour, 0);
    draw(blurB, blurB.width, blurB.height);

    gl.useProgram(programs.compose.program);
    bind(0, denoised.texture, programs.compose.uniforms.uImage);
    bind(1, blurB.texture, programs.compose.uniforms.uBlurredLuma);
    gl.uniform2f(programs.compose.uniforms.uTexel, 1 / width, 1 / height);
    gl.uniform1f(programs.compose.uniforms.uBlackPoint, plan.blackPoint);
    gl.uniform1f(programs.compose.uniforms.uWhitePoint, plan.whitePoint);
    gl.uniform1f(programs.compose.uniforms.uGamma, plan.gamma);
    gl.uniform3f(programs.compose.uniforms.uGains, plan.gains[0], plan.gains[1], plan.gains[2]);
    gl.uniform1f(programs.compose.uniforms.uSaturation, plan.saturation);
    gl.uniform1f(programs.compose.uniforms.uLocalContrast, plan.localContrast);
    gl.uniform1f(programs.compose.uniforms.uSharpen, plan.sharpen * (manual.detail / 100));
    gl.uniform1f(programs.compose.uniforms.uBrightness, manual.brightness / 100);
    gl.uniform1f(programs.compose.uniforms.uContrast, manual.contrast / 100);
    gl.uniform1f(programs.compose.uniforms.uManualSaturation, manual.saturation / 100);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(offsetX, offsetY, width, height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return gl.getError() === gl.NO_ERROR;
  };

  const dispose = () => {
    canvas.removeEventListener('webglcontextlost', onLost);
    for (const target of [full, denoised, blurA, blurB]) deleteTarget(gl, target);
    for (const entry of Object.values(programs)) gl.deleteProgram(entry.program);
    gl.deleteTexture(sourceTexture);
    gl.deleteBuffer(quad);
    gl.deleteVertexArray(vao);
  };

  return { render, isLost: () => lost || gl.isContextLost(), dispose };
}
