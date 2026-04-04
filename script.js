import { mat4 } from 'https://wgpu-matrix.org/dist/3.x/wgpu-matrix.module.js';
console.log(mat4)

/** @param {HTMLCanvasElement} canvas  */
async function initWebGPU(canvas) {
  if (!navigator.gpu) {
    alert("Error: WebGPU features are unavailable (!navigator.gpu)")
    throw Error("WebGPU not supported.");
  }
  let adapter;
  try {
    adapter = await navigator.gpu.requestAdapter();
  } catch (error) {
    console.error(error);
    alert("Error: couldn't request WebGPU adapter")
  }
  if (!adapter) {
    throw Error("Couldn't request WebGPU adapter.");
  }

  // TODO: Only require features that are absolutely needed. For example, when
  //       debug textures aren't used, we won't need 'bgra8unorm-storage'.
  // TODO: Check support for 'float32-filterable' and figure out fallbacks.
  const requiredFeatures = [
    'bgra8unorm-storage', // to use canvas textures as storage textures for debugging
    'float32-filterable', // to use r32float textures as filtered and sampled textures
  ]
  let device;
  try {
    device = await adapter.requestDevice({ requiredFeatures })
  } catch (error) {
    console.error(error)
    alert(`Error: couldn't request WebGPU device with features ${requiredFeatures}`)
    throw Error("Couldn't request WebGPU device")
  }


  /** @type {GPUCanvasContext} */
  const canvasContext = canvas.getContext("webgpu")
  canvasContext.configure({
    device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST,
    alphaMode: "premultiplied",
  });

  return {
    device: device,
    context: canvasContext,
  };
}

const rectangleShaders = /*wgsl*/ `
  const skyBlue = vec3f(0.53, 0.81, 0.92);

  struct VertexOut {
    @builtin(position) position : vec4f,
    @location(0) ndc : vec2f,
  };

  struct Uniforms {
    resolution : vec2f,
    time : f32,
    show : f32,
    sdfTextureRes : vec2f,
  }

  @group(0) @binding(0) var<uniform> u : Uniforms;
  @group(0) @binding(1) var sdfTexture : texture_2d<f32>;
  @group(0) @binding(2) var s : sampler;

  fn rot2d(time : f32) -> mat2x2<f32> {
    return mat2x2<f32>(cos(time), sin(time), -sin(time), cos(time));
  }

  @vertex
  fn vertex_main(@location(0) position : vec4f) -> VertexOut {
    var output : VertexOut;
    let screenpos = position.xy;
    output.position = vec4f(screenpos, 0, 1);
    output.ndc = position.xy;
    return output;
  }

  
  fn random(x: vec3f) -> f32 {
      // x = abs(x) + 1. ;
      var result : f32;
      result = dot(x, vec3f(0.638234, 0.913, 0.327));
      result = fract(result);
      result *= 20.234;
      result = sin(result);
      result *= 5035.34324;
      result = fract(result);
      result = sin(result);
      result *= 1102.34324;
      result = fract(result);
      return result;
  }
  fn noise(p_: vec3f) -> f32 {
      // data value at corners
      var p = p_;
      let f000: f32 = random(floor(p + vec3f(0, 0, 0)));
      let f010: f32 = random(floor(p + vec3f(0, 1, 0)));
      let f100: f32 = random(floor(p + vec3f(1, 0, 0)));
      let f110: f32 = random(floor(p + vec3f(1, 1, 0)));
      let f001: f32 = random(floor(p + vec3f(0, 0, 1)));
      let f011: f32 = random(floor(p + vec3f(0, 1, 1)));
      let f101: f32 = random(floor(p + vec3f(1, 0, 1)));
      let f111: f32 = random(floor(p + vec3f(1, 1, 1)));

      // smoothstep polynomial (for interpolation coefficient)

      p = fract(p);
      p = p * (3. * p - 2. * p * p);

      // interpolate corners
      let fx00: f32 = mix(f000, f100, p.x);
      let fx10: f32 = mix(f010, f110, p.x);
      let fx01: f32 = mix(f001, f101, p.x);
      let fx11: f32 = mix(f011, f111, p.x);
      let fxy0: f32 = mix(fx00, fx10, p.y);
      let fxy1: f32 = mix(fx01, fx11, p.y);
      let fxyz: f32 = mix(fxy0, fxy1, p.z);

      return fxyz;
  }

  fn fbm(p_ : vec3f) -> f32 {
      // domain scale
      var p = p_;
      p = p * 15.;

      var result : f32 = 0.;
      var contrib : f32 = 1.;
      var freqStep : f32 = 2.5;
      var contribStep : f32 = 0.5;
      var contribTotal : f32 = 0.;
      const NUM_OCTAVES : u32 = 4;
      for (var i: u32 = 0; i < NUM_OCTAVES; i++) {
          result += noise(p) * contrib;
          contribTotal += contrib;
          
          p *= freqStep;
          contrib *= contribStep;
      }
      result /= contribTotal;
      
      return result;
  }

  fn sdCircle(pos : vec2f, center : vec2f, rad : f32) -> f32 {
    return distance(pos, center) - rad; 
  }

  fn sdFaceScene(pos: vec2f) -> f32 {
    let dist1 = sdCircle(pos, vec2f(0, 0), 0.755);
    let distEye1 = -sdCircle(pos, vec2f(0.27, 0.16), 0.1);
    let distEye2 = -sdCircle(pos, vec2f(-0.3, 0.16), 0.1);
    let distMouth = -sdCircle(pos, vec2f(-0.04, -0.31), 0.225);
    return max(max(max(dist1, distEye1), distEye2), distMouth);
  }

  fn sdScene(pos : vec2f) -> f32 {
    // TODO: Improve how we handle scaling so it's clearer how to control it
    var texCoords = vec2f(pos.x, -pos.y + 0.5) / u.sdfTextureRes * u.sdfTextureRes.y / 1.5;
    return textureSample(sdfTexture, s, texCoords).r / u.sdfTextureRes.y * 1.8;
  }

  fn renderCloud(pos : vec2f, offset : vec2f) -> vec4f {
    let localpos = pos - offset;
    var dist = sdScene(localpos);
    let speed = vec2f(0.04, 0);
    let noise : f32 = fbm(vec3f((localpos  * 0.8 - speed * u.time), u.time * 0.02));
    dist += (noise - 0.5) * 0.15;
    let alpha = smoothstep(0.06, -0.06, dist);
    var colornoise = fbm(vec3f(localpos - speed * u.time, 0));
    colornoise = pow(colornoise, 0.5);
    let baseColor = mix(vec3f(1, 1, 1) * 0.85, vec3f(1, 1, 1), colornoise);

    return vec4f(baseColor, alpha);
  }

  @fragment
  fn fragment_main(@location(0) ndc : vec2f) -> @location(0) vec4f {
    let reso : vec2f = u.resolution;
    let minres : f32 = min(reso.x, reso.y);
    let pos = ndc * reso / minres;
    var offset = u.time * -0.2;
    offset = 0;
    let period = reso.x / minres * 5.;
    offset /= period;
    offset = fract(offset);
    offset *= period;
    offset -= period * 0.5;
    let fgColor : vec4f = renderCloud(pos, vec2f(offset, 0));
    let fogDir = normalize(vec2f(1, -3));
    let fogStrength = smoothstep(-0.1, 1., dot(pos, fogDir)) * 0.7;
    let fogColor = vec3f(1, 1, 1);
    let bgColor = mix(skyBlue, fogColor, fogStrength);
    // let color = mix(bgColor, fgColor.rgb, fgColor.a * u.show);
    let color = mix(bgColor, fgColor.rgb, fgColor.a);
    return vec4f(color, 1);
  }
`;

let depthTexture
/** @param {HTMLCanvasElement} canvas */
function resizeGPUCanvas(canvas, device) {
  canvas.width = document.documentElement.clientWidth
  canvas.height = document.documentElement.clientHeight
  depthTexture = device.createTexture({
    size: [canvas.width, canvas.height],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
    label: "depth",
  })
}

/**
 * @param {GPUDevice} device
 * @param {string} text
 * @param {string} label
 * @returns {GPUTexture}
 */
function createTextTexture(device, text, label) {
  const fontSize = 80
  const padding = { x: 25, y: 25 }
  const font = `bold ${fontSize}px "Comic Sans MS"`

  const canvas = new OffscreenCanvas(0, 0)
  const context = canvas.getContext("2d")
  context.font = font
  const textMetrics = context.measureText(text)
  const textWidth = textMetrics.actualBoundingBoxRight - textMetrics.actualBoundingBoxLeft
  const textHeight = textMetrics.actualBoundingBoxAscent + textMetrics.actualBoundingBoxDescent
  canvas.height = textHeight + padding.y * 2
  canvas.width = textWidth + padding.x * 2
  context.fillStyle = "transparent"
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.fillStyle = "white"
  context.textBaseline = "middle"
  context.textAlign = "start"
  context.font = font
  context.fillText(text, padding.x, canvas.height / 2)

  return createTextureFromCanvas(device, canvas, label)
}

/**
 * Create a texture with contents initialized from a canvas
 * @param {GPUDevice} device
 * @param {OffscreenCanvas | HTMLCanvasElement} canvas
 *
 * @returns {GPUTexture}
 */
function createTextureFromCanvas(device, canvas, label) {
  const texture = device.createTexture({
    dimension: "2d",
    format: navigator.gpu.getPreferredCanvasFormat(),
    size: [canvas.width, canvas.height],
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING
           | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    label,
  })
  device.queue.copyExternalImageToTexture(
    { source: canvas },
    { texture, premultipliedAlpha: true },
    [canvas.width, canvas.height]
  )
  return texture
}

/**
 * Calculate the SDF of a 2D image with the Jump Flooding Algorithm
 * @param {GPUDevice} device
 * @param {GPUTexture} srcTexture
 */
function calculateSDF(device, srcTexture, label) {
  const { width, height } = srcTexture
  const steps = [64, 32, 16, 8, 4, 2, 1, 1]

  // Create seed buffers

  const seedBufferLabels = [
    label ? `${label}-jump-flooding-seed1-buffer` : "jump-flooding-seed1-buffer",
    label ? `${label}-jump-flooding-seed2-buffer` : "jump-flooding-seed2-buffer",
  ]

  const seedSizeBytes = 4 * 4; // the stride of a vec3u array (four u32 values)
  const [seed1, seed2] = seedBufferLabels.map(label => device.createBuffer({
    size: width * height * seedSizeBytes,
    usage: GPUBufferUsage.STORAGE,
    label,
  }))

  // Create SDF texture

  const sdf = device.createTexture({
    size: [width, height],
    dimension: "2d",
    format: "r32float",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    label: label ? `${label}-sdf-texture` : "sdf-texture",
  })

  // Create debug texture
  const debugTextures = steps.map((step, i) => device.createTexture({
    size: [width, height],
    dimension: "2d",
    format: navigator.gpu.getPreferredCanvasFormat(),
    usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    label: label ? `${label}-jump-flooding-debug-texture-${i}-${step}` : `jump-flooding-debug-texture-${i}-${step}`,
  }))

  // Create compute pipeline

  const tileSize = 16
  const numTiles = [Math.ceil(width / tileSize), Math.ceil(height / tileSize)]
  const jfaShaderModule = device.createShaderModule({
    code: /* wgsl */`
      struct Uniforms {
        dims : vec2u,
        step : u32,
      };

      @group(0) @binding(0) var<uniform> u : Uniforms;
      @group(0) @binding(1) var<storage, read_write> dstSeed : array<vec3u>;
      @group(0) @binding(2) var<storage, read_write> srcSeed : array<vec3u>;
      @group(0) @binding(3) var srcTex : texture_2d<f32>;
      @group(0) @binding(4) var dstDist : texture_storage_2d<r32float, write>;
      @group(0) @binding(5) var debugTex : texture_storage_2d<bgra8unorm, write>;

      // For pixels outside the shape, the seed's xy component stores the
      // position of the closest known pixel that is inside the shape.
      // For pixels inside the shape, the seed's xy component stores the
      // position of the closest known pixel that is outside the shape.
      //
      // This NO_SEED value is a sentinel value indicating that no such pixel
      // is known yet.
      //
      const NO_SEED = ~vec2u(0, 0);

      // stored in a seed's z component to indicate whether we're inside a shape
      const OUTSIDE : u32 = 1;
      const INSIDE : u32 = 2;

      // get flat idx to seed buffer from global xy coords
      fn get_idx(coord : vec2u) -> u32 {
        return u.dims.x * coord.y + coord.x;
      }

      // Get the squared distance between two xy coords.
      //
      // This is meant to be fast 32-bit computation.
      // It *will* overflow if the distance is too big.
      // Using f32 or u64 will alleviate the overflow problem but these 32-bit
      // integers will be sufficient for our texture sizes.
      //
      fn dist2(v1 : vec2u, v2 : vec2u) -> u32 {
        // The casts are no-ops but they're here for... clarity? Reassurance?
        let dx = i32(v1.x) - i32(v2.x);
        let dy = i32(v1.y) - i32(v2.y);
        return u32(dx * dx + dy * dy);
      }

      @compute @workgroup_size(${tileSize}, ${tileSize})
      fn init_seed(@builtin(global_invocation_id) gid : vec3u) {
        if (!(gid.x < u.dims.x && gid.y < u.dims.y)) {
          return;
        }
        let pos: vec2u = gid.xy;
        let idx: u32 = get_idx(pos);
        if (textureLoad(srcTex, pos, 0).a > 0.5) {
          dstSeed[idx] = vec3u(NO_SEED, INSIDE);
        } else {
          dstSeed[idx] = vec3u(NO_SEED, OUTSIDE);
        }
      }

      @compute @workgroup_size(${tileSize}, ${tileSize})
      fn jump_flooding_pass(@builtin(global_invocation_id) gid : vec3u) {
        if (!(gid.x < u.dims.x && gid.y < u.dims.y)) {
          return;
        }
        let pos: vec2u = gid.xy; // the current position

        // Read neighbor seeds to discover points on the other side of (across)
        // the surface. Find the one that's closest to the current position.
        var bestSeed = srcSeed[get_idx(pos)];
        for (var i : i32 = -1; i <= 1; i++) {
          for (var j : i32 = -1; j <= 1; j++) {
            if (i == 0 && j == 0) { continue; } // skip current position
            // calculate neighbor's pixel coordinates
            let neighborPos = vec2i(
              i32(pos.x) + i * i32(u.step),
              i32(pos.y) + j * i32(u.step),
            );
            if (neighborPos.x < 0 || neighborPos.x >= i32(u.dims.x)
                || neighborPos.y < 0 || neighborPos.y >= i32(u.dims.y)) {
              continue; // This neighbor is out-of-bounds, so skip it.
            }
            let neighborSeed = srcSeed[get_idx(vec2u(neighborPos))];

            // Check neighbor to get a point on the other side of the surface
            // to use as a candidate to challenge the current best seed.
            var candidatePos : vec2u;
            if (neighborSeed.z != bestSeed.z) {
              // This neighbor *itself* is on the other side of the surface.
              candidatePos = vec2u(neighborPos);
            } else {
              // This neighbor is on the same side of the surface.
              // Its *seed*, if it exists, is on the other side of the surface.
              if (all(neighborSeed.xy == NO_SEED)) {
                continue; // Didn't find candidate pos on other side of surface.
              }
              candidatePos = neighborSeed.xy;
            }
            // Update best seed if this candidate is closer to current pos
            if (all(bestSeed.xy == NO_SEED)
                || dist2(candidatePos, pos) < dist2(bestSeed.xy, pos)) {
              bestSeed = vec3u(candidatePos, bestSeed.z);
            }
          }
        }

        // Output the best seed found after checking neighbors.
        dstSeed[get_idx(pos)] = bestSeed;

        // TODO: Remove this debug output when it is no longer needed
        // debug
        var debugVal : vec4f;
        if (!all(bestSeed.xy == NO_SEED)) {
          let dist = sqrt(f32(dist2(bestSeed.xy, pos)));
          const PI = 3.14159;
          let brightness = (sin(dist * 2. * PI / 2.5) * 0.12 + sin(dist * 2. * PI / 9.) * 0.08) + 0.5;
          var color : vec3f;
          if (bestSeed.z == OUTSIDE) {
            color = vec3f(1, 0, 0);
          } else if (bestSeed.z == INSIDE) {
            color = vec3f(0, 0, 1);
          } else {
            // We should NOT see this green color
            // because every pixel has to be either OUTSIDE or INSIDE.
            color = vec3f(0, 1, 0);
          }
          debugVal = vec4f(1 - (1 - color) * (1 - brightness), 1);
        } else {
          debugVal = vec4f(0.2, 0, 0, 1);
        }
        textureStore(debugTex, pos, debugVal);
      }

      @compute @workgroup_size(${tileSize}, ${tileSize})
      fn write_sdf_output(@builtin(global_invocation_id) gid : vec3u) {
        if (!(gid.x < u.dims.x && gid.y < u.dims.y)) {
          return;
        }
        let pos: vec2u = gid.xy; // the current position

        let seed = srcSeed[get_idx(pos)];
        var sign : f32 = 1.;
        if (seed.z == INSIDE) {
          sign = -1;
        }
        let unsignedDist: f32 = length(vec2f(seed.xy) - vec2f(pos)) - 0.5;

        textureStore(dstDist, pos, vec4f(sign * unsignedDist, 0, 0, 0));
      }
    `,
    label: "sdf-shader-module"
  })

  const initSeedPipeline = device.createComputePipeline({
    compute: {
      module: jfaShaderModule,
      entryPoint: "init_seed",
    },
    layout: "auto",
    label: "jump-flooding-init-seed-pipeline",
  })

  const jumpFloodingPipeline = device.createComputePipeline({
    compute: {
      module: jfaShaderModule,
      entryPoint: "jump_flooding_pass",
    },
    layout: "auto",
    label: "jump-flooding-pass-pipeline",
  })

  const sdfOutputPipeline = device.createComputePipeline({
    compute: {
      module: jfaShaderModule,
      entryPoint: "write_sdf_output",
    },
    layout: "auto",
    label: "sdf-output-pipeline",
  })

  // Create uniform buffers

  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: "rectangle-uniform-buffer"
  })
  device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([width, height]))

  const initSeedBindGroup = device.createBindGroup({
    entries: [
      { binding: 0, resource: uniformBuffer },
      { binding: 1, resource: seed1 },
      { binding: 3, resource: srcTexture },
    ],
    layout: initSeedPipeline.getBindGroupLayout(0),
    label: "jump-flooding-init-seed-bind-group",
  })

  // Run computation: jump-flooding seed initialization

  const commandEncoder = device.createCommandEncoder({
    label: "jump-flooding-init-seed-command-encoder"
  })
  const passEncoder = commandEncoder.beginComputePass({
    label: label ? `${label}-jump-flooding-init-seed-compute-pass` : "jump-flooding-init-seed-compute-pass"
  })
  passEncoder.setPipeline(initSeedPipeline)
  passEncoder.setBindGroup(0, initSeedBindGroup)
  passEncoder.dispatchWorkgroups(...numTiles)
  passEncoder.end()
  const commandBuffer = commandEncoder.finish()
  device.queue.submit([commandBuffer])

  // Run computation: jump-flooding passes

  /** @type {GPUTexture} */
  let lastSeedBuffer;

  steps.forEach((step, i) => {
    const dstSeedBuffer = (i % 2 == 0) ? seed2 : seed1
    const srcSeedBuffer = (i % 2 == 0) ? seed1 : seed2
    lastSeedBuffer = dstSeedBuffer

    const bindGroup = device.createBindGroup({
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: dstSeedBuffer },
        { binding: 2, resource: srcSeedBuffer },
        { binding: 5, resource: debugTextures[i] },
      ],
      layout: jumpFloodingPipeline.getBindGroupLayout(0),
      label: `jump-flooding-pass-${i}-${step}-bind-group`,
    })

    device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([width, height, step]))

    const commandEncoder = device.createCommandEncoder({
      label: "jump-flooding-pass-command-encoder"
    })

    const passEncoder = commandEncoder.beginComputePass({
      label: label ? `${label}-jump-flooding-pass-compute-pass` : "jump-flooding-pass-compute-pass"
    })
    passEncoder.setPipeline(jumpFloodingPipeline)
    passEncoder.setBindGroup(0, bindGroup)
    passEncoder.dispatchWorkgroups(...numTiles)
    passEncoder.end()
    const commandBuffer = commandEncoder.finish()
    device.queue.submit([commandBuffer])
  })

  // Run compute shader: write to SDF output texture

  {
    const bindGroup = device.createBindGroup({
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 2, resource: lastSeedBuffer },
        { binding: 4, resource: sdf },
      ],
      layout: sdfOutputPipeline.getBindGroupLayout(0),
      label: `sdf-output-bind-group`,
    })

    device.queue.writeBuffer(uniformBuffer, 0, new Uint32Array([width, height]))

    const commandEncoder = device.createCommandEncoder({
      label: 'sdf-output-command-encoder'
    })
    const passEncoder = commandEncoder.beginComputePass({
      label: 'sdf-output-compute-pass'
    })
    passEncoder.setPipeline(sdfOutputPipeline)
    passEncoder.setBindGroup(0, bindGroup)
    passEncoder.dispatchWorkgroups(...numTiles)
    passEncoder.end()
    const commandBuffer = commandEncoder.finish()
    device.queue.submit([commandBuffer])
  }

  return { sdf, debugTextures }
}

async function main() {
  // Get DOM elements
  /** @type {HTMLCanvasElement} */
  const canvas = document.querySelector("#gpu-canvas")
  console.log(canvas)

  const perfData = {
    renderTimes: []
  }
  const perfElements = {
    /** @type {HTMLParagraphElement} */
    renderTimeAvg: document.querySelector("#render-time-avg"),
    renderTimeMax: document.querySelector("#render-time-max"),
    renderTimeMin: document.querySelector("#render-time-min"),
  }

  // Init webgpu
  const { device, context } = await initWebGPU(canvas);
  console.log(device, context);

  // Create text rendering texture
  const textTexture = createTextTexture(device, "Hello, SillyCloud!", "text-texture")
  const sdfOutput = calculateSDF(device, textTexture, "text-sdf")


  // File input

  let upload = null
  const fileInputElement = document.querySelector("#file-input")
  fileInputElement.addEventListener("change", handleFileInput)
  fileInputElement.addEventListener("click", function() { this.value = null })

  /** @param {File} file */
  async function handleImageFile(file) {
    const bitmap = await createImageBitmap(file)
    console.log({ bitmap })
    const texture = device.createTexture({
      size: [bitmap.width, bitmap.height, 1],
      format: "rgba32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_DST
        | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
      label: "uploaded-image",
    })
    device.queue.copyExternalImageToTexture({source: bitmap}, {texture}, [bitmap.width, bitmap.height, 1])
    upload = {
      type: "image",
      texture,
    }
  }

  /** @param {File} file */
  async function handleTextFile(file) {
    const reader = new FileReader()
    reader.readAsText(file)
    reader.addEventListener("load", function() {
      upload = {
        type: "text",
        text: reader.result,
      }
    })
  }

  function handleFileInput() {
    console.log("File Upload!")
    /** @type {File} */
    const file = this.files[0];
    if (file.type.startsWith("image/")) {
      handleImageFile(file)
    } else if (file.type.startsWith("text/")) {
      handleTextFile(file)
    } else {
      alert(`Error: cannot handle file of type ${file.type}`)
      console.log(file)
      this.value = null
    }
  }

  window.addEventListener("resize", () => resizeGPUCanvas(canvas, device))
  resizeGPUCanvas(canvas, device)

  // Create shader module
  const rectangleShaderModule = device.createShaderModule({
    code: rectangleShaders,
    label: "rectangle-shader-module",
  });

  // Create vertex buffer layout
  /** @type {GPUVertexBufferLayout} */
  const vertexBufferLayouts = {
    arrayStride: 16, // four floats
    stepMode: "vertex",
    attributes: [
      {
        format: "float32x4",
        offset: 0,
        shaderLocation: 0,
      },
    ],
  }

  // Create render pipeline
  const rectanglePipeline = device.createRenderPipeline({
    vertex: {
      module: rectangleShaderModule,
      entryPoint: "vertex_main",
      buffers: [vertexBufferLayouts],
    },
    fragment: {
      module: rectangleShaderModule,
      entryPoint: "fragment_main",
      targets: [
        { format: navigator.gpu.getPreferredCanvasFormat() },
      ],
    },
    layout: "auto",
    
    depthStencil: {
      depthWriteEnabled: true,
      depthCompare: "less",
      format: "depth24plus",
    },
    label: "rectangle-pipeline",
  });

  // Create vertex buffer
  const rectangleVertexBufferData = new Float32Array([
    -1, -1, 0, 1,
     1, -1, 0, 1,
    -1,  1, 0, 1,
    -1,  1, 0, 1,
     1, -1, 0, 1,
     1,  1, 0, 1,
  ])
  const rectangleVertexBuffer = device.createBuffer({
    size: rectangleVertexBufferData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(rectangleVertexBuffer, 0, rectangleVertexBufferData);

  let timeStart = performance.now() / 1000.
  let time = 0;
  let prevUpload = upload;

  function update() {
    const now = performance.now() / 1000. // time in seconds
    if (prevUpload != upload) {
      console.log({upload})
      prevUpload = upload
      timeStart = now // restart time to 0
    }
    time = now - timeStart;
  }

  // Create texture sampler for sdf
  const sdfSampler = device.createSampler({
    label: 'sdf-sampler',
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
  })

  // Create uniform buffer
  const uniformBuffer = device.createBuffer({
    size: 24,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: "rectangle-uniform-buffer"
  })

  function render() {
    // Prepare render target
    const canvasTexture = context.getCurrentTexture()
    const canvasTextureView = canvasTexture.createView()

    device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([
      canvas.width,
      canvas.height,
      time,
      upload ? 1.0 : 0.0,
      sdfOutput.sdf.width,
      sdfOutput.sdf.height,
    ]))

    // Create bind group
    const uniformBindGroup = device.createBindGroup({
      entries: [
        { binding: 0, resource: uniformBuffer },
        { binding: 1, resource: sdfOutput.sdf },
        { binding: 2, resource: sdfSampler },
      ],
      layout: rectanglePipeline.getBindGroupLayout(0),
    })

    // Record commands and submit
    const commandEncoder = device.createCommandEncoder({
      label: "rectangle-command-encoder",
    })
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          loadOp: "clear",
          storeOp: "store",
          view: canvasTextureView,
          clearValue: [0, 0, 0, 1],
        }
      ],
      depthStencilAttachment: {
        view: depthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "discard",
      },
    })
    // draw triangle
    passEncoder.setPipeline(rectanglePipeline)
    passEncoder.setVertexBuffer(0, rectangleVertexBuffer, 0, rectangleVertexBuffer.size);
    passEncoder.setBindGroup(0, uniformBindGroup)
    passEncoder.draw(6);

    passEncoder.end()

    // debug: show textures
    function blitTexture(dstTexture, srcTexture, origin) {
      const [originX, originY] = origin
      const copySize = [
        Math.min(textTexture.width, canvasTexture.width - originX),
        Math.min(textTexture.height, canvasTexture.height - originY)
      ]
      if (copySize.some(size => size <= 0))
        return
      commandEncoder.copyTextureToTexture(
        { texture: srcTexture },
        { texture: dstTexture, origin },
        copySize,
      )
    }

    blitTexture(canvasTexture, textTexture, [5, 5])

    sdfOutput.debugTextures.slice(-1).forEach((debugTexture, i) => {
      blitTexture(canvasTexture, debugTexture, [5, 5 + (textTexture.height + 10) * (i + 1)])
    })

    const commandBuffer = commandEncoder.finish()
    device.queue.submit([commandBuffer])
  }

  // TODO: Make the flow of data clearer between update and render.
  async function animationLoop() {
    // Update world state
    update()

    // Perform rendering work
    render()

    // Next frame
    requestAnimationFrame(animationLoop)
  }
  animationLoop();

}

main()
