// 360 Panorama Viewer
// Uses Sphere.js to create an immersive panorama viewer

const canvas = document.getElementById('glCanvas');
const gl = canvas.getContext('webgl', { antialias: true });

if (!gl) {
    alert('WebGL not supported');
}

// Resize canvas to fit window
function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    gl.viewport(0, 0, canvas.width, canvas.height);
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// Shader programs
const vertexShaderSource = `
    attribute vec3 aPosition;
    attribute vec3 aNormal;
    attribute vec2 aTexCoord;
    
    uniform mat4 uModel;
    uniform mat4 uView;
    uniform mat4 uProjection;
    
    varying vec2 vTexCoord;
    varying vec3 vNormal;
    
    void main() {
        gl_Position = uProjection * uView * uModel * vec4(aPosition, 1.0);
        vTexCoord = aTexCoord;
        vNormal = normalize(mat3(uModel) * aNormal);
    }
`;

const fragmentShaderSource = `
    precision mediump float;
    
    uniform sampler2D uTexture;
    varying vec2 vTexCoord;
    varying vec3 vNormal;
    
    void main() {
        // Flip S so the panorama reads correctly from inside the sphere
        vec2 uv = vec2(1.0 - vTexCoord.x, vTexCoord.y);
        vec3 color = texture2D(uTexture, uv).rgb;
        gl_FragColor = vec4(color, 1.0);
    }
`;

function compileShader(source, type) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error('Shader compilation error:', gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }
    return shader;
}

function createProgram(vertexSource, fragmentSource) {
    const vertexShader = compileShader(vertexSource, gl.VERTEX_SHADER);
    const fragmentShader = compileShader(fragmentSource, gl.FRAGMENT_SHADER);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error('Program linking error:', gl.getProgramInfoLog(program));
        return null;
    }

    return program;
}

const program = createProgram(vertexShaderSource, fragmentShaderSource);
gl.useProgram(program);

// Get attribute and uniform locations
const aPosition = gl.getAttribLocation(program, 'aPosition');
const aNormal = gl.getAttribLocation(program, 'aNormal');
const aTexCoord = gl.getAttribLocation(program, 'aTexCoord');

const uModel = gl.getUniformLocation(program, 'uModel');
const uView = gl.getUniformLocation(program, 'uView');
const uProjection = gl.getUniformLocation(program, 'uProjection');
const uTexture = gl.getUniformLocation(program, 'uTexture');

// Create sphere with stack and sector count of at least 100
const sphere = new Sphere(gl, 1, 100, 100, true);
sphere.reverseNormals(); // Important for inside viewing

// Load panorama texture
function loadTexture(url, callback) {
    const texture = gl.createTexture();
    const image = new Image();

    image.onload = function () {
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.bindTexture(gl.TEXTURE_2D, null);

        if (callback) callback(texture);
    };

    image.onerror = function () {
        console.error('Failed to load image:', url);
    };

    image.src = url;
    return texture;
}

let panoramaTexture = null;
loadTexture('assets/panorama.jpg', (texture) => {
    panoramaTexture = texture;
});

// Matrix utilities
function mat4Identity() {
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ];
}

function mat4Multiply(a, b) {
    let result = [];
    for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
            result[i * 4 + j] = 0;
            for (let k = 0; k < 4; k++) {
                result[i * 4 + j] += a[i * 4 + k] * b[k * 4 + j];
            }
        }
    }
    return result;
}

function mat4RotateX(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [
        1, 0, 0, 0,
        0, c, -s, 0,
        0, s, c, 0,
        0, 0, 0, 1
    ];
}

function mat4RotateY(angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return [
        c, 0, s, 0,
        0, 1, 0, 0,
        -s, 0, c, 0,
        0, 0, 0, 1
    ];
}

function mat4Perspective(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1.0 / (near - far);
    return [
        f / aspect, 0, 0, 0,
        0, f, 0, 0,
        0, 0, (far + near) * nf, -1,
        0, 0, (2 * far * near) * nf, 0
    ];
}

// Camera control
let rotationX = 0;
let rotationY = 0;
let zoom = 1.0;
const PAN_SCALE = 0.2 * Math.PI / 180; // Match Song Ho demo: 0.2 degrees per pixel
const MIN_PITCH = -Math.PI * 0.495;
const MAX_PITCH = Math.PI * 0.495;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3.0;
const PINCH_SCALE = 0.005;
const WHEEL_SCALE = 0.1;

// Debug elements
const debugRotX = document.getElementById('debug-rotX');
const debugRotY = document.getElementById('debug-rotY');
const debugZoom = document.getElementById('debug-zoom');
const debugRotXDeg = document.getElementById('debug-rotX-deg');
const debugRotYDeg = document.getElementById('debug-rotY-deg');

// Update debug display
function updateDebugDisplay() {
    if (debugRotX) debugRotX.textContent = rotationX.toFixed(4);
    if (debugRotY) debugRotY.textContent = rotationY.toFixed(4);
    if (debugZoom) debugZoom.textContent = zoom.toFixed(2);
    if (debugRotXDeg) debugRotXDeg.textContent = (rotationX * 180 / Math.PI).toFixed(1) + '°';
    if (debugRotYDeg) debugRotYDeg.textContent = (rotationY * 180 / Math.PI).toFixed(1) + '°';
}

// Pointer interaction model copied from Song Ho's test_sphere pattern
const pointers = [];
pointers.downs = [];
pointers.distance = 0;
let pointerAngleX = 0;
let pointerAngleY = 0;

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function getDistance2D(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return Math.hypot(dx, dy);
}

function copyPointer(pe) {
    return {
        id: pe.pointerId,
        x: pe.clientX,
        y: pe.clientY,
        button: pe.button,
        delta: { x: 0, y: 0 }
    };
}

function findPointerIndex(pointerId) {
    return pointers.findIndex((p) => p.id === pointerId);
}

canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pointers.push(copyPointer(e));

    if (pointers.length === 1) {
        pointerAngleX = rotationX;
        pointerAngleY = rotationY;
        pointers.downs = [];
        pointers.downs.push(copyPointer(e));
    } else if (pointers.length === 2) {
        pointers.downs.push(copyPointer(e));
    }
});

canvas.addEventListener('pointerup', (e) => {
    e.preventDefault();
    const index = findPointerIndex(e.pointerId);
    if (index >= 0) {
        pointers.splice(index, 1);
        pointers.distance = 0;
    }
});

canvas.addEventListener('pointermove', (e) => {
    e.preventDefault();

    const index = findPointerIndex(e.pointerId);
    if (index < 0) {
        return;
    }

    const p = pointers[index];
    p.delta.x = e.clientX - p.x;
    p.delta.y = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;

    if (pointers.length === 2) {
        const SCALE_ZOOM = PINCH_SCALE;
        const dist = getDistance2D(pointers[0], pointers[1]);
        let deltaDistance = 0;
        if (pointers.distance > 0) {
            deltaDistance = dist - pointers.distance;
        }
        pointers.distance = dist;
        zoom = clamp(zoom + deltaDistance * SCALE_ZOOM, MIN_ZOOM, MAX_ZOOM);
    } else if (pointers.length === 1) {
        // Exact Song Ho rotate formula/sign, converted to radians
        rotationX = pointerAngleX + (pointers[0].y - pointers.downs[0].y) * PAN_SCALE;
        rotationY = pointerAngleY - (pointers[0].x - pointers.downs[0].x) * PAN_SCALE;
    }

    updateDebugDisplay();
});

canvas.addEventListener('pointercancel', () => {
    pointers.length = 0;
    pointers.distance = 0;
});

canvas.addEventListener('pointerleave', () => {
    pointers.length = 0;
    pointers.distance = 0;
});

// Mouse wheel zoom
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const deltaZoom = e.deltaY > 0 ? -WHEEL_SCALE : WHEEL_SCALE;
    zoom = clamp(zoom + deltaZoom, MIN_ZOOM, MAX_ZOOM);
    updateDebugDisplay();
}, { passive: false });

// Render loop
function render() {
    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    if (!panoramaTexture) {
        requestAnimationFrame(render);
        return;
    }

    // Setup matrices
    // Rotate sphere so poles align with ±Y and equator lies in the XZ plane;
    // this puts the horizon at the centre of the default (0,0) view.
    const model = mat4RotateX(-Math.PI / 2);

    // Rotation transformations
    let view = mat4Identity();
    view = mat4Multiply(view, mat4RotateX(rotationX));
    view = mat4Multiply(view, mat4RotateY(rotationY));

    const aspect = canvas.width / canvas.height;
    const fov = Math.PI / 3 / zoom; // Adjust FOV with zoom
    const projection = mat4Perspective(fov, aspect, 0.1, 100.0);

    // Set uniforms
    gl.uniformMatrix4fv(uModel, false, new Float32Array(model));
    gl.uniformMatrix4fv(uView, false, new Float32Array(view));
    gl.uniformMatrix4fv(uProjection, false, new Float32Array(projection));

    // Bind texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, panoramaTexture);
    gl.uniform1i(uTexture, 0);

    // Setup sphere vertex attributes
    gl.bindBuffer(gl.ARRAY_BUFFER, sphere.vboVertex);

    gl.enableVertexAttribArray(aPosition);
    gl.vertexAttribPointer(aPosition, 3, gl.FLOAT, false, sphere.stride, 0);

    gl.enableVertexAttribArray(aNormal);
    gl.vertexAttribPointer(aNormal, 3, gl.FLOAT, false, sphere.stride, 12);

    gl.enableVertexAttribArray(aTexCoord);
    gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, false, sphere.stride, 24);

    // Draw sphere
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, sphere.vboIndex);
    gl.drawElements(gl.TRIANGLES, sphere.getIndexCount(), gl.UNSIGNED_SHORT, 0);

    requestAnimationFrame(render);
}

render();
updateDebugDisplay();
