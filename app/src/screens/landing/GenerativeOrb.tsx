import { useEffect, useRef } from 'react'
import * as THREE from 'three'

// Sienna, the hero's generative-art accent. Kept here (not in CSS) because
// the shader needs a numeric colour, not a custom property.
const SIENNA = '#A0522D'

// Icosahedron subdivision. High enough to read as a woven lattice, low enough
// that the wireframe stays delicate instead of collapsing into a solid mass.
const DETAIL = 8
const RADIUS = 1.2
const MAX_PIXEL_RATIO = 2

// The orb breathes rather than sitting still: a calm adult breath cycle,
// which is the rhythm the product is built around.
const BREATH_PERIOD_MS = 5500
const BASE_AMPLITUDE = 0.17
const BREATH_DEPTH = 0.038

// Rotation expressed per-millisecond so a dropped frame slows nothing down.
const SPIN_Y_PER_MS = 0.00003
const SPIN_X_PER_MS = 0.000012
const MAX_FRAME_MS = 64

// On the waitlist site this shader also carried a one-shot ring, fired when a
// signup succeeded, that travelled out across the orb as an answer. There is no
// signup event on this page to answer, so the ring uniform, its varying and the
// module-level emitter behind it are all gone rather than left dark.
const VERTEX_SHADER = /* glsl */ `
  uniform float time;
  uniform float amplitude;
  varying vec3 vNormal;
  varying vec3 vPosition;

  vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
  vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
  vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }

  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz);
    vec3 l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy);
    vec3 i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx;
    vec3 x2 = x0 - i2 + C.yyy;
    vec3 x3 = x0 - D.yyy;
    i = mod289(i);
    vec4 p = permute(permute(permute(
                i.z + vec4(0.0, i1.z, i2.z, 1.0))
              + i.y + vec4(0.0, i1.y, i2.y, 1.0))
              + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    float n_ = 0.142857142857;
    vec3 ns = n_ * D.wyz - D.xzx;
    vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
    vec4 x_ = floor(j * ns.z);
    vec4 y_ = floor(j - 7.0 * x_);
    vec4 x = x_ * ns.x + ns.yyyy;
    vec4 y = y_ * ns.x + ns.yyyy;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy);
    vec4 b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0;
    vec4 s1 = floor(b1) * 2.0 + 1.0;
    vec4 sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
    vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 p0 = vec3(a0.xy, h.x);
    vec3 p1 = vec3(a0.zw, h.y);
    vec3 p2 = vec3(a1.xy, h.z);
    vec3 p3 = vec3(a1.zw, h.w);
    vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
    p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
    vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
  }

  void main() {
    vNormal = normal;
    vPosition = position;

    float displacement = snoise(position * 1.5 + time * 0.5) * amplitude;

    vec3 newPosition = position + normal * displacement;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
  }
`

// Reworked for a light ground: instead of adding light to a dark background,
// we vary the *alpha* of a single sienna so the paper reads through the mesh.
// Rim strands sit strongest, interior strands fall away — an ink drawing that
// happens to breathe, rather than a glowing sci-fi object.
const FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 color;
  uniform vec3 pointLightPosition;
  uniform float opacity;
  varying vec3 vNormal;
  varying vec3 vPosition;

  void main() {
    vec3 normal = normalize(vNormal);
    vec3 lightDir = normalize(pointLightPosition - vPosition);
    float diffuse = max(dot(normal, lightDir), 0.0);

    float fresnel = 1.0 - abs(dot(normal, vec3(0.0, 0.0, 1.0)));
    fresnel = pow(fresnel, 2.0);

    float strength = 0.20 + diffuse * 0.40 + fresnel * 0.55;
    gl_FragColor = vec4(color, clamp(strength, 0.0, 1.0) * opacity);
  }
`

export default function GenerativeOrb() {
  const mountRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return undefined

    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reducedMotion = motionQuery.matches

    // Width/height can be 0 on the first frame if the column hasn't laid out
    // yet; fall back to 1 so the projection matrix stays finite.
    const width = mount.clientWidth || 1
    const height = mount.clientHeight || 1

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 1000)
    camera.position.z = 3

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      // No WebGL (old browser, blocked GPU). The orb is decorative — the hero
      // reads fine without it, so fail quiet rather than take the page down.
      return undefined
    }

    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO))
    renderer.setClearAlpha(0)
    mount.appendChild(renderer.domElement)

    const geometry = new THREE.IcosahedronGeometry(RADIUS, DETAIL)
    const material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        amplitude: { value: BASE_AMPLITUDE },
        opacity: { value: 0.8 },
        pointLightPosition: { value: new THREE.Vector3(0, 0, 5) },
        color: { value: new THREE.Color(SIENNA) },
      },
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      wireframe: true,
      transparent: true,
      // Overlapping strands should blend, not occlude each other — that's what
      // gives the lattice its x-ray depth.
      depthWrite: false,
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.rotation.set(0.35, 0.6, 0)
    scene.add(mesh)

    // Pointer position is only *recorded* on the event and applied inside the
    // animation loop, so a fast mouse can't force extra unprojections.
    const pointer = new THREE.Vector2(0, 0)
    let pointerDirty = true
    const lightTarget = new THREE.Vector3(0, 0, 5)

    const applyPointer = () => {
      const vec = new THREE.Vector3(pointer.x, pointer.y, 0.5).unproject(camera)
      const dir = vec.sub(camera.position).normalize()
      const distance = -camera.position.z / dir.z
      lightTarget.copy(camera.position).add(dir.multiplyScalar(distance))
      material.uniforms.pointLightPosition.value.copy(lightTarget)
    }

    let frameId: number | null = null
    let running = false
    let lastTimestamp = 0
    let activeElapsed = 0
    let onScreen = true

    const renderFrame = () => {
      if (pointerDirty) {
        applyPointer()
        pointerDirty = false
      }
      material.uniforms.time.value = activeElapsed * 0.0003
      renderer.render(scene, camera)
    }

    const step = (timestamp: number) => {
      if (!lastTimestamp) lastTimestamp = timestamp
      // Clamp so returning from a background tab doesn't jump the animation.
      const delta = Math.min(timestamp - lastTimestamp, MAX_FRAME_MS)
      lastTimestamp = timestamp

      activeElapsed += delta
      mesh.rotation.y += delta * SPIN_Y_PER_MS
      mesh.rotation.x += delta * SPIN_X_PER_MS
      material.uniforms.amplitude.value =
        BASE_AMPLITUDE +
        Math.sin((activeElapsed / BREATH_PERIOD_MS) * Math.PI * 2) * BREATH_DEPTH

      renderFrame()
      frameId = requestAnimationFrame(step)
    }

    function start() {
      if (running) return
      running = true
      lastTimestamp = 0
      frameId = requestAnimationFrame(step)
    }

    function stop() {
      running = false
      if (frameId !== null) cancelAnimationFrame(frameId)
      frameId = null
    }

    // An ambient loop has no business burning a phone battery once it has
    // scrolled out of view, or while the tab is in the background. Under
    // reduced motion it never runs at all — the orb is drawn once and holds.
    const sync = () => {
      if (onScreen && !document.hidden && !reducedMotion) start()
      else stop()
    }

    const intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting
        sync()
      },
      { threshold: 0 },
    )
    intersectionObserver.observe(mount)

    // The hero column resizes independently of the window (grid reflow), so
    // observe the element rather than listening for window resizes.
    const resizeObserver = new ResizeObserver(([entry]) => {
      const nextWidth = entry.contentRect.width || 1
      const nextHeight = entry.contentRect.height || 1
      camera.aspect = nextWidth / nextHeight
      camera.updateProjectionMatrix()
      renderer.setSize(nextWidth, nextHeight)
      if (!running) renderFrame()
    })
    resizeObserver.observe(mount)

    const handlePointerMove = (event: PointerEvent) => {
      pointer.x = (event.clientX / window.innerWidth) * 2 - 1
      pointer.y = -(event.clientY / window.innerHeight) * 2 + 1
      pointerDirty = true
      if (!running) renderFrame()
    }

    const handleMotionPreference = (event: MediaQueryListEvent) => {
      reducedMotion = event.matches
      sync()
      if (!running) renderFrame()
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: true })
    document.addEventListener('visibilitychange', sync)
    motionQuery.addEventListener('change', handleMotionPreference)

    renderFrame()
    sync()

    return () => {
      stop()
      intersectionObserver.disconnect()
      resizeObserver.disconnect()
      window.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('visibilitychange', sync)
      motionQuery.removeEventListener('change', handleMotionPreference)
      geometry.dispose()
      material.dispose()
      renderer.dispose()
      if (renderer.domElement.parentNode === mount) {
        mount.removeChild(renderer.domElement)
      }
    }
  }, [])

  return <div className="orb" ref={mountRef} aria-hidden="true" />
}
