// Packs build/icons/*.png into a multi-resolution build/icon.ico.
// Plain Node, no dependencies. Vista+ ICO files may store PNG data directly.
//
//   node tools/make-ico.js

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DIR = path.join(ROOT, "build", "icons");
const OUT = path.join(ROOT, "build", "icon.ico");

const sizes = [16, 20, 24, 32, 48, 64, 128, 256].filter((s) =>
  fs.existsSync(path.join(DIR, `${s}.png`))
);

if (sizes.length === 0) {
  console.error(`no PNGs in ${DIR}; run "npm run icons:png" first`);
  process.exit(1);
}

const images = sizes.map((size) => ({ size, data: fs.readFileSync(path.join(DIR, `${size}.png`)) }));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;

const entries = images.map((img) => {
  const e = Buffer.alloc(16);
  const dim = img.size >= 256 ? 0 : img.size; // 0 means 256 in the ICO spec
  e.writeUInt8(dim, 0); // width
  e.writeUInt8(dim, 1); // height
  e.writeUInt8(0, 2); // palette count
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // colour planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(img.data.length, 8);
  e.writeUInt32LE(offset, 12);
  offset += img.data.length;
  return e;
});

fs.writeFileSync(OUT, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));

const total = fs.statSync(OUT).size;
console.log(`wrote ${path.relative(ROOT, OUT)} (${sizes.join(", ")}px, ${total} bytes)`);
