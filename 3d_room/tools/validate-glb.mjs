// The Khronos glTF validator over a GLB on stdin; prints its report as JSON.
// backend/catalogue/ingest.py runs it on every model before it enters the catalogue.
import validator from "gltf-validator";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const report = await validator.validateBytes(new Uint8Array(Buffer.concat(chunks)), {
  maxIssues: 50,
  // A self-contained GLB only: an external buffer/image is an error, not a fetch.
  externalResourceFunction: (uri) => Promise.reject(`external file ${uri}`),
});
console.log(JSON.stringify(report.issues));
