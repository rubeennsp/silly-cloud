import { mat4 } from 'https://wgpu-matrix.org/dist/3.x/wgpu-matrix.module.js';

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
  const device = await adapter.requestDevice();

  /** @type {GPUCanvasContext} */
  const canvasContext = canvas.getContext("webgpu")
  canvasContext.configure({
    device,
    format: navigator.gpu.getPreferredCanvasFormat(),
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
  }

  @group(0) @binding(0) var<uniform> u : Uniforms;

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

  @fragment
  fn fragment_main(@location(0) ndc : vec2f) -> @location(0) vec4f {
    let reso : vec2f = u.resolution;
    let minres : f32 = min(reso.x, reso.y);
    let pos = ndc * reso / minres;
    var color = vec4f(pos, 0, 1);
    let fogDir = normalize(vec2f(1, -3));
    let fogStrength = smoothstep(-0.1, 1., dot(pos, fogDir)) * 0.5;
    let fogColor = vec3f(1, 1, 1);
    let bgColor = mix(skyBlue, fogColor, fogStrength);
    color = vec4f(bgColor, 1);
    return color;
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
  })
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
  
  
  // counter-clockwise triangle list with vertices and normals
  // assuming x-right, y-up, and z-out (right-handed coords)
  const boxVertexBufferData = new Float32Array([
    // z = 0
    0, 0, 0, 1,     0, 0, -1, 0,
    0, 1, 0, 1,     0, 0, -1, 0,
    1, 0, 0, 1,     0, 0, -1, 0,
    1, 0, 0, 1,     0, 0, -1, 0,
    0, 1, 0, 1,     0, 0, -1, 0,
    1, 1, 0, 1,     0, 0, -1, 0,
    // z = 1
    0, 0, 1, 1,     0, 0, 1, 0,
    1, 0, 1, 1,     0, 0, 1, 0,
    0, 1, 1, 1,     0, 0, 1, 0,
    0, 1, 1, 1,     0, 0, 1, 0,
    1, 0, 1, 1,     0, 0, 1, 0,
    1, 1, 1, 1,     0, 0, 1, 0,
    // y = 0
    0, 0, 0, 1,     0, -1, 0, 0,
    1, 0, 0, 1,     0, -1, 0, 0,
    0, 0, 1, 1,     0, -1, 0, 0,
    0, 0, 1, 1,     0, -1, 0, 0,
    1, 0, 0, 1,     0, -1, 0, 0,
    1, 0, 1, 1,     0, -1, 0, 0,
    // y = 1
    0, 1, 0, 1,     0, 1, 0, 0,
    0, 1, 1, 1,     0, 1, 0, 0,
    1, 1, 0, 1,     0, 1, 0, 0,
    1, 1, 0, 1,     0, 1, 0, 0,
    0, 1, 1, 1,     0, 1, 0, 0,
    1, 1, 1, 1,     0, 1, 0, 0,
    // x = 0
    0, 0, 0, 1,     -1, 0, 0, 0,
    0, 0, 1, 1,     -1, 0, 0, 0,
    0, 1, 0, 1,     -1, 0, 0, 0,
    0, 1, 0, 1,     -1, 0, 0, 0,
    0, 0, 1, 1,     -1, 0, 0, 0,
    0, 1, 1, 1,     -1, 0, 0, 0,
    // x = 1
    1, 0, 0, 1,     1, 0, 0, 0,
    1, 1, 0, 1,     1, 0, 0, 0,
    1, 0, 1, 1,     1, 0, 0, 0,
    1, 0, 1, 1,     1, 0, 0, 0,
    1, 1, 0, 1,     1, 0, 0, 0,
    1, 1, 1, 1,     1, 0, 0, 0,
  ])
  const boxVertexBuffer = device.createBuffer({
    size: boxVertexBufferData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  device.queue.writeBuffer(boxVertexBuffer, 0, boxVertexBufferData);
  const boxShaderModule = device.createShaderModule({
    code: /* wgsl */`
      struct VertexOut {
        @builtin(position) ndcPos : vec4f,
        @location(0) worldPos : vec3f,
        @location(1) worldNormal : vec3f,
        @location(2) objPos : vec3f,
      }

      struct Uniforms {
        M : mat4x4<f32>, // object to world
        V : mat4x4<f32>, // world to view
        P : mat4x4<f32>, // view to NDC
        V_inv : mat4x4<f32>, // view to world
        time : f32,
      }
      @group(0) @binding(0) var<uniform> u : Uniforms;

      @vertex
      fn vertex_main(
        @location(0) position : vec4f,
        @location(1) normal : vec3f,
      ) -> VertexOut {
        let worldPos = u.M * position;
        let worldNormal = u.M * vec4f(normal, 0);
        var ndcPos = u.P * u.V * worldPos;
        // ndcPos /= ndcPos.w; // Don't perform perspective divide, hardware needs the w!
        return VertexOut(
          ndcPos,
          worldPos.xyz, // w should be 1
          worldNormal.xyz, // w should be 0
          position.xyz // w should be 0
        );
      }

      fn max3(v: vec3f) -> f32 { return max(v.x, max(v.y, v.z)); }

      fn sdBox(pos: vec3f, size: vec3f) -> f32 {
        let allAxes = abs(pos) - size;
        let positives = max(allAxes, vec3f(0, 0, 0));
        let negatives = min(allAxes, vec3f(0, 0, 0));
        return length(positives) + max3(negatives);
      }

      fn sdScene(pos: vec3f) -> f32 {
        let boxCenter = vec3f(sin(u.time), 0, 0);
        return sdBox(pos - boxCenter, vec3f(0.5, 0.5, 0.5));
      }

      @fragment
      fn fragment_main(
        @builtin(position) ndcPos : vec4f,
        @location(0) worldPos : vec3f,
        @location(1) worldNormal : vec3f,
        @location(2) objPos : vec3f,
      ) -> @location(0) vec4f {
        var eye = vec3f(0, 0, 0); // view-space eye coords
        eye = (u.V_inv * vec4f(eye, 1)).xyz; // world-space eye coords
        var color = vec3f(0.8, 0.8, 1);

        // Loop constants
        let raydir : vec3f = normalize(worldPos - eye);
        const numIter : u32 = 100;
        const eps : f32 = 0.01;

        // Loop variables
        // var t: f32 = distance(eye, worldPos);
        var t: f32 = 0;
        var hit: bool = false;

        for (var i: u32 = 0; i < numIter; i++) {
          let pos = eye + raydir * t;
          let dist = sdScene(pos);
          if (abs(dist) < eps) {
            hit = true;
            break;
          }
          t += dist;
        }

        if (hit) {
          color = abs(raydir);
        }

        return vec4f(color, 1);
      }
    `,
  })

  const timeStart = performance.now() / 1000.
  let time = 0;
  let prevUpload = upload;

  function update() {
    if (prevUpload != upload) {
      console.log({upload})
      prevUpload = upload
    }
    const now = performance.now() / 1000. // time in seconds
    time = now - timeStart;
  }

  // Create uniform buffer
  const uniformBuffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: "rectangle-uniform-buffer"
  })

  const uniformBindGroupLayout = rectanglePipeline.getBindGroupLayout(0)
  const uniformBindGroup = device.createBindGroup({
    entries: [{ binding: 0, resource: uniformBuffer }],
    layout: uniformBindGroupLayout,
  })

  const boxUniformBuffer = device.createBuffer({
    size: 16 * 4 * 4 + 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    label: "box-uniform-buffer"
  })

  console.log(mat4)

  function render() {
    // Prepare render target
    const canvasTexture = context.getCurrentTexture()
    const canvasTextureView = canvasTexture.createView()

    device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([
      canvas.width,
      canvas.height,
      time,
    ]))

    // Record commands and submit
    const commandEncoder = device.createCommandEncoder()
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
    const commandBuffer = commandEncoder.finish()
    device.queue.submit([commandBuffer])
  }

  // TODO: Make the flow of data clearer between update and render.
  async function animationLoop() {
    // Update world state
    const renderStartTime = performance.now()
    update()

    // Perform rendering work
    render()

    // Next frame
    requestAnimationFrame(animationLoop)
  }
  animationLoop();

}

main()
