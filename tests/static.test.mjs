import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

test("静态页引用的脚本和样式都在仓库里", () => {
  const html = read("index.html");
  const refs = [...html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map((m) => m[1]);
  assert.ok(refs.includes("app.js"));
  assert.ok(refs.includes("ics.js") || /app\.js/.test(html));
  assert.ok(refs.includes("style.css"));
  for (const rel of refs) {
    if (rel.startsWith("http") || rel.startsWith("data:")) continue;
    assert.ok(existsSync(join(root, rel)), `missing ${rel}`);
  }
});

test("README / OG 不指向仓库里不存在的截图", () => {
  const html = read("index.html");
  const readme = read("README.md");
  const imageRefs = [
    ...html.matchAll(/og:image[^>]+content="([^"]+)"/g),
    ...readme.matchAll(/!\[[^\]]*]\(([^)]+)\)/g),
  ].map((m) => m[1]);
  for (const ref of imageRefs) {
    const local = ref.replace(/^https:\/\/raw\.githubusercontent\.com\/hc-ui\/kebiao2ics\/[^/]+\//, "");
    if (local.startsWith("http")) continue;
    assert.ok(existsSync(join(root, local)), `broken image ref: ${ref}`);
  }
});
