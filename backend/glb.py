"""Reads what the catalogue needs from an uploaded GLB without changing a byte of it.

Stdlib only. The bounding box is computed the way @gltf-transform/core's getBounds does
(the catalogue tools measure with it): every vertex the indices reference, in world space
(node matrices applied), over the default scene's node trees.
"""

from __future__ import annotations

import base64
import json
import struct

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942
# componentType → (struct code, byte size, divisor when normalized)
COMPONENTS = {5120: ("b", 1, 127), 5121: ("B", 1, 255), 5122: ("h", 2, 32767),
              5123: ("H", 2, 65535), 5125: ("I", 4, 0), 5126: ("f", 4, 0)}
WIDTH = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}
IDENTITY = [1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0, 0, 0, 0, 0, 1.0]


class GlbError(ValueError):
    """The upload is not a GLB this app can use; the message is for the user."""


class Glb:
    def __init__(self, data: bytes):
        if len(data) < 20 or data[:4] != b"glTF":
            raise GlbError("not a GLB file (no glTF header)")
        version, length = struct.unpack_from("<II", data, 4)
        if version != 2:
            raise GlbError(f"GLB version {version}; only glTF 2.0 is supported")
        if length != len(data):
            raise GlbError(f"GLB header says {length} bytes but the file has {len(data)}")
        size, kind = struct.unpack_from("<II", data, 12)
        if kind != JSON_CHUNK or 20 + size > len(data):
            raise GlbError("GLB's first chunk is not its JSON")
        try:
            self.json = json.loads(data[20:20 + size])
        except ValueError as e:
            raise GlbError(f"GLB's JSON is unreadable: {e}") from None
        if not str(self.json.get("asset", {}).get("version", "")).startswith("2"):
            raise GlbError("not glTF 2.0 (asset.version)")
        at, self.bin = 20 + size, None
        if at + 8 <= len(data):
            size, kind = struct.unpack_from("<II", data, at)
            if kind == BIN_CHUNK:
                self.bin = data[at + 8:at + 8 + size]
        self.buffers = [self._data(b, f"buffer {i}", i == 0) for i, b in enumerate(self.json.get("buffers", []))]
        self.size = len(data)

    def _data(self, ref: dict, what: str, may_be_bin: bool = False) -> bytes:
        uri = ref.get("uri")
        if uri is None:
            if may_be_bin and self.bin is not None:
                return self.bin
            raise GlbError(f"{what} has no data")
        if uri.startswith("data:"):
            return base64.b64decode(uri.split(",", 1)[1])
        raise GlbError(f"{what} points at an external file ({uri}); upload a self-contained .glb")

    def _view(self, index: int) -> bytes:
        v = self.json["bufferViews"][index]
        start = v.get("byteOffset", 0)
        return self.buffers[v["buffer"]][start:start + v["byteLength"]]

    def accessor(self, index: int) -> list[tuple] | None:
        """The accessor's elements, or None when its data isn't plain (sparse, Draco, …)."""
        a = self.json["accessors"][index]
        if "bufferView" not in a or "sparse" in a:
            return None
        code, size, norm = COMPONENTS[a["componentType"]]
        n, count = WIDTH[a["type"]], a["count"]
        stride = self.json["bufferViews"][a["bufferView"]].get("byteStride") or size * n
        buf, base = self._view(a["bufferView"]), a.get("byteOffset", 0)
        if stride == size * n:
            flat = struct.unpack_from(f"<{count * n}{code}", buf, base)
            out = list(zip(*[iter(flat)] * n))
        else:
            out = [struct.unpack_from(f"<{n}{code}", buf, base + i * stride) for i in range(count)]
        if a.get("normalized") and norm:
            out = [tuple(max(c / norm, -1.0) for c in e) for e in out]
        return out

    def instances(self):
        """(mesh index, world matrix) for every mesh node in the default scene."""
        scenes = self.json.get("scenes") or []
        if not scenes:
            raise GlbError("GLB has no scene")
        nodes = self.json.get("nodes", [])

        def walk(i: int, parent: list[float]):
            node = nodes[i]
            world = mul(parent, local(node))
            if "mesh" in node:
                yield node["mesh"], world
            for c in node.get("children", []):
                yield from walk(c, world)

        for root in scenes[self.json.get("scene", 0)].get("nodes", []):
            yield from walk(root, IDENTITY)

    def bounds(self) -> tuple[list[float], list[float]]:
        lo, hi = [float("inf")] * 3, [float("-inf")] * 3
        cache: dict[int, list[tuple]] = {}
        for mesh, m in self.instances():
            for prim in self.json["meshes"][mesh]["primitives"]:
                pos = prim.get("attributes", {}).get("POSITION")
                if pos is None:
                    continue
                if pos not in cache:
                    cache[pos] = self._used(prim)
                for x, y, z in cache[pos]:
                    for k in range(3):
                        w = m[k] * x + m[4 + k] * y + m[8 + k] * z + m[12 + k]
                        if w < lo[k]: lo[k] = w
                        if w > hi[k]: hi[k] = w
        if lo[0] == float("inf"):
            raise GlbError("GLB has no geometry in its scene")
        return lo, hi

    def _used(self, prim: dict) -> list[tuple]:
        """The vertices a primitive draws: those its indices reference (all, without indices).
        ponytail: sparse/Draco positions fall back to the accessor's min/max box corners (spec-required),
        which is looser under rotation; decode them if such uploads show up."""
        a = prim["attributes"]["POSITION"]
        verts = self.accessor(a)
        if verts is None:
            acc = self.json["accessors"][a]
            lo, hi = acc["min"], acc["max"]
            return [(x, y, z) for x in (lo[0], hi[0]) for y in (lo[1], hi[1]) for z in (lo[2], hi[2])]
        if "indices" not in prim:
            return verts
        idx = self.accessor(prim["indices"])
        return verts if idx is None else [verts[i] for i in {e[0] for e in idx}]

    def triangles(self) -> int:
        """Triangles drawn per frame: each mesh node counts, strips and fans included."""
        n = 0
        for mesh, _ in self.instances():
            for prim in self.json["meshes"][mesh]["primitives"]:
                ref = prim.get("indices", prim.get("attributes", {}).get("POSITION"))
                count = self.json["accessors"][ref]["count"] if ref is not None else 0
                mode = prim.get("mode", 4)
                n += count // 3 if mode == 4 else max(count - 2, 0) if mode in (5, 6) else 0
        return n

    def textures(self) -> list[dict]:
        out = []
        for i, img in enumerate(self.json.get("images", [])):
            data = self._view(img["bufferView"]) if "bufferView" in img else self._data(img, f"image {i}")
            w, h = image_size(data)
            out.append({"width": w, "height": h, "mime_type": img.get("mimeType") or sniff(data)})
        return out


def local(node: dict) -> list[float]:
    """The node's matrix, column-major as glTF stores it."""
    if "matrix" in node:
        return [float(v) for v in node["matrix"]]
    tx, ty, tz = node.get("translation", (0, 0, 0))
    x, y, z, w = node.get("rotation", (0, 0, 0, 1))
    sx, sy, sz = node.get("scale", (1, 1, 1))
    return [
        (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
        2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
        2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        tx, ty, tz, 1,
    ]


def mul(a: list[float], b: list[float]) -> list[float]:
    return [sum(a[k * 4 + r] * b[c * 4 + k] for k in range(4)) for c in range(4) for r in range(4)]


def sniff(data: bytes) -> str | None:
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def image_size(data: bytes) -> tuple[int | None, int | None]:
    """Width, height from a PNG or JPEG header. ponytail: WebP/KTX2 report None; add when uploads use them."""
    kind = sniff(data)
    if kind == "image/png":
        return struct.unpack_from(">II", data, 16)
    if kind == "image/jpeg":
        i = 2
        while i + 9 < len(data):
            if data[i] != 0xFF:
                i += 1
                continue
            marker, length = data[i + 1], struct.unpack_from(">H", data, i + 2)[0]
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack_from(">HH", data, i + 5)
                return w, h
            i += 2 + length
    return None, None


def auto_scale(size: list[float]) -> float:
    """cm per model unit, the old gltf-to-threejs-json.js computeAutoScale rule."""
    max_dim = max(size)
    height = size[1] if size[1] > 0.001 else max_dim
    if height < 3:
        return 1 if height < max_dim * 0.1 and max_dim >= 30 else 100
    return 10 if height < 25 and max_dim < 30 else 1
