import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
let failed = false;

function fail(message) {
  failed = true;
  console.error(`ERROR: ${message}`);
}

function fullPath(relativePath) {
  return path.join(root, ...relativePath.split("/"));
}

function requireFile(relativePath, minimumBytes = 1) {
  const filename = fullPath(relativePath);

  if (!fs.existsSync(filename)) {
    fail(`Missing required file: ${relativePath}`);
    return null;
  }

  const stats = fs.statSync(filename);

  if (!stats.isFile()) {
    fail(`Expected a file: ${relativePath}`);
    return null;
  }

  if (stats.size < minimumBytes) {
    fail(`File is unexpectedly small: ${relativePath}`);
    return null;
  }

  return { filename, stats };
}

function requireDirectory(relativePath) {
  const directory = fullPath(relativePath);

  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail(`Missing required directory: ${relativePath}`);
    return null;
  }

  return directory;
}

console.log("InfraScan viewer asset verification");
console.log(`Node.js: ${process.versions.node}`);
console.log("");

requireFile("viewer/package.json");
requireFile("viewer/package-lock.json");

const model = requireFile(
  "viewer/public/scene/scene-c2.ply",
  1024 * 1024,
);

if (model) {
  console.log(
    `Model: scene-c2.ply (${(model.stats.size / 1024 / 1024).toFixed(2)} MB)`,
  );
}

const cameraFile = requireFile(
  "viewer/public/dataset/cameras-c2.json",
);

if (cameraFile) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(cameraFile.filename, "utf8"),
    );

    const records = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed.frames)
        ? parsed.frames
        : Array.isArray(parsed.cameras)
          ? parsed.cameras
          : null;

    if (!records) {
      fail("cameras-c2.json does not contain a recognized camera array.");
    } else {
      console.log(`Camera records: ${records.length}`);

      if (records.length !== 240) {
        fail(`Expected 240 camera records, found ${records.length}.`);
      }
    }
  } catch (error) {
    fail(`Could not parse cameras-c2.json: ${error.message}`);
  }
}

const viewsDirectory = requireDirectory(
  "viewer/public/dataset/views",
);

if (viewsDirectory) {
  const imageExtensions = [".jpg", ".jpeg", ".png"];
  const imageCount = fs
    .readdirSync(viewsDirectory, { withFileTypes: true })
    .filter((entry) => {
      if (!entry.isFile()) return false;
      const extension = path.extname(entry.name).toLowerCase();
      return imageExtensions.includes(extension);
    }).length;

  console.log(`Source images: ${imageCount}`);

  if (imageCount !== 240) {
    fail(`Expected 240 source images, found ${imageCount}.`);
  }
}

requireDirectory("viewer/public/processed");
requireFile("viewer/public/minimap/floorplan.png");
requireFile("viewer/public/minimap/floorplan.json");

const mainFile = requireFile("viewer/src/main.js");
const dataFile = requireFile("viewer/src/data.js");

if (mainFile) {
  const source = fs.readFileSync(mainFile.filename, "utf8");

  if (!source.includes("scene-c2.ply")) {
    fail("viewer/src/main.js does not reference scene-c2.ply.");
  }
}

if (dataFile) {
  const source = fs.readFileSync(dataFile.filename, "utf8");

  if (!source.includes("cameras-c2.json")) {
    fail("viewer/src/data.js does not reference cameras-c2.json.");
  }
}

if (failed) {
  console.error("");
  console.error("Asset verification failed. The scene data is not included in this repository; see docs/ASSETS.md.");
  process.exitCode = 1;
} else {
  console.log("");
  console.log("Verification passed.");
}
